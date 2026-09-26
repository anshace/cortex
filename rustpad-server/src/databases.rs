//! One database per organization, opened on demand.
//!
//! The control plane (`SQLITE_URI`) holds identity, sessions, the org registry,
//! the routing index in `doc_org`, plans and instance audit. Document content —
//! the `document` table — can live in a file per organization instead, which is
//! what makes "that tenant's bytes are over there" true in storage rather than
//! only in a `WHERE org_id = ?`.
//!
//! Three modes, chosen once at boot:
//! * `Single` — `CORTEX_ORG_DBS` unset. Every org resolves to the control
//!   database, so the server behaves exactly as it did before this module
//!   existed. This is the default: a per-org file is a second thing to back up,
//!   and the runbook has to say so before the flag is worth flipping.
//! * `Files(dir)` — `CORTEX_ORG_DBS=1` with a file-backed control database: one
//!   SQLite file per org at `<dir>/org-<id>.db`.
//! * `Memory` — `CORTEX_ORG_DBS=1` with an in-memory control database (a box
//!   whose root filesystem is read-only): named shared-cache memory databases,
//!   because two orgs opening `sqlite::memory:` would otherwise share one
//!   anonymous database and every isolation property this module exists for.

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::database::Database;

/// How long an organization's pool may sit unused before maintenance closes it.
/// Each open pool is a file handle plus a WAL pair, and a hundred dormant orgs
/// should not cost a hundred of each.
const IDLE_TTL: Duration = Duration::from_secs(15 * 60);

/// One database per organization, opened on demand and cached while in use.
#[derive(Clone, Debug)]
pub struct Databases {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    control: Database,
    mode: Mode,
    open: tokio::sync::Mutex<HashMap<i64, Cached>>,
    /// Salts the in-memory database names so two registries in one process can
    /// never resolve the same org to the same shared-cache database. One
    /// registry per process is all the server does today; without a salt, two
    /// of them race each other through the same migration set.
    nonce: u64,
}

#[derive(Clone, Debug)]
enum Mode {
    Single,
    Files(PathBuf),
    Memory,
}

#[derive(Debug)]
struct Cached {
    db: Database,
    used: Instant,
}

/// One row of the console's per-organization database table.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OrgDbStatus {
    /// The organization this database belongs to.
    pub org_id: i64,
    /// Where it is: a file path, or the name of a shared in-memory database.
    /// Empty in single mode, where there is nothing beyond the control file.
    pub uri: String,
    /// The highest migration this database has applied.
    pub schema_version: i64,
    /// True when this database is on an older schema than the running binary.
    pub behind: bool,
    /// Bytes of its file, or 0 when it has none.
    pub size_bytes: i64,
    /// Documents the routing index credits to this organization.
    pub documents: i64,
}

/// The console's whole databases block.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Report {
    /// "single", "files" or "memory" — how content is laid out on this instance.
    pub mode: &'static str,
    /// The version this binary's embedded migrations would leave a database at.
    pub expected_version: i64,
    /// One row per organization the control plane knows about.
    pub orgs: Vec<OrgDbStatus>,
}

impl Databases {
    /// Choose the layout from the environment and keep the control database.
    ///
    /// `sqlite_uri` is the one the control plane opened, and only decides the
    /// layout: an instance whose own database is in memory cannot put an org's
    /// database on a disk it does not have.
    pub fn new(control: Database, sqlite_uri: &str) -> Self {
        let split = matches!(
            std::env::var("CORTEX_ORG_DBS").as_deref(),
            Ok("1") | Ok("true") | Ok("yes")
        );
        let mode = if !split {
            Mode::Single
        } else if sqlite_uri.contains(":memory:") {
            Mode::Memory
        } else {
            Mode::Files(
                std::env::var("CORTEX_ORG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from("/data/orgs")),
            )
        };
        if !matches!(mode, Mode::Single) {
            log::info!("per-org databases enabled ({mode:?})");
        }
        Self {
            inner: Arc::new(Inner {
                control,
                mode,
                open: tokio::sync::Mutex::new(HashMap::new()),
                nonce: rand::random(),
            }),
        }
    }

    /// The layout name an operator reads in the console: "single", "files",
    /// or "memory".
    pub fn mode(&self) -> &'static str {
        match self.inner.mode {
            Mode::Single => "single",
            Mode::Files(_) => "files",
            Mode::Memory => "memory",
        }
    }

