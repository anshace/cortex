//! Backend SQLite database handlers.
//!
//! Model: **Org → Workspaces → files**, plus one org-wide chat. Every user is
//! assigned to at most one org (by the root owner). Access to a workspace is by
//! org membership; the root owner bypasses org checks (full cross-org access).

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Column, Sqlite, SqlitePool, Transaction,
};

/// Represents a document persisted in database storage.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct PersistedDocument {
    /// Text content of the document.
    pub text: String,
    /// Language of the document for editor syntax highlighting.
    pub language: Option<String>,
}

/// A seeded application user.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct User {
    /// Primary key.
    pub id: i64,
    /// Login email (unique).
    pub email: String,
    /// Display name (editable in profile).
    pub name: String,
    /// bcrypt hash of the password.
    pub password_hash: String,
    /// "root" (hidden owner), "admin", or "user".
    pub role: String,
    /// Org the user is assigned to (None for root / unassigned).
    pub org_id: Option<i64>,
    /// Base32 TOTP secret, if the user has started 2FA enrollment (None = never set).
    pub totp_secret: Option<String>,
    /// True once the user has confirmed 2FA with a valid code; login then requires it.
    pub totp_enabled: bool,
}

/// A user as shown in the root admin console (never includes root accounts).
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AdminUser {
    /// Primary key.
    pub id: i64,
    /// Login email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Role ("admin" or "user").
    pub role: String,
    /// Assigned org id (nullable).
    pub org_id: Option<i64>,
    /// Assigned org name (nullable).
    pub org_name: Option<String>,
}

/// An org.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Org {
    /// Primary key.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// URL slug (unique), e.g. "dev".
    pub slug: String,
}

/// An org as shown in the owner console, with counts.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AdminOrg {
    /// Primary key.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// URL slug.
    pub slug: String,
    /// Number of assigned users.
    pub members: i64,
    /// Number of workspaces.
    pub workspaces: i64,
}

/// A group: the people + conversation hub inside an org, scoped to one of
/// three layers — `org` (whole org), `group` (visible to group_member rows)
/// or `personal` (visible only to `created_by`). A group holds one or more
/// workspaces (file/code projects) beneath it, and its own chat.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Group {
    /// Primary key.
    pub id: i64,
    /// Owning org.
    pub org_id: i64,
    /// Display name.
    pub name: String,
    /// Visibility layer: "org" | "group" | "personal".
    pub scope: String,
    /// Creator; owner for personal/group scopes.
    pub created_by: i64,
}

/// A workspace (file project) inside a group.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Workspace {
    /// Primary key.
    pub id: i64,
    /// Owning group.
    pub group_id: i64,
    /// Display name.
    pub name: String,
    /// URL slug, unique within the group (e.g. "backend").
    pub slug: String,
    /// Creator.
    pub created_by: i64,
}

/// Turn a name into a URL slug.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() {
        "workspace".to_string()
    } else {
        t
    }
}

/// A file within a workspace.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct FileRow {
    /// Primary key.
    pub id: i64,
    /// Owning workspace.
    pub workspace_id: i64,
    /// Path/name within the workspace.
    pub path: String,
    /// Id of the collaborative document holding this file's text.
    pub doc_id: String,
    /// "text" (collaborative) or "binary" (uploaded document).
    pub kind: String,
    /// MIME type for binary files.
    pub mime: Option<String>,
    /// Content size in bytes: blob length for binaries, document text length
    /// for text files. Lets clients pick viewer/editor modes without fetching.
    pub size: i64,
}

/// A validated entry extracted from a ZIP workspace import.
pub struct ImportedFile {
    /// Normalized virtual path, already checked for traversal.
    pub path: String,
    /// MIME type inferred from the filename (never trusted from ZIP metadata).
    pub mime: Option<String>,
    /// The uncompressed contents.
    pub bytes: Vec<u8>,
    /// Whether the bytes are valid, small UTF-8 and not a whiteboard scene.
    pub is_text: bool,
}

/// A chat message with its author's name/email.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct ChatMessage {
    /// Primary key.
    pub id: i64,
    /// Markdown body.
    pub body: String,
    /// Author display name (falls back to email on the client).
    pub author: String,
    /// Author email.
    pub email: String,
    /// Unix seconds.
    pub created_at: i64,
    /// When the message was last edited (None if never).
    pub edited_at: Option<i64>,
}

/// One emoji's tally on a message, from the requesting user's point of view.
#[derive(Serialize, PartialEq, Eq, Clone, Debug)]
pub struct ReactionView {
    /// The emoji.
    pub emoji: String,
    /// How many people reacted with it.
    pub count: i64,
    /// Whether the requesting user is one of them.
    pub mine: bool,
}

/// Group flat (msg_id, emoji, user_id) rows into per-message reaction tallies,
/// marking which are the requesting user's. Preserves first-seen emoji order.
fn group_reactions(rows: Vec<(i64, String, i64)>, me: i64) -> HashMap<i64, Vec<ReactionView>> {
    let mut map: HashMap<i64, Vec<ReactionView>> = HashMap::new();
    for (msg_id, emoji, user_id) in rows {
        let list = map.entry(msg_id).or_default();
        if let Some(rv) = list.iter_mut().find(|rv| rv.emoji == emoji) {
            rv.count += 1;
            rv.mine |= user_id == me;
        } else {
            list.push(ReactionView {
                emoji,
                count: 1,
                mine: user_id == me,
            });
        }
    }
    map
}

/// One audit-log entry, joined to its actor's identity for display.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AuditEntry {
    /// Primary key.
    pub id: i64,
    /// Action slug, e.g. "login", "download", "delete_file".
    pub action: String,
    /// Optional human detail (a path, a target email, …).
    pub detail: Option<String>,
    /// Actor email ("system" for actorless events).
    pub email: String,
    /// Actor display name.
    pub name: String,
    /// Unix seconds.
    pub created_at: i64,
}

/// A member of an org, as returned to the client.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Member {
    /// User id.
    pub id: i64,
    /// User email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// User role ("admin" or "user").
    pub role: String,
}

/// A path cannot be both a file and a directory in the virtual tree.
fn paths_overlap(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

/// Choose a non-conflicting name without overwriting existing files/folders.
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn available_path(existing: &HashSet<String>, requested: &str) -> Result<String> {
    if existing.iter().any(|p| requested.starts_with(&format!("{p}/"))) {
        bail!("destination folder is a file");
    }
    if !existing.iter().any(|p| paths_overlap(p, requested)) {
        return Ok(requested.to_string());
    }
    let (dir, name) = requested.rsplit_once('/').unwrap_or(("", requested));
    let dot = name.rfind('.').filter(|&i| i > 0);
    let (stem, ext) = dot.map(|i| name.split_at(i)).unwrap_or((name, ""));
    for n in 1.. {
        let candidate = if dir.is_empty() {
            format!("{stem} ({n}){ext}")
        } else {
            format!("{dir}/{stem} ({n}){ext}")
        };
        if !existing.iter().any(|p| paths_overlap(p, &candidate)) {
            return Ok(candidate);
        }
    }
    unreachable!()
}

/// Resolve a batch path without splitting up its folder. When a destination
/// already has a *file* at a parent path, rename that whole incoming folder
/// consistently for all files in the batch (e.g. `docs/a` + `docs/b` become
/// `docs (1)/a` + `docs (1)/b`). Leaf collisions are numbered individually.
fn available_tree_path(
    occupied: &HashSet<String>,
    requested: &str,
    folders: &mut HashMap<String, String>,
) -> Result<String> {
    let segments: Vec<&str> = requested.split('/').collect();
    let mut original = String::new();
    let mut parent = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        original = if original.is_empty() { (*segment).into() } else { format!("{original}/{segment}") };
        if let Some(mapped) = folders.get(&original) {
            parent = mapped.clone();
            continue;
        }
        let candidate = if parent.is_empty() { (*segment).into() } else { format!("{parent}/{segment}") };
        if occupied.contains(&candidate) {
            let renamed = available_path(occupied, &candidate)?;
            folders.insert(original.clone(), renamed.clone());
            parent = renamed;
        } else {
            parent = candidate;
        }
    }
    let leaf = segments.last().ok_or_else(|| anyhow::anyhow!("invalid path"))?;
    let path = if parent.is_empty() { (*leaf).into() } else { format!("{parent}/{leaf}") };
    available_path(occupied, &path)
}

/// Result of one scheduled or owner-requested maintenance run.
#[derive(Serialize)]
pub struct MaintenanceReport {
    /// SQLite main DB file size at the start (WAL is separate).
    pub db_bytes_before: i64,
    /// SQLite main DB file size after maintenance (WAL is separate).
    pub db_bytes_after: i64,
    /// Reusable pages before compaction.
    pub free_bytes_before: i64,
    /// Whether the DB file was compacted.
    pub vacuumed: bool,
    /// Nonzero if a reader prevented a checkpoint / compaction.
    pub checkpoint_busy: i64,
    /// Expired login sessions removed.
    pub expired_sessions: u64,
    /// Documents no longer attached to any file.
    pub orphan_documents: u64,
    /// Binary blobs no longer attached to any file.
    pub orphan_blobs: u64,
    /// Reactions to missing messages or by missing users.
    pub orphan_reactions: u64,
    /// Unreferenced old pasted chat images.
    pub orphan_chat_images: u64,
    /// Audit entries older than the configured retention period.
    pub pruned_audit: u64,
}

/// A driver for database operations wrapping a pool connection.
#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
    maintenance_lock: Arc<tokio::sync::Mutex<()>>,
}