    /// `Single` is the whole point of the default: content keeps living exactly
    /// where it did before, in the database every handler already uses.
    pub fn is_split(&self) -> bool {
        !matches!(self.inner.mode, Mode::Single)
    }

    fn uri_for(&self, org_id: i64) -> String {
        match &self.inner.mode {
            Mode::Single => String::new(),
            Mode::Files(dir) => dir
                .join(format!("org-{org_id}.db"))
                .to_string_lossy()
                .replace('\\', "/"),
            Mode::Memory => format!(
                "file:cortex-org-{org_id}-{}?mode=memory&cache=shared",
                self.inner.nonce
            ),
        }
    }

    /// The database holding this organization's content, opened and migrated on
    /// first use. Two concurrent requests for the same org both wait on the
    /// lock, and the second one gets the pool the first created.
    pub async fn org(&self, org_id: i64) -> Result<Database> {
        if !self.is_split() {
            return Ok(self.inner.control.clone());
        }
        let mut open = self.inner.open.lock().await;
        if let Some(cached) = open.get_mut(&org_id) {
            cached.used = Instant::now();
            return Ok(cached.db.clone());
        }
        let db = Database::open_org(&self.uri_for(org_id)).await?;
        project_members(&self.inner.control, &db, org_id).await?;
        open.insert(
            org_id,
            Cached {
                db: db.clone(),
                used: Instant::now(),
            },
        );
        Ok(db)
    }

    /// Create the database when the organization is created, so a tenant never
    /// discovers at its first write that its storage is missing.
    pub async fn provision(&self, org_id: i64) -> Result<()> {
        self.org(org_id).await.map(|_| ())
    }