// These helpers share the caller's transaction. File content, chats, reactions
// and membership must disappear together or not at all (including on old DBs).
async fn delete_workspace_tx(tx: &mut Transaction<'_, Sqlite>, id: i64) -> Result<Vec<String>> {
    let docs: Vec<(String,)> = sqlx::query_as("SELECT doc_id FROM file WHERE workspace_id = $1")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM file_blob WHERE file_id IN (SELECT id FROM file WHERE workspace_id = $1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM document WHERE id IN (SELECT doc_id FROM file WHERE workspace_id = $1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM file WHERE workspace_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE message SET workspace_id = NULL WHERE workspace_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM workspace WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    Ok(docs.into_iter().map(|(id,)| id).collect())
}

async fn delete_group_tx(tx: &mut Transaction<'_, Sqlite>, id: i64) -> Result<Vec<String>> {
    let workspaces: Vec<(i64,)> =
        sqlx::query_as("SELECT id FROM workspace WHERE group_id = $1")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let mut docs = Vec::new();
    for (ws_id,) in workspaces {
        docs.extend(delete_workspace_tx(tx, ws_id).await?);
    }
    sqlx::query("DELETE FROM reaction WHERE kind = 'ws' AND msg_id IN (SELECT id FROM message WHERE group_id = $1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM message WHERE group_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM group_member WHERE group_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM groups WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    Ok(docs)
}

impl Database {
    /// Construct a new database, creating the file and running migrations.
    pub async fn new(uri: &str) -> Result<Self> {
        // The migrator and *every* pooled connection need the same pragmas.
        // WAL allows readers to continue during edits; foreign keys stay ON
        // (SQLx's default). Only use WAL on a local disk, not a network share.
        let options = SqliteConnectOptions::from_str(uri)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(10));
        // Migrate through the same pool that will serve requests. Opening a
        // second WAL-enabled connection while the migrator's worker is still
        // closing can yield SQLITE_BUSY on fresh databases (notably in tests).
        // SQLx 0.6 starts transactions DEFERRED. With multiple pooled
        // connections, a read-then-write (rename/delete/import) can fail
        // immediately with SQLITE_BUSY_SNAPSHOT despite busy_timeout. One
        // writer/reader connection serializes in-process operations; WAL
        // still lets external backup readers coexist with the application.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(Database {
            pool,
            maintenance_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    // ----- Documents (OT content) -----

    /// Load the text of a document from the database.
    pub async fn load(&self, document_id: &str) -> Result<PersistedDocument> {
        sqlx::query_as(r#"SELECT text, language FROM document WHERE id = $1"#)
            .bind(document_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Write text directly, bypassing OT. Never recreate a deleted document:
    /// the file must still exist, and creation seeds the row in the same tx.
    pub async fn store_document_text(&self, document_id: &str, text: &str) -> Result<()> {
        let result = sqlx::query(
            r#"UPDATE document SET text = $2 WHERE id = $1
               AND EXISTS (SELECT 1 FROM file WHERE doc_id = $1 AND kind = 'text')"#,
        )
        .bind(document_id)
        .bind(text)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!("text document no longer exists");
        }
        Ok(())
    }

    /// Persist a live OT snapshot. An UPDATE (not an upsert) prevents a stale
    /// persister from resurrecting a file after a concurrent hard delete.
    pub async fn store(&self, document_id: &str, document: &PersistedDocument) -> Result<()> {
        let result = sqlx::query(
            r#"UPDATE document SET text = $2, language = $3 WHERE id = $1
               AND EXISTS (SELECT 1 FROM file WHERE doc_id = $1 AND kind = 'text')"#,
        )
        .bind(document_id)
        .bind(&document.text)
        .bind(&document.language)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!("text document no longer exists");
        }
        Ok(())
    }

    /// Count the number of documents in the database.
    pub async fn count(&self) -> Result<usize> {
        let row: (i64,) = sqlx::query_as("SELECT count(*) FROM document")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0 as usize)
    }

    // ----- Users / auth -----

    /// Insert a user if the email doesn't already exist. Returns true if inserted.
    pub async fn create_user_if_absent(
        &self,
        email: &str,
        name: &str,
        password_hash: &str,
        role: &str,
        org_id: Option<i64>,
    ) -> Result<bool> {
        let result = sqlx::query(
            r#"INSERT INTO users (email, name, password_hash, role, org_id)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT(email) DO NOTHING"#,
        )
        .bind(email)
        .bind(name)
        .bind(password_hash)
        .bind(role)
        .bind(org_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Number of user accounts. Used to decide the first-run owner bootstrap.
    pub async fn count_users(&self) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM users")
            .fetch_one(&self.pool)
            .await?;
        Ok(n)
    }

    /// Look up a user by email for login.
    pub async fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        sqlx::query_as(
            r#"SELECT id, email, name, password_hash, role, org_id, totp_secret, totp_enabled FROM users WHERE email = $1"#,
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Update a user's display name.
    pub async fn update_name(&self, user_id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Change a user's login username (the `email` column). Returns Ok(false) if
    /// the username is already taken by someone else (the column is UNIQUE).
    pub async fn update_email(&self, user_id: i64, email: &str) -> Result<bool> {
        let taken: Option<(i64,)> =
            sqlx::query_as(r#"SELECT id FROM users WHERE email = $1 AND id <> $2"#)
                .bind(email)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        if taken.is_some() {
            return Ok(false);
        }
        sqlx::query(r#"UPDATE users SET email = $1 WHERE id = $2"#)
            .bind(email)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(true)
    }

    /// Update a user's password hash.
    pub async fn update_password(&self, user_id: i64, password_hash: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET password_hash = $1 WHERE id = $2"#)
            .bind(password_hash)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Store a pending TOTP secret (enrollment started but not yet confirmed).
    pub async fn set_totp_pending(&self, user_id: i64, secret: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET totp_secret = $1, totp_enabled = 0 WHERE id = $2"#)
            .bind(secret)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Flip TOTP on after the first code is verified.
    pub async fn enable_totp(&self, user_id: i64) -> Result<()> {
        sqlx::query(r#"UPDATE users SET totp_enabled = 1 WHERE id = $1"#)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove TOTP entirely (user turn-off, or owner recovery / break-glass reset).
    pub async fn clear_totp(&self, user_id: i64) -> Result<()> {
        sqlx::query(r#"UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = $1"#)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Clear TOTP for every root/owner account. Host-level break-glass on boot.
    pub async fn clear_totp_for_roots(&self) -> Result<u64> {
        let r = sqlx::query(
            r#"UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE role = 'root'"#,
        )
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Create a session row.
    pub async fn create_session(&self, token: &str, user_id: i64, expires_at: i64) -> Result<()> {
        sqlx::query(r#"INSERT INTO session (token, user_id, expires_at) VALUES ($1, $2, $3)"#)
            .bind(token)
            .bind(user_id)
            .bind(expires_at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Resolve a session token to its user, only if the session is unexpired.
    pub async fn get_session_user(&self, token: &str, now: i64) -> Result<Option<User>> {
        sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.password_hash, u.role, u.org_id, u.totp_secret, u.totp_enabled
               FROM session s JOIN users u ON u.id = s.user_id
               WHERE s.token = $1 AND s.expires_at > $2"#,
        )
        .bind(token)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Delete all expired sessions (housekeeping, run on login).
    pub async fn purge_expired_sessions(&self, now: i64) -> Result<()> {
        sqlx::query(r#"DELETE FROM session WHERE expires_at <= $1"#)
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a session (logout).
    pub async fn delete_session(&self, token: &str) -> Result<()> {
        sqlx::query(r#"DELETE FROM session WHERE token = $1"#)
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ----- Root admin: users -----

    /// List all non-root users, with their org name.
    pub async fn admin_list_users(&self) -> Result<Vec<AdminUser>> {
        sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.role, u.org_id, o.name AS org_name
               FROM users u LEFT JOIN org o ON o.id = u.org_id
               WHERE u.role != 'root' ORDER BY u.email"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// List only the members of the admin's own org; never include root.
    pub async fn admin_list_users_in_org(&self, org_id: i64) -> Result<Vec<AdminUser>> {
        Ok(sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.role, u.org_id, o.name AS org_name
               FROM users u JOIN org o ON o.id = u.org_id
               WHERE u.org_id = $1 AND u.role != 'root' ORDER BY u.email"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Fetch a target for an authorization decision (never expose its hash).
    pub async fn admin_target(&self, id: i64) -> Result<Option<User>> {
        Ok(sqlx::query_as(
            "SELECT id, email, name, password_hash, role, org_id, totp_secret, totp_enabled FROM users WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// One scoped update: no partially-applied name/role/org changes. A scope
    /// is required for org admins; SQL checks it at write time, not only in
    /// the handler, to prevent an admin racing an owner reassigning the user.
    pub async fn admin_update_user(
        &self,
        id: i64,
        email: Option<&str>,
        name: Option<&str>,
        role: Option<&str>,
        new_org: Option<Option<i64>>,
        scope: Option<i64>,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let r = sqlx::query(
            "UPDATE users SET email = COALESCE($1, email), name = COALESCE($2, name), role = COALESCE($3, role), \
             org_id = CASE WHEN $4 THEN $5 ELSE org_id END \
             WHERE id = $6 AND role != 'root' AND ($7 IS NULL OR org_id = $7)",
        )
        .bind(email)
        .bind(name)
        .bind(role)
        .bind(new_org.is_some())
        .bind(new_org.flatten())
        .bind(id)
        .bind(scope)
        .execute(&mut tx)
        .await?;
        if r.rows_affected() == 0 { return Ok(false); }
        // Reauth after permission changes (name-only edits keep sessions).
        if email.is_some() || role.is_some() || new_org.is_some() {
            sqlx::query("DELETE FROM session WHERE user_id = $1")
                .bind(id).execute(&mut tx).await?;
        }
        // Immediately drop memberships from an org the user just left.
        if new_org.is_some() {
            sqlx::query("DELETE FROM group_member WHERE user_id = $1 AND group_id IN (SELECT id FROM groups WHERE org_id != (SELECT org_id FROM users WHERE id = $1) OR (SELECT org_id FROM users WHERE id = $1) IS NULL)")
                .bind(id).execute(&mut tx).await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Reset a non-owner password/2FA and revoke all sessions in one
    /// transaction. Scoped writes also guard against cross-org races.
    pub async fn admin_reset_credentials(
        &self,
        id: i64,
        password_hash: Option<&str>,
        scope: Option<i64>,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let r = if let Some(hash) = password_hash {
            sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2 AND role != 'root' AND ($3 IS NULL OR org_id = $3)")
                .bind(hash).bind(id).bind(scope).execute(&mut tx).await?
        } else {
            sqlx::query("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = $1 AND role != 'root' AND ($2 IS NULL OR org_id = $2)")
                .bind(id).bind(scope).execute(&mut tx).await?
        };
        if r.rows_affected() == 0 { return Ok(false); }
        sqlx::query("DELETE FROM session WHERE user_id = $1")
            .bind(id).execute(&mut tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// All collaborative docs in one org, for closing existing sockets when
    /// an org member is removed, reassigned or changes privilege.
    pub async fn org_doc_ids(&self, org_id: i64) -> Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT f.doc_id FROM file f JOIN workspace w ON w.id = f.workspace_id JOIN groups g ON g.id = w.group_id WHERE g.org_id = $1 AND f.kind = 'text'",
        )
        .bind(org_id).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Delete a non-owner account without leaving FK references or unreachable
    /// personal files. Shared groups/workspaces keep their data and get the
    /// root owner as their custodian; their chat/DM history by this user is
    /// erased. Return deleted personal document IDs for live eviction.
    pub async fn admin_delete_user(&self, id: i64, scope: Option<i64>) -> Result<Vec<String>> {
        let mut tx = self.pool.begin().await?;
        let target: Option<(String, Option<i64>)> =
            sqlx::query_as("SELECT role, org_id FROM users WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut tx)
                .await?;
        match target.as_ref() {
            Some((role, _)) if role == "root" => bail!("owner accounts cannot be deleted"),
            Some((_, org_id)) if scope.is_some() && *org_id != scope => bail!("user is outside this org"),
            None => bail!("user not found"),
            _ => {}
        }
        let (root,): (i64,) = sqlx::query_as(
            "SELECT id FROM users WHERE role = 'root' ORDER BY id LIMIT 1",
        )
        .fetch_one(&mut tx)
        .await?;
        let personal: Vec<(i64,)> = sqlx::query_as(
            "SELECT id FROM groups WHERE created_by = $1 AND scope = 'personal'",
        )
        .bind(id)
        .fetch_all(&mut tx)
        .await?;
        let mut docs = Vec::new();
        for (group_id,) in personal {
            docs.extend(delete_group_tx(&mut tx, group_id).await?);
        }
        sqlx::query("UPDATE groups SET created_by = $1 WHERE created_by = $2")
            .bind(root)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("UPDATE workspace SET created_by = $1 WHERE created_by = $2")
            .bind(root)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM group_member WHERE user_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM reaction WHERE user_id = $1 OR (kind = 'ws' AND msg_id IN (SELECT id FROM message WHERE user_id = $1)) OR (kind = 'dm' AND msg_id IN (SELECT id FROM dm WHERE sender_id = $1 OR recipient_id = $1))")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM message WHERE user_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM dm WHERE sender_id = $1 OR recipient_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM audit WHERE user_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM session WHERE user_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(docs)
    }

    // ----- Orgs -----

    /// Create an org.
    pub async fn create_org(&self, name: &str, slug: &str, now: i64) -> Result<Org> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO org (name, slug, created_at) VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(slug)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(Org {
            id: row.0,
            name: name.to_string(),
            slug: slug.to_string(),
        })
    }

    /// List all orgs with member and workspace counts.
    pub async fn list_orgs(&self) -> Result<Vec<AdminOrg>> {
        sqlx::query_as(
            r#"SELECT o.id, o.name, o.slug,
                      (SELECT count(*) FROM users u WHERE u.org_id = o.id) AS members,
                      (SELECT count(*) FROM workspace w JOIN groups g ON g.id = w.group_id WHERE g.org_id = o.id) AS workspaces
               FROM org o ORDER BY o.name"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch an org by id.
    pub async fn get_org(&self, id: i64) -> Result<Option<Org>> {
        sqlx::query_as(r#"SELECT id, name, slug FROM org WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Rename an org.
    pub async fn rename_org(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE org SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove all org data and unassign its users in one transaction. Returns
    /// document IDs so no WebSocket can keep writing after the deletion.
    pub async fn delete_org(&self, id: i64) -> Result<Vec<String>> {
        let mut tx = self.pool.begin().await?;
        let groups: Vec<(i64,)> = sqlx::query_as("SELECT id FROM groups WHERE org_id = $1")
            .bind(id)
            .fetch_all(&mut tx)
            .await?;
        let mut docs = Vec::new();
        for (group_id,) in groups {
            docs.extend(delete_group_tx(&mut tx, group_id).await?);
        }
        // Old org-wide chat rows (group_id IS NULL) still exist on upgraded DBs.
        sqlx::query("DELETE FROM reaction WHERE kind = 'ws' AND msg_id IN (SELECT id FROM message WHERE org_id = $1)")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM message WHERE org_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM reaction WHERE kind = 'dm' AND msg_id IN (SELECT id FROM dm WHERE org_id = $1)")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM dm WHERE org_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM chat_image WHERE org_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM audit WHERE org_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query("UPDATE users SET org_id = NULL WHERE org_id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        let r = sqlx::query("DELETE FROM org WHERE id = $1")
            .bind(id)
            .execute(&mut tx)
            .await?;
        if r.rows_affected() != 1 {
            bail!("org not found");
        }
        tx.commit().await?;
        Ok(docs)
    }

    /// List the members (non-root users) of an org.
    pub async fn list_org_members(&self, org_id: i64) -> Result<Vec<Member>> {
        sqlx::query_as(
            r#"SELECT id, email, name, role FROM users
               WHERE org_id = $1 AND role != 'root' ORDER BY email"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    // ----- Groups (the people + conversation hub) -----

    /// Create a group in an org with a visibility scope
    /// ("org" | "group" | "personal"). For "group" the creator is added as
    /// a member (owner) so they can see it immediately.
    pub async fn create_group(
        &self,
        org_id: i64,
        name: &str,
        created_by: i64,
        now: i64,
        scope: &str,
    ) -> Result<Group> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO groups (org_id, name, scope, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        )
        .bind(org_id)
        .bind(name)
        .bind(scope)
        .bind(created_by)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        if scope == "group" {
            let _ = self.add_group_member(row.0, created_by, "owner").await;
        }
        Ok(Group {
            id: row.0,
            org_id,
            name: name.to_string(),
            scope: scope.to_string(),
            created_by,
        })
    }

    /// List the groups in an org (used by the root owner, who bypasses scoping).
    pub async fn list_groups(&self, org_id: i64) -> Result<Vec<Group>> {
        sqlx::query_as(
            r#"SELECT id, org_id, name, scope, created_by FROM groups WHERE org_id = $1 ORDER BY name"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// List the groups in an org that a regular member may see: every org-wide
    /// group, their own personal groups, and every group they belong to.
    pub async fn list_groups_for_user(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<Vec<Group>> {
        sqlx::query_as(
            r#"SELECT g.id, g.org_id, g.name, g.scope, g.created_by
               FROM groups g
               WHERE g.org_id = $1
                 AND (g.scope = 'org'
                      OR (g.scope = 'personal' AND g.created_by = $2)
                      OR (g.scope = 'group' AND EXISTS (
                          SELECT 1 FROM group_member m
                          WHERE m.group_id = g.id AND m.user_id = $2)))
               ORDER BY g.name"#,
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a group by id.
    pub async fn get_group(&self, id: i64) -> Result<Option<Group>> {
        sqlx::query_as(
            r#"SELECT id, org_id, name, scope, created_by FROM groups WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Add a member to a group (no-op when already a member).
    pub async fn add_group_member(&self, group_id: i64, user_id: i64, role: &str) -> Result<()> {
        sqlx::query(
            r#"INSERT OR IGNORE INTO group_member (group_id, user_id, role)
               VALUES ($1, $2, $3)"#,
        )
        .bind(group_id)
        .bind(user_id)
        .bind(role)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove a member from a group.
    pub async fn remove_group_member(&self, group_id: i64, user_id: i64) -> Result<()> {
        sqlx::query(
            r#"DELETE FROM group_member WHERE group_id = $1 AND user_id = $2"#,
        )
        .bind(group_id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// True when the user is a member of the group (group scope).
    pub async fn is_group_member(&self, group_id: i64, user_id: i64) -> Result<bool> {
        let row: (i64,) = sqlx::query_as(
            r#"SELECT count(*) FROM group_member WHERE group_id = $1 AND user_id = $2"#,
        )
        .bind(group_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0 > 0)
    }

    /// Member user-ids of a group (empty for other scopes).
    pub async fn group_member_ids(&self, group_id: i64) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            r#"SELECT user_id FROM group_member WHERE group_id = $1 ORDER BY user_id"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    /// Rename a group.
    pub async fn rename_group(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE groups SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Hard-delete a group and its contents. Return doc IDs for live eviction.
    pub async fn delete_group(&self, id: i64) -> Result<Vec<String>> {
        let mut tx = self.pool.begin().await?;
        let docs = delete_group_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(docs)
    }

    /// The org that owns a group, if it exists.
    pub async fn group_org(&self, group_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(r#"SELECT org_id FROM groups WHERE id = $1"#)
            .bind(group_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.0))
    }

    // ----- Workspaces (file projects inside a group) -----

    /// Create a workspace inside a group, with a slug unique within that group.
    pub async fn create_workspace(
        &self,
        group_id: i64,
        name: &str,
        created_by: i64,
        now: i64,
    ) -> Result<Workspace> {
        let base = slugify(name);
        let mut slug = base.clone();
        let mut n = 2;
        while self.slug_taken(group_id, &slug).await? {
            slug = format!("{base}-{n}");
            n += 1;
        }
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO workspace (group_id, name, slug, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        )
        .bind(group_id)
        .bind(name)
        .bind(&slug)
        .bind(created_by)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(Workspace {
            id: row.0,
            group_id,
            name: name.to_string(),
            slug,
            created_by,
        })
    }

    async fn slug_taken(&self, group_id: i64, slug: &str) -> Result<bool> {
        let row: (i64,) =
            sqlx::query_as(r#"SELECT count(*) FROM workspace WHERE group_id = $1 AND slug = $2"#)
                .bind(group_id)
                .bind(slug)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.0 > 0)
    }

    /// List the workspaces inside a group.
    pub async fn list_workspaces(&self, group_id: i64) -> Result<Vec<Workspace>> {
        sqlx::query_as(
            r#"SELECT id, group_id, name, slug, created_by FROM workspace WHERE group_id = $1 ORDER BY name"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a workspace by id.
    pub async fn get_workspace(&self, id: i64) -> Result<Option<Workspace>> {
        sqlx::query_as(
            r#"SELECT id, group_id, name, slug, created_by FROM workspace WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Rename a workspace.
    pub async fn rename_workspace(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE workspace SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Hard-delete a workspace and return doc IDs for live eviction.
    pub async fn delete_workspace(&self, id: i64) -> Result<Vec<String>> {
        let mut tx = self.pool.begin().await?;
        let docs = delete_workspace_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(docs)
    }

    /// Move all source files into the target and remove the empty source
    /// workspace in one transaction. Preserve file/document IDs (and blobs),
    /// auto-rename conflicts rather than overwriting target data.
    pub async fn merge_workspaces(&self, source: i64, target: i64) -> Result<(usize, Vec<String>)> {
        if source == target {
            bail!("cannot merge a workspace with itself");
        }
        let mut tx = self.pool.begin().await?;
        let source_files: Vec<(i64, String, String)> =
            sqlx::query_as("SELECT id, path, doc_id FROM file WHERE workspace_id = $1 ORDER BY path")
                .bind(source)
                .fetch_all(&mut tx)
                .await?;
        let target_paths: Vec<(String,)> =
            sqlx::query_as("SELECT path FROM file WHERE workspace_id = $1")
                .bind(target)
                .fetch_all(&mut tx)
                .await?;
        let mut occupied: HashSet<String> = target_paths.into_iter().map(|(p,)| p).collect();
        let mut docs = Vec::with_capacity(source_files.len());
        let mut folders = HashMap::new();
        for (id, path, doc_id) in &source_files {
            let final_path = available_tree_path(&occupied, path, &mut folders)?;
            if final_path.len() > 512 {
                bail!("destination path is too long");
            }
            sqlx::query("UPDATE file SET workspace_id = $1, path = $2 WHERE id = $3")
                .bind(target)
                .bind(&final_path)
                .bind(id)
                .execute(&mut tx)
                .await?;
            occupied.insert(final_path);
            docs.push(doc_id.clone());
        }
        // Only delete the emptied workspace row, not its moved files.
        sqlx::query("UPDATE message SET workspace_id = NULL WHERE workspace_id = $1")
            .bind(source)
            .execute(&mut tx)
            .await?;
        let deleted = sqlx::query("DELETE FROM workspace WHERE id = $1")
            .bind(source)
            .execute(&mut tx)
            .await?;
        if deleted.rows_affected() != 1 {
            bail!("source workspace not found");
        }
        tx.commit().await?;
        Ok((source_files.len(), docs))
    }

    /// Reparent a workspace inside a different group without changing any
    /// file IDs. Ensure the slug stays unique within its new group.
    pub async fn move_workspace_to_group(&self, ws: &Workspace, group_id: i64) -> Result<Workspace> {
        let mut tx = self.pool.begin().await?;
        let existing: Vec<(String,)> =
            sqlx::query_as("SELECT slug FROM workspace WHERE group_id = $1 AND id != $2")
                .bind(group_id)
                .bind(ws.id)
                .fetch_all(&mut tx)
                .await?;
        let taken: HashSet<String> = existing.into_iter().map(|(slug,)| slug).collect();
        let base = slugify(&ws.name);
        let mut slug = base.clone();
        let mut n = 2;
        while taken.contains(&slug) {
            slug = format!("{base}-{n}");
            n += 1;
        }
        sqlx::query("UPDATE workspace SET group_id = $1, slug = $2 WHERE id = $3")
            .bind(group_id)
            .bind(&slug)
            .bind(ws.id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(Workspace {
            id: ws.id,
            group_id,
            name: ws.name.clone(),
            slug,
            created_by: ws.created_by,
        })
    }

    /// File IDs under one workspace, for disconnecting board relays.
    pub async fn workspace_file_ids(&self, ws_id: i64) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT id FROM file WHERE workspace_id = $1")
            .bind(ws_id).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// File IDs under one group, for disconnecting board relays.
    pub async fn group_file_ids(&self, group_id: i64) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT f.id FROM file f JOIN workspace w ON w.id = f.workspace_id WHERE w.group_id = $1",
        )
        .bind(group_id).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Text document IDs under one group for revoking prior membership.
    pub async fn group_doc_ids(&self, group_id: i64) -> Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT f.doc_id FROM file f JOIN workspace w ON w.id = f.workspace_id WHERE w.group_id = $1 AND f.kind = 'text'",
        )
        .bind(group_id).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// All document IDs in a workspace (used to revoke sockets after a move).
    pub async fn workspace_doc_ids(&self, ws_id: i64) -> Result<Vec<String>> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT doc_id FROM file WHERE workspace_id = $1")
                .bind(ws_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// The org that owns the group containing a workspace, if it exists.
    pub async fn workspace_org(&self, workspace_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT g.org_id FROM workspace w JOIN groups g ON g.id = w.group_id
               WHERE w.id = $1"#,
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The group that owns a workspace, if it exists.
    pub async fn workspace_group(&self, workspace_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(r#"SELECT group_id FROM workspace WHERE id = $1"#)
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.0))
    }    /// The org that owns the group containing the workspace of a file, if any.
    pub async fn file_org(&self, file_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT g.org_id FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.id = $1"#,
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The org that owns the group containing the workspace of a document.
    pub async fn doc_org(&self, doc_id: &str) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT g.org_id FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.doc_id = $1"#,
        )
        .bind(doc_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The group, org, visibility scope and creator of the group that owns
    /// the workspace of a document — used for the layered access check on the
    /// collaborative socket. Returns (group_id, org_id, scope, created_by).
    #[allow(clippy::type_complexity)]
    pub async fn doc_ws_info(
        &self,
        doc_id: &str,

    ) -> Result<Option<(i64, i64, String, i64)>> {
        let row: Option<(i64, i64, String, i64)> = sqlx::query_as(
            r#"SELECT g.id, g.org_id, g.scope, g.created_by
               FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.doc_id = $1 AND f.kind = 'text'"#,
        )
        .bind(doc_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// The group, org, visibility scope and creator for a file's workspace.
    #[allow(clippy::type_complexity)]
    pub async fn file_ws_info(
        &self,
        file_id: i64,
    ) -> Result<Option<(i64, i64, String, i64)>> {
        let row: Option<(i64, i64, String, i64)> = sqlx::query_as(
            r#"SELECT g.id, g.org_id, g.scope, g.created_by
               FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.id = $1"#,
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    // ----- Files -----

    /// Create an empty collaborative text file. Document and file are inserted
    /// atomically so no editor can observe an unseeded document.
    pub async fn create_file(
        &self,
        workspace_id: i64,
        path: &str,
        doc_id: &str,
        kind: &str,
        mime: Option<&str>,
        now: i64,
    ) -> Result<FileRow> {
        self.insert_file(workspace_id, path, doc_id, kind, mime, None, None, now)
            .await
    }

    /// Create an upload in one transaction. A failed blob/document write must
    /// not leave a file row blocking the next upload of the same name.
    pub async fn create_uploaded_file(
        &self,
        workspace_id: i64,
        path: &str,
        doc_id: &str,
        mime: Option<&str>,
        text: Option<&str>,
        bytes: &[u8],
        now: i64,
    ) -> Result<FileRow> {
        let kind = if text.is_some() { "text" } else { "binary" };
        self.insert_file(workspace_id, path, doc_id, kind, mime, text, Some(bytes), now)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_file(
        &self,
        workspace_id: i64,
        path: &str,
        doc_id: &str,
        kind: &str,
        mime: Option<&str>,
        text: Option<&str>,
        bytes: Option<&[u8]>,
        now: i64,
    ) -> Result<FileRow> {
        let mut tx = self.pool.begin().await?;
        let existing: Vec<(String,)> =
            sqlx::query_as("SELECT path FROM file WHERE workspace_id = $1")
                .bind(workspace_id)
                .fetch_all(&mut tx)
                .await?;
        if existing.iter().any(|(p,)| paths_overlap(p, path)) {
            bail!("a file or folder already exists at that path");
        }
        let (id,): (i64,) = sqlx::query_as(
            r#"INSERT INTO file (workspace_id, path, doc_id, kind, mime, created_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
        )
        .bind(workspace_id)
        .bind(path)
        .bind(doc_id)
        .bind(kind)
        .bind(mime)
        .bind(now)
        .fetch_one(&mut tx)
        .await?;
        if kind == "text" {
            sqlx::query("INSERT INTO document (id, text, language) VALUES ($1, $2, NULL)")
                .bind(doc_id)
                .bind(text.unwrap_or(""))
                .execute(&mut tx)
                .await?;
        } else if let Some(bytes) = bytes {
            sqlx::query("INSERT INTO file_blob (file_id, data) VALUES ($1, $2)")
                .bind(id)
                .bind(bytes)
                .execute(&mut tx)
                .await?;
        }
        tx.commit().await?;
        Ok(FileRow {
            id,
            workspace_id,
            path: path.to_string(),
            doc_id: doc_id.to_string(),
            kind: kind.to_string(),
            mime: mime.map(str::to_string),
            size: bytes.map(|b| b.len() as i64).unwrap_or(0),
        })
    }

    /// Import a validated ZIP as a single unit. Collisions get a numbered
    /// suffix; any missing content/invalid parent leaves the DB untouched.
    pub async fn import_files(
        &self,
        workspace_id: i64,
        files: &[ImportedFile],
        now: i64,
    ) -> Result<Vec<FileRow>> {
        let mut tx = self.pool.begin().await?;
        let paths: Vec<(String,)> =
            sqlx::query_as("SELECT path FROM file WHERE workspace_id = $1")
                .bind(workspace_id)
                .fetch_all(&mut tx)
                .await?;
        let mut occupied: HashSet<String> = paths.into_iter().map(|(p,)| p).collect();
        let mut added = Vec::with_capacity(files.len());
        let mut folders = HashMap::new();
        for entry in files {
            if let Some(dir) = entry.path.strip_suffix("/.keep") {
                // Existing content already creates the folder implicitly.
                if occupied.iter().any(|p| p.starts_with(&format!("{dir}/"))) {
                    continue;
                }
            }
            let path = available_tree_path(&occupied, &entry.path, &mut folders)?;
            if path.len() > 512 {
                bail!("import path is too long");
            }
            let doc_id = random_id();
            let kind = if entry.is_text { "text" } else { "binary" };
            let (id,): (i64,) = sqlx::query_as(
                "INSERT INTO file (workspace_id, path, doc_id, kind, mime, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            )
            .bind(workspace_id)
            .bind(&path)
            .bind(&doc_id)
            .bind(kind)
            .bind(&entry.mime)
            .bind(now)
            .fetch_one(&mut tx)
            .await?;
            if entry.is_text {
                sqlx::query("INSERT INTO document (id, text, language) VALUES ($1, $2, NULL)")
                    .bind(&doc_id)
                    .bind(std::str::from_utf8(&entry.bytes)?)
                    .execute(&mut tx)
                    .await?;
            } else {
                sqlx::query("INSERT INTO file_blob (file_id, data) VALUES ($1, $2)")
                    .bind(id)
                    .bind(&entry.bytes)
                    .execute(&mut tx)
                    .await?;
            }
            occupied.insert(path.clone());
            added.push(FileRow {
                id,
                workspace_id,
                path,
                doc_id,
                kind: kind.into(),
                mime: entry.mime.clone(),
                size: entry.bytes.len() as i64,
            });
        }
        tx.commit().await?;
        Ok(added)
    }

    /// List files in a workspace, ordered by path.
    pub async fn list_files(&self, workspace_id: i64) -> Result<Vec<FileRow>> {
        sqlx::query_as(
            r#"SELECT f.id, f.workspace_id, f.path, f.doc_id, f.kind, f.mime,
                      COALESCE((SELECT LENGTH(fb.data) FROM file_blob fb WHERE fb.file_id = f.id),
                               (SELECT LENGTH(CAST(d.text AS BLOB)) FROM document d WHERE d.id = f.doc_id), 0) AS size
               FROM file f
               WHERE f.workspace_id = $1 ORDER BY f.path"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a file by id.
    pub async fn get_file(&self, id: i64) -> Result<Option<FileRow>> {
        sqlx::query_as(
            r#"SELECT f.id, f.workspace_id, f.path, f.doc_id, f.kind, f.mime,
                      COALESCE((SELECT LENGTH(fb.data) FROM file_blob fb WHERE fb.file_id = f.id),
                               (SELECT LENGTH(CAST(d.text AS BLOB)) FROM document d WHERE d.id = f.doc_id), 0) AS size
               FROM file f WHERE f.id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Rename a file without silently creating a file/directory collision.
    pub async fn rename_file(&self, id: i64, path: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let row: (i64,) = sqlx::query_as("SELECT workspace_id FROM file WHERE id = $1")
            .bind(id)
            .fetch_one(&mut tx)
            .await?;
        let existing: Vec<(String,)> = sqlx::query_as(
            "SELECT path FROM file WHERE workspace_id = $1 AND id != $2",
        )
        .bind(row.0)
        .bind(id)
        .fetch_all(&mut tx)
        .await?;
        if existing.iter().any(|(p,)| paths_overlap(p, path)) {
            bail!("a file or folder already exists at that path");
        }
        sqlx::query("UPDATE file SET path = $1 WHERE id = $2")
            .bind(path)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Transactional file/folder transfer. Paths are explicit so the client
    /// can move a whole folder in one request. Source IDs, target workspace and
    /// desired paths are pre-authorized by the HTTP handler. A copy gets fresh
    /// file/document IDs and exact blob bytes; a move preserves IDs. No partial
    /// results when any input, content or destination conflicts.
    pub async fn transfer_files(
        &self,
        target_workspace: i64,
        items: &[(i64, String)],
        copy: bool,
        rename_conflicts: bool,
        snapshots: &HashMap<String, PersistedDocument>,
        now: i64,
    ) -> Result<Vec<FileRow>> {
        if items.is_empty() || items.len() > 1000 {
            bail!("select 1–1000 files");
        }
        let mut tx = self.pool.begin().await?;
        let mut seen = HashSet::new();
        let mut sources = Vec::with_capacity(items.len());
        for (id, path) in items {
            if !seen.insert(*id) || path.is_empty() || path.len() > 512 {
                bail!("invalid transfer item");
            }
            let file: Option<FileRow> = sqlx::query_as(
                r#"SELECT f.id, f.workspace_id, f.path, f.doc_id, f.kind, f.mime,
                         COALESCE((SELECT LENGTH(fb.data) FROM file_blob fb WHERE fb.file_id = f.id),
                                  (SELECT LENGTH(CAST(d.text AS BLOB)) FROM document d WHERE d.id = f.doc_id), 0) AS size
                   FROM file f WHERE f.id = $1"#,
            )
            .bind(id)
            .fetch_optional(&mut tx)
            .await?;
            sources.push(file.ok_or_else(|| anyhow::anyhow!("source file not found"))?);
        }
        let dest_rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, path FROM file WHERE workspace_id = $1")
                .bind(target_workspace)
                .fetch_all(&mut tx)
                .await?;
        let moving_here: HashSet<i64> = if copy {
            HashSet::new()
        } else {
            sources.iter().filter(|f| f.workspace_id == target_workspace)
                .map(|f| f.id).collect()
        };
        let mut occupied: HashSet<String> = dest_rows.iter()
            .filter(|(id, _)| !moving_here.contains(id))
            .map(|(_, path)| path.clone())
            .collect();
        let mut destinations = Vec::with_capacity(items.len());
        let mut folders = HashMap::new();
        for (_, requested) in items {
            let path = if rename_conflicts {
                available_tree_path(&occupied, requested, &mut folders)?
            } else {
                if occupied.iter().any(|p| paths_overlap(p, requested)) {
                    bail!("a file or folder already exists at the destination");
                }
                requested.to_string()
            };
            if path.len() > 512 {
                bail!("destination path is too long");
            }
            occupied.insert(path.clone());
            destinations.push(path);
        }

        if !copy {
            // Free ALL original paths first. A file/folder swap or two files
            // exchanging names should not fail the unique(workspace_id,path)
            // constraint halfway through the transaction.
            let mut reserved: HashSet<String> = dest_rows.into_iter().map(|(_, p)| p).collect();
            reserved.extend(destinations.iter().cloned());
            for src in &sources {
                if src.workspace_id == target_workspace {
                    let temp = loop {
                        let candidate = format!(".cortex-transfer-{}", random_id());
                        if !reserved.iter().any(|p| paths_overlap(p, &candidate)) {
                            break candidate;
                        }
                    };
                    reserved.insert(temp.clone());
                    sqlx::query("UPDATE file SET path = $1 WHERE id = $2")
                        .bind(temp)
                        .bind(src.id)
                        .execute(&mut tx)
                        .await?;
                }
            }
        }

        let mut result = Vec::with_capacity(items.len());
        for (mut src, path) in sources.into_iter().zip(destinations) {
            if copy {
                let doc_id = random_id();
                let (id,): (i64,) = sqlx::query_as(
                    "INSERT INTO file (workspace_id, path, doc_id, kind, mime, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
                )
                .bind(target_workspace)
                .bind(&path)
                .bind(&doc_id)
                .bind(&src.kind)
                .bind(&src.mime)
                .bind(now)
                .fetch_one(&mut tx)
                .await?;
                if src.kind == "text" {
                    let rows = if let Some(snapshot) = snapshots.get(&src.doc_id) {
                        src.size = snapshot.text.len() as i64;
                        sqlx::query("INSERT INTO document (id, text, language) VALUES ($1, $2, $3)")
                            .bind(&doc_id)
                            .bind(&snapshot.text)
                            .bind(&snapshot.language)
                            .execute(&mut tx)
                            .await?.rows_affected()
                    } else {
                        sqlx::query("INSERT INTO document (id, text, language) SELECT $1, text, language FROM document WHERE id = $2")
                            .bind(&doc_id)
                            .bind(&src.doc_id)
                            .execute(&mut tx)
                            .await?.rows_affected()
                    };
                    if rows != 1 { bail!("source text content missing"); }
                } else {
                    let rows = sqlx::query("INSERT INTO file_blob (file_id, data) SELECT $1, data FROM file_blob WHERE file_id = $2")
                        .bind(id)
                        .bind(src.id)
                        .execute(&mut tx)
                        .await?.rows_affected();
                    if rows != 1 { bail!("source blob content missing"); }
                }
                src.id = id;
                src.doc_id = doc_id;
            } else {
                sqlx::query("UPDATE file SET workspace_id = $1, path = $2 WHERE id = $3")
                    .bind(target_workspace)
                    .bind(&path)
                    .bind(src.id)
                    .execute(&mut tx)
                    .await?;
            }
            src.workspace_id = target_workspace;
            src.path = path;
            result.push(src);
        }
        tx.commit().await?;
        Ok(result)
    }

    /// Store raw bytes for a binary file.
    pub async fn store_blob(&self, file_id: i64, data: &[u8]) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO file_blob (file_id, data) VALUES ($1, $2)
               ON CONFLICT(file_id) DO UPDATE SET
                 data = excluded.data,
                 revision = file_blob.revision + 1"#,
        )
        .bind(file_id)
        .bind(data)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Replace a blob only if it still has the revision read by the client.
    pub async fn store_blob_at_revision(
        &self,
        file_id: i64,
        data: &[u8],
        expected_revision: i64,
    ) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"UPDATE file_blob
               SET data = $1, revision = revision + 1
               WHERE file_id = $2 AND revision = $3
               RETURNING revision"#,
        )
        .bind(data)
        .bind(file_id)
        .bind(expected_revision)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|result| result.0))
    }

    /// Load raw bytes for a binary file.
    pub async fn load_blob(&self, file_id: i64) -> Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as(r#"SELECT data FROM file_blob WHERE file_id = $1"#)
                .bind(file_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }

    /// Load a binary file's bytes together with its concurrency revision.
    pub async fn load_blob_with_revision(&self, file_id: i64) -> Result<Option<(Vec<u8>, i64)>> {
        Ok(
            sqlx::query_as(r#"SELECT data, revision FROM file_blob WHERE file_id = $1"#)
                .bind(file_id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    /// Hard-delete files and their content atomically. Returns their document
    /// IDs so the caller can close any live collaborative sessions immediately.
    /// Unknown IDs fail the entire batch instead of reporting false success.
    pub async fn delete_files(&self, ids: &[i64]) -> Result<Vec<String>> {
        let mut tx = self.pool.begin().await?;
        let mut docs = Vec::with_capacity(ids.len());
        let mut seen = HashSet::new();
        for &id in ids {
            if !seen.insert(id) {
                bail!("duplicate file id");
            }
            let row: Option<(String,)> =
                sqlx::query_as("SELECT doc_id FROM file WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&mut tx)
                    .await?;
            let (doc_id,) = row.ok_or_else(|| anyhow::anyhow!("file not found"))?;
            sqlx::query("DELETE FROM file_blob WHERE file_id = $1")
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query("DELETE FROM file WHERE id = $1")
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query("DELETE FROM document WHERE id = $1")
                .bind(&doc_id)
                .execute(&mut tx)
                .await?;
            docs.push(doc_id);
        }
        tx.commit().await?;
        Ok(docs)
    }

    /// Delete a single file, with the same all-or-nothing semantics as a batch.
    pub async fn delete_file(&self, id: i64) -> Result<String> {
        let docs = self.delete_files(&[id]).await?;
        Ok(docs.into_iter().next().expect("one requested file"))
    }

    /// Current SQLite database file size in bytes.
    pub async fn db_size_bytes(&self) -> Result<i64> {
        let (pages,): (i64,) = sqlx::query_as("PRAGMA page_count")
            .fetch_one(&self.pool)
            .await?;
        let (size,): (i64,) = sqlx::query_as("PRAGMA page_size")
            .fetch_one(&self.pool)
            .await?;
        Ok(pages * size)
    }

    /// Row count for a single table (table name is a fixed constant, never user input).
    pub async fn table_rows(&self, table: &str) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", table);
        let (n,): (i64,) = sqlx::query_as(&sql).fetch_one(&self.pool).await?;
        Ok(n)
    }

    /// Total bytes stored in binary blobs (uploaded files + pasted chat images).
    pub async fn blob_bytes(&self) -> Result<i64> {
        let (a,): (i64,) = sqlx::query_as("SELECT COALESCE(SUM(LENGTH(data)),0) FROM file_blob")
            .fetch_one(&self.pool)
            .await?;
        let (b,): (i64,) = sqlx::query_as("SELECT COALESCE(SUM(LENGTH(data)),0) FROM chat_image")
            .fetch_one(&self.pool)
            .await?;
        Ok(a + b)
    }

    /// Bytes in pages SQLite may reuse but the OS cannot reclaim until VACUUM.
    pub async fn free_bytes(&self) -> Result<i64> {
        let (pages,): (i64,) = sqlx::query_as("PRAGMA freelist_count")
            .fetch_one(&self.pool)
            .await?;
        let (size,): (i64,) = sqlx::query_as("PRAGMA page_size")
            .fetch_one(&self.pool)
            .await?;
        Ok(pages * size)
    }

    /// Daily in-app housekeeping. VACUUM is deliberately outside the tx: it
    /// temporarily needs additional disk space and an exclusive write lock.
    /// Avoid doing it for tiny files/short-lived free pages. Explicit owner
    /// requests force compaction regardless of the free-page threshold.
    pub async fn maintain(&self, now: i64, retention_days: i64, force: bool) -> Result<MaintenanceReport> {
        let _guard = self.maintenance_lock.lock().await;
        let db_bytes_before = self.db_size_bytes().await?;
        let mut tx = self.pool.begin().await?;
        let expired_sessions = sqlx::query("DELETE FROM session WHERE expires_at <= $1")
            .bind(now)
            .execute(&mut tx)
            .await?
            .rows_affected();
        let orphan_documents = sqlx::query(
            "DELETE FROM document WHERE NOT EXISTS (SELECT 1 FROM file WHERE file.doc_id = document.id AND file.kind = 'text')",
        )
        .execute(&mut tx)
        .await?
        .rows_affected();
        let orphan_blobs = sqlx::query(
            "DELETE FROM file_blob WHERE NOT EXISTS (SELECT 1 FROM file WHERE file.id = file_blob.file_id)",
        )
        .execute(&mut tx)
        .await?
        .rows_affected();
        let orphan_reactions = sqlx::query(
            "DELETE FROM reaction WHERE (kind = 'ws' AND NOT EXISTS (SELECT 1 FROM message WHERE message.id = reaction.msg_id)) OR (kind = 'dm' AND NOT EXISTS (SELECT 1 FROM dm WHERE dm.id = reaction.msg_id)) OR kind NOT IN ('ws', 'dm') OR NOT EXISTS (SELECT 1 FROM users WHERE users.id = reaction.user_id)",
        )
        .execute(&mut tx)
        .await?
        .rows_affected();
        // Give in-flight pasted images a week to be referenced by a message.
        // `instr` may keep a false-positive numeric prefix, never delete a
        // referenced image. Images for a deleted org are already removed there.
        let orphan_chat_images = sqlx::query(
            "DELETE FROM chat_image WHERE created_at < $1 AND NOT EXISTS (SELECT 1 FROM message WHERE message.org_id = chat_image.org_id AND instr(message.body, '/api/chat-image/' || chat_image.id) > 0) AND NOT EXISTS (SELECT 1 FROM dm WHERE dm.org_id = chat_image.org_id AND instr(dm.body, '/api/chat-image/' || chat_image.id) > 0)",
        )
        .bind(now - 7 * 86400)
        .execute(&mut tx)
        .await?
        .rows_affected();
        let pruned_audit = sqlx::query("DELETE FROM audit WHERE created_at < $1")
            .bind(now - retention_days.max(1) * 86400)
            .execute(&mut tx)
            .await?
            .rows_affected();
        tx.commit().await?;

        let free_bytes_before = self.free_bytes().await?;
        let vacuum_needed = force
            || free_bytes_before >= 16 * 1024 * 1024
                && free_bytes_before * 5 >= db_bytes_before;
        // PASSIVE checkpoint does not wait for readers; a full VACUUM only
        // starts if a TRUNCATE checkpoint obtains the lock. Neither can run in
        // the cleanup transaction above.
        let mode = if vacuum_needed { "TRUNCATE" } else { "PASSIVE" };
        let (checkpoint_busy, _, _): (i64, i64, i64) =
            sqlx::query_as(&format!("PRAGMA wal_checkpoint({mode})"))
                .fetch_one(&self.pool)
                .await?;
        let vacuumed = vacuum_needed && checkpoint_busy == 0;
        if vacuumed {
            sqlx::query("VACUUM").execute(&self.pool).await?;
            // VACUUM itself writes WAL pages; truncate those too when possible.
            let _: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
                .fetch_one(&self.pool)
                .await?;
        }
        sqlx::query("PRAGMA optimize").execute(&self.pool).await?;
        Ok(MaintenanceReport {
            db_bytes_before,
            db_bytes_after: self.db_size_bytes().await?,
            free_bytes_before,
            vacuumed,
            checkpoint_busy,
            expired_sessions,
            orphan_documents,
            orphan_blobs,
            orphan_reactions,
            orphan_chat_images,
            pruned_audit,
        })
    }

    // ----- Group chat -----

    /// Post a message to a group's chat (org_id derived from the group).
    pub async fn create_message(
        &self,
        group_id: i64,
        user_id: i64,
        body: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO message (group_id, org_id, user_id, body, created_at)
               VALUES ($1, (SELECT org_id FROM groups WHERE id = $1), $2, $3, $4)"#,
        )
        .bind(group_id)
        .bind(user_id)
        .bind(body)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The most recent messages in a group, oldest-first.
    pub async fn list_messages(&self, group_id: i64, limit: i64) -> Result<Vec<ChatMessage>> {
        let mut rows: Vec<ChatMessage> = sqlx::query_as(
            r#"SELECT m.id, m.body, u.name AS author, u.email AS email, m.created_at, m.edited_at
               FROM message m JOIN users u ON u.id = m.user_id
               WHERE m.group_id = $1 ORDER BY m.id DESC LIMIT $2"#,
        )
        .bind(group_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// The latest message in a group: (id, author id, body, created_at).
    pub async fn group_last_msg(
        &self,
        group_id: i64,
    ) -> Result<Option<(i64, i64, String, i64)>> {
        Ok(sqlx::query_as(
            r#"SELECT id, user_id, body, created_at FROM message
               WHERE group_id = $1 ORDER BY id DESC LIMIT 1"#,
        )
        .bind(group_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Count of group messages after `after` not sent by `me` (unread).
    pub async fn group_unread_count(&self, group_id: i64, me: i64, after: i64) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            r#"SELECT COUNT(*) FROM message WHERE group_id = $1 AND id > $2 AND user_id <> $3"#,
        )
        .bind(group_id)
        .bind(after)
        .bind(me)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    /// For each DM peer of `me`, the latest message: (peer, id, sender, body, created_at).
    pub async fn dm_overview(
        &self,
        org_id: i64,
        me: i64,
    ) -> Result<Vec<(i64, i64, i64, String, i64)>> {
        let rows: Vec<(i64, i64, i64, String, i64)> = sqlx::query_as(
            r#"SELECT
                 CASE WHEN d.sender_id = $2 THEN d.recipient_id ELSE d.sender_id END AS peer_id,
                 d.id AS last_id,
                 d.sender_id AS last_sender,
                 d.body AS body,
                 d.created_at AS created_at
               FROM dm d
               JOIN (
                 SELECT MAX(id) AS mid FROM dm
                 WHERE org_id = $1 AND (sender_id = $2 OR recipient_id = $2)
                 GROUP BY (CASE WHEN sender_id = $2 THEN recipient_id ELSE sender_id END)
               ) x ON d.id = x.mid"#,
        )
        .bind(org_id)
        .bind(me)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Count of DMs from `peer` to `me` after `after` (unread from that peer).
    pub async fn dm_unread_count(
        &self,
        org_id: i64,
        me: i64,
        peer: i64,
        after: i64,
    ) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            r#"SELECT COUNT(*) FROM dm
               WHERE org_id = $1 AND recipient_id = $2 AND sender_id = $3 AND id > $4"#,
        )
        .bind(org_id)
        .bind(me)
        .bind(peer)
        .bind(after)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    /// Edit a group-chat message's body — only the author may do so. Returns
    /// true if a row was actually changed (false = not yours / not found).
    pub async fn edit_message(&self, id: i64, user_id: i64, body: &str, now: i64) -> Result<bool> {
        let r = sqlx::query(
            r#"UPDATE message SET body = $1, edited_at = $2 WHERE id = $3 AND user_id = $4"#,
        )
        .bind(body)
        .bind(now)
        .bind(id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Delete a group-chat message (author or an authorized moderator).
    /// Reactions are removed in the same transaction.
    pub async fn delete_message(&self, id: i64, user_id: i64, moderator: bool) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let r = sqlx::query("DELETE FROM message WHERE id = $1 AND (user_id = $2 OR $3)")
            .bind(id)
            .bind(user_id)
            .bind(moderator)
            .execute(&mut tx)
            .await?;
        if r.rows_affected() > 0 {
            sqlx::query("DELETE FROM reaction WHERE kind = 'ws' AND msg_id = $1")
                .bind(id)
                .execute(&mut tx)
                .await?;
        }
        tx.commit().await?;
        Ok(r.rows_affected() > 0)
    }

    /// The group a chat message belongs to, for authorization before moderation.
    pub async fn message_group(&self, id: i64) -> Result<Option<i64>> {
        let row: Option<(Option<i64>,)> =
            sqlx::query_as("SELECT group_id FROM message WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|(group_id,)| group_id))
    }

    /// Clear a group's chat and all reactions to its messages.
    pub async fn clear_messages(&self, group_id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM reaction WHERE kind = 'ws' AND msg_id IN (SELECT id FROM message WHERE group_id = $1)")
            .bind(group_id)
            .execute(&mut tx)
            .await?;
        sqlx::query("DELETE FROM message WHERE group_id = $1")
            .bind(group_id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // ----- Direct messages (org-wide, 1:1) -----

    /// The org a user belongs to (for validating a DM peer is a co-member).
    pub async fn user_org(&self, user_id: i64) -> Result<Option<i64>> {
        let row: Option<(Option<i64>,)> =
            sqlx::query_as(r#"SELECT org_id FROM users WHERE id = $1"#)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|r| r.0))
    }

    /// Send a direct message from `sender` to `recipient` within an org.
    pub async fn create_dm(
        &self,
        org_id: i64,
        sender: i64,
        recipient: i64,
        body: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO dm (org_id, sender_id, recipient_id, body, created_at)
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(org_id)
        .bind(sender)
        .bind(recipient)
        .bind(body)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The conversation between two users in an org, oldest-first.
    pub async fn list_dm(
        &self,
        org_id: i64,
        a: i64,
        b: i64,
        limit: i64,
    ) -> Result<Vec<ChatMessage>> {
        let mut rows: Vec<ChatMessage> = sqlx::query_as(
            r#"SELECT d.id, d.body, u.name AS author, u.email AS email, d.created_at, d.edited_at
               FROM dm d JOIN users u ON u.id = d.sender_id
               WHERE d.org_id = $1
                 AND ((d.sender_id = $2 AND d.recipient_id = $3)
                   OR (d.sender_id = $3 AND d.recipient_id = $2))
               ORDER BY d.id DESC LIMIT $4"#,
        )
        .bind(org_id)
        .bind(a)
        .bind(b)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// Edit a direct message's body — only the sender. Returns true if changed.
    pub async fn edit_dm(&self, id: i64, sender_id: i64, body: &str, now: i64) -> Result<bool> {
        let r = sqlx::query(
            r#"UPDATE dm SET body = $1, edited_at = $2 WHERE id = $3 AND sender_id = $4"#,
        )
        .bind(body)
        .bind(now)
        .bind(id)
        .bind(sender_id)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Delete a direct message — only its sender; remove reactions as well.
    pub async fn delete_dm_message(&self, id: i64, sender_id: i64) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let r = sqlx::query("DELETE FROM dm WHERE id = $1 AND sender_id = $2")
            .bind(id)
            .bind(sender_id)
            .execute(&mut tx)
            .await?;
        if r.rows_affected() > 0 {
            sqlx::query("DELETE FROM reaction WHERE kind = 'dm' AND msg_id = $1")
                .bind(id)
                .execute(&mut tx)
                .await?;
        }
        tx.commit().await?;
        Ok(r.rows_affected() > 0)
    }

    /// Clear a 1:1 conversation for both parties (and remove its reactions).
    pub async fn clear_dm(&self, org_id: i64, a: i64, b: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let where_pair = "org_id = $1 AND ((sender_id = $2 AND recipient_id = $3) OR (sender_id = $3 AND recipient_id = $2))";
        sqlx::query(&format!("DELETE FROM reaction WHERE kind = 'dm' AND msg_id IN (SELECT id FROM dm WHERE {where_pair})"))
            .bind(org_id)
            .bind(a)
            .bind(b)
            .execute(&mut tx)
            .await?;
        sqlx::query(&format!("DELETE FROM dm WHERE {where_pair}"))
            .bind(org_id)
            .bind(a)
            .bind(b)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Message context for checking reaction permissions.
    pub async fn reaction_context(&self, kind: &str, msg_id: i64) -> Result<Option<(i64, i64, i64)>> {
        if kind == "ws" {
            // (group_id, org_id, author_id)
            sqlx::query_as("SELECT group_id, org_id, user_id FROM message WHERE id = $1 AND group_id IS NOT NULL")
                .bind(msg_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(Into::into)
        } else {
            // (sender_id, org_id, recipient_id)
            sqlx::query_as("SELECT sender_id, org_id, recipient_id FROM dm WHERE id = $1")
                .bind(msg_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(Into::into)
        }
    }

    // ----- Presence (heartbeat) -----

    /// Record that a user was just seen (heartbeat).
    pub async fn touch_last_seen(&self, user_id: i64, now: i64) -> Result<()> {
        sqlx::query(r#"UPDATE users SET last_seen = $1 WHERE id = $2"#)
            .bind(now)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// (user_id, last_seen) for everyone in an org.
    pub async fn org_presence(&self, org_id: i64) -> Result<Vec<(i64, i64)>> {
        let rows: Vec<(i64, i64)> =
            sqlx::query_as(r#"SELECT id, last_seen FROM users WHERE org_id = $1"#)
                .bind(org_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows)
    }

    // ----- Reactions -----

    /// Toggle a user's emoji reaction on a message (add if absent, else remove).
    pub async fn toggle_reaction(
        &self,
        kind: &str,
        msg_id: i64,
        user_id: i64,
        emoji: &str,
    ) -> Result<()> {
        let del = sqlx::query(
            r#"DELETE FROM reaction WHERE kind = $1 AND msg_id = $2 AND user_id = $3 AND emoji = $4"#,
        )
        .bind(kind)
        .bind(msg_id)
        .bind(user_id)
        .bind(emoji)
        .execute(&self.pool)
        .await?;
        if del.rows_affected() == 0 {
            sqlx::query(
                r#"INSERT INTO reaction (kind, msg_id, user_id, emoji) VALUES ($1, $2, $3, $4)"#,
            )
            .bind(kind)
            .bind(msg_id)
            .bind(user_id)
            .bind(emoji)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Reactions for every message in a group's chat, keyed by msg id.
    pub async fn reactions_for_group(
        &self,
        group_id: i64,
        me: i64,
    ) -> Result<HashMap<i64, Vec<ReactionView>>> {
        let rows: Vec<(i64, String, i64)> = sqlx::query_as(
            r#"SELECT r.msg_id, r.emoji, r.user_id
               FROM reaction r JOIN message m ON m.id = r.msg_id
               WHERE r.kind = 'ws' AND m.group_id = $1"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(group_reactions(rows, me))
    }

    /// Reactions for every message in a 1:1 conversation, keyed by msg id.
    pub async fn reactions_for_dm(
        &self,
        org_id: i64,
        a: i64,
        b: i64,
        me: i64,
    ) -> Result<HashMap<i64, Vec<ReactionView>>> {
        let rows: Vec<(i64, String, i64)> = sqlx::query_as(
            r#"SELECT r.msg_id, r.emoji, r.user_id
               FROM reaction r JOIN dm d ON d.id = r.msg_id
               WHERE r.kind = 'dm' AND d.org_id = $1
                 AND ((d.sender_id = $2 AND d.recipient_id = $3)
                   OR (d.sender_id = $3 AND d.recipient_id = $2))"#,
        )
        .bind(org_id)
        .bind(a)
        .bind(b)
        .fetch_all(&self.pool)
        .await?;
        Ok(group_reactions(rows, me))
    }

    // ----- Audit log -----

    /// Append an audit entry. Best-effort — callers ignore the result.
    pub async fn audit(
        &self,
        org_id: Option<i64>,
        user_id: Option<i64>,
        action: &str,
        detail: Option<&str>,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO audit (org_id, user_id, action, detail, created_at) VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(org_id)
        .bind(user_id)
        .bind(action)
        .bind(detail)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Recent audit entries: an org's when `all` is false, otherwise every org's
    /// (root view). Newest first.
    pub async fn list_audit(
        &self,
        org_id: Option<i64>,
        all: bool,
        limit: i64,
    ) -> Result<Vec<AuditEntry>> {
        let base = r#"SELECT a.id, a.action, a.detail,
                             COALESCE(u.email, 'system') AS email,
                             COALESCE(u.name, 'system') AS name,
                             a.created_at
                      FROM audit a LEFT JOIN users u ON u.id = a.user_id"#;
        let rows = if all {
            sqlx::query_as::<_, AuditEntry>(&format!("{base} ORDER BY a.id DESC LIMIT $1"))
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query_as::<_, AuditEntry>(&format!(
                "{base} WHERE a.org_id = $1 ORDER BY a.id DESC LIMIT $2"
            ))
            .bind(org_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        };
        Ok(rows)
    }

    // ----- Chat images (org-scoped blobs, separate from workspace files) -----

    /// Store a pasted chat image and return its id.
    pub async fn create_chat_image(
        &self,
        org_id: i64,
        mime: Option<&str>,
        data: &[u8],
        now: i64,
    ) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO chat_image (org_id, mime, data, created_at) VALUES ($1, $2, $3, $4) RETURNING id"#,
        )
        .bind(org_id)
        .bind(mime)
        .bind(data)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0)
    }

    /// Load a chat image: (org_id, mime, bytes).
    pub async fn get_chat_image(&self, id: i64) -> Result<Option<(i64, Option<String>, Vec<u8>)>> {
        let row: Option<(i64, Option<String>, Vec<u8>)> =
            sqlx::query_as(r#"SELECT org_id, mime, data FROM chat_image WHERE id = $1"#)
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row)
    }

    // ----- Full export / import (root owner, whole-instance migration) -----

    /// Every table carried by a full export, in insert (dependency) order.
    /// Rows are exported as generic JSON with ids preserved so cross-table
    /// references survive a round-trip into a fresh instance.
    pub const MIGRATE_TABLES: &[&str] = &[
        "users",
        "org",
        "groups",
        "group_member",
        "workspace",
        "file",
        "document",
        "file_blob",
        "message",
        "dm",
        "reaction",
        "chat_image",
        "audit",
    ];

    /// Read a consistent whole-instance snapshot in one SQLite read
    /// transaction. Exporting tables one-by-one without a snapshot can produce
    /// dangling file/blob/user references during concurrent edits and deletes.
    /// The session table is deliberately excluded (auth tokens never travel).
    pub async fn export_snapshot(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        use sqlx::Row;
        let mut tx = self.pool.begin().await?;
        let mut out = serde_json::Map::new();
        for table in Self::MIGRATE_TABLES {
            let rows = sqlx::query(&format!("SELECT * FROM {table}"))
                .fetch_all(&mut tx).await?;
            let mut values = Vec::with_capacity(rows.len());
            for row in rows {
                let mut obj = serde_json::Map::new();
                for (i, col) in row.columns().iter().enumerate() {
                    let name = col.name();
                    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
                        obj.insert(name.into(), serde_json::to_value(v)?);
                    } else if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
                        obj.insert(name.into(), serde_json::to_value(v)?);
                    } else if let Ok(v) = row.try_get::<Option<String>, _>(i) {
                        obj.insert(name.into(), serde_json::to_value(v)?);
                    } else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
                        obj.insert(name.into(), serde_json::to_value(v.map(|b| B64.encode(b)))?);
                    }
                }
                values.push(serde_json::Value::Object(obj));
            }
            out.insert((*table).to_string(), serde_json::Value::Array(values));
        }
        tx.rollback().await?;
        Ok(out)
    }

    /// Replace the entire dataset with the given export. Row ids are kept, so
    /// references between tables stay valid; SQLite affinity restores column
    /// types from the JSON round-trip. Everything runs in one transaction —
    /// either the whole import lands or nothing changes. Sessions are cleared
    /// (their tokens belong to the old instance) so everyone signs in again.
    pub async fn import_replace_all(
        &self,
        tables: &[(String, Vec<serde_json::Value>)],
    ) -> Result<()> {
        use sqlx::Row;
        let supplied: HashSet<&str> = tables.iter().map(|(name, _)| name.as_str()).collect();
        if tables.len() != Self::MIGRATE_TABLES.len()
            || !Self::MIGRATE_TABLES.iter().all(|name| supplied.contains(name))
        {
            bail!("incomplete or invalid export tables");
        }
        let mut tx = self.pool.begin().await?;
        // Sessions reference users (the first export table). Clear them BEFORE
        // deleting users; leaving this until afterward made every import fail
        // under SQLx's default foreign-key enforcement.
        sqlx::query("DELETE FROM session").execute(&mut tx).await?;
        for table in Self::MIGRATE_TABLES.iter().rev() {
            sqlx::query(&format!("DELETE FROM {}", table))
                .execute(&mut tx)
                .await?;
        }
        for (table, rows) in tables {
            if rows.is_empty() {
                continue;
            }
            let mut names: Vec<String> = match rows[0] {
                serde_json::Value::Object(ref map) => map.keys().cloned().collect(),
                _ => bail!("malformed export: {} rows are not objects", table),
            };
            names.retain(|n| {
                n != "data" || *table == "file_blob" || *table == "chat_image"
            });
            // Only manifest columns that actually exist in the schema are
            // interpolated into the INSERT; everything else is a corrupted
            // export and is skipped rather than executed.
            let real = sqlx::query(&format!("PRAGMA table_info({})", table))
                .fetch_all(&mut *tx)
                .await?;
            let real: HashSet<String> = real
                .iter()
                .map(|row| row.try_get::<String, _>("name"))
                .collect::<std::result::Result<_, _>>()?;
            names.retain(|n| real.contains(n));
            for row in rows {
                let map = match row {
                    serde_json::Value::Object(map) => map,
                    _ => bail!("malformed export: {} rows are not objects", table),
                };
                let mut sql = format!("INSERT INTO {} (", table);
                sql.push_str(&names.join(", "));
                sql.push_str(") VALUES (");
                sql.push_str(
                    &(1..=names.len())
                        .map(|i| format!("${}", i))
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                sql.push_str(")");
                let mut q = sqlx::query(&sql);
                for name in &names {
                    let v = map
                        .get(name)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let is_blob_col = name == "data"
                        && (*table == "file_blob" || *table == "chat_image");
                    if is_blob_col {
                        let bytes = match &v {
                            serde_json::Value::String(s) => B64.decode(s)?,
                            _ => Vec::new(),
                        };
                        q = q.bind(bytes);
                    } else {
                        // Non-blob values bind as text (or NULL); SQLite's
                        // column affinity restores the stored type.
                        q = q.bind(match v {
                            serde_json::Value::Null => None::<String>,
                            serde_json::Value::Number(n) => Some(n.to_string()),
                            serde_json::Value::String(s) => Some(s),
                            serde_json::Value::Bool(b) => Some(if b { "1".to_string() } else { "0".to_string() }),
                            other => bail!("unsupported value in {}: {}", table, other),
                        });
                    }
                }
                q.execute(&mut tx).await?;
            }
        }
        let (owners,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM users WHERE role = 'root'")
                .fetch_one(&mut tx)
                .await?;
        if owners == 0 {
            bail!("export has no owner account");
        }
        let (violations,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&mut tx)
            .await?;
        if violations > 0 {
            bail!("export has {violations} broken foreign keys");
        }
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Database;

    async fn test_database() -> (tempfile::NamedTempFile, Database) {
        let file = tempfile::NamedTempFile::new().unwrap();
        let uri = format!("sqlite://{}", file.path().to_str().unwrap());
        let db = Database::new(&uri).await.unwrap();
        (file, db)
    }

    async fn assert_no_bad_foreign_keys(db: &Database) {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn hard_delete_never_resurrects_document() {
        let (_tmp, db) = test_database().await;
        let hash = "test";
        db.create_user_if_absent("owner", "Owner", hash, "root", None)
            .await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        let group = db.create_group(org.id, "Team", owner.id, 1, "group").await.unwrap();
        let ws = db.create_workspace(group.id, "Project", owner.id, 1).await.unwrap();
        let file = db.create_file(ws.id, "hello.txt", "test-doc", "text", None, 1)
            .await.unwrap();
        assert_eq!(db.load(&file.doc_id).await.unwrap().text, "");
        db.store(&file.doc_id, &super::PersistedDocument {
            text: "saved".into(), language: None
        }).await.unwrap();
        assert_eq!(db.delete_file(file.id).await.unwrap(), file.doc_id);
        assert!(db.store(&file.doc_id, &super::PersistedDocument {
            text: "ghost".into(), language: None
        }).await.is_err());
        assert!(db.load(&file.doc_id).await.is_err());
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn user_and_org_deletes_clean_dependents() {
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "hash", "root", None).await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        db.create_user_if_absent("alice", "Alice", "hash", "user", Some(org.id)).await.unwrap();
        db.create_user_if_absent("bob", "Bob", "hash", "user", Some(org.id)).await.unwrap();
        let alice = db.get_user_by_email("alice").await.unwrap().unwrap();
        let bob = db.get_user_by_email("bob").await.unwrap().unwrap();
        let personal = db.create_group(org.id, "Personal", alice.id, 1, "personal").await.unwrap();
        let private_ws = db.create_workspace(personal.id, "Secrets", alice.id, 1).await.unwrap();
        let private_file = db.create_file(private_ws.id, "secret.txt", "private-doc", "text", None, 1).await.unwrap();
        let shared = db.create_group(org.id, "Shared", alice.id, 1, "group").await.unwrap();
        db.add_group_member(shared.id, bob.id, "member").await.unwrap();
        let shared_ws = db.create_workspace(shared.id, "Project", alice.id, 1).await.unwrap();
        db.create_file(shared_ws.id, "keep.txt", "shared-doc", "text", None, 1).await.unwrap();
        db.create_message(shared.id, alice.id, "hello", 1).await.unwrap();
        db.create_dm(org.id, alice.id, bob.id, "hi", 1).await.unwrap();
        db.create_chat_image(org.id, Some("image/png"), b"img", 1).await.unwrap();
        let docs = db.admin_delete_user(alice.id, None).await.unwrap();
        assert!(docs.contains(&private_file.doc_id));
        assert!(db.get_group(personal.id).await.unwrap().is_none());
        assert_eq!(db.get_group(shared.id).await.unwrap().unwrap().created_by, owner.id);
        assert_eq!(db.get_workspace(shared_ws.id).await.unwrap().unwrap().created_by, owner.id);
        assert_eq!(db.load("shared-doc").await.unwrap().text, "");
        assert_eq!(db.table_rows("message").await.unwrap(), 0);
        assert_eq!(db.table_rows("dm").await.unwrap(), 0);
        assert_no_bad_foreign_keys(&db).await;
        assert_eq!(db.delete_org(org.id).await.unwrap(), vec!["shared-doc"]);
        assert_eq!(db.table_rows("chat_image").await.unwrap(), 0);
        assert_eq!(db.user_org(bob.id).await.unwrap(), None);
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn maintenance_prunes_and_compacts() {
        let (_tmp, db) = test_database().await;
        sqlx::query("INSERT INTO document (id, text) VALUES ('orphan', 'unused')")
            .execute(&db.pool).await.unwrap();
        sqlx::query("INSERT INTO audit (action, created_at) VALUES ('old', 1)")
            .execute(&db.pool).await.unwrap();
        let report = db.maintain(200 * 86400, 180, true).await.unwrap();
        assert_eq!(report.orphan_documents, 1);
        assert_eq!(report.pruned_audit, 1);
        assert!(report.vacuumed);
        assert_eq!(db.table_rows("document").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn batch_transfer_merge_and_zip_import_are_atomic() {
        use std::collections::HashMap;
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "hash", "root", None).await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        let g1 = db.create_group(org.id, "Source", owner.id, 1, "group").await.unwrap();
        let g2 = db.create_group(org.id, "Other", owner.id, 1, "group").await.unwrap();
        let src = db.create_workspace(g1.id, "Project", owner.id, 1).await.unwrap();
        let dst = db.create_workspace(g1.id, "Destination", owner.id, 1).await.unwrap();
        let text = db.create_file(src.id, "docs/note.txt", "source-note", "text", None, 1).await.unwrap();
        let binary = db.create_uploaded_file(src.id, "docs/logo.png", "source-logo", Some("image/png"), None, &[0, 7, 255], 1).await.unwrap();
        let original = db.create_file(dst.id, "folder", "target-file", "text", None, 1).await.unwrap();
        let mut snapshots = HashMap::new();
        snapshots.insert(text.doc_id.clone(), super::PersistedDocument { text: "unflushed OT edit".into(), language: Some("markdown".into()) });
        let copied = db.transfer_files(dst.id, &[(text.id, "folder/note.txt".into()), (binary.id, "folder/logo.png".into())], true, true, &snapshots, 1).await.unwrap();
        assert_eq!(copied[0].path, "folder (1)/note.txt");
        assert_eq!(copied[1].path, "folder (1)/logo.png");
        assert_eq!(db.load(&copied[0].doc_id).await.unwrap(), snapshots[&text.doc_id]);
        assert_eq!(db.load_blob(copied[1].id).await.unwrap().unwrap(), vec![0, 7, 255]);
        assert_eq!(db.load(&text.doc_id).await.unwrap().text, "");
        assert_eq!(db.get_file(original.id).await.unwrap().unwrap().path, "folder");
        // A missing id aborts the entire batch, even though the first is valid.
        assert!(db.transfer_files(dst.id, &[(text.id, "moved.txt".into()), (-99, "missing.txt".into())], false, true, &HashMap::new(), 1).await.is_err());
        assert_eq!(db.get_file(text.id).await.unwrap().unwrap().workspace_id, src.id);
        assert!(db.delete_files(&[copied[0].id, -99]).await.is_err());
        assert!(db.get_file(copied[0].id).await.unwrap().is_some());
        let removed = db.delete_files(&[copied[0].id, copied[1].id]).await.unwrap();
        assert_eq!(removed.len(), 2);
        assert!(db.load(&copied[0].doc_id).await.is_err());
        // Merge must rename an entire folder if the destination already has
        // a file at its parent path, and keep the file/blob IDs intact.
        db.create_file(dst.id, "docs", "target-docs", "text", None, 1).await.unwrap();
        let (moved, _) = db.merge_workspaces(src.id, dst.id).await.unwrap();
        assert_eq!(moved, 2);
        assert!(db.get_workspace(src.id).await.unwrap().is_none());
        assert_eq!(db.get_file(text.id).await.unwrap().unwrap().path, "docs (1)/note.txt");
        assert_eq!(db.get_file(binary.id).await.unwrap().unwrap().path, "docs (1)/logo.png");
        assert_eq!(db.load_blob(binary.id).await.unwrap().unwrap(), vec![0, 7, 255]);
        let relocated = db.move_workspace_to_group(&dst, g2.id).await.unwrap();
        assert_eq!(relocated.group_id, g2.id);
        assert_eq!(db.get_file(text.id).await.unwrap().unwrap().workspace_id, dst.id);
        // Invalid UTF-8 in a text import rolls the entire import back.
        let invalid = [
            super::ImportedFile { path: "new.txt".into(), mime: None, bytes: b"new".to_vec(), is_text: true },
            super::ImportedFile { path: "bad.txt".into(), mime: None, bytes: vec![255], is_text: true },
        ];
        assert!(db.import_files(dst.id, &invalid, 1).await.is_err());
        assert!(db.list_files(dst.id).await.unwrap().iter().all(|f| f.path != "new.txt"));
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn admin_mutations_reject_other_orgs_and_revoke_sessions() {
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "hash", "root", None).await.unwrap();
        let first = db.create_org("First", "first", 1).await.unwrap();
        let second = db.create_org("Second", "second", 1).await.unwrap();
        db.create_user_if_absent("alice", "Alice", "hash", "user", Some(first.id)).await.unwrap();
        db.create_user_if_absent("bob", "Bob", "hash", "user", Some(second.id)).await.unwrap();
        let alice = db.get_user_by_email("alice").await.unwrap().unwrap();
        let bob = db.get_user_by_email("bob").await.unwrap().unwrap();
        assert_eq!(db.admin_list_users_in_org(first.id).await.unwrap().iter().map(|u| u.email.as_str()).collect::<Vec<_>>(), vec!["alice"]);
        assert!(!db.admin_update_user(bob.id, None, None, Some("admin"), None, Some(first.id)).await.unwrap());
        assert!(!db.admin_reset_credentials(bob.id, Some("newhash"), Some(first.id)).await.unwrap());
        assert!(db.admin_delete_user(bob.id, Some(first.id)).await.is_err());
        assert_eq!(db.admin_target(bob.id).await.unwrap().unwrap().role, "user");
        db.create_session("old-session", alice.id, 999).await.unwrap();
        assert!(db.admin_update_user(alice.id, None, None, Some("admin"), None, Some(first.id)).await.unwrap());
        assert_eq!(db.admin_target(alice.id).await.unwrap().unwrap().role, "admin");
        assert!(db.get_session_user("old-session", 1).await.unwrap().is_none());
        db.create_session("another-session", alice.id, 999).await.unwrap();
        assert!(db.admin_reset_credentials(alice.id, None, Some(first.id)).await.unwrap());
        assert!(db.get_session_user("another-session", 1).await.unwrap().is_none());
        assert!(db.admin_update_user(alice.id, None, None, None, Some(Some(second.id)), None).await.unwrap());
        assert_eq!(db.admin_target(alice.id).await.unwrap().unwrap().org_id, Some(second.id));
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn whole_instance_export_import_keeps_audit_and_forgets_sessions() {
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "hash", "root", None).await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Example", "example", 1).await.unwrap();
        let group = db.create_group(org.id, "Team", owner.id, 1, "group").await.unwrap();
        let ws = db.create_workspace(group.id, "Project", owner.id, 1).await.unwrap();
        let file = db.create_uploaded_file(ws.id, "icon.png", "icon-doc", Some("image/png"), None, &[0, 255, 2], 1).await.unwrap();
        db.audit(Some(org.id), Some(owner.id), "backup-test", Some("retained"), 1).await.unwrap();
        db.create_session("old-login", owner.id, 999999).await.unwrap();
        let snapshot = db.export_snapshot().await.unwrap();
        assert!(snapshot.contains_key("audit"));
        assert!(!snapshot.contains_key("session"));
        db.delete_org(org.id).await.unwrap();
        let data: Vec<(String, Vec<serde_json::Value>)> = super::Database::MIGRATE_TABLES.iter()
            .map(|t| (t.to_string(), snapshot[t].as_array().unwrap().clone())).collect();
        db.import_replace_all(&data).await.unwrap();
        assert_eq!(db.load_blob(file.id).await.unwrap().unwrap(), vec![0, 255, 2]);
        assert_eq!(db.get_workspace(ws.id).await.unwrap().unwrap().group_id, group.id);
        assert_eq!(db.table_rows("audit").await.unwrap(), 1);
        assert!(db.get_session_user("old-login", 1).await.unwrap().is_none());
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn migrations_remove_ai_schema() {
        let file = tempfile::NamedTempFile::new().expect("create temporary database");
        let uri = format!(
            "sqlite://{}",
            file.path()
                .to_str()
                .expect("temporary database path is valid UTF-8")
        );
        let db = Database::new(&uri).await.expect("run database migrations");

        let (ai_tables,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%'",
        )
        .fetch_one(&db.pool)
        .await
        .expect("inspect migrated schema");
        assert_eq!(ai_tables, 0);

        let (cleanup_applied,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 26")
                .fetch_one(&db.pool)
                .await
                .expect("inspect migration history");
        assert_eq!(cleanup_applied, 1);
    }
}