    /// Destroy an organization's storage once its control-plane rows are gone:
    /// drop the registry's handle, then unlink its database and the `-wal`/`-shm`
    /// siblings SQLite leaves beside it. Returns how many files went.
    ///
    /// Nothing else in the server deletes a tenant file, so without this a
    /// deleted organization keeps its database on disk forever — member rows
    /// today, and its documents too once content is routed per tenant.
    ///
    /// Dropping the handle does not by itself close the pool: a request already
    /// holding a clone keeps the file open. The caller must therefore have
    /// disconnected the org's live documents and boards first, under the same
    /// access gate the delete runs on.
    pub async fn discard(&self, org_id: i64) -> usize {
        // Close the pool before touching the filesystem: while a connection is
        // open the database file is held — Windows refuses the unlink outright,
        // and POSIX would happily delete a file SQLite is still writing.
        if let Some(cached) = self.inner.open.lock().await.remove(&org_id) {
            // `Pool::close` through the pool accessor: no further connections,
            // and idle ones dropped — that is what releases the file handle.
            cached.db.read_only().close();
        }
        let dir = match &self.inner.mode {
            Mode::Files(dir) => dir.clone(),
            // Single mode never made a file; memory mode has nothing on disk.
            _ => return 0,
        };
        let base = dir.join(format!("org-{org_id}.db"));
        let mut removed = 0;
        for suffix in ["", "-wal", "-shm"] {
            let path = std::path::PathBuf::from(format!("{}{suffix}", base.display()));
            // Releasing a handle can lag the close by a few milliseconds, so try
            // a handful of times before giving up — and say so loudly, because a
            // tenant file that survives its organization's deletion is exactly
            // the residue this method exists to remove.
            for attempt in 0..5 {
                match std::fs::remove_file(&path) {
                    Ok(()) => {
                        removed += 1;
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                    Err(e) if attempt < 4 => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => log::warn!("could not remove {}: {e}", path.display()),
                }
            }
        }
        removed
    }

    /// Close pools nobody has used for [`IDLE_TTL`]. `busy` reports whether an
    /// org still has a live document or board, and those are never evicted.
    pub async fn close_idle(&self, busy: impl Fn(i64) -> bool) {
        let mut open = self.inner.open.lock().await;
        let cutoff = Instant::now() - IDLE_TTL;
        let stale: Vec<i64> = open
            .iter()
            .filter(|(org, cached)| cached.used < cutoff && !busy(**org))
            .map(|(org, _)| *org)
            .collect();
        for org in stale {
            open.remove(&org);
            log::info!("closed idle database for org {org}");
        }
    }

    /// Every organization the control plane knows about, in a stable order.
    pub async fn org_ids(&self) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT id FROM org ORDER BY id")
            .fetch_all(self.inner.control.read_only())
            .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Bring every organization's database to this binary's schema, and refresh
    /// each one's member projection. Boot runs it so that an update never leaves
    /// a tenant on an old schema until someone happens to open a document;
    /// opening is what applies the embedded migrations.
    ///
    /// Returns how many databases were brought forward. In single mode there is
    /// nothing to do — the control database was migrated by `Database::new`.
    pub async fn migrate_all(&self) -> Result<usize> {
        if !self.is_split() {
            return Ok(0);
        }
        let mut moved = 0;
        for org_id in self.org_ids().await? {
            let db = self.org(org_id).await?;
            // Opening caches a pool, and a cached pool is not a fresh
            // projection: a member added to the control plane after the org's
            // database was first opened only arrives here.
            project_members(&self.inner.control, &db, org_id).await?;
            if schema_version(&db).await? != expected_version() {
                bail!(
                    "org {org_id} is still short of schema {}",
                    expected_version()
                );
            }
            moved += 1;
        }
        Ok(moved)
    }

    /// Every organization the control plane knows about, with what an operator
    /// needs in order to notice a database that an update left behind.
    pub async fn report(&self) -> Result<Report> {
        let expected = expected_version();
        let mut out = Vec::new();
        for org_id in self.org_ids().await? {
            let (db, uri) = if self.is_split() {
                (self.org(org_id).await?, self.uri_for(org_id))
            } else {
                (self.inner.control.clone(), String::new())
            };
            let version = schema_version(&db).await?;
            out.push(OrgDbStatus {
                org_id,
                uri,
                schema_version: version,
                behind: version != expected,
                size_bytes: db.file_size().await.unwrap_or(0),
                documents: self.inner.control.count_documents_of(org_id).await.unwrap_or(0),
            });
        }
        Ok(Report {
            mode: self.mode(),
            expected_version: expected,
            orgs: out,
        })
    }
}

/// The version a binary's migrations would leave a database at.
pub fn expected_version() -> i64 {
    sqlx::migrate!()
        .migrations
        .iter()
        .map(|m| m.version)
        .max()
        .unwrap_or(0)
}

/// The version one database is actually at.
pub async fn schema_version(db: &Database) -> Result<i64> {
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_optional(db.read_only())
            .await?;
    Ok(row.and_then(|v| v.0).unwrap_or(0))
}

/// Copy this organization's members into its database.
///
/// The organization database needs real `users` rows, because
/// `workspace.owner_id`, `group_member.user_id` and `message.sender_id` are
/// foreign keys to `users` and SQLite cannot satisfy a foreign key across a
/// database boundary. So identity is replicated, not referenced — and what is
/// replicated is display data only. Credentials stay in the control plane: the
/// hash written here is a value bcrypt can never verify and the email is a
/// placeholder, so a leaked tenant file yields names and nothing to sign in
/// with. Authentication is exclusively a control-plane operation.
async fn project_members(control: &Database, org: &Database, org_id: i64) -> Result<()> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, name, role FROM users WHERE org_id = $1 ORDER BY id",
    )
    .bind(org_id)
    .fetch_all(control.read_only())
    .await?;
    let authorized: Vec<i64> = rows.iter().map(|(id, ..)| *id).collect();
    for (id, name, role) in rows {
        org.upsert_member(id, &format!("member-{id}@org.local"), &name, &role, org_id)
            .await?;
    }
    // Additions alone leave a tenant database ahead of reality in the only way
    // that matters: a member who left, or moved to another organization, keeps
    // their row here forever, and this is the table the tenant's own foreign
    // keys resolve against. Prune to exactly who the control plane authorizes.
    let removed = org.remove_members_not_in(&authorized).await?;
    if removed > 0 {
        log::info!("pruned {removed} unauthorized member row(s) from org {org_id}'s database");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn control() -> (tempfile::TempDir, Database) {
        let tmp = tempfile::tempdir().unwrap();
        let uri = format!(
            "sqlite://{}",
            tmp.path().join("ctl.db").to_string_lossy()
        );
        let db = Database::open_org(&uri).await.unwrap();
        (tmp, db)
    }

    async fn add_org(db: &Database, id: i64) {
        sqlx::query("INSERT INTO org (id, name, slug, created_at) VALUES ($1, $2, $3, 1)")
            .bind(id)
            .bind(format!("Org {id}"))
            .bind(format!("org-{id}"))
            .execute(db.write())
            .await
            .unwrap();
    }

    async fn add_member(db: &Database, id: i64, org_id: i64) {
        sqlx::query(
            "INSERT INTO users (id, email, password_hash, role, name, org_id) \
             VALUES ($1, $2, 'not-a-bcrypt-hash', 'user', 'Dana', $3)",
        )
        .bind(id)
        .bind(format!("real{id}@corp.example"))
        .bind(org_id)
        .execute(db.write())
        .await
        .unwrap();
    }

    fn split(control: Database, mode: Mode) -> Databases {
        Databases {
            inner: Arc::new(Inner {
                control,
                mode,
                open: tokio::sync::Mutex::new(HashMap::new()),
                nonce: rand::random(),
            }),
        }
    }

    #[tokio::test]
    async fn with_the_flag_off_every_org_shares_the_one_database() {
        let (_tmp, db) = control().await;
        let registry = Databases::new(db.clone(), "sqlite://ctl.db");
        assert!(!registry.is_split());
        assert!(registry.org(7).await.unwrap().shares_pool_with(&db));
    }

    #[tokio::test]
    async fn an_organizations_database_is_created_and_migrated_on_first_use() {
        let tmp = tempfile::tempdir().unwrap();
        let (_t, db) = control().await;
        let registry = split(db, Mode::Files(tmp.path().to_path_buf()));
        registry.provision(3).await.unwrap();
        assert!(tmp.path().join("org-3.db").exists());
        let org = registry.org(3).await.unwrap();
        assert_eq!(
            schema_version(&org).await.unwrap(),
            expected_version(),
            "a provisioned database is on this binary's schema"
        );
    }

    #[tokio::test]
    async fn two_organizations_do_not_share_one_in_memory_database() {
        let (_t, db) = control().await;
        let registry = split(db, Mode::Memory);
        let a = registry.org(1).await.unwrap();
        let b = registry.org(2).await.unwrap();
        assert!(
            !a.shares_pool_with(&b),
            "one memory database cannot hold two tenants"
        );
        sqlx::query("INSERT INTO document (id, text) VALUES ('doc-a', 'secret')")
            .execute(a.write())
            .await
            .unwrap();
        let seen: Option<(String,)> =
            sqlx::query_as("SELECT text FROM document WHERE id = 'doc-a'")
                .fetch_optional(b.read_only())
                .await
                .unwrap();
        assert!(seen.is_none(), "the other organization must not see it");
    }

    #[tokio::test]
    async fn replicated_members_carry_no_credential_worth_stealing() {
        let (_t, control) = control().await;
        add_org(&control, 9).await;
        add_member(&control, 41, 9).await;
        let registry = split(control, Mode::Memory);
        let org = registry.org(9).await.unwrap();
        let row: (String, String) =
            sqlx::query_as("SELECT email, password_hash FROM users WHERE id = 41")
                .fetch_one(org.read_only())
                .await
                .unwrap();
        assert_eq!(row.0, "member-41@org.local", "the email is a placeholder");
        assert_eq!(
            row.1, "!",
            "no hash to mount an offline crack against"
        );
        let name: (String,) = sqlx::query_as("SELECT name FROM users WHERE id = 41")
            .fetch_one(org.read_only())
            .await
            .unwrap();
        assert_eq!(name.0, "Dana", "display data does arrive");
    }

    #[tokio::test]
    async fn a_member_of_another_org_is_not_replicated() {
        let (_t, control) = control().await;
        add_org(&control, 9).await;
        add_org(&control, 10).await;
        add_member(&control, 41, 10).await;
        let registry = split(control, Mode::Memory);
        let org = registry.org(9).await.unwrap();
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
            .fetch_one(org.read_only())
            .await
            .unwrap();
        assert_eq!(count.0, 0, "only this org's members cross the boundary");
    }

    #[tokio::test]
    async fn the_report_names_a_database_an_update_left_behind() {
        let (_t, control) = control().await;
        add_org(&control, 9).await;
        let registry = Databases::new(control.clone(), "sqlite://ctl.db");
        let report = registry.report().await.unwrap();
        assert_eq!(report.mode, "single");
        assert_eq!(report.orgs.len(), 1);
        assert!(
            !report.orgs[0].behind,
            "the control database is migrated at boot"
        );
        assert_eq!(report.expected_version, expected_version());
        assert_eq!(
            report.orgs[0].schema_version,
            expected_version(),
            "single mode reports the control database's own version"
        );
        assert!(
            report.orgs[0].uri.is_empty(),
            "single mode has no per-org location to name"
        );

        // A database an update moved past must be reported, not silently used.
        // The newest applied-migration row is what a database that has not run
        // the latest migration lacks, so dropping it is the skew.
        sqlx::query(
            "DELETE FROM _sqlx_migrations \
             WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)",
        )
        .execute(control.write())
        .await
        .unwrap();
        let skewed = registry.report().await.unwrap();
        assert!(
            skewed.orgs[0].behind,
            "one migration behind is the skew an operator has to see"
        );
        assert_eq!(
            skewed.orgs[0].schema_version,
            expected_version() - 1,
            "and it is reported as a version, not just a flag"
        );
    }

    #[tokio::test]
    async fn migrating_all_refreshes_a_member_who_joined_after_provisioning() {
        let (_t, control) = control().await;
        add_org(&control, 9).await;
        add_member(&control, 41, 9).await;
        let registry = split(control.clone(), Mode::Memory);
        assert_eq!(registry.migrate_all().await.unwrap(), 1);

        // The control plane is the authority: a second member added there must
        // reach the tenant database on the next pass, not only on first open.
        add_member(&control, 42, 9).await;
        assert_eq!(registry.migrate_all().await.unwrap(), 1);
        let org = registry.org(9).await.unwrap();
        let names: Vec<(String,)> = sqlx::query_as("SELECT name FROM users ORDER BY id")
            .fetch_all(org.read_only())
            .await
            .unwrap();
        assert_eq!(names.len(), 2, "both members are projected");
        let email: (String,) =
            sqlx::query_as("SELECT email FROM users WHERE id = 42")
                .fetch_one(org.read_only())
                .await
                .unwrap();
        assert_eq!(email.0, "member-42@org.local");
    }

    #[tokio::test]
    async fn single_mode_has_nothing_to_migrate() {
        let (_t, control) = control().await;
        add_org(&control, 9).await;
        let registry = Databases::new(control, "sqlite://ctl.db");
        assert_eq!(
            registry.migrate_all().await.unwrap(),
            0,
            "one database, migrated at boot by its own constructor"
        );
    }

    #[tokio::test]
    async fn a_member_who_left_the_org_is_pruned_from_its_database() {
        let (_t, control) = control().await;
        add_org(&control, 9).await;
        add_org(&control, 10).await;
        add_member(&control, 41, 9).await;
        add_member(&control, 42, 9).await;
        let registry = split(control.clone(), Mode::Memory);
        let org = registry.org(9).await.unwrap();

        // The control plane changes its mind; the tenant database must follow,
        // which a projection that only ever adds rows cannot do.
        sqlx::query("UPDATE users SET org_id = 10 WHERE id = 42")
            .execute(control.write())
            .await
            .unwrap();
        add_member(&control, 43, 9).await;
        registry.migrate_all().await.unwrap();

        let ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM users ORDER BY id")
            .fetch_all(org.read_only())
            .await
            .unwrap();
        assert_eq!(
            ids.into_iter().map(|(id,)| id).collect::<Vec<_>>(),
            vec![41, 43],
            "a tenant holds exactly who the control plane authorizes today"
        );
    }

    #[tokio::test]
    async fn deleting_an_organization_unlinks_its_database_and_wal_siblings() {
        let tmp = tempfile::tempdir().unwrap();
        let (_t, control) = control().await;
        let registry = split(control, Mode::Files(tmp.path().to_path_buf()));
        registry.provision(3).await.unwrap();
        let base = tmp.path().join("org-3.db");
        assert!(base.exists(), "provisioning created the tenant database");
        assert_eq!(registry.discard(3).await, 1, "the tenant database goes with the tenant");
        assert!(!base.exists(), "a deleted organization must not leave its data behind");

        // SQLite leaves `-wal` and `-shm` siblings beside a live database, so a
        // delete that unlinked only the `.db` would leave half a tenant on disk.
        // Written by hand for an org that was never opened: Windows refuses to
        // rewrite a WAL that a live connection has mapped.
        for name in ["org-7.db", "org-7.db-wal", "org-7.db-shm"] {
            std::fs::write(tmp.path().join(name), b"x").unwrap();
        }
        assert_eq!(registry.discard(7).await, 3, "database plus its wal and shm siblings");
        for name in ["org-7.db", "org-7.db-wal", "org-7.db-shm"] {
            assert!(!tmp.path().join(name).exists(), "{name} survived the delete");
        }

        // A later organization given the same id must start from nothing, not
        // from a leftover file written under an older schema.
        let again = registry.org(3).await.unwrap();
        assert!(base.exists(), "discarding does not stop a new tenant being provisioned");
        assert_eq!(schema_version(&again).await.unwrap(), expected_version());
    }
}
