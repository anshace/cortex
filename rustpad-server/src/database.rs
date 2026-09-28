//! Backend SQLite database handlers.
//!
//! Model: **Org → Workspaces → files**, plus one org-wide chat. Every user is
//! assigned to at most one org (by the root owner). Access to a workspace is by
//! org membership; the root owner bypasses org checks (full cross-org access).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow},
    Column, Row, Sqlite, SqlitePool, Transaction,
};

use crate::blobstore::BlobStore;
use crate::databases::Databases;
use crate::keystore;

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
    /// HKDF-sealed [`Self::totp_secret`] — never the seed itself. None means 2FA
    /// was never started.
    pub totp_secret_cipher: Option<String>,
    /// True once the user has confirmed 2FA with a valid code; login then requires it.
    pub totp_enabled: bool,
}

impl User {
    /// The base32 TOTP seed, unsealed. None if 2FA was never started, and also
    /// None if the row was sealed by a different install's data key — which reads
    /// as "start setup again" rather than as a working second factor.
    pub fn totp_secret(&self) -> Option<String> {
        self.totp_secret_cipher.as_deref().and_then(|cipher| keystore::open(keystore::TOTP, cipher))
    }
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

/// The conversation a pasted chat image belongs to, recorded at upload time so
/// a read can be scoped to it. Exactly one side may be set; both None means the
/// uploader pasted it with no target yet, so only they may read it.
#[derive(PartialEq, Eq, Clone, Copy, Debug, Default)]
pub struct ChatImageScope {
    /// Group channel the image was pasted into.
    pub group_id: Option<i64>,
    /// The other user in the DM the image was pasted into.
    pub dm_with: Option<i64>,
}

/// A chat attachment blob with the tenancy and conversation it may be read in.
#[derive(sqlx::FromRow, Clone, Debug)]
pub struct ChatImage {
    /// Owning org.
    pub org_id: i64,
    /// Uploader; always allowed to read their own paste. NULL on a row the
    /// migration could not trace back to a message.
    pub uploaded_by: Option<i64>,
    /// Conversation scope — see `ChatImageScope`. A row with no uploader and no
    /// scope falls back to the org-wide rule that predates them.
    pub group_id: Option<i64>,
    /// See `group_id`.
    pub dm_with: Option<i64>,
    /// Declared MIME type.
    pub mime: Option<String>,
    /// The bytes.
    pub data: Vec<u8>,
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

/// One row of any table, as the JSON an archive is made of. Types come back as
/// SQLite reports them, and bytes travel base64 because JSON has no other way to
/// say "these exact octets".
fn row_to_json(row: &SqliteRow) -> Result<serde_json::Map<String, serde_json::Value>> {
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
    Ok(obj)
}

/// `$1, $2, …, $n` — the placeholder list for a set of values bound one by one.
fn value_list(n: usize) -> String {
    (1..=n)
        .map(|i| format!("${i}"))
        .collect::<Vec<_>>()
        .join(", ")
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
    /// Objects no row references any more, deleted from the object store.
    pub released_objects: u64,
    /// Audit entries older than the configured retention period.
    pub pruned_audit: u64,
}

/// Seconds an identity answer may be served from memory when nothing has
/// explicitly invalidated it. Short by design: it is the backstop for the few
/// membership deletes that run inside free-function transaction helpers, which
/// cannot reach the cache through `self`.
const AUTH_TTL: i64 = 30;

/// Read-through cache for the two questions nearly every request asks: which
/// account owns this session token, and is this account a member of this group.
///
/// It is wiped wholesale by every identity write in this file rather than
/// tracked per entry, because a stale authorization answer is a security bug and
/// a forgotten invalidation must not be one. Natural session expiry is still
/// honoured exactly — a cached session carries its own deadline, so only an
/// administrative revocation depends on the wipe, and that is the case where
/// immediacy matters.
#[derive(Debug, Default)]
struct AuthCache {
    sessions: dashmap::DashMap<String, (User, i64)>,
    members: dashmap::DashMap<(i64, i64), (bool, i64)>,
    hits: std::sync::atomic::AtomicU64,
}

impl AuthCache {
    fn wipe(&self) {
        self.sessions.clear();
        self.members.clear();
    }

    fn count_hit(&self) {
        self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Wall-clock seconds for cache lifetimes, independent of the `now` handlers pass
/// around for auditing.
fn wall_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// A driver for database operations wrapping a pool connection.
#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
    /// The URI this pool was opened with, kept because a database's *file* is
    /// something an operator asks about (its size) and a pool cannot report it.
    uri: String,
    /// Identity of the pool behind this handle. Clones share it; two databases
    /// opened separately never do, even when they name the same file.
    pool_id: Arc<u64>,
    maintenance_lock: Arc<tokio::sync::Mutex<()>>,
    auth: Arc<AuthCache>,
    /// Where binary content lives: inline in the row, or as an object the row
    /// names. Chosen once at boot and never re-decided per query.
    blobs: BlobStore,
    /// One lock per organization, held from the moment its stored bytes are
    /// counted until the write that count authorized has landed.
    quota_locks: Arc<dashmap::DashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    /// The per-organization database registry document content routes through.
    ///
    /// Shared by every handle over one pool — `Database` is a cheap clone, so a
    /// plain cell here would belong to the single handle that happened to set it
    /// and every other clone would keep resolving content to the control
    /// database. It is filled *after* construction, at boot: the registry holds
    /// this very handle, so neither can be built first.
    ///
    /// An organization's own handle leaves it empty on purpose. A tenant database
    /// *is* the content database: asking it to route would resolve its routing
    /// index — a control-plane table it does not maintain — and come back with
    /// itself anyway.
    registries: Arc<OnceLock<Databases>>,
}

/// Hands every opened database an identity no other database can share.
static POOL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// How long a request waits for the one pooled connection before the server
/// says the database is busy.
///
/// This is the difference between a slow moment and a refused sign-in, so it is
/// set against what actually holds the connection: housekeeping runs one short
/// statement at a time and gives the connection back between them, which leaves
/// `VACUUM` as the only thing a request can be queued behind for seconds. SQLx's
/// 30-second default spends thirty seconds deciding a database is busy; four is
/// long enough to ride out a compaction of a modest file and short enough that a
/// genuinely stuck writer is reported while the user is still looking at it.
const POOL_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(4);

/// Bytes of database file an unattended pass may rewrite with `VACUUM`, or zero
/// for no bound.
///
/// `VACUUM`'s cost is a property of the install's size and of nothing else, and
/// because it cannot be interrupted it is the one part of housekeeping a request
/// can be made to wait for. `CORTEX_VACUUM_MAX_DB_MB` is the bound an operator
/// sets when their database has grown past a second; unset or zero, which is how
/// an install starts, bounds nothing and every pass compacts when the free pages
/// justify it — exactly as it does today.
fn vacuum_ceiling_bytes() -> i64 {
    std::env::var("CORTEX_VACUUM_MAX_DB_MB")
        .ok()
        .and_then(|mb| mb.trim().parse::<i64>().ok())
        .filter(|mb| *mb > 0)
        .map_or(0, |mb| mb * 1024 * 1024)
}

// These helpers share the caller's transaction. File content, chats, reactions
// and membership must disappear together or not at all (including on old DBs).
async fn delete_workspace_tx(
    tx: &mut Transaction<'_, Sqlite>,
    id: i64,
) -> Result<Vec<(String, Option<i64>)>> {
    // Each document, with the organization whose database holds its content —
    // read here, because a delete that waits for the commit can no longer ask:
    // by then the row that answered is gone. The content itself is dropped by
    // the caller *after* this transaction commits, which leaves an orphan as the
    // only failure mode and a missing document as none.
    let docs: Vec<(String, Option<i64>)> = sqlx::query_as(
        "SELECT f.doc_id, (SELECT org_id FROM doc_org WHERE doc_id = f.doc_id) \
         FROM file f WHERE f.workspace_id = $1",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM file_blob WHERE file_id IN (SELECT id FROM file WHERE workspace_id = $1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM doc_org WHERE doc_id IN (SELECT doc_id FROM file WHERE workspace_id = $1)")
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
    Ok(docs)
}

async fn delete_group_tx(
    tx: &mut Transaction<'_, Sqlite>,
    id: i64,
) -> Result<Vec<(String, Option<i64>)>> {
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

// The routing index (issue #24) is maintained inside these same transactions:
// a document is never on record as belonging to an org while its file row
// says otherwise, and never survives as a pointer to a deleted document.

/// Point the routing index at the org that owns a document right now, derived
/// from the workspace it currently sits in. Used when a file row is created
/// and when a move changes the answer. If the workspace does not resolve to a
/// group inside a live org the statement inserts nothing: an unroutable
/// document is one no tenant database holds yet, not a mapping to guess.
async fn route_doc_tx(tx: &mut Transaction<'_, Sqlite>, doc_id: &str, workspace_id: i64) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO doc_org (doc_id, org_id, created_at)
           SELECT f.doc_id, g.org_id, f.created_at
           FROM file f
           JOIN workspace w ON w.id = f.workspace_id
           JOIN groups g ON g.id = w.group_id
           WHERE f.doc_id = $1 AND w.id = $2
           ON CONFLICT(doc_id) DO UPDATE SET org_id = excluded.org_id"#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Re-route every document under one workspace — the whole-subtree form of
/// [`route_doc_tx`], for when a workspace is reparented and its files move
/// with it without their rows changing.
async fn route_workspace_tx(tx: &mut Transaction<'_, Sqlite>, workspace_id: i64) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO doc_org (doc_id, org_id, created_at)
           SELECT f.doc_id, g.org_id, f.created_at
           FROM file f
           JOIN workspace w ON w.id = f.workspace_id
           JOIN groups g ON g.id = w.group_id
           WHERE w.id = $1
           ON CONFLICT(doc_id) DO UPDATE SET org_id = excluded.org_id"#,
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Which organization's database holds this document's content, answered through
/// the caller's transaction.
///
/// Resolving a route needs the control database, and a transaction on its single
/// pooled connection is the only thing that can read it without waiting for
/// itself: every delete that has to empty a tenant database learns the answer
/// here, while the row that gives it still exists.
async fn route_of_doc_tx(tx: &mut Transaction<'_, Sqlite>, doc_id: &str) -> Result<Option<i64>> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT org_id FROM doc_org WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_optional(&mut *tx)
        .await?;
    Ok(row.map(|(org_id,)| org_id))
}

// Content placement (issue #19).
//
// `document` is the only table in the schema with no inbound foreign key, which
// is what makes it the only table that can leave the control database: nothing
// else has to be told where it went. `file` and `doc_org` stay here and keep
// sharing one transaction, so the routing index keeps meaning exactly what the
// file list says — and the content row is written *before* that transaction
// commits and removed *after* it. The one surviving mismatch is therefore an
// unreachable content row in a tenant that names nothing, which the maintenance
// sweep reclaims, rather than a file whose content has gone missing.

/// Seed a document row. Fails loudly if the id is already taken: content ids
/// are random and created with the file that owns them, so a collision is a bug.
async fn insert_content(db: &Database, doc_id: &str, doc: &PersistedDocument) -> Result<()> {
    sqlx::query("INSERT INTO document (id, text, language) VALUES ($1, $2, $3)")
        .bind(doc_id)
        .bind(&doc.text)
        .bind(&doc.language)
        .execute(db.write())
        .await?;
    Ok(())
}

/// Carry a document row to a new home, overwriting anything already there: a
/// document that changed organizations moves with the content it has now.
async fn replace_content(db: &Database, doc_id: &str, doc: &PersistedDocument) -> Result<()> {
    sqlx::query("INSERT OR REPLACE INTO document (id, text, language) VALUES ($1, $2, $3)")
        .bind(doc_id)
        .bind(&doc.text)
        .bind(&doc.language)
        .execute(db.write())
        .await?;
    Ok(())
}

/// Drop a document row, reporting whether anything went. No row is not an error:
/// every caller has already let the file go, and a content row can legitimately
/// be missing when a delete is retried or the row was never written.
async fn delete_content(db: &Database, doc_id: &str) -> Result<bool> {
    Ok(sqlx::query("DELETE FROM document WHERE id = $1")
        .bind(doc_id)
        .execute(db.write())
        .await?
        .rows_affected()
        > 0)
}

/// Drop a set of document rows, in lists small enough for one statement.
async fn delete_content_ids(db: &Database, doc_ids: &[String]) -> Result<u64> {
    let mut dropped = 0;
    for chunk in doc_ids.chunks(Database::IDS_PER_QUERY) {
        let sql = format!(
            "DELETE FROM document WHERE id IN ({})",
            value_list(chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(id);
        }
        dropped += query.execute(db.write()).await?.rows_affected();
    }
    Ok(dropped)
}

/// A `file` row as the clients see it, in every query that lists them.
///
/// Binary content is measured here, in the database that keeps `file`. Text is
/// left at zero and filled in afterwards by [`Database::fill_text_sizes`],
/// because that row now lives in an organization's database and no subquery
/// reaches across: a listing that could not ask would report every note in the
/// product as an empty file, and the storage meter would agree with it.
const FILE_COLUMNS: &str = "f.id, f.workspace_id, f.path, f.doc_id, f.kind, f.mime, \
    COALESCE((SELECT COALESCE(fb.size, LENGTH(fb.data), 0) FROM file_blob fb WHERE fb.file_id = f.id), 0) AS size";

/// The answer to "may this organization store `n` more bytes?".
pub enum Quota {
    /// The plan puts no ceiling on storage.
    Unlimited,
    /// There is room, and the organization's accounting stays locked until the
    /// carrier is dropped — which means the caller must keep it alive until the
    /// content row is written, not just until it has been measured.
    Admitted(QuotaHold),
    /// The bytes would take the organization past its plan.
    Over,
}

/// The lock portion of an admitted reservation. See [`Quota`].
pub struct QuotaHold {
    _hold: tokio::sync::OwnedMutexGuard<()>,
}

impl Database {
    /// Construct a new database, creating the file and running migrations.
    pub async fn new(uri: &str) -> Result<Self> {
        // One store for the process, chosen once from the environment, so every
        // database opened later agrees on where content lives.
        crate::blobstore::init(uri);
        let blobs = crate::blobstore::store().clone();
        let db = Self::open_with(uri, blobs).await?;
        // Stated once at boot, because it is the fact a shred is judged on: an
        // install keeping content in rows seals nothing and mints no keys, and an
        // install whose data key came from somewhere unexpected will read its own
        // objects as garbage. Both are discoverable here or not at all.
        log::info!(
            "content in {}, data key from {}",
            db.blobs.mode(),
            keystore::source()
        );
        Ok(db)
    }

    /// Open an organization's database.
    ///
    /// Identical to a control database in every mechanical way — same pool
    /// construction, same embedded migrations, same blob backend — and different
    /// in exactly the ways that only make sense for the identity store: the
    /// three boot repairs (sealing TOTP seeds, recording inline sizes,
    /// backfilling the routing index) do not run, because an org database holds
    /// no credentials to seal and the routing index is a control-plane claim
    /// about *other* databases. The process's object store is reused rather than
    /// re-chosen: `blobstore::init` has already decided where bytes live, and a
    /// second decision would put an org's content somewhere the control plane
    /// then cannot find.
    pub(crate) async fn open_org(uri: &str) -> Result<Self> {
        Self::open_pool(uri, crate::blobstore::store().clone(), false).await
    }

    /// Open a database against an explicit blob backend. Tests use this to
    /// exercise the object path without touching the process environment.
    async fn open_with(uri: &str, blobs: BlobStore) -> Result<Self> {
        let db = Self::open_pool(uri, blobs, true).await?;
        db.seal_existing_totp().await?;
        db.record_inline_sizes().await?;
        db.backfill_doc_routing().await?;
        log::info!("blob storage backend: {}", db.blobs.mode());
        Ok(db)
    }

    /// Pool, migrations, data key: everything a handle needs to be usable, and
    /// nothing that reads or rewrites the rows it contains.
    ///
    /// `control_plane` decides whether this process's data key is established
    /// here. The key exists to seal credentials, and credentials are a control
    /// plane concern — an organization database has none, and asking for its key
    /// would mean writing a sidecar next to a database that may not have a file
    /// at all.
    async fn open_pool(uri: &str, blobs: BlobStore, control_plane: bool) -> Result<Self> {
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
        // A measured corollary, in tests/maintenance_busy.rs: a second
        // connection in *this* process can invalidate the snapshot a running
        // transaction has already read — `VACUUM` there costs an application
        // write indefinitely, not merely an error — so housekeeping stays on
        // this connection too, and yields it between statements instead.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            // What "the connection is held" costs a request. Housekeeping is
            // now one statement at a time (see [`Database::sweep`]), so a wait
            // this long means something genuinely uninterruptible is running —
            // a compaction — and SQLx's 30-second default would spend it
            // deciding that the database is busy.
            .acquire_timeout(POOL_ACQUIRE_TIMEOUT)
            .connect_with(options)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        // The data key must exist before anything can be sealed, and the
        // backfill below needs it to move seeds that predate encryption.
        if control_plane {
            keystore::ensure_for(uri).map_err(anyhow::Error::msg)?;
        }
        Ok(Database {
            pool,
            uri: uri.to_string(),
            pool_id: Arc::new(POOL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
            maintenance_lock: Arc::new(tokio::sync::Mutex::new(())),
            blobs,
            auth: Arc::default(),
            quota_locks: Arc::default(),
            // Empty for every handle, including a control one: the registry is
            // built from the control database, so it can only be attached after
            // both exist. See [`Self::attach_registries`].
            registries: Arc::new(OnceLock::new()),
        })
    }

    /// Reads go here. Naming the accessor instead of the field is what lets a
    /// caller outside this module take a query without owning a pool.
    pub fn read_only(&self) -> &SqlitePool {
        &self.pool
    }

    /// Writes go here. SQLite has no read-replica topology, so this is the same
    /// pool as [`Self::read_only`] under a name that says what the query does.
    pub fn write(&self) -> &SqlitePool {
        &self.pool
    }

    /// Whether two handles are served by one pool — the only honest way to ask
    /// "is this the same database?" without comparing files, which a shared
    /// in-memory database does not have.
    pub fn shares_pool_with(&self, other: &Database) -> bool {
        Arc::ptr_eq(&self.pool_id, &other.pool_id)
    }

    /// Hand this (control) database the registry its documents route through.
    ///
    /// Only the control database is ever given one, and only once: the registry
    /// holds a clone of this handle, so the dependency is circular and neither
    /// side can be constructed first. Every clone of this pool sees it, because
    /// the cell is shared — which is the whole reason it is an `Arc`.
    pub fn attach_registries(&self, registries: Databases) -> bool {
        self.registries.set(registries).is_ok()
    }

    /// Whether document content lives somewhere other than here.
    ///
    /// `false` covers both an instance that never turned the flag on and a
    /// database that has no registry at all — an organization's own handle, and
    /// every handle in a test that builds a bare control database. Both answer
    /// "content is right here", which is what they mean.
    fn content_is_split(&self) -> bool {
        self.registries.get().is_some_and(Databases::is_split)
    }

    /// The database holding — or about to hold — this document's content.
    ///
    /// The routing index is the whole answer: it is control-plane data, it is
    /// maintained in the same transaction as the `file` row it describes, and it
    /// keeps resolving after the content row itself has left this database. An
    /// unroutable document is one no tenant has ever been told about, so it
    /// stays exactly where it is.
    async fn content_db_for(&self, document_id: &str) -> Result<Database> {
        if !self.content_is_split() {
            return Ok(self.clone());
        }
        // A failure to *route* is an error, never a fallback: quietly writing
        // content into the control database because its owning tenant's file
        // would not open would strand it where no read will look.
        let org = self.org_of_doc(document_id).await?;
        self.content_db_for_org(org).await
    }

    /// The database holding the content of documents owned by `org_id`.
    async fn content_db_for_org(&self, org_id: Option<i64>) -> Result<Database> {
        match self.registries.get() {
            Some(registries) if registries.is_split() => match org_id {
                Some(org_id) => Ok(registries.org(org_id).await?),
                // Content the index never attributed to a tenant belongs to the
                // control database, which is where it already sits.
                None => Ok(self.clone()),
            },
            _ => Ok(self.clone()),
        }
    }

    /// The database that will hold content for documents created under
    /// `workspace_id` right now.
    async fn content_db_for_workspace(&self, workspace_id: i64) -> Result<Database> {
        if !self.content_is_split() {
            return Ok(self.clone());
        }
        let org = self.workspace_org(workspace_id).await?;
        self.content_db_for_org(org).await
    }

    /// Bytes of the file backing this database.
    ///
    /// A memory database has no file, and reporting that as an error would make
    /// every caller that sizes a database fail on exactly the installations
    /// (read-only root filesystem) that deliberately chose memory. So: zero.
    pub async fn file_size(&self) -> Result<i64> {
        let Some(path) = self.file_path() else {
            return Ok(0);
        };
        // A database that was never written has no file yet; that is a size of
        // zero, not a missing database.
        Ok(tokio::fs::metadata(&path).await.map(|m| m.len() as i64).unwrap_or(0))
    }

    /// The path half of a URI, if this database is a file at all. Mirrors how
    /// SQLx parses one (`sqlite://` prefix, then the path, then `?` params).
    fn file_path(&self) -> Option<PathBuf> {
        let uri = self
            .uri
            .trim_start_matches("sqlite://")
            .trim_start_matches("sqlite:");
        let (path, params) = uri.split_once('?').unwrap_or((uri, ""));
        if path == ":memory:" || params.contains("mode=memory") {
            return None;
        }
        Some(PathBuf::from(path))
    }

    /// Documents the routing index says this organization owns.
    pub async fn count_documents_of(&self, org_id: i64) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM doc_org WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(n)
    }

    /// Replicate one identity row into this database as display data.
    ///
    /// The org database needs real `users` rows because its own foreign keys
    /// (`workspace.owner_id`, `group_member.user_id`, `message.sender_id`) point
    /// at `users`, and SQLite cannot satisfy a foreign key across a database
    /// boundary. What arrives is name and role: the email is a placeholder and
    /// the password hash is `!`, a value bcrypt can never verify, so a leaked
    /// tenant file yields no credential to attack. Updating on conflict touches
    /// display columns only — a projection never overwrites a real account.
    pub async fn upsert_member(
        &self,
        id: i64,
        email: &str,
        name: &str,
        role: &str,
        org_id: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO users (id, email, password_hash, role, name, org_id)
               VALUES ($1, $2, '!', $3, $4, $5)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role"#,
        )
        .bind(id)
        .bind(email)
        .bind(role)
        .bind(name)
        .bind(org_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drop every member row this list does not authorize, so a tenant database
    /// cannot outlive the control plane's decision about who belongs to it. An
    /// empty list clears the table: no user is authorized into an organization
    /// that has lost all of them.
    pub async fn remove_members_not_in(&self, authorized: &[i64]) -> Result<u64> {
        if authorized.is_empty() {
            return Ok(sqlx::query("DELETE FROM users")
                .execute(&self.pool)
                .await?
                .rows_affected());
        }
        // Built from integers only, and the values themselves travel as binds —
        // there is no string in here for anyone but us to control.
        let placeholders: Vec<String> = (1..=authorized.len()).map(|i| format!("${i}")).collect();
        let sql = format!(
            "DELETE FROM users WHERE id NOT IN ({})",
            placeholders.join(", ")
        );
        let mut delete = sqlx::query(&sql);
        for id in authorized {
            delete = delete.bind(id);
        }
        Ok(delete.execute(&self.pool).await?.rows_affected())
    }

    /// Move an imported row's inline bytes into this install's object store,
    /// sealed for the organization that owns them. Returns the row unchanged when
    /// there is nothing to rehome.
    ///
    /// Sealing here is what keeps a restore honest: content that arrived through
    /// an archive and stayed in the clear would outlive the deletion of the key
    /// that was supposed to destroy it.
    ///
    /// Nothing here may query the database outside `tx`. Import runs inside a
    /// transaction on the install's only pooled connection, so a query on the pool
    /// would wait for that transaction forever — which is exactly how the first
    /// version of this feature deadlocked two existing tests.
    async fn rehome_content(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        row: &serde_json::Value,
        org_of_file: &HashMap<i64, i64>,
        deks: &mut HashMap<i64, [u8; 32]>,
    ) -> Result<serde_json::Value> {
        let serde_json::Value::Object(map) = row else {
            return Ok(row.clone());
        };
        let mut map = map.clone();
        let bytes = match map.get("data") {
            Some(serde_json::Value::String(text)) => B64.decode(text)?,
            Some(serde_json::Value::Null) | None => return Ok(serde_json::Value::Object(map)),
            _ => bail!("malformed export: content row holds a non-string data value"),
        };
        // A chat image names its own organization. A blob does not, so it is
        // found through the file that holds it — from the archive's rows, which
        // are in memory and already complete.
        let org_id = match map.get("org_id").and_then(|value| value.as_i64()) {
            Some(org_id) => Some(org_id),
            None => map
                .get("file_id")
                .and_then(|value| value.as_i64())
                .and_then(|file_id| org_of_file.get(&file_id).copied()),
        };
        let dek = match org_id {
            Some(org_id) => match deks.get(&org_id) {
                Some(dek) => Some(*dek),
                None => {
                    let created = self.org_dek_in(tx, org_id).await?;
                    if let Some(dek) = created {
                        deks.insert(org_id, dek);
                    }
                    created
                }
            },
            None => None,
        };
        let placed = match (dek, org_id) {
            (Some(dek), Some(org_id)) if !self.blobs.is_inline() => {
                let sealed = keystore::seal_bytes(&dek, &bytes);
                let name = Self::sealed_object_name(org_id, &sealed);
                self.blobs.put(&name, &sealed).then_some((name, bytes.len()))
            }
            _ => self
                .blobs
                .store(&bytes)
                .map(|key| (key, bytes.len())),
        };
        if let Some((key, size)) = placed {
            // An empty value, not a null: the column is NOT NULL, and reads
            // always prefer the key.
            map.insert("data".into(), serde_json::json!(""));
            map.insert("storage_key".into(), serde_json::Value::String(key));
            map.insert("size".into(), serde_json::json!(size));
        }
        Ok(serde_json::Value::Object(map))
    }

    /// `file_id -> org_id`, joined from the archive's own rows.
    ///
    /// Import cannot ask the database: the rows it would join through are being
    /// inserted by the same transaction that needs the answer. The archive carries
    /// every row of every table, so the join is done in memory instead.
    fn archive_file_orgs(tables: &[(String, Vec<serde_json::Value>)]) -> HashMap<i64, i64> {
        let column_map = |table: &str, key: &str, value: &str| -> HashMap<i64, i64> {
            let mut out = HashMap::new();
            let Some((_, rows)) = tables.iter().find(|(name, _)| name == table) else {
                return out;
            };
            for row in rows {
                let (Some(k), Some(v)) = (
                    row.get(key).and_then(|v| v.as_i64()),
                    row.get(value).and_then(|v| v.as_i64()),
                ) else {
                    continue;
                };
                out.insert(k, v);
            }
            out
        };
        let group_of_workspace = column_map("workspace", "id", "group_id");
        let org_of_group = column_map("groups", "id", "org_id");
        let file_rows = tables.iter().find(|(name, _)| name == "file");
        let mut out = HashMap::new();
        if let Some((_, rows)) = file_rows {
            for row in rows {
                let (Some(file_id), Some(workspace_id)) = (
                    row.get("id").and_then(|v| v.as_i64()),
                    row.get("workspace_id").and_then(|v| v.as_i64()),
                ) else {
                    continue;
                };
                if let Some(org_id) = group_of_workspace
                    .get(&workspace_id)
                    .and_then(|group_id| org_of_group.get(group_id))
                {
                    out.insert(file_id, *org_id);
                }
            }
        }
        out
    }

    /// Record the byte length of every blob on the row that holds it, so a size
    /// question never depends on where the bytes are. Rows written by an older
    /// build carry only `data`.
    async fn record_inline_sizes(&self) -> Result<()> {
        for table in ["file_blob", "chat_image"] {
            let sql =
                format!("UPDATE {table} SET size = LENGTH(data) WHERE size IS NULL AND data IS NOT NULL");
            let moved = sqlx::query(&sql).execute(&self.pool).await?.rows_affected();
            if moved > 0 {
                log::info!("recorded content sizes for {moved} {table} row(s)");
            }
        }
        Ok(())
    }

    /// A row's bytes, wherever they live. A row naming an object the store
    /// cannot produce is an error, not an empty file — a silently blank download
    /// is how lost data stays undiscovered.
    async fn blob_content(&self, data: Vec<u8>, key: Option<String>) -> Result<Vec<u8>> {
        match key {
            Some(key) => {
                let stored = self.blobs.get(&key).ok_or_else(|| {
                    anyhow::anyhow!(
                        "stored object {key} is missing from the {} backend",
                        self.blobs.mode()
                    )
                })?;
                self.unseal(&key, stored).await
            }
            None => Ok(data),
        }
    }

    /// One-time, at startup: copy plaintext TOTP seeds into the sealed column and
    /// empty the plaintext one. A seed that cannot be sealed fails the boot rather
    /// than being left readable, because a half-done backfill is exactly the leak
    /// the sealed column exists to close.
    async fn seal_existing_totp(&self) -> Result<()> {
        let rows: Vec<(i64, String)> =
            sqlx::query_as(r#"SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL"#)
                .fetch_all(&self.pool)
                .await?;
        for (id, seed) in &rows {
            let cipher = keystore::seal(keystore::TOTP, seed).ok_or_else(|| {
                anyhow::anyhow!("no data key available to seal existing TOTP seeds")
            })?;
            sqlx::query(
                r#"UPDATE users SET totp_secret_cipher = $1, totp_secret = NULL WHERE id = $2"#,
            )
            .bind(cipher)
            .bind(id)
            .execute(&self.pool)
            .await?;
        }
        if !rows.is_empty() {
            log::info!(
                "sealed {} TOTP seed(s) at rest (data key: {})",
                rows.len(),
                keystore::source()
            );
        }
        Ok(())
    }

    /// At startup, once: route every document that predates the routing index.
    /// A file whose workspace chain no longer resolves to a live org is left
    /// unrouted rather than guessed at — it is unreachable data, not a tenant.
    /// Rows already in the index are skipped, so running this against a healthy
    /// database changes nothing and reports zero. Returns rows added.
    async fn backfill_doc_routing(&self) -> Result<u64> {
        let added = sqlx::query(
            r#"INSERT INTO doc_org (doc_id, org_id, created_at)
               SELECT f.doc_id, g.org_id, f.created_at
               FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.doc_id NOT IN (SELECT doc_id FROM doc_org)"#,
        )
        .execute(&self.pool)
        .await?
        .rows_affected();
        if added > 0 {
            log::info!("routed {added} existing document(s) to their owning org");
        }
        Ok(added)
    }

    /// Move every document row still held in this database into the database of
    /// the organization the routing index credits it to.
    ///
    /// This is what makes an *existing* install routed rather than a new one:
    /// content an upgrade leaves here is invisible to a read that now goes to a
    /// tenant file, so an instance that turned the flag on without this would
    /// show every one of its users an empty file.
    ///
    /// Idempotent, and restartable in the way that matters. A row already present
    /// in its tenant database is never overwritten, because once a document is
    /// routed every write to it lands there and the copy here is by definition
    /// the older one. The row here goes only after its replacement is in place,
    /// so an interruption leaves content duplicated and reachable — never lost,
    /// never stranded — and the next pass finishes what it started.
    ///
    /// Returns the rows moved. Unrouted documents stay exactly where they are:
    /// there is no tenant to hand them to, and a read resolves them here.
    pub async fn migrate_content_to_orgs(&self) -> Result<u64> {
        if !self.content_is_split() {
            return Ok(0);
        }
        let mut moved = 0;
        let mut after = String::new();
        loop {
            // Paged by id rather than drained: a hundred thousand documents must
            // not be held in memory at once, and a page that cannot be moved —
            // one tenant whose file will not open — must not be read again
            // forever. `after` only ever advances.
            let rows: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
                r#"SELECT d.id, d.text, d.language, o.org_id
                   FROM document d JOIN doc_org o ON o.doc_id = d.id
                   WHERE d.id > $1 ORDER BY d.id LIMIT 200"#,
            )
            .bind(&after)
            .fetch_all(&self.pool)
            .await?;
            let Some(last) = rows.last() else {
                break;
            };
            after = last.0.clone();
            for (doc_id, text, language, org_id) in rows {
                let content = match self.content_db_for_org(Some(org_id)).await {
                    Ok(content) => content,
                    Err(e) => {
                        log::warn!("cannot move document {doc_id} to org {org_id}: {e}");
                        continue;
                    }
                };
                let document = PersistedDocument { text, language };
                let present = sqlx::query(
                    "INSERT INTO document (id, text, language) \
                     SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM document WHERE id = $1)",
                )
                .bind(&doc_id)
                .bind(&document.text)
                .bind(&document.language)
                .execute(content.write())
                .await?
                .rows_affected();
                if present == 0 {
                    log::info!("document {doc_id} was already in org {org_id}'s database");
                }
                // Only now is the copy here let go — from this database, which is
                // the one the row is being taken out of.
                sqlx::query("DELETE FROM document WHERE id = $1")
                    .bind(&doc_id)
                    .execute(&self.pool)
                    .await?;
                moved += 1;
            }
        }
        if moved > 0 {
            log::info!("moved {moved} document(s) into their organization databases");
        }
        Ok(moved)
    }

    /// Reclaim content rows the routing index no longer claims for the
    /// organization holding them, and report how many went.
    ///
    /// The collector that the ordering of a routed delete depends on: content is
    /// dropped after the control transaction that makes it unreachable, so an
    /// interrupted delete leaves a row no file names and no read will look for.
    /// It is invisible rather than lost, and this removes it.
    ///
    /// One tenant database that will not open is logged and skipped — the other
    /// organizations still get swept, and housekeeping must not be held hostage
    /// by a single damaged file.
    async fn sweep_tenant_content(&self) -> u64 {
        let Some(registries) = self.registries.get().filter(|r| r.is_split()) else {
            return 0;
        };
        let mut swept = 0;
        let orgs = match registries.openable_org_ids().await {
            Ok(orgs) => orgs,
            Err(e) => {
                log::warn!("could not list organizations to sweep: {e}");
                return swept;
            }
        };
        for org_id in orgs {
            // The index is the authority on what a tenant owns, and it is read
            // here rather than joined because it is a control-plane claim.
            let owned: HashSet<String> = match self.docs_of_org(org_id).await {
                Ok(docs) => docs.into_iter().collect(),
                Err(e) => {
                    log::warn!("could not read org {org_id}'s routing: {e}");
                    continue;
                }
            };
            let content = match registries.org(org_id).await {
                Ok(content) => content,
                Err(e) => {
                    log::warn!("could not open org {org_id}'s database: {e}");
                    continue;
                }
            };
            let held: Vec<String> =
                match sqlx::query_as::<_, (String,)>("SELECT id FROM document")
                    .fetch_all(content.read_only())
                    .await
                {
                    Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
                    Err(e) => {
                        log::warn!("could not read org {org_id}'s content: {e}");
                        continue;
                    }
                };
            let stale: Vec<String> = held
                .into_iter()
                .filter(|id| !owned.contains(id))
                .collect();
            if stale.is_empty() {
                continue;
            }
            match delete_content_ids(&content, &stale).await {
                Ok(n) => swept += n,
                Err(e) => log::warn!("could not sweep org {org_id}'s content: {e}"),
            }
        }
        swept
    }

    // ----- Documents (OT content) -----

    /// Load the text of a document from the database that holds it.
    pub async fn load(&self, document_id: &str) -> Result<PersistedDocument> {
        let content = self.content_db_for(document_id).await?;
        sqlx::query_as(r#"SELECT text, language FROM document WHERE id = $1"#)
            .bind(document_id)
            .fetch_one(content.read_only())
            .await
            .map_err(|e| e.into())
    }

    /// True when a [`Self::load`] failure means the document has no row yet, as
    /// opposed to the database being temporarily unavailable. Only the first is
    /// safe to treat as an empty document.
    pub fn is_missing_document(err: &anyhow::Error) -> bool {
        matches!(
            err.downcast_ref::<sqlx::Error>(),
            Some(sqlx::Error::RowNotFound)
        )
    }

    /// The guard [`Self::store`] and [`Self::store_document_text`] apply: a
    /// snapshot may only be written over a document a text file still names.
    ///
    /// This is a control-plane question — `file` never leaves — so it is asked
    /// here and answered before the write goes anywhere. Reading it from the
    /// tenant database is not an option: a tenant database has the schema, and
    /// an empty `file` table, because foreign keys cannot cross a database
    /// boundary and its own rows need these tables to exist.
    async fn file_names_text_doc(&self, document_id: &str) -> Result<bool> {
        let (exists,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM file WHERE doc_id = $1 AND kind = 'text')",
        )
        .bind(document_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(exists)
    }

    /// Write text directly, bypassing OT. Never recreate a deleted document:
    /// the file must still exist, and creation seeds the row in the same tx.
    pub async fn store_document_text(&self, document_id: &str, text: &str) -> Result<()> {
        let content = self.content_db_for(document_id).await?;
        // With content in this database the guard is a subquery in the same
        // statement, which is what it has always been. Once content is routed
        // the two live in different databases and no statement can join them, so
        // the check runs first — and the routed `UPDATE` still refuses a row
        // that has gone away, which is the same refusal for the same reason: it
        // is updating, never inserting, that makes resurrection impossible.
        let written = if content.shares_pool_with(self) {
            sqlx::query(
                r#"UPDATE document SET text = $2 WHERE id = $1
                   AND EXISTS (SELECT 1 FROM file WHERE doc_id = $1 AND kind = 'text')"#,
            )
            .bind(document_id)
            .bind(text)
            .execute(content.write())
            .await?
            .rows_affected()
        } else {
            if !self.file_names_text_doc(document_id).await? {
                bail!("text document no longer exists");
            }
            sqlx::query("UPDATE document SET text = $2 WHERE id = $1")
                .bind(document_id)
                .bind(text)
                .execute(content.write())
                .await?
                .rows_affected()
        };
        if written != 1 {
            bail!("text document no longer exists");
        }
        Ok(())
    }

    /// Persist a live OT snapshot. An UPDATE (not an upsert) prevents a stale
    /// persister from resurrecting a file after a concurrent hard delete.
    pub async fn store(&self, document_id: &str, document: &PersistedDocument) -> Result<()> {
        let content = self.content_db_for(document_id).await?;
        let written = if content.shares_pool_with(self) {
            sqlx::query(
                r#"UPDATE document SET text = $2, language = $3 WHERE id = $1
                   AND EXISTS (SELECT 1 FROM file WHERE doc_id = $1 AND kind = 'text')"#,
            )
            .bind(document_id)
            .bind(&document.text)
            .bind(&document.language)
            .execute(content.write())
            .await?
            .rows_affected()
        } else {
            if !self.file_names_text_doc(document_id).await? {
                bail!("text document no longer exists");
            }
            sqlx::query("UPDATE document SET text = $2, language = $3 WHERE id = $1")
                .bind(document_id)
                .bind(&document.text)
                .bind(&document.language)
                .execute(content.write())
                .await?
                .rows_affected()
        };
        if written != 1 {
            bail!("text document no longer exists");
        }
        Ok(())
    }

    /// Whether this database can write a document inside its own transaction.
    ///
    /// True in single mode and for a document no tenant owns yet, and it is what
    /// keeps those two paths exactly what they were: one statement, one commit,
    /// nothing to repair if the transaction rolls back. False once the content
    /// lives in another database, where the ordering below takes over.
    fn holds(&self, content: &Database) -> bool {
        content.shares_pool_with(self)
    }

    /// Carry the content of existing documents into the database of the
    /// organization that is about to own them.
    ///
    /// Every path that moves a document between tenants — a transfer, a merge, a
    /// workspace reparented into another organization's group — needs this:
    /// re-pointing the index without carrying the row leaves the document named
    /// by a database that has never heard of it, which a user reads as a file
    /// that emptied itself. It runs before the control transaction commits, so
    /// the moment a file is visible under its new owner its content is already
    /// there.
    ///
    /// Returns the rows to drop from their old homes once the commit lands.
    async fn carry_content_to(&self, org: Option<i64>, docs: &[String]) -> Result<Vec<(String, Option<i64>)>> {
        // An unroutable destination keeps its documents wherever they already
        // are, because the index cannot be pointed at "no one": `route_doc_tx`
        // inserts nothing when the workspace chain does not resolve, so the old
        // route — and the content it names — stays true.
        let Some(org) = org else {
            return Ok(Vec::new());
        };
        let mut stale = Vec::new();
        if !self.content_is_split() {
            return Ok(stale);
        }
        let dest = self.content_db_for_org(Some(org)).await?;
        for id in docs {
            let from = self.org_of_doc(id).await?;
            if from == Some(org) {
                continue; // already this organization's: the row is at home
            }
            match self.load(id).await {
                Ok(document) => replace_content(&dest, id, &document).await?,
                // An upload is routed like a text file but has no content row:
                // its bytes are a `file_blob`, which is control-plane data.
                Err(e) if Self::is_missing_document(&e) => continue,
                Err(e) => return Err(e),
            }
            stale.push((id.clone(), from));
        }
        Ok(stale)
    }

    /// Drop content rows whose files a control transaction has just committed
    /// away.
    ///
    /// Deliberately after the commit and deliberately tolerant: a row left
    /// behind is an orphan no file names — unreachable, metered by nothing, and
    /// reclaimed by the maintenance sweep — while failing the deletion the user
    /// asked for because one tenant database would not open is a visible harm
    /// with no corresponding benefit.
    async fn drop_content_of(&self, stale: &[(String, Option<i64>)]) -> u64 {
        let mut dropped = 0;
        for (doc_id, org) in stale {
            let content = match self.content_db_for_org(*org).await {
                Ok(content) => content,
                Err(e) => {
                    log::warn!("cannot reach the database holding {doc_id}: {e}");
                    continue;
                }
            };
            // A tenant whose database is not there cannot be holding a row, and
            // opening one to look would resurrect a file the delete above — or
            // an organization's removal — has just unlinked.
            if let (Some(org), Some(registries)) = (org, self.registries.get()) {
                if !registries.is_provisioned(*org).await {
                    continue;
                }
            }
            match delete_content(&content, doc_id).await {
                Ok(true) => dropped += 1,
                Ok(false) => {}
                Err(e) => log::warn!("could not drop the content of {doc_id}: {e}"),
            }
        }
        dropped
    }

    /// Count the documents this instance stores.
    ///
    /// With content routed per organization, counting the rows in this database
    /// would answer "how much has this instance got?" with the number of
    /// documents no tenant has been given yet — and the endpoint that shows the
    /// answer must not open a database for every organization to get it. The
    /// routing index is that count, and it is local.
    pub async fn count(&self) -> Result<usize> {
        if !self.content_is_split() {
            let row: (i64,) = sqlx::query_as("SELECT count(*) FROM document")
                .fetch_one(&self.pool)
                .await?;
            return Ok(row.0 as usize);
        }
        let (routed,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM file WHERE kind = 'text' AND doc_id IN (SELECT doc_id FROM doc_org)",
        )
        .fetch_one(&self.pool)
        .await?;
        let (here,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM document WHERE id NOT IN (SELECT doc_id FROM doc_org)",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok((routed + here) as usize)
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
        self.auth.wipe();
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
            r#"SELECT id, email, name, password_hash, role, org_id, totp_secret_cipher, totp_enabled FROM users WHERE email = $1"#,
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Update a user's display name.
    pub async fn update_name(&self, user_id: i64, name: &str) -> Result<()> {
        self.auth.wipe();
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
        self.auth.wipe();
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

    /// Update a user's password hash and revoke their other sessions. Only the
    /// session that just proved the old password survives, so a stolen cookie
    /// stops working the moment the owner changes their password. `None` keeps
    /// nothing and signs the user out everywhere.
    pub async fn update_password(
        &self,
        user_id: i64,
        password_hash: &str,
        keep_token: Option<&str>,
    ) -> Result<()> {
        self.auth.wipe();
        let mut tx = self.pool.begin().await?;
        sqlx::query(r#"UPDATE users SET password_hash = $1 WHERE id = $2"#)
            .bind(password_hash)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(r#"DELETE FROM session WHERE user_id = $1 AND token IS NOT $2"#)
            .bind(user_id)
            .bind(keep_token)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Store a pending TOTP secret (enrollment started but not yet confirmed).
    /// The seed is sealed before it is stored; a missing data key is an error,
    /// never a licence to write it in the clear.
    pub async fn set_totp_pending(&self, user_id: i64, secret: &str) -> Result<()> {
        self.auth.wipe();
        let cipher = keystore::seal(keystore::TOTP, secret)
            .ok_or_else(|| anyhow::anyhow!("no data key available to seal a TOTP seed"))?;
        sqlx::query(
            r#"UPDATE users SET totp_secret = NULL, totp_secret_cipher = $1, totp_enabled = 0
               WHERE id = $2"#,
        )
        .bind(cipher)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Flip TOTP on after the first code is verified.
    pub async fn enable_totp(&self, user_id: i64) -> Result<()> {
        self.auth.wipe();
        sqlx::query(r#"UPDATE users SET totp_enabled = 1 WHERE id = $1"#)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove TOTP entirely (user turn-off, or owner recovery / break-glass reset).
    pub async fn clear_totp(&self, user_id: i64) -> Result<()> {
        self.auth.wipe();
        sqlx::query(
            r#"UPDATE users SET totp_secret = NULL, totp_secret_cipher = NULL, totp_enabled = 0
               WHERE id = $1"#,
        )
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Clear TOTP for every root/owner account. Host-level break-glass on boot.
    pub async fn clear_totp_for_roots(&self) -> Result<u64> {
        self.auth.wipe();
        let r = sqlx::query(
            r#"UPDATE users SET totp_secret = NULL, totp_secret_cipher = NULL, totp_enabled = 0
               WHERE role = 'root'"#,
        )
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Create a session row.
    pub async fn create_session(&self, token: &str, user_id: i64, expires_at: i64) -> Result<()> {
        self.auth.wipe();
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
        use sqlx::Row;
        if let Some(entry) = self.auth.sessions.get(token) {
            let (user, valid_until) = entry.value();
            if now < *valid_until {
                self.auth.count_hit();
                return Ok(Some(user.clone()));
            }
        }
        let row = sqlx::query(
            r#"SELECT u.id, u.email, u.name, u.password_hash, u.role, u.org_id,
                      u.totp_secret_cipher, u.totp_enabled, s.expires_at AS session_expires_at
               FROM session s JOIN users u ON u.id = s.user_id
               WHERE s.token = $1 AND s.expires_at > $2"#,
        )
        .bind(token)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            self.auth.sessions.remove(token);
            return Ok(None);
        };
        let session_expires_at: i64 = row.try_get("session_expires_at")?;
        let user = User {
            id: row.try_get("id")?,
            email: row.try_get("email")?,
            name: row.try_get("name")?,
            password_hash: row.try_get("password_hash")?,
            role: row.try_get("role")?,
            org_id: row.try_get("org_id")?,
            totp_secret_cipher: row.try_get("totp_secret_cipher")?,
            totp_enabled: row.try_get("totp_enabled")?,
        };
        self.auth.sessions.insert(
            token.to_string(),
            (user.clone(), session_expires_at.min(now + AUTH_TTL)),
        );
        Ok(Some(user))
    }

    /// Delete all expired sessions (housekeeping, run on login).
    pub async fn purge_expired_sessions(&self, now: i64) -> Result<()> {
        self.auth.wipe();
        sqlx::query(r#"DELETE FROM session WHERE expires_at <= $1"#)
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a session (logout).
    pub async fn delete_session(&self, token: &str) -> Result<()> {
        self.auth.wipe();
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
            "SELECT id, email, name, password_hash, role, org_id, totp_secret_cipher, totp_enabled FROM users WHERE id = $1",
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
        self.auth.wipe();
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
        self.auth.wipe();
        let mut tx = self.pool.begin().await?;
        let r = if let Some(hash) = password_hash {
            sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2 AND role != 'root' AND ($3 IS NULL OR org_id = $3)")
                .bind(hash).bind(id).bind(scope).execute(&mut tx).await?
        } else {
            sqlx::query(
                "UPDATE users SET totp_secret = NULL, totp_secret_cipher = NULL, totp_enabled = 0 WHERE id = $1 AND role != 'root' AND ($2 IS NULL OR org_id = $2)",
            )
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
        self.auth.wipe();
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
        self.drop_content_of(&docs).await;
        Ok(docs.into_iter().map(|(doc_id, _)| doc_id).collect())
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
    pub async fn rename_org(&self, id: i64, name: &str) -> Result<bool> {
        let r = sqlx::query(r#"UPDATE org SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected() == 1)
    }

    /// Remove all org data and unassign its users in one transaction. Returns
    /// document IDs so no WebSocket can keep writing after the deletion.
    pub async fn delete_org(&self, id: i64) -> Result<Vec<String>> {
        self.auth.wipe();
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
        // The key row went with the `org` row by cascade at that commit. That is
        // the point of no return: the organization's objects are now bytes nobody
        // can read, here and in every backup that holds them. Unlinking them is
        // hygiene, not the shred — a name is a hash, an orphan leaks nothing, and
        // restoring an older control database would have brought the key back
        // anyway, which is the fact DEPLOY.md tells operators not to forget.
        let prefix = format!("o{id}-");
        let orphans: Vec<String> = self
            .blobs
            .object_keys()
            .into_iter()
            .filter(|key| key.starts_with(&prefix))
            .collect();
        for key in &orphans {
            self.blobs.delete(key).ok();
        }
        if !orphans.is_empty() {
            log::info!(
                "discarded {} object(s) of organization {id}",
                orphans.len()
            );
        }
        // Empty the tenant's database as well as unlinking it: whoever deletes
        // the organization goes on to `discard` its file, and an install that
        // reuses the id must not inherit the old rows through a file it is
        // about to recreate.
        self.drop_content_of(&docs).await;
        Ok(docs.into_iter().map(|(doc_id, _)| doc_id).collect())
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
        self.auth.wipe();
        let mut tx = self.pool.begin().await?;
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO groups (org_id, name, scope, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        )
        .bind(org_id)
        .bind(name)
        .bind(scope)
        .bind(created_by)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        // Without this row the creator could not see the group they just made,
        // so it is part of the creation, not a follow-up best effort.
        if scope == "group" {
            sqlx::query(
                r#"INSERT OR IGNORE INTO group_member (group_id, user_id, role)
                   VALUES ($1, $2, 'owner')"#,
            )
            .bind(row.0)
            .bind(created_by)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
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
        self.auth.wipe();
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
        self.auth.wipe();
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
        let key = (group_id, user_id);
        let now = wall_now();
        if let Some(entry) = self.auth.members.get(&key) {
            let (member, valid_until) = entry.value();
            if now < *valid_until {
                self.auth.count_hit();
                return Ok(*member);
            }
        }
        let row: (i64,) = sqlx::query_as(
            r#"SELECT count(*) FROM group_member WHERE group_id = $1 AND user_id = $2"#,
        )
        .bind(group_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        let member = row.0 > 0;
        self.auth.members.insert(key, (member, now + AUTH_TTL));
        Ok(member)
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
        self.drop_content_of(&docs).await;
        Ok(docs.into_iter().map(|(doc_id, _)| doc_id).collect())
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
        self.drop_content_of(&docs).await;
        Ok(docs.into_iter().map(|(doc_id, _)| doc_id).collect())
    }

    /// Move all source files into the target and remove the empty source
    /// workspace in one transaction. Preserve file/document IDs (and blobs),
    /// auto-rename conflicts rather than overwriting target data.
    pub async fn merge_workspaces(&self, source: i64, target: i64) -> Result<(usize, Vec<String>)> {
        if source == target {
            bail!("cannot merge a workspace with itself");
        }
        // Merging into another organization's workspace moves every document
        // with its files, so their content is carried first: the transaction
        // below is what makes the new owner visible, and it must never be able
        // to name a document its database has never heard of.
        let text_docs: Vec<(String,)> = sqlx::query_as(
            "SELECT doc_id FROM file WHERE workspace_id = $1 AND kind = 'text' ORDER BY doc_id",
        )
        .bind(source)
        .fetch_all(&self.pool)
        .await?;
        let text_docs: Vec<String> = text_docs.into_iter().map(|(id,)| id).collect();
        let stale = self
            .carry_content_to(self.workspace_org(target).await?, &text_docs)
            .await?;
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
            route_doc_tx(&mut tx, doc_id, target).await?;
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
        self.drop_content_of(&stale).await;
        Ok((source_files.len(), docs))
    }

    /// Reparent a workspace inside a different group without changing any
    /// file IDs. Ensure the slug stays unique within its new group.
    pub async fn move_workspace_to_group(&self, ws: &Workspace, group_id: i64) -> Result<Workspace> {
        // Reparenting changes who owns every document in the subtree, so the
        // content follows the route before the route moves — the same ordering
        // every other path that changes an owner uses.
        let text_docs: Vec<String> = sqlx::query_as(
            "SELECT doc_id FROM file WHERE workspace_id = $1 AND kind = 'text' ORDER BY doc_id",
        )
        .bind(ws.id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(id,)| id)
        .collect();
        let new_org: Option<(i64,)> = sqlx::query_as("SELECT org_id FROM groups WHERE id = $1")
            .bind(group_id)
            .fetch_optional(&self.pool)
            .await?;
        let stale = self.carry_content_to(new_org.map(|(org_id,)| org_id), &text_docs).await?;
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
        // The whole subtree changes owner with its parent group.
        route_workspace_tx(&mut tx, ws.id).await?;
        tx.commit().await?;
        self.drop_content_of(&stale).await;
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

    /// Which org's database holds this document, answered straight from the
    /// routing index — no joins, and valid even once the document's own tables
    /// live in the tenant database rather than this one. None means the index
    /// never learned this document: it is gone, or predates the table and the
    /// next boot's [`Self::backfill_doc_routing`] will route it.
    pub async fn org_of_doc(&self, doc_id: &str) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as("SELECT org_id FROM doc_org WHERE doc_id = $1")
            .bind(doc_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.0))
    }

    /// Every document routed to one org. The control plane asks this when it
    /// moves an org's whole estate into its own database — or verifies after
    /// the move that nothing was left behind.
    pub async fn docs_of_org(&self, org_id: i64) -> Result<Vec<String>> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT doc_id FROM doc_org WHERE org_id = $1 ORDER BY doc_id")
                .bind(org_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
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

    /// How many ids go into one `WHERE id IN (…)` list. SQLite's variable limit
    /// is what bounds it, and a folder listing can name thousands of documents.
    const IDS_PER_QUERY: usize = 400;

    /// Byte length of each of these documents' text, read from whichever
    /// database holds the row.
    ///
    /// A text file's size is the length of a `document` row, and that row may
    /// live in another database now: a file list, a download header and a copy
    /// all ask the question, and an answer of `0` for every text file is how a
    /// routed install silently loses its quota accounting. One query per
    /// organization named in the page, not one per file. A document with no row
    /// is absent from the result, which is the same zero the old single-database
    /// `COALESCE` produced.
    async fn text_sizes(&self, doc_ids: &[String]) -> Result<HashMap<String, i64>> {
        let mut sizes = HashMap::new();
        if doc_ids.is_empty() {
            return Ok(sizes);
        }
        let mut routes: HashMap<String, i64> = HashMap::new();
        if self.content_is_split() {
            // The routing index answers for the whole page at once, and a
            // document missing from it is one no tenant was ever told about.
            for chunk in doc_ids.chunks(Self::IDS_PER_QUERY) {
                let sql = format!(
                    "SELECT doc_id, org_id FROM doc_org WHERE doc_id IN ({})",
                    value_list(chunk.len())
                );
                let mut query = sqlx::query_as::<_, (String, i64)>(&sql);
                for id in chunk {
                    query = query.bind(id);
                }
                routes.extend(query.fetch_all(&self.pool).await?);
            }
        }
        let mut by_org: HashMap<Option<i64>, Vec<&String>> = HashMap::new();
        for id in doc_ids {
            by_org
                .entry(routes.get(id).copied())
                .or_default()
                .push(id);
        }
        for (org, ids) in by_org {
            let content = self.content_db_for_org(org).await?;
            for chunk in ids.chunks(Self::IDS_PER_QUERY) {
                let sql = format!(
                    "SELECT id, LENGTH(CAST(text AS BLOB)) FROM document WHERE id IN ({})",
                    value_list(chunk.len())
                );
                let mut query = sqlx::query_as::<_, (String, i64)>(&sql);
                for id in chunk {
                    query = query.bind(id);
                }
                sizes.extend(query.fetch_all(content.read_only()).await?);
            }
        }
        Ok(sizes)
    }

    /// Fill in the size of every text file in a list read from this database.
    ///
    /// The SQL that produced these rows measures binary content, which stays
    /// here, and leaves text at zero, which is what this corrects.
    async fn fill_text_sizes(&self, rows: &mut [FileRow]) -> Result<()> {
        let ids: Vec<String> = rows
            .iter()
            .filter(|row| row.kind == "text")
            .map(|row| row.doc_id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        let sizes = self.text_sizes(&ids).await?;
        for row in rows.iter_mut().filter(|row| row.kind == "text") {
            row.size = sizes.get(&row.doc_id).copied().unwrap_or(0);
        }
        Ok(())
    }

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
        // Resolved while the connection is still free: deciding where a
        // document's content goes asks the control database a question, and a
        // transaction on it cannot be answered by itself.
        let content = self.content_db_for_workspace(workspace_id).await?;
        let seed_here = self.holds(&content);
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
            let document = PersistedDocument {
                text: text.unwrap_or("").to_string(),
                language: None,
            };
            if seed_here {
                sqlx::query("INSERT INTO document (id, text, language) VALUES ($1, $2, NULL)")
                    .bind(doc_id)
                    .bind(text.unwrap_or(""))
                    .execute(&mut tx)
                    .await?;
            } else {
                // Written before the commit below, which is the moment a file
                // becomes visible: an editor can never see a row it cannot
                // load. If this transaction then fails, the row is a content
                // nothing names — unreachable, and reclaimed by maintenance.
                insert_content(&content, doc_id, &document).await?;
            }
        } else if let Some(bytes) = bytes {
            sqlx::query("INSERT INTO file_blob (file_id, data) VALUES ($1, $2)")
                .bind(id)
                .bind(bytes)
                .execute(&mut tx)
                .await?;
        }
        route_doc_tx(&mut tx, doc_id, workspace_id).await?;
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
        let content = self.content_db_for_workspace(workspace_id).await?;
        let seed_here = self.holds(&content);
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
                let text = std::str::from_utf8(&entry.bytes)?;
                if seed_here {
                    sqlx::query("INSERT INTO document (id, text, language) VALUES ($1, $2, NULL)")
                        .bind(&doc_id)
                        .bind(text)
                        .execute(&mut tx)
                        .await?;
                } else {
                    insert_content(
                        &content,
                        &doc_id,
                        &PersistedDocument { text: text.to_string(), language: None },
                    )
                    .await?;
                }
            } else {
                sqlx::query("INSERT INTO file_blob (file_id, data) VALUES ($1, $2)")
                    .bind(id)
                    .bind(&entry.bytes)
                    .execute(&mut tx)
                    .await?;
            }
            route_doc_tx(&mut tx, &doc_id, workspace_id).await?;
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
        let mut rows: Vec<FileRow> = sqlx::query_as(&format!(
            "SELECT {FILE_COLUMNS} FROM file f WHERE f.workspace_id = $1 ORDER BY f.path"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        self.fill_text_sizes(&mut rows).await?;
        Ok(rows)
    }

    /// Fetch a file by id.
    pub async fn get_file(&self, id: i64) -> Result<Option<FileRow>> {
        let mut row: Option<FileRow> = sqlx::query_as(&format!(
            "SELECT {FILE_COLUMNS} FROM file f WHERE f.id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = row.as_mut() {
            self.fill_text_sizes(std::slice::from_mut(row)).await?;
        }
        Ok(row)
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
        if items.is_empty() || items.len() > 5000 {
            bail!("select 1–5000 files");
        }
        // Read the sources while this database's connection is still free.
        // Copying or moving a text file across an organization boundary has to
        // ask where its content lives, and a transaction on the one pooled
        // connection cannot answer that question for itself. The transaction
        // below re-checks that every source is still there, so nothing can be
        // transferred out from under a stale plan.
        let mut sources = Vec::with_capacity(items.len());
        let mut seen = HashSet::new();
        for (id, path) in items {
            if !seen.insert(*id) || path.is_empty() || path.len() > 512 {
                bail!("invalid transfer item");
            }
            let file: Option<FileRow> = sqlx::query_as(&format!(
                "SELECT {FILE_COLUMNS} FROM file f WHERE f.id = $1"
            ))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            sources.push(file.ok_or_else(|| anyhow::anyhow!("source file not found"))?);
        }
        self.fill_text_sizes(&mut sources).await?;
        let dest_content = self.content_db_for_workspace(target_workspace).await?;
        let seed_here = self.holds(&dest_content);
        // A copy gets a document id of its own, decided now because a staged
        // content row has to be named before the transaction that names the file.
        let mut copies: HashMap<String, String> = HashMap::new();
        let mut stale: Vec<(String, Option<i64>)> = Vec::new();
        if !seed_here {
            let dest_org = self.workspace_org(target_workspace).await?;
            for src in &sources {
                if src.kind != "text" {
                    continue; // an upload's bytes are a `file_blob`, which stays here
                }
                let from = self.org_of_doc(&src.doc_id).await?;
                let document = match snapshots.get(&src.doc_id) {
                    Some(snapshot) => snapshot.clone(),
                    None => match self.load(&src.doc_id).await {
                        Ok(document) => document,
                        Err(e) if Self::is_missing_document(&e) => {
                            if copy {
                                bail!("source text content missing");
                            }
                            continue; // a move of a document with nothing stored
                        }
                        Err(e) => return Err(e),
                    },
                };
                if copy {
                    let doc_id = random_id();
                    insert_content(&dest_content, &doc_id, &document).await?;
                    copies.insert(src.doc_id.clone(), doc_id);
                } else if from != dest_org {
                    replace_content(&dest_content, &src.doc_id, &document).await?;
                    stale.push((src.doc_id.clone(), from));
                }
            }
        }
        let mut tx = self.pool.begin().await?;
        for src in &sources {
            let still_there: Option<(i64,)> = sqlx::query_as("SELECT id FROM file WHERE id = $1")
                .bind(src.id)
                .fetch_optional(&mut tx)
                .await?;
            if still_there.is_none() {
                bail!("source file not found");
            }
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
                let doc_id = copies
                    .get(&src.doc_id)
                    .cloned()
                    .unwrap_or_else(random_id);
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
                    if seed_here {
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
                        // Already in the destination's database, staged above
                        // this transaction: the copy is only claimable once the
                        // content it names is reachable from it.
                        src.size = snapshots
                            .get(&src.doc_id)
                            .map(|snapshot| snapshot.text.len() as i64)
                            .unwrap_or(src.size);
                    }
                } else {
                    let rows = sqlx::query("INSERT INTO file_blob (file_id, data, storage_key, size) SELECT $1, data, storage_key, size FROM file_blob WHERE file_id = $2")
                        .bind(id)
                        .bind(src.id)
                        .execute(&mut tx)
                        .await?.rows_affected();
                    if rows != 1 { bail!("source blob content missing"); }
                }
                route_doc_tx(&mut tx, &doc_id, target_workspace).await?;
                src.id = id;
                src.doc_id = doc_id;
            } else {
                sqlx::query("UPDATE file SET workspace_id = $1, path = $2 WHERE id = $3")
                    .bind(target_workspace)
                    .bind(&path)
                    .bind(src.id)
                    .execute(&mut tx)
                    .await?;
                // A move across org boundaries re-routes the document and
                // carries its content with the route; within one org it restates
                // the answer. Either way the index cannot drift.
                route_doc_tx(&mut tx, &src.doc_id, target_workspace).await?;
            }
            src.workspace_id = target_workspace;
            src.path = path;
            result.push(src);
        }
        tx.commit().await?;
        // A moved document's old home is emptied only now that the route that
        // no longer uses it is gone: the row left behind would be invisible
        // either way, and dropping it here cannot fail the transfer.
        self.drop_content_of(&stale).await;
        Ok(result)
    }

    /// Decide where new bytes go. With an object backend the bytes are stored
    /// once under their content hash and the row keeps only the key; with the
    /// inline backend the row keeps the bytes, exactly as before.
    ///
    /// The row's `data` column is NOT NULL in the schema, so a keyed row keeps an
    /// empty placeholder rather than a null. Reads always prefer the key, and the
    /// `size` column is what byte accounting uses, so the placeholder is never
    /// mistaken for content.
    /// Decide where new bytes go, sealing them for the owning organization when
    /// this install can. With an object backend the bytes are stored once and the
    /// row keeps only the name; with the inline backend the row keeps the bytes,
    /// exactly as before.
    ///
    /// Inline bytes are deliberately not sealed. They live in a row that deleting
    /// the organization already removes, so a key would buy no destruction and
    /// add one way to lose content permanently. Sealing exists for objects, which
    /// outlive the rows that name them — including in backups.
    ///
    /// The row's `data` column is NOT NULL in the schema, so a keyed row keeps an
    /// empty placeholder rather than a null. Reads always prefer the key, and the
    /// `size` column is what byte accounting uses, so the placeholder is never
    /// mistaken for content.
    async fn place_for(
        &self,
        org_id: Option<i64>,
        data: &[u8],
    ) -> Result<(Vec<u8>, Option<String>, i64)> {
        // Only an install that puts bytes in objects can seal them, and only one
        // that is about to seal may mint a key. A row-based install that created a
        // data key would hold a key over content it never encrypted — and a
        // shredding story about protecting bytes it still has in the clear.
        let dek = match (org_id, self.blobs.is_inline()) {
            (Some(org_id), false) => self.org_dek(org_id).await?,
            (_, true) | (None, _) => None,
        };
        let key = match (org_id, dek) {
            (Some(org_id), Some(dek)) => {
                let sealed = keystore::seal_bytes(&dek, data);
                let name = Self::sealed_object_name(org_id, &sealed);
                self.blobs.put(&name, &sealed).then_some(name)
            }
            // No organization, no key, or an inline row: store content exactly as
            // this install always has, so nothing written before organization keys
            // existed becomes unreadable on upgrade.
            _ => self.blobs.store(data),
        };
        let inline = if key.is_some() { Vec::new() } else { data.to_vec() };
        Ok((inline, key, data.len() as i64))
    }

    /// The organization's data key, created on first use.
    ///
    /// `None` means this install has no master key, so it can neither seal content
    /// nor shred it; bytes are stored as they were before this existed.
    async fn org_dek(&self, org_id: i64) -> Result<Option<[u8; 32]>> {
        if let Some((_, wrapped)) = self.org_dek_stored(org_id).await? {
            return Ok(keystore::unwrap_dek(&wrapped));
        }
        let Some(wrapped) = keystore::wrap_dek(&keystore::new_dek()) else {
            return Ok(None);
        };
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default();
        sqlx::query("INSERT OR IGNORE INTO org_keys (org_id, dek_cipher, created_at) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(&wrapped)
            .bind(created_at)
            .execute(&self.pool)
            .await?;
        // Two racing writers both insert-or-ignore and re-read, so the loser
        // adopts the winner's key rather than installing a second one whose
        // objects the first could never open.
        let (_, stored) = self.org_dek_stored(org_id).await?.ok_or_else(|| {
            anyhow::anyhow!("organization {org_id}'s data key vanished while being created")
        })?;
        Ok(keystore::unwrap_dek(&stored))
    }

    /// The same, through an open transaction. Import needs this: the pool has one
    /// connection, and a query for a key while a transaction holds it would wait
    /// for that same transaction forever.
    async fn org_dek_in(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        org_id: i64,
    ) -> Result<Option<[u8; 32]>> {
        if let Some((_, wrapped)) =
            sqlx::query_as::<_, (i64, String)>(
                "SELECT org_id, dek_cipher FROM org_keys WHERE org_id = $1",
            )
            .bind(org_id)
            .fetch_optional(&mut *tx)
            .await?
        {
            return Ok(keystore::unwrap_dek(&wrapped));
        }
        let Some(wrapped) = keystore::wrap_dek(&keystore::new_dek()) else {
            return Ok(None);
        };
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default();
        sqlx::query("INSERT OR IGNORE INTO org_keys (org_id, dek_cipher, created_at) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(&wrapped)
            .bind(created_at)
            .execute(&mut *tx)
            .await?;
        let (_, stored) = sqlx::query_as::<_, (i64, String)>(
            "SELECT org_id, dek_cipher FROM org_keys WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| anyhow::anyhow!("organization {org_id}'s data key vanished while being created"))?;
        Ok(keystore::unwrap_dek(&stored))
    }

    /// Whether this install seals organization content at all.
    ///
    /// Two things have to hold: content has to live in objects rather than in rows,
    /// and a master key has to be loaded to wrap organization keys. An inline
    /// install fails the first test and is honest about it — its content is gone
    /// with the row that held it, and no key is involved either way.
    pub fn content_sealed(&self) -> bool {
        !self.blobs.is_inline() && keystore::source() != "unset"
    }

    /// How many organizations hold a data key. A caller that cannot read this says
    /// "unknown", not zero: "no organization keys exist here" is a claim about
    /// whether stored content can still be read.
    pub async fn org_key_count(&self) -> Result<i64> {
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM org_keys").fetch_one(&self.pool).await?;
        Ok(n)
    }

    /// The stored (wrapped) key, without creating one. Reads must use this: a read
    /// that minted a fresh key would turn a shredded organization's objects into a
    /// mystery instead of the clear failure they are.
    async fn org_dek_stored(&self, org_id: i64) -> Result<Option<(i64, String)>> {
        Ok(
            sqlx::query_as::<_, (i64, String)>(
                "SELECT org_id, dek_cipher FROM org_keys WHERE org_id = $1",
            )
            .bind(org_id)
            .fetch_optional(&self.pool)
            .await?,
        )
    }

    /// The object-store name for sealed content.
    ///
    /// The organization is part of the name, so a reader knows which key to ask for
    /// without a query, and two organizations holding identical bytes stop sharing
    /// an object — which is the entire point: a shared object is content that
    /// survives the deletion of either owner's key.
    fn sealed_object_name(org_id: i64, sealed: &[u8]) -> String {
        format!("o{org_id}-{}", crate::blobstore::content_key(sealed))
    }

    /// The organization an object name belongs to, or `None` for an object written
    /// before names carried one.
    fn sealed_object_org(key: &str) -> Option<i64> {
        let body = key.strip_prefix('o')?;
        let (org, _) = body.split_once('-')?;
        org.parse().ok()
    }

    /// Stored bytes, unsealed if they are sealed. An organization whose key is
    /// gone gets an error, never empty bytes: silent blanks are how destroyed data
    /// stays undiscovered until someone notices a file is missing.
    async fn unseal(&self, key: &str, stored: Vec<u8>) -> Result<Vec<u8>> {
        if !keystore::is_sealed(&stored) {
            return Ok(stored);
        }
        let Some(org_id) = Self::sealed_object_org(key) else {
            bail!("stored object {key} is sealed but its name names no organization");
        };
        let Some((_, wrapped)) = self.org_dek_stored(org_id).await? else {
            bail!("organization {org_id}'s data key is gone, so its stored content cannot be read");
        };
        let dek = keystore::unwrap_dek(&wrapped).ok_or_else(|| {
            anyhow::anyhow!("organization {org_id}'s data key cannot be unwrapped by this install")
        })?;
        keystore::open_bytes(&dek, &stored).ok_or_else(|| {
            anyhow::anyhow!("stored object {key} does not match organization {org_id}'s key")
        })
    }

    /// Store raw bytes for a binary file.
    pub async fn store_blob(&self, file_id: i64, data: &[u8]) -> Result<()> {
        let (inline, key, size) = self
            .place_for(self.file_org(file_id).await?, data)
            .await?;
        sqlx::query(
            r#"INSERT INTO file_blob (file_id, data, storage_key, size) VALUES ($1, $2, $3, $4)
               ON CONFLICT(file_id) DO UPDATE SET
                 data = excluded.data,
                 storage_key = excluded.storage_key,
                 size = excluded.size,
                 revision = file_blob.revision + 1"#,
        )
        .bind(file_id)
        .bind(inline)
        .bind(key)
        .bind(size)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Replace a blob only if it still has the revision read by the client. The
    /// object is written before the guarded update, because an object store
    /// cannot join this transaction; a revision that no longer matches leaves the
    /// new object unreferenced, and maintenance collects it.
    pub async fn store_blob_at_revision(
        &self,
        file_id: i64,
        data: &[u8],
        expected_revision: i64,
    ) -> Result<Option<i64>> {
        let (inline, key, size) = self
            .place_for(self.file_org(file_id).await?, data)
            .await?;
        let row: Option<(i64,)> = sqlx::query_as(
            r#"UPDATE file_blob
               SET data = $1, storage_key = $2, size = $3, revision = revision + 1
               WHERE file_id = $4 AND revision = $5
               RETURNING revision"#,
        )
        .bind(inline)
        .bind(key)
        .bind(size)
        .bind(file_id)
        .bind(expected_revision)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|result| result.0))
    }

    /// Load raw bytes for a binary file.
    pub async fn load_blob(&self, file_id: i64) -> Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>, Option<String>)> = sqlx::query_as(
            "SELECT data, storage_key FROM file_blob WHERE file_id = $1",
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some((data, key)) => Ok(Some(self.blob_content(data, key).await?)),
            None => Ok(None),
        }
    }

    /// Load a binary file's bytes together with its concurrency revision.
    pub async fn load_blob_with_revision(&self, file_id: i64) -> Result<Option<(Vec<u8>, i64)>> {
        let row: Option<(Vec<u8>, Option<String>, i64)> = sqlx::query_as(
            "SELECT data, storage_key, revision FROM file_blob WHERE file_id = $1",
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some((data, key, revision)) => {
                Ok(Some((self.blob_content(data, key).await?, revision)))
            }
            None => Ok(None),
        }
    }

    /// Hard-delete files and their content. Returns their document IDs so the
    /// caller can close any live collaborative sessions immediately. Unknown IDs
    /// fail the entire batch instead of reporting false success.
    ///
    /// The rows this database owns — `file`, its blob, the routing index — go in
    /// one transaction. Content in another organization's database cannot join
    /// it and is dropped once that transaction has committed, which is the order
    /// that can only ever leave an unreachable orphan behind: a file that outlives
    /// its own content is the failure a user can see, and it is not available
    /// here.
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
            // Asked before the index goes, because the index is the answer.
            let org = route_of_doc_tx(&mut tx, &doc_id).await?;
            sqlx::query("DELETE FROM file_blob WHERE file_id = $1")
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query("DELETE FROM file WHERE id = $1")
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query("DELETE FROM doc_org WHERE doc_id = $1")
                .bind(&doc_id)
                .execute(&mut tx)
                .await?;
            docs.push((doc_id, org));
        }
        tx.commit().await?;
        self.drop_content_of(&docs).await;
        Ok(docs.into_iter().map(|(doc_id, _)| doc_id).collect())
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

    /// Total content bytes held by binary rows, whether they live in the
    /// database or in the object store.
    pub async fn blob_bytes(&self) -> Result<i64> {
        let (a,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(COALESCE(size, LENGTH(data))),0) FROM file_blob",
        )
        .fetch_one(&self.pool)
        .await?;
        let (b,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(COALESCE(size, LENGTH(data))),0) FROM chat_image",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(a + b)
    }

    /// Accounts in one org, which is what a plan's seat count is compared
    /// against. Root accounts are excluded: they are the operator, not a tenant.
    pub async fn org_user_count(&self, org_id: i64) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM users WHERE org_id = $1 AND role != 'root'",
        )
        .bind(org_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    /// Every content byte an organization owns: binary blobs, chat attachments
    /// The lock that serializes one organization's storage accounting. Distinct
    /// organizations never wait on each other.
    fn quota_gate(&self, org_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        // `entry`, not get-then-insert: two racing callers that both miss the
        // map would otherwise each create their own mutex, each insert over the
        // other, and serialize nothing at all.
        self.quota_locks
            .entry(org_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Measure what an organization holds and decide whether `add` more bytes
    /// fit under `limit`, as one indivisible step.
    ///
    /// Checking a ceiling by measuring and *then* writing is a race that costs
    /// the plan its meaning: two uploads measure the same total, both see room,
    /// and the organization ends up storing more than it pays for. Taking the
    /// per-organization lock here and handing its guard back means the next
    /// upload cannot even measure until this one's row is on disk.
    pub async fn reserve_content_bytes(&self, org_id: i64, add: i64, limit: i64) -> Result<Quota> {
        if limit == i64::MAX {
            return Ok(Quota::Unlimited);
        }
        let hold = Arc::clone(&self.quota_gate(org_id)).lock_owned().await;
        if self.org_content_bytes(org_id).await? + add > limit {
            return Ok(Quota::Over);
        }
        Ok(Quota::Admitted(QuotaHold { _hold: hold }))
    }

    /// and document text. Text is counted because a ceiling that only measures
    /// uploads is trivially escaped by typing. Reads `size`, so content that has
    /// moved to the object store is still counted.
    pub async fn org_content_bytes(&self, org_id: i64) -> Result<i64> {
        let (files,): (i64,) = sqlx::query_as(
            r#"SELECT COALESCE(SUM(COALESCE(b.size, LENGTH(b.data))),0)
               FROM file_blob b
               JOIN file f ON f.id = b.file_id
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE g.org_id = $1"#,
        )
        .bind(org_id)
        .fetch_one(&self.pool)
        .await?;
        let (images,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(COALESCE(size, LENGTH(data))),0) FROM chat_image WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_one(&self.pool)
        .await?;
        let (mut text,): (i64,) = sqlx::query_as(
            r#"SELECT COALESCE(SUM(LENGTH(CAST(d.text AS BLOB))),0)
               FROM document d
               JOIN file f ON f.doc_id = d.id AND f.kind = 'text'
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE g.org_id = $1"#,
        )
        .bind(org_id)
        .fetch_one(&self.pool)
        .await?;
        // What this database can still see of an organization's text is only the
        // part that has not moved. Reading it alone in a routed install would
        // report a tenant typing nothing and hand it an unlimited ceiling, so
        // the meter asks the organization's own database for the rest.
        text += self.routed_text_bytes(org_id).await?;
        Ok(files + images + text)
    }

    /// Bytes of text stored in the database of the organization that owns it.
    /// Zero in single mode, where the meter's own query already saw every row.
    async fn routed_text_bytes(&self, org_id: i64) -> Result<i64> {
        if !self.content_is_split() {
            return Ok(0);
        }
        let docs = self.docs_of_org(org_id).await?;
        if docs.is_empty() {
            return Ok(0);
        }
        let content = self.content_db_for_org(Some(org_id)).await?;
        let mut total = 0;
        for chunk in docs.chunks(Self::IDS_PER_QUERY) {
            let sql = format!(
                "SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))),0) FROM document WHERE id IN ({})",
                value_list(chunk.len())
            );
            let mut query = sqlx::query_as::<_, (i64,)>(&sql);
            for id in chunk {
                query = query.bind(id);
            }
            total += query.fetch_one(content.read_only()).await?.0;
        }
        Ok(total)
    }

    /// How many identity answers came from cache rather than the database. A
    /// number worth seeing in the console, because a cache that never hits is
    /// only a stale-read risk.
    pub fn auth_cache_hits(&self) -> u64 {
        self.auth.hits.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Which backend content is kept in, for the owner console: `inline` while
    /// bytes sit in the database file, `fs` once they live beside it.
    pub fn blob_backend(&self) -> &'static str {
        self.blobs.mode()
    }

    /// Content bytes that live outside the database file, and so are not covered
    /// by a backup of that file alone. Zero while the inline backend is active.
    pub async fn object_bytes(&self) -> Result<i64> {
        let mut total = 0;
        for table in ["file_blob", "chat_image"] {
            let (n,): (i64,) = sqlx::query_as(&format!(
                "SELECT COALESCE(SUM(size),0) FROM {table} WHERE storage_key IS NOT NULL"
            ))
            .fetch_one(&self.pool)
            .await?;
            total += n;
        }
        Ok(total)
    }

    /// Objects no row refers to any more. Row deletes deliberately do not touch
    /// the object store — a content-addressed object can be shared by any number
    /// of rows, so the only safe place to decide is here, where every reference
    /// can be checked at once.
    pub async fn unreferenced_objects(&self) -> Result<Vec<String>> {
        let mut referenced: HashSet<String> = HashSet::new();
        for table in ["file_blob", "chat_image"] {
            let keys: Vec<(String,)> = sqlx::query_as(&format!(
                "SELECT DISTINCT storage_key FROM {table} WHERE storage_key IS NOT NULL"
            ))
            .fetch_all(&self.pool)
            .await?;
            referenced.extend(keys.into_iter().map(|(key,)| key));
        }
        let mut orphaned = Vec::new();
        for key in self.blobs.object_keys() {
            if !referenced.contains(&key) {
                orphaned.push(key);
            }
        }
        Ok(orphaned)
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

    /// One housekeeping sweep: a single DELETE, in a transaction of its own.
    ///
    /// The pool has exactly one connection, and a request that cannot get it is
    /// refused as busy — so the grain at which housekeeping commits is the grain
    /// at which it yields. Run as one seven-statement transaction, a pass holds
    /// that connection for the sum of its statements and every request arriving
    /// inside the window is told the database is busy; run one statement at a
    /// time, a waiting request takes the connection in the gap between two
    /// sweeps, and the worst queue a request can be given is a single DELETE.
    ///
    /// Nothing here needs the sweeps to land together: each is an idempotent
    /// repair that re-runs on the next pass. The one pair that does need it —
    /// orphan documents and their routing rows — commits together in
    /// [`Self::sweep_pair`], because a routing row that outlives its document by
    /// even one transaction is a tenant database the control plane still
    /// believes it must keep.
    async fn sweep(&self, statement: &str, bind: Option<i64>) -> Result<u64> {
        let mut query = sqlx::query(statement);
        if let Some(value) = bind {
            query = query.bind(value);
        }
        let mut tx = self.pool.begin().await?;
        let rows = query.execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        Ok(rows)
    }

    /// Two statements that must disappear together, counted by the first.
    async fn sweep_pair(&self, first: &str, second: &str) -> Result<u64> {
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(first).execute(&mut *tx).await?.rows_affected();
        sqlx::query(second).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(rows)
    }

    /// Daily in-app housekeeping.
    ///
    /// Every step runs on the application's own connection, because a second
    /// connection in this process can invalidate the snapshot a running
    /// transaction has already read — see [`Self::open_pool`] and the measurement
    /// in `tests/maintenance_busy.rs`. What keeps a request from being queued
    /// behind the pass is therefore how the pass is cut up, not where it runs:
    /// [`Self::sweep`] yields between statements, [`vacuum_ceiling_bytes`] bounds
    /// the one statement that cannot be interrupted, and a step that cannot get
    /// the write lock is reported as deferred rather than as a failed pass.
    ///
    /// VACUUM is outside the cleanup transactions because it temporarily needs
    /// additional disk space and the write lock. Avoid doing it for tiny
    /// files/short-lived free pages. Explicit owner requests force compaction
    /// regardless of the free-page threshold or the size bound.
    pub async fn maintain(&self, now: i64, retention_days: i64, force: bool) -> Result<MaintenanceReport> {
        let _guard = self.maintenance_lock.lock().await;
        let db_bytes_before = self.db_size_bytes().await?;
        let expired_sessions = self
            .sweep("DELETE FROM session WHERE expires_at <= $1", Some(now))
            .await?;
        // A routing row for a document no file names any more is a pointer to
        // nothing, so the two sweeps share a transaction. Every delete path
        // drops both in-transaction; this repair is the belt-and-braces sweep,
        // the same kind boot-time backfill is.
        let mut orphan_documents = self
            .sweep_pair(
                "DELETE FROM document WHERE NOT EXISTS (SELECT 1 FROM file WHERE file.doc_id = document.id AND file.kind = 'text')",
                "DELETE FROM doc_org WHERE doc_id NOT IN (SELECT doc_id FROM file)",
            )
            .await?;
        let orphan_blobs = self
            .sweep(
                "DELETE FROM file_blob WHERE NOT EXISTS (SELECT 1 FROM file WHERE file.id = file_blob.file_id)",
                None,
            )
            .await?;
        let orphan_reactions = self
            .sweep(
                "DELETE FROM reaction WHERE (kind = 'ws' AND NOT EXISTS (SELECT 1 FROM message WHERE message.id = reaction.msg_id)) OR (kind = 'dm' AND NOT EXISTS (SELECT 1 FROM dm WHERE dm.id = reaction.msg_id)) OR kind NOT IN ('ws', 'dm') OR NOT EXISTS (SELECT 1 FROM users WHERE users.id = reaction.user_id)",
                None,
            )
            .await?;
        // Give in-flight pasted images a week to be referenced by a message.
        // `instr` may keep a false-positive numeric prefix, never delete a
        // referenced image. Images for a deleted org are already removed there.
        let orphan_chat_images = self
            .sweep(
                "DELETE FROM chat_image WHERE created_at < $1 AND NOT EXISTS (SELECT 1 FROM message WHERE message.org_id = chat_image.org_id AND instr(message.body, '/api/chat-image/' || chat_image.id) > 0) AND NOT EXISTS (SELECT 1 FROM dm WHERE dm.org_id = chat_image.org_id AND instr(dm.body, '/api/chat-image/' || chat_image.id) > 0)",
                Some(now - 7 * 86400),
            )
            .await?;
        let pruned_audit = self
            .sweep(
                "DELETE FROM audit WHERE created_at < $1",
                Some(now - retention_days.clamp(1, 36_500) * 86400),
            )
            .await?;
        // Content an organization's database is still holding after the control
        // plane let it go. A routed delete drops rows *after* the commit, so the
        // residue of an interruption is a row nothing names — and this is what
        // collects it. Counted with the orphans found here, because the console
        // reports one number and a tenant's leftovers are the same problem.
        orphan_documents += self.sweep_tenant_content().await;

        // Objects are reclaimed only after the deletes above are committed: until
        // this point a row may still name them, and a content-addressed object can
        // be shared by any number of rows.
        let mut released_objects = 0;
        for key in self.unreferenced_objects().await? {
            if self.blobs.delete(&key).is_ok() {
                released_objects += 1;
            }
        }

        let free_bytes_before = self.free_bytes().await?;
        // `VACUUM` is the one statement here that cannot be made short by
        // yielding: it rewrites the whole live database and cannot be
        // interrupted, so a request that arrives during it waits for it whatever
        // the shape of the pass. Its duration belongs to the size of the file,
        // which is what an operator can be asked about.
        let ceiling = vacuum_ceiling_bytes();
        let capped = !force && ceiling > 0 && db_bytes_before > ceiling;
        let vacuum_needed = !capped
            && (force
                || free_bytes_before >= 16 * 1024 * 1024
                    && free_bytes_before * 5 >= db_bytes_before);
        if capped {
            log::info!(
                "housekeeping: no compaction, {} bytes of database is past CORTEX_VACUUM_MAX_DB_MB",
                db_bytes_before
            );
        }
        // PASSIVE checkpoint does not wait for readers; a full VACUUM only
        // starts if a TRUNCATE checkpoint obtains the lock. Neither can run in
        // the cleanup transactions above.
        let mode = if vacuum_needed { "TRUNCATE" } else { "PASSIVE" };
        let (checkpoint_busy, _, _): (i64, i64, i64) =
            match sqlx::query_as::<_, (i64, i64, i64)>(&format!("PRAGMA wal_checkpoint({mode})"))
                .fetch_one(&self.pool)
                .await
            {
                Ok(row) => row,
                // Somebody else holds the writer — a backup, an import — so the
                // WAL cannot be handed over now. That is a deferral, not a failed
                // pass: the sweeps above are already committed, and the next tick
                // catches up. Reporting it as an error would bury the one log
                // line that says housekeeping actually ran.
                Err(err) => {
                    log::info!("housekeeping: WAL checkpoint deferred: {err}");
                    (1, 0, 0)
                }
            };
        let mut vacuumed = vacuum_needed && checkpoint_busy == 0;
        if vacuumed {
            if let Err(err) = sqlx::query("VACUUM").execute(&self.pool).await {
                log::info!("housekeeping: compaction deferred: {err}");
                vacuumed = false;
            } else {
                // VACUUM itself writes WAL pages; truncate those too when possible.
                let _: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
                    .fetch_one(&self.pool)
                    .await?;
            }
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
            released_objects,
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

    /// Read an instance-level switch. `None` means never set, so callers pick
    /// their own default.
    pub async fn setting(&self, key: &str) -> Result<Option<String>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM app_setting WHERE key = $1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }

    /// Create or replace an instance-level switch.
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO app_setting (key, value) VALUES ($1, $2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Whether security events are being recorded. Off is only ever an explicit
    /// choice, so an absent row means on.
    pub async fn audit_enabled(&self) -> bool {
        self.setting("audit_enabled")
            .await
            .ok()
            .flatten()
            .map(|v| v != "0")
            .unwrap_or(true)
    }

    /// Append an audit entry. Best-effort — callers ignore the result.
    pub async fn audit(
        &self,
        org_id: Option<i64>,
        user_id: Option<i64>,
        action: &str,
        detail: Option<&str>,
        now: i64,
    ) -> Result<()> {
        if !self.audit_enabled().await {
            return Ok(());
        }
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

    /// Drop recorded events — every org's for root, otherwise one org's.
    /// Returns how many rows went away.
    pub async fn clear_audit(&self, org_id: Option<i64>, all: bool) -> Result<u64> {
        let n = if all {
            sqlx::query("DELETE FROM audit").execute(&self.pool).await?
        } else {
            sqlx::query("DELETE FROM audit WHERE org_id = $1")
                .bind(org_id)
                .execute(&self.pool)
                .await?
        };
        Ok(n.rows_affected())
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

    // ----- Chat images (conversation-scoped blobs, separate from workspace files) -----

    /// Store a pasted chat image and return its id.
    pub async fn create_chat_image(
        &self,
        org_id: i64,
        uploaded_by: i64,
        scope: ChatImageScope,
        mime: Option<&str>,
        data: &[u8],
        now: i64,
    ) -> Result<i64> {
        let (inline, key, size) = self.place_for(Some(org_id), data).await?;
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO chat_image
                 (org_id, mime, data, created_at, uploaded_by, group_id, dm_with, storage_key, size)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id"#,
        )
        .bind(org_id)
        .bind(mime)
        .bind(inline)
        .bind(now)
        .bind(uploaded_by)
        .bind(scope.group_id)
        .bind(scope.dm_with)
        .bind(key)
        .bind(size)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0)
    }

    /// Load a chat image with the conversation it may be read in.
    pub async fn get_chat_image(&self, id: i64) -> Result<Option<ChatImage>> {
        use sqlx::Row;
        let row = sqlx::query(
            r#"SELECT org_id, uploaded_by, group_id, dm_with, mime, data, storage_key
               FROM chat_image WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let data = self
            .blob_content(row.try_get("data")?, row.try_get("storage_key")?)
            .await?;
        Ok(Some(ChatImage {
            org_id: row.try_get("org_id")?,
            uploaded_by: row.try_get("uploaded_by")?,
            group_id: row.try_get("group_id")?,
            dm_with: row.try_get("dm_with")?,
            mime: row.try_get("mime")?,
            data,
        }))
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
        "doc_org",
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
    /// Every organization's data key, resolved before the export transaction
    /// opens: the pool has one connection, so a query from inside that
    /// transaction would wait for itself forever.
    ///
    /// An archive must carry bytes the restoring install can read. Its keys are
    /// its own, so shipping sealed objects would produce a backup that imports
    /// ciphertext and re-seals it as if it were content — a restore that quietly
    /// destroys what it restored.
    async fn export_deks(&self) -> Result<HashMap<i64, [u8; 32]>> {
        let rows = sqlx::query_as::<_, (i64, String)>("SELECT org_id, dek_cipher FROM org_keys")
            .fetch_all(&self.pool)
            .await?;
        let mut out = HashMap::new();
        for (org_id, wrapped) in rows {
            if let Some(dek) = keystore::unwrap_dek(&wrapped) {
                out.insert(org_id, dek);
            }
        }
        Ok(out)
    }

    /// Read a consistent whole-instance snapshot in one SQLite read
    /// transaction. Exporting tables one-by-one without a snapshot can produce
    /// dangling file/blob/user references during concurrent edits and deletes.
    /// The session table is deliberately excluded (auth tokens never travel).
    pub async fn export_snapshot(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        // The organizations' content is read *before* this database's transaction
        // opens, for two reasons that are both load-bearing. Mechanically, the
        // pool has one connection and a transaction on it would wait for itself
        // forever. Correctly, because content is always written before the file
        // row that names it: reading content first can only ever add a row the
        // archive does not need, while reading it last could produce an archive
        // naming a file whose content it does not carry.
        let mut tenant_content = self.exported_tenant_content().await?;
        // Resolved before the transaction opens; see [`Self::export_deks`].
        let deks = self.export_deks().await?;
        let mut tx = self.pool.begin().await?;
        let mut out = serde_json::Map::new();
        for table in Self::MIGRATE_TABLES {
            let rows = sqlx::query(&format!("SELECT * FROM {table}"))
                .fetch_all(&mut tx).await?;
            let mut values = Vec::with_capacity(rows.len());
            for row in rows {
                let mut obj = row_to_json(&row)?;
                // A whole-instance archive always carries its content inline, so
                // it stays readable by an install on the inline backend and by a
                // build that predates the object store entirely.
                if *table == "file_blob" || *table == "chat_image" {
                    self.archive_content_row(table, &mut obj, &deks)?;
                }
                values.push(serde_json::Value::Object(obj));
            }
            if *table == "document" {
                values.append(&mut tenant_content);
            }
            out.insert((*table).to_string(), serde_json::Value::Array(values));
        }
        tx.rollback().await?;
        Ok(out)
    }

    /// One organization's rows, in the same table shape a whole-instance archive
    /// uses, so the same import code can read either.
    ///
    /// The point is a handover or a backup that leaves the other tenants alone. The
    /// cost is that a single-organization archive can only *replace* a dataset: row
    /// ids are kept as they were, because renumbering them across fourteen tables
    /// and rewriting every reference is how one tenant ends up inheriting another's
    /// rows. So [`Self::orgs_other_than`] guards the restore, and an instance that
    /// holds any other organization refuses the archive instead of merging badly.
    pub async fn export_org_snapshot(
        &self,
        org_id: i64,
    ) -> Result<serde_json::Map<String, serde_json::Value>> {
        let known: Option<(i64,)> = sqlx::query_as("SELECT id FROM org WHERE id = $1")
            .bind(org_id)
            .fetch_optional(&self.pool)
            .await?;
        if known.is_none() {
            bail!("organization {org_id} does not exist");
        }
        // The documents this tenant's files name, resolved here because the tenant's
        // content lives in another database and the predicate belongs to this one.
        let doc_ids: HashSet<String> = sqlx::query_as::<_, (String,)>(
            r#"SELECT f.doc_id FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE g.org_id = $1"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(doc_id,)| doc_id)
        .collect();
        let mut tenant_content = self.exported_org_content(org_id, &doc_ids).await?;
        let deks = self.export_deks().await?;
        let mut tx = self.pool.begin().await?;
        let mut out = serde_json::Map::new();
        for table in Self::MIGRATE_TABLES {
            let rows = sqlx::query(&format!(
                "SELECT * FROM {table} WHERE {}",
                Self::org_scope_sql(table)
            ))
            .bind(org_id)
            .fetch_all(&mut tx)
            .await?;
            let mut values = Vec::with_capacity(rows.len());
            for row in rows {
                let mut obj = row_to_json(&row)?;
                if *table == "file_blob" || *table == "chat_image" {
                    self.archive_content_row(table, &mut obj, &deks)?;
                }
                values.push(serde_json::Value::Object(obj));
            }
            if *table == "document" {
                values.append(&mut tenant_content);
            }
            out.insert((*table).to_string(), serde_json::Value::Array(values));
        }
        tx.rollback().await?;
        Ok(out)
    }

    /// How one table is filtered to a single organization, with `$1` bound to the
    /// organization id. Every path runs through `groups`, because a group is what
    /// an organization actually contains: workspaces hang off groups, files off
    /// workspaces, and content off files — which is the same reachability
    /// [`delete_group_tx`] uses when it destroys them.
    fn org_scope_sql(table: &str) -> String {
        let group_ids = "SELECT id FROM groups WHERE org_id = $1".to_string();
        let workspace_ids = format!("SELECT id FROM workspace WHERE group_id IN ({group_ids})");
        let file_ids = format!("SELECT id FROM file WHERE workspace_id IN ({workspace_ids})");
        match table {
            // `org` is the organization itself; every other tenant-shaped table
            // names it in a column.
            "org" => "id = $1".to_string(),
            "groups" | "doc_org" | "message" | "dm" | "chat_image" | "audit" => {
                "org_id = $1".to_string()
            }
            // The tenant's members by assignment and by enrollment, plus this
            // install's owners: an archive nobody can sign in with is not a
            // restorable backup, and `import_replace_all` requires an owner row.
            "users" => format!(
                "org_id = $1 OR role = 'root' OR id IN \
                 (SELECT user_id FROM group_member WHERE group_id IN ({group_ids}))"
            ),
            "group_member" | "workspace" => format!("group_id IN ({group_ids})"),
            "file" => format!("workspace_id IN ({workspace_ids})"),
            "document" => format!(
                "id IN (SELECT doc_id FROM file WHERE workspace_id IN ({workspace_ids}))"
            ),
            "file_blob" => format!("file_id IN ({file_ids})"),
            "reaction" => "msg_id IN (SELECT id FROM message WHERE org_id = $1 \
                 UNION SELECT id FROM dm WHERE org_id = $1)".to_string(),
            // Fail closed. A table added to `MIGRATE_TABLES` without a scope rule of
            // its own would otherwise be exported whole into a single-tenant
            // archive, which is the one mistake this function exists to prevent.
            _ => "0 = 1".to_string(),
        }
    }

    /// Put a content row into the shape an archive carries: bytes inline, the
    /// object name gone, and sealed content unsealed on the way out.
    ///
    /// Unsealing is not a courtesy — it is the only version of this that survives a
    /// restore. The target install holds different organization keys, so an archive
    /// of sealed bytes would import ciphertext and re-seal it as though it were
    /// content, which is a backup that quietly destroys what it restored. A key that
    /// cannot be unwrapped refuses the export rather than shipping what it cannot
    /// read.
    fn archive_content_row(
        &self,
        table: &str,
        obj: &mut serde_json::Map<String, serde_json::Value>,
        deks: &HashMap<i64, [u8; 32]>,
    ) -> Result<()> {
        let Some(serde_json::Value::String(key)) = obj.remove("storage_key") else {
            obj.insert("storage_key".into(), serde_json::Value::Null);
            return Ok(());
        };
        let stored = self.blobs.get(&key).ok_or_else(|| {
            anyhow::anyhow!("cannot export {table}: stored object {key} is missing")
        })?;
        let bytes = if keystore::is_sealed(&stored) {
            let org_id = Self::sealed_object_org(&key).ok_or_else(|| {
                anyhow::anyhow!("cannot export {table}: sealed object {key} names no organization")
            })?;
            let dek = *deks.get(&org_id).ok_or_else(|| {
                anyhow::anyhow!(
                    "cannot export {table}: organization {org_id}'s data key is unavailable, \
                     so its content cannot be read for the archive"
                )
            })?;
            keystore::open_bytes(&dek, &stored).ok_or_else(|| {
                anyhow::anyhow!(
                    "cannot export {table}: object {key} does not match organization \
                     {org_id}'s key"
                )
            })?
        } else {
            stored
        };
        obj.insert("data".into(), serde_json::to_value(B64.encode(bytes))?);
        obj.insert("storage_key".into(), serde_json::Value::Null);
        Ok(())
    }

    /// The organizations this instance holds apart from `org_id`.
    ///
    /// A single-organization archive replaces everything when it is imported, so any
    /// other organization here would have its identity rows deleted while its
    /// content stayed on disk — a workspace whose every document opens blank. The
    /// count is what the import refuses on.
    pub async fn orgs_other_than(&self, org_id: i64) -> Result<Vec<(i64, String)>> {
        Ok(sqlx::query_as::<_, (i64, String)>(
            "SELECT id, name FROM org WHERE id <> $1 ORDER BY id",
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// The documents a routed tenant holds for the given ids, in archive shape.
    ///
    /// A tenant database is never opened *for* an export: an install whose tenant
    /// file does not exist yet holds no content, and provisioning one to discover
    /// that would leave a database behind for a read.
    async fn exported_org_content(
        &self,
        org_id: i64,
        doc_ids: &HashSet<String>,
    ) -> Result<Vec<serde_json::Value>> {
        let Some(registries) = self.registries.get().filter(|r| r.is_split()) else {
            return Ok(Vec::new());
        };
        if !registries.openable_org_ids().await?.contains(&org_id) {
            return Ok(Vec::new());
        }
        let content = registries.org(org_id).await?;
        let rows = sqlx::query("SELECT * FROM document").fetch_all(content.read_only()).await?;
        let mut out = Vec::new();
        for row in &rows {
            let id: String = row.try_get("id")?;
            if doc_ids.contains(&id) {
                out.push(serde_json::Value::Object(row_to_json(row)?));
            }
        }
        Ok(out)
    }

    /// Every document row stored outside the control database, in the same JSON
    /// shape an archive uses.
    ///
    /// The ZIP export is the one backup that has to carry a whole instance in one
    /// file, and a routed install keeps no content in this database at all: an
    /// export that read only here would be a backup with every document removed
    /// and nothing to say about it.
    async fn exported_tenant_content(&self) -> Result<Vec<serde_json::Value>> {
        let mut out = Vec::new();
        let Some(registries) = self.registries.get().filter(|r| r.is_split()) else {
            return Ok(out);
        };
        for org_id in registries.openable_org_ids().await? {
            let content = registries.org(org_id).await?;
            let rows = sqlx::query("SELECT * FROM document")
                .fetch_all(content.read_only())
                .await?;
            for row in &rows {
                out.push(serde_json::Value::Object(row_to_json(row)?));
            }
        }
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
        // Sealing an imported row needs the organization that owns its bytes and
        // that organization's key. Neither can be asked of the pool while this
        // transaction holds it, so the archive's own rows answer the first question
        // and one map, filled as we go, answers the second.
        let org_of_file = Self::archive_file_orgs(tables);
        let mut deks: HashMap<i64, [u8; 32]> = HashMap::new();
        for (table, rows) in tables {
            // An archive carries bytes inline; on an install using the object
            // store, content rows are rehomed into objects as they come in so the
            // database does not fill back up with what it just stopped holding.
            let rehomed: Vec<serde_json::Value> = if !self.blobs.is_inline()
                && (*table == "file_blob" || *table == "chat_image")
            {
                let mut out = Vec::with_capacity(rows.len());
                for row in rows {
                    out.push(self.rehome_content(&mut tx, row, &org_of_file, &mut deks).await?);
                }
                out
            } else {
                Vec::new()
            };
            let rows = if rehomed.is_empty() { rows.as_slice() } else { rehomed.as_slice() };
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
                sql.push(')');
                let mut q = sqlx::query(&sql);
                for name in &names {
                    let v = map
                        .get(name)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let is_blob_col = name == "data"
                        && (*table == "file_blob" || *table == "chat_image");
                    if is_blob_col {
                        // NULL stays NULL: a row whose content is an object
                        // carries no inline bytes, and binding empty bytes here
                        // would store a zero-length blob that reads as a file.
                        let bytes = match &v {
                            serde_json::Value::String(s) => Some(B64.decode(s)?),
                            serde_json::Value::Null => None,
                            _ => Some(Vec::new()),
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
        // An import deletes every organization and re-inserts the archive's, which
        // can leave a data key belonging to an organization that no longer exists
        // here. Such a key shreds nothing and explains nothing, so the invariant
        // kept is: a stored key means a live organization.
        sqlx::query("DELETE FROM org_keys WHERE org_id NOT IN (SELECT id FROM org)")
            .execute(&mut tx)
            .await?;
        let (violations,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&mut tx)
            .await?;
        if violations > 0 {
            bail!("export has {violations} broken foreign keys");
        }
        tx.commit().await?;
        // An archive from a build that predates the routing index carries no
        // doc_org rows; repair the mapping from the freshly imported files so
        // the very first routed request after an import finds its tenant.
        self.backfill_doc_routing().await?;
        // An archive also carries every document in this database, because that
        // is the one place a whole-instance backup reads from. On a routed
        // install the documents now have to move to the tenants that own them —
        // and each tenant is still holding the *previous* dataset's rows, which
        // a replace has to answer for before it lands the new ones.
        if self.content_is_split() {
            self.reset_org_content().await?;
            self.migrate_content_to_orgs().await?;
        }
        Ok(())
    }

    /// Empty every organization's document table, for a restore that replaces the
    /// whole instance: an archive naming no document for a tenant is a tenant
    /// that must not keep the one it was holding.
    async fn reset_org_content(&self) -> Result<()> {
        let Some(registries) = self.registries.get().filter(|r| r.is_split()) else {
            return Ok(());
        };
        for org_id in registries.openable_org_ids().await? {
            let content = registries.org(org_id).await?;
            sqlx::query("DELETE FROM document").execute(content.write()).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        insert_content, keystore, BlobStore, ChatImageScope, Database, Databases,
        PersistedDocument, Workspace, B64,
    };
    use base64::Engine;

    /// Every test runs against the object backend, so the storage path that
    /// ships as opt-in is the one this suite covers.
    async fn test_database() -> (tempfile::NamedTempFile, Database) {
        let file = tempfile::NamedTempFile::new().unwrap();
        let uri = format!("sqlite://{}", file.path().to_str().unwrap());
        let blobs = BlobStore::fs(format!("{}.blobs", file.path().display())).unwrap();
        let db = Database::open_with(&uri, blobs).await.unwrap();
        (file, db)
    }

    /// The backend a default install uses: bytes stay in the row.
    async fn test_database_inline() -> (tempfile::NamedTempFile, Database) {
        let file = tempfile::NamedTempFile::new().unwrap();
        let uri = format!("sqlite://{}", file.path().to_str().unwrap());
        let db = Database::open_with(&uri, BlobStore::inline()).await.unwrap();
        (file, db)
    }

    /// A user, org, group and workspace to hang files off, because blob rows are
    /// foreign-keyed to real ones.
    async fn seed_workspace(db: &Database) -> (i64, i64) {
        db.create_user_if_absent("owner", "Owner", "pw", "root", None)
            .await
            .unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        let group = db
            .create_group(org.id, "Team", owner.id, 1, "group")
            .await
            .unwrap();
        let ws = db
            .create_workspace(group.id, "Project", owner.id, 1)
            .await
            .unwrap();
        (owner.id, ws.id)
    }

    async fn add_binary(db: &Database, ws_id: i64, path: &str, bytes: &[u8]) -> i64 {
        let file = db
            .create_file(ws_id, path, &format!("doc-{path}"), "binary", Some("image/png"), 1)
            .await
            .unwrap();
        db.store_blob(file.id, bytes).await.unwrap();
        file.id
    }

    #[tokio::test]
    async fn binary_content_is_written_as_an_object_and_read_back() {
        let (tmp, db) = test_database().await;
        let (_, ws) = seed_workspace(&db).await;
        let id = add_binary(&db, ws, "shot.png", b"pretend png bytes").await;

        assert_eq!(
            db.load_blob(id).await.unwrap().as_deref(),
            Some(b"pretend png bytes".as_ref())
        );
        // The row points at content instead of holding it.
        let (inline_data, key, size): (Vec<u8>, Option<String>, i64) =
            sqlx::query_as("SELECT data, storage_key, size FROM file_blob WHERE file_id = $1")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(inline_data.is_empty(), "content must not also sit in the row");
        assert!(key.is_some(), "the row must name its object");
        assert_eq!(size, 17);
        // The bytes are on disk, and are not inside the database file.
        assert_eq!(db.blobs.object_keys().len(), 1);
        let db_bytes = std::fs::read(tmp.path()).unwrap();
        assert!(!db_bytes
            .windows(b"pretend png bytes".len())
            .any(|window| window == b"pretend png bytes"));
    }

    #[tokio::test]
    async fn identical_bytes_become_two_objects_while_a_copy_shares_one() {
        use std::collections::HashMap;
        let (_tmp, db) = test_database().await;
        let (_, ws) = seed_workspace(&db).await;
        let first = add_binary(&db, ws, "a.png", b"duplicate bytes").await;
        let second = add_binary(&db, ws, "b.png", b"duplicate bytes").await;

        // Content is sealed with a fresh nonce, so two copies of the same bytes no
        // longer land on one object. Sharing by value is what a shred cannot undo:
        // one object standing for two owners survives the deletion of either key.
        assert_eq!(
            db.blobs.object_keys().len(),
            2,
            "identical bytes seal to different objects"
        );
        assert_eq!(
            db.load_blob(first).await.unwrap().as_deref(),
            Some(b"duplicate bytes".as_ref())
        );
        assert_eq!(
            db.load_blob(second).await.unwrap().as_deref(),
            Some(b"duplicate bytes".as_ref())
        );

        // Sharing still happens by reference, which is what keeps a file copy a
        // metadata-only operation: the new row names the object the old one has.
        let copied = db
            .transfer_files(
                ws,
                &[(first, "c.png".into())],
                true,
                true,
                &HashMap::new(),
                1,
            )
            .await
            .unwrap();
        let copy_id = copied[0].id;
        assert_eq!(db.blobs.object_keys().len(), 2, "a copy stores no new bytes");

        // Deleting one referrer must not pull the object out from under the other.
        db.delete_file(first).await.unwrap();
        db.maintain(2_000_000_000, 180, false).await.unwrap();
        assert_eq!(db.blobs.object_keys().len(), 2, "still referenced by the copy");
        assert_eq!(
            db.load_blob(copy_id).await.unwrap().as_deref(),
            Some(b"duplicate bytes".as_ref())
        );

        db.delete_file(copy_id).await.unwrap();
        let report = db.maintain(2_000_000_000, 180, false).await.unwrap();
        assert!(report.released_objects >= 1, "the last delete frees the object");
        assert_eq!(db.blobs.object_keys().len(), 1);

        db.delete_file(second).await.unwrap();
        db.maintain(2_000_000_000, 180, false).await.unwrap();
        assert!(db.blobs.object_keys().is_empty());
    }

    #[tokio::test]
    async fn inline_backend_keeps_bytes_in_the_row() {
        let (_tmp, db) = test_database_inline().await;
        let (_, ws) = seed_workspace(&db).await;
        let id = add_binary(&db, ws, "legacy.bin", b"kept inline").await;

        let (inline_data, key): (Vec<u8>, Option<String>) =
            sqlx::query_as("SELECT data, storage_key FROM file_blob WHERE file_id = $1")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(inline_data, b"kept inline");
        assert!(key.is_none(), "the inline backend names no objects");
        // And no key either. An install that keeps bytes in rows has nothing sealed
        // for a key to destroy, so minting one would be a shredding claim about
        // content it still holds in the clear.
        let (keys,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_keys")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(keys, 0, "an inline install mints no organization keys");
        assert_eq!(db.load_blob(id).await.unwrap().as_deref(), Some(b"kept inline".as_ref()));
        assert_eq!(db.blob_bytes().await.unwrap(), 11);
        assert_eq!(db.object_bytes().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn export_carries_object_content_back_inline() {
        let (_tmp, db) = test_database().await;
        let (_, ws) = seed_workspace(&db).await;
        add_binary(&db, ws, "shot.png", b"archive me please").await;

        let snapshot = db.export_snapshot().await.unwrap();
        let rows = snapshot["file_blob"].as_array().unwrap();
        let row = rows[0].as_object().unwrap();
        let encoded = row["data"].as_str().expect("export must materialize content");
        assert_eq!(B64.decode(encoded).unwrap(), b"archive me please");
        assert!(row["storage_key"].is_null(), "an archive names no objects");
    }

    /// Two tenants, each with a note, an upload and a pasted image — three content
    /// paths, because a scoped archive can be wrong about any one of them alone.
    ///
    /// Every byte is tagged with its tenant, so "did the other tenant leak" is a
    /// string search rather than a set of id comparisons that has to be remembered
    /// whenever a table is added.
    async fn seed_two_tenants_with_content(db: &Database) -> (i64, i64) {
        db.create_user_if_absent("owner", "Owner", "pw", "root", None)
            .await
            .unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let (org_a, group_a, ws_a) = seed_org(db, owner.id, "Alpha").await;
        let (org_b, group_b, ws_b) = seed_org(db, owner.id, "Beta").await;
        for (org, group, ws, tag) in [
            (org_a, group_a, ws_a.id, "alpha"),
            (org_b, group_b, ws_b.id, "beta"),
        ] {
            let doc_id = format!("doc-{tag}");
            db.create_file(ws, &format!("{tag}.md"), &doc_id, "text", None, 1)
                .await
                .unwrap();
            db.store(
                &doc_id,
                &PersistedDocument {
                    text: format!("{tag} secret text"),
                    language: Some("markdown".into()),
                },
            )
            .await
            .unwrap();
            add_binary(db, ws, &format!("{tag}.png"), format!("{tag} bytes").as_bytes()).await;
            db.create_chat_image(
                org,
                owner.id,
                ChatImageScope { group_id: Some(group), dm_with: None },
                Some("image/png"),
                format!("{tag} paste").as_bytes(),
                1,
            )
            .await
            .unwrap();
        }
        (org_a, org_b)
    }

    #[tokio::test]
    async fn a_single_organization_archive_carries_only_that_organization() {
        let (_tmp, db) = test_database().await;
        let (org_a, _org_b) = seed_two_tenants_with_content(&db).await;

        let snapshot = db.export_org_snapshot(org_a).await.unwrap();
        let text = serde_json::to_string(&snapshot).unwrap();
        // Content travels base64-encoded, so that is the form worth searching for:
        // it is what "the archive carries this tenant's bytes" means, and it is the
        // same form a sealed object's bytes would arrive in if unsealing had not
        // happened.
        let alpha = [B64.encode(b"alpha bytes"), B64.encode(b"alpha paste")];
        let beta = [B64.encode(b"beta bytes"), B64.encode(b"beta paste")];
        // The other tenant's identity and its bytes are both absent: a note that was
        // never in scope, content that was never in scope, and the tenant's own name.
        let mut absent =
            vec!["doc-beta".to_string(), "beta secret text".to_string(), "Beta".to_string()];
        absent.extend(beta.iter().cloned());
        for needle in &absent {
            assert!(
                !text.contains(needle.as_str()),
                "the archive carries the other organization: {needle}"
            );
        }
        // And this tenant's content is here in the clear, which is the only shape a
        // restoring install can use: it holds different organization keys, so sealed
        // bytes in an archive are bytes nobody can ever read again.
        assert!(
            text.contains("alpha secret text"),
            "the archive lost its own note"
        );
        for needle in &alpha {
            assert!(
                text.contains(needle.as_str()),
                "the archive lost its own content, or shipped it sealed: {needle}"
            );
        }

        let orgs = snapshot["org"].as_array().unwrap();
        assert_eq!(orgs.len(), 1, "one organization, one row");
        assert_eq!(orgs[0]["id"].as_i64(), Some(org_a));
        // Users are the one table that is deliberately wider than the tenant: its
        // members plus this install's owners, so the archive can be signed into.
        for row in snapshot["users"].as_array().unwrap() {
            let belongs = row["org_id"].is_null()
                || row["org_id"].as_i64() == Some(org_a)
                || row["role"].as_str() == Some("root");
            assert!(belongs, "a foreign tenant's account travelled with the archive: {row}");
        }
        assert_eq!(snapshot["groups"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["workspace"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["file"].as_array().unwrap().len(), 2, "a note and an upload");
        assert_eq!(snapshot["file_blob"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["chat_image"].as_array().unwrap().len(), 1);
        let docs: Vec<String> = snapshot["document"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(docs, vec!["doc-alpha".to_string()]);
    }

    #[tokio::test]
    async fn an_organization_archive_restores_onto_an_instance_holding_nothing_else() {
        let (_tmp, source) = test_database().await;
        let (org_a, org_b) = seed_two_tenants_with_content(&source).await;
        let snapshot = source.export_org_snapshot(org_a).await.unwrap();
        let tables: Vec<(String, Vec<serde_json::Value>)> = Database::MIGRATE_TABLES
            .iter()
            .map(|name| ((*name).to_string(), snapshot[*name].as_array().unwrap().clone()))
            .collect();

        let (_tmp2, target) = test_database().await;
        assert!(
            target.orgs_other_than(org_a).await.unwrap().is_empty(),
            "a fresh instance must pass the guard its own archive relies on"
        );
        target.import_replace_all(&tables).await.unwrap();

        assert_eq!(
            target.load("doc-alpha").await.unwrap().text,
            "alpha secret text",
            "the tenant's note reads back after the trip"
        );
        let (orgs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org")
            .fetch_one(&target.pool)
            .await
            .unwrap();
        assert_eq!(orgs, 1, "the archive brought one organization, not two");
        let (foreign,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org WHERE id = $1")
            .bind(org_b)
            .fetch_one(&target.pool)
            .await
            .unwrap();
        assert_eq!(foreign, 0);
        // Its content went back into this install's object store, under this
        // install's key for this organization — not as the archive's plaintext.
        let keys = target.blobs.object_keys();
        assert_eq!(keys.len(), 2, "an upload and a paste");
        assert!(
            keys.iter().all(|key| key.starts_with(&format!("o{org_a}-"))),
            "restored content is sealed for the tenant that owns it: {keys:?}"
        );
        let (file_id,): (i64,) = sqlx::query_as("SELECT file_id FROM file_blob")
            .fetch_one(&target.pool)
            .await
            .unwrap();
        assert_eq!(
            target.load_blob(file_id).await.unwrap().as_deref(),
            Some(b"alpha bytes".as_ref())
        );
    }

    #[tokio::test]
    async fn the_org_guard_names_the_tenants_a_single_organization_archive_would_destroy() {
        let (_tmp, db) = test_database().await;
        let (org_a, org_b) = seed_two_tenants_with_content(&db).await;
        let others = db.orgs_other_than(org_a).await.unwrap();
        assert_eq!(others.len(), 1, "one tenant is one refusal");
        assert_eq!(others[0].0, org_b);
        assert_eq!(others[0].1, "Beta", "and the refusal names it");
        assert_eq!(db.orgs_other_than(org_b).await.unwrap().len(), 1);
        // Restoring tenant A's own archive onto tenant A's instance is a restore,
        // not a collision: the same id is not "another organization".
        assert!(db.orgs_other_than(org_a).await.unwrap().iter().all(|(id, _)| *id != org_a));
    }

    #[tokio::test]
    async fn chat_images_round_trip_through_the_object_store() {
        let (_tmp, db) = test_database().await;
        let (owner, _ws) = seed_workspace(&db).await;
        let id = db
            .create_chat_image(
                1,
                owner,
                ChatImageScope { group_id: None, dm_with: None },
                Some("image/png"),
                b"pasted bytes",
                1,
            )
            .await
            .unwrap();

        let image = db.get_chat_image(id).await.unwrap().expect("image reads back");
        assert_eq!(image.data, b"pasted bytes");
        assert_eq!(db.blobs.object_keys().len(), 1);
        let (inline_data,): (Vec<u8>,) =
            sqlx::query_as("SELECT data FROM chat_image WHERE id = $1")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(inline_data.is_empty(), "the paste must not sit in the row as well");
    }

    #[tokio::test]
    async fn the_storage_report_says_whether_content_is_sealed() {
        let (_tmp, fs_db) = test_database().await;
        assert!(fs_db.content_sealed(), "an object-store install seals what it writes");
        assert_eq!(fs_db.org_key_count().await.unwrap(), 0, "no key before the first upload");
        let (_, ws) = seed_workspace(&fs_db).await;
        add_binary(&fs_db, ws, "a.png", b"sealed bytes").await;
        assert_eq!(fs_db.org_key_count().await.unwrap(), 1, "one organization, one key");

        let (_tmp2, inline) = test_database_inline().await;
        assert!(!inline.content_sealed(), "a row-based install has nothing to seal");
        let (_, ws) = seed_workspace(&inline).await;
        add_binary(&inline, ws, "a.png", b"plain bytes").await;
        assert_eq!(inline.org_key_count().await.unwrap(), 0, "and it mints no keys");
    }

    #[tokio::test]
    async fn object_bytes_and_database_bytes_are_counted_apart() {
        let (tmp, db) = test_database().await;
        let (_, ws) = seed_workspace(&db).await;
        add_binary(&db, ws, "a.bin", b"0123456789").await;
        add_binary(&db, ws, "b.bin", b"01234").await;
        assert_eq!(db.object_bytes().await.unwrap(), 15);
        assert_eq!(db.blob_bytes().await.unwrap(), 15);
        // Content lives outside the database file, so the size a backup reports
        // is no longer the size the content weighs.
        let on_disk = std::fs::read(tmp.path()).unwrap();
        assert!(!on_disk.windows(10).any(|w| w == b"0123456789"));
    }

    #[tokio::test]
    async fn a_restored_archive_lands_in_the_object_store() {
        let (_tmp, source) = test_database_inline().await;
        let (_, ws) = seed_workspace(&source).await;
        add_binary(&source, ws, "portable.bin", b"bytes that travel").await;
        let snapshot = source.export_snapshot().await.unwrap();
        // Insert order is dependency order, so an archive is walked in
        // `MIGRATE_TABLES` order rather than in whatever order the map yields.
        let tables: Vec<(String, Vec<serde_json::Value>)> = Database::MIGRATE_TABLES
            .iter()
            .map(|name| ((*name).to_string(), snapshot[*name].as_array().unwrap().clone()))
            .collect();

        let (_tmp2, target) = test_database().await;
        target.import_replace_all(&tables).await.unwrap();
        let keys = target.blobs.object_keys();
        assert_eq!(keys.len(), 1, "the import rehomed the content");
        // Rehomed means sealed for the organization the archive says owns it. An
        // import that stored the archive's plaintext instead would read back fine
        // here and be unshreddable forever after.
        let (org_id,): (i64,) = sqlx::query_as("SELECT id FROM org")
            .fetch_one(&target.pool)
            .await
            .unwrap();
        assert!(
            keys[0].starts_with(&format!("o{org_id}-")),
            "the imported object is named for its organization: {keys:?}"
        );
        let stored = target.blobs.get(&keys[0]).expect("object is on disk");
        assert!(
            keystore::is_sealed(&stored),
            "imported content must not sit in the object store in the clear"
        );
        assert!(!stored.windows(b"bytes that travel".len()).any(|w| w == b"bytes that travel"));
        let (key_rows,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM org_keys WHERE org_id = (SELECT id FROM org LIMIT 1)",
        )
        .fetch_one(&target.pool)
        .await
        .unwrap();
        assert_eq!(key_rows, 1, "the organization's key came with its content");
        let files: Vec<(i64,)> =
            sqlx::query_as("SELECT file_id FROM file_blob").fetch_all(&target.pool).await.unwrap();
        assert_eq!(
            target.load_blob(files[0].0).await.unwrap().as_deref(),
            Some(b"bytes that travel".as_ref())
        );
    }

    #[tokio::test]
    async fn a_read_never_mints_an_organization_key() {
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        let id = add_binary(&db, ws, "a.png", b"sealed bytes").await;
        assert_eq!(db.load_blob(id).await.unwrap().as_deref(), Some(b"sealed bytes".as_ref()));

        // Destroy the key the way a shred does, leaving the object where it is.
        sqlx::query("DELETE FROM org_keys WHERE org_id = $1")
            .bind(org)
            .execute(&db.pool)
            .await
            .unwrap();

        // The read has to fail, and fail without "helping" by creating a key: a
        // freshly minted one cannot open bytes sealed under the old, and the row
        // would then look healthy while naming content nobody can ever read.
        let err = db.load_blob(id).await.unwrap_err().to_string();
        assert!(err.contains("data key is gone"), "unexpected error: {err}");
        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_keys")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "a read cannot mint a key");
        // Writing new content is a different matter, and still works.
        let other = add_binary(&db, ws, "b.png", b"fresh bytes").await;
        assert_eq!(db.load_blob(other).await.unwrap().as_deref(), Some(b"fresh bytes".as_ref()));
    }

    #[tokio::test]
    async fn shredding_an_organization_destroys_its_objects_and_not_a_neighbours() {
        let (_tmp, db) = test_database().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let a = add_binary(&db, ws_a, "a.png", b"same bytes").await;
        let b = add_binary(&db, ws_b, "b.png", b"same bytes").await;
        assert_eq!(db.blobs.object_keys().len(), 2, "two organizations, two objects");

        db.delete_org(org_a).await.unwrap();

        let keys = db.blobs.object_keys();
        assert_eq!(keys.len(), 1, "the shredded organization left no object behind");
        // The surviving name is what proves the first organization ever held its own
        // sealed object: unsealed content is named by its hash, and this assertion
        // would pass on an install that cannot shred anything.
        assert!(keys[0].starts_with(&format!("o{org_b}-")), "neighbour kept: {keys:?}");
        assert_eq!(
            db.load_blob(b).await.unwrap().as_deref(),
            Some(b"same bytes".as_ref()),
            "the other organization's identical content still reads"
        );
        assert!(db.load_blob(a).await.unwrap().is_none(), "its row is gone too");
        let stored = db.blobs.get(&keys[0]).expect("object is on disk");
        assert!(
            !stored.windows(b"same bytes".len()).any(|w| w == b"same bytes"),
            "what remains on disk is ciphertext"
        );
        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_keys WHERE org_id = $1")
            .bind(org_a)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "the key went with the organization");
    }

    async fn assert_no_bad_foreign_keys(db: &Database) {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn a_sealed_totp_seed_never_reaches_the_file() {
        let (file, db) = test_database().await;
        db.create_user_if_absent("ada", "Ada", "pw", "user", None).await.unwrap();
        let user = db.get_user_by_email("ada").await.unwrap().unwrap();
        db.set_totp_pending(user.id, "JBSWY3DPEHPK3PXP").await.unwrap();

        // Reading it back works, but the seed is not in the file bytes — nor in
        // the WAL sidecar, which is what a live backup would also capture.
        let stored = db.get_user_by_email("ada").await.unwrap().unwrap();
        assert_eq!(stored.totp_secret().as_deref(), Some("JBSWY3DPEHPK3PXP"));
        let seed = b"JBSWY3DPEHPK3PXP";
        for path in [file.path().to_path_buf(), wal_path(file.path())] {
            if let Ok(bytes) = std::fs::read(&path) {
                assert!(
                    !bytes.windows(seed.len()).any(|w| w == seed),
                    "plaintext seed found in {}",
                    path.display()
                );
            }
        }
    }

    #[tokio::test]
    async fn plaintext_seeds_are_sealed_on_the_next_boot() {
        let (_file, db) = test_database().await;
        db.create_user_if_absent("miriam", "Miriam", "pw", "user", None).await.unwrap();
        let (id,): (i64,) =
            sqlx::query_as("SELECT id FROM users WHERE email = 'miriam'").fetch_one(&db.pool).await.unwrap();
        // A row written by an older build, before the sealed column existed.
        sqlx::query("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = $1")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();

        db.seal_existing_totp().await.unwrap();

        let user = db.get_user_by_email("miriam").await.unwrap().unwrap();
        assert!(user.totp_enabled, "2FA must stay on across the backfill");
        assert_eq!(user.totp_secret().as_deref(), Some("JBSWY3DPEHPK3PXP"));
        let (left,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM users WHERE totp_secret IS NOT NULL")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(left, 0, "no row may keep a readable seed");
    }

    fn wal_path(path: &std::path::Path) -> std::path::PathBuf {
        let mut wal = path.as_os_str().to_os_string();
        wal.push("-wal");
        std::path::PathBuf::from(wal)
    }

    #[tokio::test]
    async fn org_usage_answers_are_the_numbers_a_plan_is_checked_against() {
        let (_tmp, db) = test_database().await;
        let (owner, ws) = seed_workspace(&db).await;
        // The seeded owner is root, so it must not consume a seat.
        assert_eq!(db.org_user_count(1).await.unwrap(), 0);
        db.create_user_if_absent("dev1", "Dev One", "pw", "user", Some(1))
            .await
            .unwrap();
        assert_eq!(db.org_user_count(1).await.unwrap(), 1);

        add_binary(&db, ws, "a.bin", b"0123456789").await;
        assert_eq!(db.org_content_bytes(1).await.unwrap(), 10);
        // Typed content counts too, or a text editor alone escapes the ceiling.
        let note = db
            .create_file(ws, "note.md", "note-doc", "text", None, 1)
            .await
            .unwrap();
        db.store(
            &note.doc_id,
            &super::PersistedDocument {
                text: "four words".into(),
                language: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(db.org_content_bytes(1).await.unwrap(), 20);
        // Content attributed to another org must not leak into this one's total.
        assert_eq!(db.org_content_bytes(2).await.unwrap(), 0);
        assert!(db.org_user_count(2).await.unwrap() == 0);
        let _ = owner;
    }

#[tokio::test]
    async fn revoking_a_session_beats_the_identity_cache() {
        let (_tmp, db) = test_database_inline().await;
        db.create_user_if_absent("member", "Member", "hash", "user", Some(1))
            .await
            .unwrap();
        let member = db.get_user_by_email("member").await.unwrap().unwrap();
        db.create_org("Org", "org", 1).await.unwrap();
        db.create_session("keep", member.id, 9_999_999_999).await.unwrap();
        db.create_session("drop", member.id, 9_999_999_999).await.unwrap();

        // Both resolutions are now cached, well inside their own expiry, so a
        // lookup after revocation can only return None if the write wiped them.
        assert!(db.get_session_user("drop", 1_000).await.unwrap().is_some());
        assert!(db.get_session_user("keep", 1_000).await.unwrap().is_some());
        db.update_password(member.id, "newhash", Some("keep")).await.unwrap();

        assert!(db.get_session_user("drop", 1_000).await.unwrap().is_none());
        assert!(db.get_session_user("keep", 1_000).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn removing_a_member_beats_the_membership_cache() {
        let (_tmp, db) = test_database_inline().await;
        let (owner, _ws) = seed_workspace(&db).await;
        db.create_user_if_absent("viewer", "Viewer", "hash", "user", Some(1))
            .await
            .unwrap();
        let viewer = db.get_user_by_email("viewer").await.unwrap().unwrap();
        let group = db.create_group(1, "Team", owner, 1, "group").await.unwrap();

        db.add_group_member(group.id, viewer.id, "user").await.unwrap();
        assert!(db.is_group_member(group.id, viewer.id).await.unwrap());
        assert!(db.is_group_member(group.id, viewer.id).await.unwrap(), "second read is cached");

        db.remove_group_member(group.id, viewer.id).await.unwrap();
        assert!(
            !db.is_group_member(group.id, viewer.id).await.unwrap(),
            "the cache must not keep a revoked membership alive"
        );
        assert!(db.auth_cache_hits() > 0, "the cache is actually being used");
    }

    #[tokio::test]
    async fn creating_a_group_enrolls_its_creator() {
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "test", "root", None).await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        let group = db.create_group(org.id, "Team", owner.id, 1, "group").await.unwrap();
        // Without this membership the creator cannot see the group they made.
        assert!(db.is_group_member(group.id, owner.id).await.unwrap());
        assert_eq!(db.group_member_ids(group.id).await.unwrap(), vec![owner.id]);
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
        db.create_chat_image(
            org.id,
            alice.id,
            ChatImageScope {
                group_id: Some(shared.id),
                ..Default::default()
            },
            Some("image/png"),
            b"img",
            1,
        )
        .await
        .unwrap();
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
            .map(|t| (t.to_string(), snapshot[*t].as_array().unwrap().clone())).collect();
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

    /// An org, a group and a workspace, handing back the two ids a routing
    /// test has to name: the org that must own new documents, and the
    /// workspace they are filed under.
    async fn seed_routed_workspace(db: &Database) -> (i64, i64) {
        db.create_user_if_absent("owner", "Owner", "pw", "root", None)
            .await
            .unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        let group = db
            .create_group(org.id, "Team", owner.id, 1, "group")
            .await
            .unwrap();
        let ws = db
            .create_workspace(group.id, "Project", owner.id, 1)
            .await
            .unwrap();
        (org.id, ws.id)
    }

    /// One org with one group and one workspace, identified however a caller
    /// needs them.
    async fn seed_org(
        db: &Database,
        owner_id: i64,
        name: &str,
    ) -> (i64, i64, Workspace) {
        let org = db.create_org(name, name, 1).await.unwrap();
        let group = db
            .create_group(org.id, name, owner_id, 1, "group")
            .await
            .unwrap();
        let ws = db
            .create_workspace(group.id, name, owner_id, 1)
            .await
            .unwrap();
        (org.id, group.id, ws)
    }

    #[tokio::test]
    async fn creating_a_file_routes_its_document_to_the_owning_org() {
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        let note = db.create_file(ws, "note.txt", "route-note", "text", None, 1).await.unwrap();
        assert_eq!(db.org_of_doc(&note.doc_id).await.unwrap(), Some(org));
        // Uploads are documents too: a PDF has an owning tenant as much as a note.
        let upload = db
            .create_uploaded_file(ws, "deck.pdf", "route-deck", Some("application/pdf"), None, &[1, 2, 3], 1)
            .await
            .unwrap();
        assert_eq!(db.org_of_doc(&upload.doc_id).await.unwrap(), Some(org));
        assert_eq!(db.docs_of_org(org).await.unwrap(), vec!["route-deck".to_string(), "route-note".to_string()]);
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn deleting_a_file_drops_its_routing_row() {
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        let a = db.create_file(ws, "a.txt", "gone-a", "text", None, 1).await.unwrap();
        let b = db.create_file(ws, "b.txt", "gone-b", "text", None, 1).await.unwrap();
        db.delete_file(a.id).await.unwrap();
        assert_eq!(db.org_of_doc("gone-a").await.unwrap(), None, "a dead document must not route anywhere");
        assert_eq!(db.org_of_doc("gone-b").await.unwrap(), Some(org), "the survivor keeps its route");
        db.delete_files(&[b.id]).await.unwrap();
        assert!(db.docs_of_org(org).await.unwrap().is_empty());
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn zip_import_and_file_copies_arrive_routed() {
        use std::collections::HashMap;
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        let entries = [
            super::ImportedFile { path: "imported.txt".into(), mime: None, bytes: b"hello".to_vec(), is_text: true },
            super::ImportedFile { path: "imported.bin".into(), mime: Some("image/png".into()), bytes: vec![0, 1, 2], is_text: false },
        ];
        let imported = db.import_files(ws, &entries, 1).await.unwrap();
        assert_eq!(imported.len(), 2);
        for file in &imported {
            assert_eq!(db.org_of_doc(&file.doc_id).await.unwrap(), Some(org), "imported {file:?}");
        }
        // A copy is a new document and gets its own route, in the same tx.
        let source = &imported[0];
        let copied = db
            .transfer_files(ws, &[(source.id, "copy.txt".into())], true, true, &HashMap::new(), 1)
            .await
            .unwrap();
        assert_ne!(copied[0].doc_id, source.doc_id);
        assert_eq!(db.org_of_doc(&copied[0].doc_id).await.unwrap(), Some(org));
        assert_eq!(db.docs_of_org(org).await.unwrap().len(), 3);
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn the_boot_backfill_routes_documents_that_predate_the_index() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let uri = format!("sqlite://{}", tmp.path().to_str().unwrap());
        let db = Database::open_with(&uri, BlobStore::inline()).await.unwrap();
        let (org, ws) = seed_routed_workspace(&db).await;
        // Rows as an older build wrote them: a file, a document, no mapping.
        sqlx::query("INSERT INTO file (workspace_id, path, doc_id, kind, created_at) VALUES ($1, 'legacy.txt', 'legacy-doc', 'text', 1)")
            .bind(ws)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO document (id, text) VALUES ('legacy-doc', 'old but reachable')")
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(db.org_of_doc("legacy-doc").await.unwrap(), None, "the insert itself routes nothing");
        assert_eq!(db.backfill_doc_routing().await.unwrap(), 1);
        assert_eq!(db.org_of_doc("legacy-doc").await.unwrap(), Some(org));
        assert_eq!(db.backfill_doc_routing().await.unwrap(), 0, "a second pass must repair nothing");
        assert!(db.load("legacy-doc").await.is_ok(), "backfill must not disturb the document");
        // Reopening the same database — a boot against an upgraded file — also
        // finds and routes anything a previous pass missed.
        drop(db);
        let db = Database::open_with(&uri, BlobStore::inline()).await.unwrap();
        assert_eq!(db.org_of_doc("legacy-doc").await.unwrap(), Some(org));
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn a_document_in_an_orgless_workspace_is_not_routed() {
        let (_tmp, db) = test_database().await;
        let (_org, ws) = seed_routed_workspace(&db).await;
        db.create_file(ws, "kept.txt", "kept-doc", "text", None, 1).await.unwrap();
        // A workspace whose group link is NULL (the schema allows it; historic
        // dev data has it) must not make the backfill invent an owner.
        let (lost,): (i64,) = sqlx::query_as(
            "INSERT INTO workspace (group_id, name, slug, created_by, created_at) VALUES (NULL, 'Lost', 'lost', 1, 1) RETURNING id",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO file (workspace_id, path, doc_id, kind, created_at) VALUES ($1, 'x.txt', 'orphan-chain', 'text', 1)")
            .bind(lost)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(db.backfill_doc_routing().await.unwrap(), 0, "an unreachable chain routes nothing");
        assert_eq!(db.org_of_doc("orphan-chain").await.unwrap(), None);
        assert_eq!(db.org_of_doc("kept-doc").await.unwrap(), Some(_org));
    }

    #[tokio::test]
    async fn two_orgs_documents_never_route_to_the_wrong_database() {
        use std::collections::HashMap;
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "pw", "root", None).await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let (org_a, group_a, ws_a) = seed_org(&db, owner.id, "Alpha").await;
        let (org_b, group_b, ws_b) = seed_org(&db, owner.id, "Beta").await;
        let a1 = db.create_file(ws_a.id, "one.txt", "a-one", "text", None, 1).await.unwrap();
        db.create_file(ws_a.id, "two.txt", "a-two", "text", None, 1).await.unwrap();
        db.create_file(ws_b.id, "only.txt", "b-only", "text", None, 1).await.unwrap();
        assert_eq!(db.org_of_doc("a-one").await.unwrap(), Some(org_a));
        assert_eq!(db.org_of_doc("b-only").await.unwrap(), Some(org_b));
        assert_ne!(db.org_of_doc("a-one").await.unwrap(), db.org_of_doc("b-only").await.unwrap());
        // docs_of_org answers with exactly that org's documents.
        assert_eq!(db.docs_of_org(org_a).await.unwrap(), vec!["a-one".to_string(), "a-two".to_string()]);
        assert_eq!(db.docs_of_org(org_b).await.unwrap(), vec!["b-only".to_string()]);

        // A copy across the org boundary belongs to the destination, not the
        // source — and the original never moves.
        let copied = db
            .transfer_files(ws_b.id, &[(a1.id, "stolen.txt".into())], true, true, &HashMap::new(), 1)
            .await
            .unwrap();
        assert_eq!(db.org_of_doc(&copied[0].doc_id).await.unwrap(), Some(org_b));
        assert_eq!(db.org_of_doc("a-one").await.unwrap(), Some(org_a));

        // A real move re-routes the document itself.
        db.transfer_files(ws_b.id, &[(a1.id, "moved.txt".into())], false, true, &HashMap::new(), 1)
            .await
            .unwrap();
        assert_eq!(db.org_of_doc("a-one").await.unwrap(), Some(org_b));
        assert_eq!(db.docs_of_org(org_a).await.unwrap(), vec!["a-two".to_string()]);

        // Merging a workspace across the org boundary re-routes every moved
        // document, even though its file and doc ids are preserved.
        let ws_a2 = db.create_workspace(group_a, "Second", owner.id, 1).await.unwrap();
        db.create_file(ws_a2.id, "merge.txt", "a-merge", "text", None, 1).await.unwrap();
        db.merge_workspaces(ws_a2.id, ws_b.id).await.unwrap();
        assert_eq!(db.org_of_doc("a-merge").await.unwrap(), Some(org_b));

        // Reparenting a whole workspace re-routes all of its documents.
        db.move_workspace_to_group(&ws_a, group_b).await.unwrap();
        assert_eq!(db.org_of_doc("a-two").await.unwrap(), Some(org_b));
        assert!(db.docs_of_org(org_a).await.unwrap().is_empty());
        let mut expected = vec![
            "a-one".to_string(),
            "a-two".to_string(),
            "a-merge".to_string(),
            "b-only".to_string(),
            copied[0].doc_id.clone(),
        ];
        expected.sort();
        assert_eq!(db.docs_of_org(org_b).await.unwrap(), expected);
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn deleting_an_org_or_workspace_takes_its_routing_rows_with_it() {
        let (_tmp, db) = test_database().await;
        db.create_user_if_absent("owner", "Owner", "pw", "root", None).await.unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let (org_a, _ga, ws_a) = seed_org(&db, owner.id, "Alpha").await;
        let (org_b, gb, ws_b) = seed_org(&db, owner.id, "Beta").await;
        db.create_file(ws_a.id, "doomed.txt", "ws-doc", "text", None, 1).await.unwrap();
        db.create_file(ws_a.id, "also.txt", "org-doc", "text", None, 1).await.unwrap();
        db.create_file(ws_b.id, "kept.txt", "other-doc", "text", None, 1).await.unwrap();

        db.delete_workspace(ws_a.id).await.unwrap();
        assert_eq!(db.org_of_doc("ws-doc").await.unwrap(), None);
        assert_eq!(db.org_of_doc("org-doc").await.unwrap(), None, "no mapping may outlive its document");
        // The workspace delete above took both rows, so the org list is empty.
        assert!(db.docs_of_org(org_a).await.unwrap().is_empty());

        let ws_b2 = db.create_workspace(gb, "More", owner.id, 1).await.unwrap();
        db.create_file(ws_b2.id, "deep.txt", "deep-doc", "text", None, 1).await.unwrap();
        db.delete_org(org_b).await.unwrap();
        assert!(db.org_of_doc("other-doc").await.unwrap().is_none());
        assert!(db.org_of_doc("deep-doc").await.unwrap().is_none());
        assert!(db.docs_of_org(org_b).await.unwrap().is_empty());
        assert_no_bad_foreign_keys(&db).await;
    }

    #[tokio::test]
    async fn the_routing_index_boots_on_a_memory_database() {
        // Production rollout runs on `sqlite::memory:`; routing must not
        // assume a database file exists anywhere.
        let db = Database::new("sqlite::memory:")
            .await
            .expect("boot the routing index on an in-memory database");
        let (org, ws) = seed_routed_workspace(&db).await;
        let file = db.create_file(ws, "ram.txt", "ram-doc", "text", None, 1).await.unwrap();
        assert_eq!(db.org_of_doc(&file.doc_id).await.unwrap(), Some(org));
        db.delete_file(file.id).await.unwrap();
        assert_eq!(db.org_of_doc("ram-doc").await.unwrap(), None);
    }

    #[tokio::test]
    async fn maintenance_sweeps_routing_rows_that_point_at_nothing() {
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        let file = db.create_file(ws, "real.txt", "real-doc", "text", None, 1).await.unwrap();
        // A stale row as a crashed-transaction or hand-edited database would
        // leave behind: the file is gone but the index still claims to know it.
        sqlx::query("DELETE FROM file WHERE id = $1").bind(file.id).execute(&db.pool).await.unwrap();
        assert_eq!(db.org_of_doc("real-doc").await.unwrap(), Some(org), "the sweep, not the delete, is tested here");
        db.maintain(2_000_000_000, 180, false).await.unwrap();
        assert_eq!(db.org_of_doc("real-doc").await.unwrap(), None);
        assert_no_bad_foreign_keys(&db).await;
    }

    /// The storage ceiling is only real if two uploads written at the same moment
    /// cannot both be told there is room. Each measures, compares, then writes;
    /// without serialization both measure the same total and both pass.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_concurrent_uploads_cannot_both_pass_a_storage_ceiling() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        use crate::database::Quota;
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        add_binary(&db, ws, "seeded.bin", vec![b'a'; 1024].as_slice()).await;
        // Room for exactly one more 1 KiB upload, and nothing after it.
        let limit = db.org_content_bytes(org).await.unwrap() + 1024;

        let admitted = Arc::new(AtomicUsize::new(0));
        let refused = Arc::new(AtomicUsize::new(0));
        let counter = Arc::new(AtomicUsize::new(0));
        let mut racing = Vec::new();
        for _ in 0..2 {
            let db = db.clone();
            let (admitted, refused, counter) =
                (admitted.clone(), refused.clone(), counter.clone());
            racing.push(tokio::spawn(async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                match db.reserve_content_bytes(org, 1024, limit).await.unwrap() {
                    Quota::Admitted(held) => {
                        // The write happens with the lock held, exactly as the
                        // upload handler does: the next upload cannot measure
                        // until this content is on disk.
                        add_binary(
                            &db,
                            ws,
                            &format!("race-{n}.bin"),
                            vec![b'b'; 1024].as_slice(),
                        )
                        .await;
                        admitted.fetch_add(1, Ordering::SeqCst);
                        drop(held);
                    }
                    Quota::Over => {
                        refused.fetch_add(1, Ordering::SeqCst);
                    }
                    Quota::Unlimited => panic!("a ceiling was given"),
                }
            }));
        }
        for task in racing {
            task.await.unwrap();
        }
        assert_eq!(admitted.load(Ordering::SeqCst), 1, "one upload fits");
        assert_eq!(refused.load(Ordering::SeqCst), 1, "the other does not");
        assert!(
            db.org_content_bytes(org).await.unwrap() <= limit,
            "stored bytes never pass the plan's ceiling"
        );
    }

    /// The structural half of the same guarantee, with no timing in it: an
    /// organization must always be handed *the same* lock, and a different
    /// organization must not be handed that one.
    #[tokio::test]
    async fn one_organization_always_gets_the_same_storage_lock() {
        use std::sync::Arc;
        let (_tmp, db) = test_database().await;
        let (org, _) = seed_routed_workspace(&db).await;
        assert!(
            Arc::ptr_eq(&db.quota_gate(org), &db.quota_gate(org)),
            "two callers that race the first use must not get two different locks"
        );
        assert!(
            !Arc::ptr_eq(&db.quota_gate(org), &db.quota_gate(org + 1)),
            "another organization must not queue behind this one's uploads"
        );
    }

    /// The OT write path is the most data-critical code in the server, and the
    /// UPDATE-only persist is what stops a persister holding a pre-delete
    /// snapshot from bringing a document back. Nothing covered it: the tests
    /// that used to were the ignored WebSocket harness (#28).
    #[tokio::test]
    async fn a_persisted_snapshot_never_resurrects_a_deleted_document() {
        let (_tmp, db) = test_database().await;
        let (_org, ws) = seed_routed_workspace(&db).await;
        let file = db.create_file(ws, "note.md", "live-doc", "text", None, 1).await.unwrap();
        db.store(
            &file.doc_id,
            &crate::database::PersistedDocument { text: "typed while open".into(), language: Some("markdown".into()) },
        )
        .await
        .unwrap();
        assert_eq!(db.load(&file.doc_id).await.unwrap().text, "typed while open");

        db.delete_file(file.id).await.unwrap();
        let stale = db
            .store(&file.doc_id, &crate::database::PersistedDocument { text: "ghost".into(), language: None })
            .await;
        assert!(
            stale.is_err(),
            "an UPDATE-only persist must refuse to recreate a deleted document"
        );
        assert!(db.load(&file.doc_id).await.is_err(), "the document must stay gone");
        assert!(
            db.store_document_text(&file.doc_id, "ghost").await.is_err(),
            "the direct write path carries the same guard"
        );
    }

    #[tokio::test]
    async fn persisting_refuses_a_document_no_file_points_at() {
        let (_tmp, db) = test_database().await;
        // A row that exists but is unreachable — an interrupted create, or a
        // hand-edited database. Reading it is harmless; writing it back would
        // hide the fact that nothing owns it.
        sqlx::query("INSERT INTO document (id, text, language) VALUES ('orphan-doc', 'loose', NULL)")
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(db.load("orphan-doc").await.unwrap().text, "loose");
        assert!(
            db.store("orphan-doc", &crate::database::PersistedDocument { text: "written".into(), language: None })
                .await
                .is_err(),
            "only a document a text file still names may be persisted"
        );
        assert_eq!(db.load("orphan-doc").await.unwrap().text, "loose", "the refusal changed nothing");
    }

    /// A caller that treats "this document has no row" and "the database did not
    /// answer" as the same thing will blank a user's file on a transient failure.
    /// The two are only distinguishable through `is_missing_document`.
    #[tokio::test]
    async fn a_transient_read_failure_is_never_mistaken_for_an_empty_document() {
        let (_tmp, db) = test_database().await;
        let (_org, ws) = seed_routed_workspace(&db).await;
        let file = db.create_file(ws, "a.md", "doc-a", "text", None, 1).await.unwrap();

        let missing = db.load("never-existed").await.unwrap_err();
        assert!(
            Database::is_missing_document(&missing),
            "no row yet is the one case an empty document is the right answer"
        );

        db.pool.close().await;
        let unavailable = db.load(&file.doc_id).await.unwrap_err();
        assert!(
            !Database::is_missing_document(&unavailable),
            "an unreachable database must not be read as a document that is empty"
        );
    }

    /// A storage plan is sold in bytes and `file.size` already reports bytes
    /// (`LENGTH(CAST(text AS BLOB))`). The meter summed `LENGTH(text)`, which
    /// counts characters, so an organization writing Cyrillic, accented Latin or
    /// emoji was charged a fraction of what it stored, and the console disagreed
    /// with the file list about the same document.
    #[tokio::test]
    async fn the_storage_meter_counts_utf8_bytes_not_characters() {
        let (_tmp, db) = test_database().await;
        let (org, ws) = seed_routed_workspace(&db).await;
        let file = db
            .create_file(ws, "unicode.md", "uni-doc", "text", None, 1)
            .await
            .unwrap();
        let before = db.org_content_bytes(org).await.unwrap();

        let text = "\u{e9}".repeat(100); // 100 characters, 200 UTF-8 bytes
        db.store(
            &file.doc_id,
            &crate::database::PersistedDocument {
                text,
                language: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            db.org_content_bytes(org).await.unwrap() - before,
            200,
            "a byte ceiling measured in characters makes non-Latin content free"
        );
    }
    // ----- Content in its own database (issue #19) -----

    /// The layout `CORTEX_ORG_DBS=1` chooses, wired the way a boot wires it: a
    /// file-backed control database, one tenant database per organization in a
    /// directory of its own, and the registry attached to the handle every
    /// handler is handed. The content migration is *not* run — the tests that
    /// want it ask for it, because that is what makes them say something.
    async fn split_databases(
    ) -> (
        tempfile::NamedTempFile,
        tempfile::TempDir,
        Database,
        Databases,
    ) {
        let file = tempfile::NamedTempFile::new().unwrap();
        let uri = format!("sqlite://{}", file.path().to_str().unwrap());
        let blobs = BlobStore::fs(format!("{}.blobs", file.path().display())).unwrap();
        let db = Database::open_with(&uri, blobs).await.unwrap();
        let orgs = tempfile::tempdir().unwrap();
        let registries = Databases::files_in(db.clone(), orgs.path().to_path_buf());
        assert!(
            db.attach_registries(registries.clone()),
            "a control database is given exactly one registry"
        );
        assert!(db.content_is_split(), "and the flag is what routes content");
        (file, orgs, db, registries)
    }

    /// Two organizations, each with a group and a workspace: the smallest fixture
    /// in which "did this tenant's bytes land in the wrong file?" can even be
    /// answered wrongly.
    async fn seed_two_orgs(db: &Database) -> (i64, i64, i64, i64) {
        db.create_user_if_absent("owner", "Owner", "pw", "root", None)
            .await
            .unwrap();
        let owner = db.get_user_by_email("owner").await.unwrap().unwrap();
        let (org_a, _ga, ws_a) = seed_org(db, owner.id, "Alpha").await;
        let (org_b, _gb, ws_b) = seed_org(db, owner.id, "Beta").await;
        (org_a, ws_a.id, org_b, ws_b.id)
    }

    /// The text one *specific* database holds for a document id, bypassing the
    /// routing entirely — which is the point: through the router both answers are
    /// "here", and only the file says where the bytes actually are.
    async fn stored_text(db: &Database, doc_id: &str) -> Option<String> {
        sqlx::query_as::<_, (String,)>("SELECT text FROM document WHERE id = $1")
            .bind(doc_id)
            .fetch_optional(db.read_only())
            .await
            .unwrap()
            .map(|(text,)| text)
    }

    #[tokio::test]
    async fn an_organizations_content_lives_in_its_own_database() {
        let (_file, orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        db.create_file(ws_a, "a.md", "doc-a", "text", None, 1).await.unwrap();
        db.create_file(ws_b, "b.md", "doc-b", "text", None, 1).await.unwrap();
        db.store(
            "doc-a",
            &PersistedDocument { text: "alpha only".into(), language: Some("markdown".into()) },
        )
        .await
        .unwrap();
        db.store("doc-b", &PersistedDocument { text: "beta only".into(), language: None })
            .await
            .unwrap();

        let tenant_a = registries.org(org_a).await.unwrap();
        let tenant_b = registries.org(org_b).await.unwrap();
        assert_eq!(stored_text(&tenant_a, "doc-a").await.as_deref(), Some("alpha only"));
        assert_eq!(stored_text(&tenant_b, "doc-b").await.as_deref(), Some("beta only"));
        assert_eq!(
            stored_text(&tenant_a, "doc-b").await,
            None,
            "one tenant's file does not hold another organization's text"
        );
        assert_eq!(stored_text(&tenant_b, "doc-a").await, None, "nor the other way round");
        assert_eq!(
            stored_text(&db, "doc-a").await,
            None,
            "and the control database holds no content for a routed document"
        );
        assert_eq!(db.table_rows("document").await.unwrap(), 0, "not one row of content is left here");
        assert_eq!(tenant_a.table_rows("document").await.unwrap(), 1, "nor is it stored twice");
        assert!(orgs.path().join(format!("org-{org_a}.db")).exists());
        assert!(orgs.path().join(format!("org-{org_b}.db")).exists());
    }

    #[tokio::test]
    async fn reading_and_persisting_work_through_the_routed_handle() {
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, ..) = seed_two_orgs(&db).await;
        let file = db.create_file(ws_a, "note.md", "live", "text", None, 1).await.unwrap();
        assert_eq!(db.load(&file.doc_id).await.unwrap().text, "", "a new file starts empty");

        db.store(
            &file.doc_id,
            &PersistedDocument { text: "typed here".into(), language: Some("markdown".into()) },
        )
        .await
        .unwrap();
        let back = db.load(&file.doc_id).await.unwrap();
        assert_eq!(back.text, "typed here", "an OT snapshot round-trips through the tenant");
        assert_eq!(back.language.as_deref(), Some("markdown"), "including its language");
        db.store_document_text(&file.doc_id, "written directly").await.unwrap();
        assert_eq!(db.load(&file.doc_id).await.unwrap().text, "written directly");
        assert_eq!(
            stored_text(&registries.org(org_a).await.unwrap(), "live").await.as_deref(),
            Some("written directly"),
            "and it is the tenant's file that changed"
        );
    }

    #[tokio::test]
    async fn a_restarted_instance_finds_content_in_the_tenant_that_holds_it() {
        let (file, orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, ..) = seed_two_orgs(&db).await;
        let created = db.create_file(ws_a, "note.md", "durable", "text", None, 1).await.unwrap();
        db.store_document_text(&created.doc_id, "survives a restart").await.unwrap();
        let uri = format!("sqlite://{}", file.path().to_str().unwrap());
        drop(db);
        drop(registries);

        // A new process: the control database opens, the registry is built from
        // it, and the migration finds nothing left to move.
        let db = Database::open_with(&uri, BlobStore::inline()).await.unwrap();
        let registries = Databases::files_in(db.clone(), orgs.path().to_path_buf());
        db.attach_registries(registries.clone());
        assert_eq!(db.migrate_content_to_orgs().await.unwrap(), 0, "it was never in the control file");
        assert_eq!(db.load("durable").await.unwrap().text, "survives a restart");
        assert_eq!(
            stored_text(&registries.org(org_a).await.unwrap(), "durable").await.as_deref(),
            Some("survives a restart"),
            "read from the tenant's own file, on disk"
        );
    }

    #[tokio::test]
    async fn deleting_a_workspace_leaves_no_content_behind() {
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, ..) = seed_two_orgs(&db).await;
        let note = db.create_file(ws_a, "note.md", "ws-note", "text", None, 1).await.unwrap();
        let also = db.create_file(ws_a, "also.md", "ws-also", "text", None, 1).await.unwrap();
        let upload = db
            .create_uploaded_file(ws_a, "deck.pdf", "ws-deck", Some("application/pdf"), None, &[1, 2], 1)
            .await
            .unwrap();
        let tenant = registries.org(org_a).await.unwrap();
        assert_eq!(tenant.table_rows("document").await.unwrap(), 2, "only text files have content rows");

        let docs = db.delete_workspace(ws_a).await.unwrap();
        assert_eq!(docs.len(), 3, "the eviction list still names all three");
        assert_eq!(tenant.table_rows("document").await.unwrap(), 0, "a deleted workspace takes its content with it");
        assert!(db.load(&note.doc_id).await.is_err());
        assert!(db.load(&also.doc_id).await.is_err());
        assert!(db.get_file(upload.id).await.unwrap().is_none());
        assert!(db.docs_of_org(org_a).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn deleting_a_file_empties_only_the_tenant_that_held_it() {
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let mine = db.create_file(ws_a, "mine.md", "mine", "text", None, 1).await.unwrap();
        db.create_file(ws_b, "theirs.md", "theirs", "text", None, 1).await.unwrap();
        db.store_document_text("theirs", "untouched").await.unwrap();

        db.delete_file(mine.id).await.unwrap();
        let tenant_a = registries.org(org_a).await.unwrap();
        let tenant_b = registries.org(org_b).await.unwrap();
        assert_eq!(tenant_a.table_rows("document").await.unwrap(), 0, "gone from its own tenant");
        assert_eq!(stored_text(&tenant_b, "theirs").await.as_deref(), Some("untouched"), "and no other is touched");
        assert_eq!(db.load("theirs").await.unwrap().text, "untouched");
    }

    #[tokio::test]
    async fn a_persisted_snapshot_cannot_resurrect_content_in_a_tenant_file() {
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, ..) = seed_two_orgs(&db).await;
        let file = db.create_file(ws_a, "a.md", "ghost", "text", None, 1).await.unwrap();
        db.store(&file.doc_id, &PersistedDocument { text: "while open".into(), language: None })
            .await
            .unwrap();
        db.delete_file(file.id).await.unwrap();
        let tenant = registries.org(org_a).await.unwrap();
        assert_eq!(tenant.table_rows("document").await.unwrap(), 0);

        // A persister still holding the snapshot from before the delete: across a
        // database boundary the guard is a control-plane read and an `UPDATE`
        // that matches nothing, so it refuses instead of writing the row back.
        let stale = db.store(&file.doc_id, &PersistedDocument { text: "ghost".into(), language: None }).await;
        assert!(stale.is_err(), "the persist path still refuses across the boundary");
        assert!(db.store_document_text(&file.doc_id, "ghost").await.is_err());
        assert_eq!(tenant.table_rows("document").await.unwrap(), 0, "and nothing came back");
        assert!(db.load(&file.doc_id).await.is_err(), "the document stays gone");
    }

    #[tokio::test]
    async fn an_unreachable_tenant_is_never_read_as_an_empty_document() {
        let (_file, orgs, db, _registries) = split_databases().await;
        let (_org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let kept = db.create_file(ws_a, "a.md", "kept", "text", None, 1).await.unwrap();
        // Damage the second tenant's file before anything has opened it. The
        // failure these paths must answer is a database that will not open, not a
        // document that has no row.
        std::fs::write(orgs.path().join(format!("org-{org_b}.db")), b"not a database at all").unwrap();

        // Creating under it fails outright rather than quietly writing content
        // somewhere no routed read will ever look.
        assert!(db.create_file(ws_b, "b.md", "lost", "text", None, 1).await.is_err());
        assert_eq!(db.table_rows("file").await.unwrap(), 1, "no file row claims a document nobody stores");
        assert_eq!(db.table_rows("doc_org").await.unwrap(), 1);

        // A document already routed there reads as an error, and the error is the
        // one a caller must not mistake for "start with an empty document".
        sqlx::query("INSERT INTO doc_org (doc_id, org_id, created_at) VALUES ($1, $2, 1)")
            .bind("routed-away")
            .bind(org_b)
            .execute(db.write())
            .await
            .unwrap();
        let err = db.load("routed-away").await.unwrap_err();
        assert!(
            !Database::is_missing_document(&err),
            "an unreachable database is not an empty document"
        );
        assert_eq!(db.load(&kept.doc_id).await.unwrap().text, "", "the healthy tenant still works");
    }

    #[tokio::test]
    async fn an_orphan_in_a_tenant_is_reclaimed_and_the_owned_row_is_not() {
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, ..) = seed_two_orgs(&db).await;
        let file = db.create_file(ws_a, "a.md", "owned", "text", None, 1).await.unwrap();
        db.store_document_text(&file.doc_id, "keep me").await.unwrap();
        let tenant = registries.org(org_a).await.unwrap();

        // Exactly what an interrupted write leaves: a row in the tenant's
        // database that no file and no route names.
        insert_content(&tenant, "never-named", &PersistedDocument { text: "orphan".into(), language: None })
            .await
            .unwrap();
        assert!(db.load("never-named").await.is_err(), "and it is unreachable, not readable");
        let meter = db.org_content_bytes(org_a).await.unwrap();
        assert_eq!(db.list_files(ws_a).await.unwrap().len(), 1);

        let report = db.maintain(2_000_000_000, 180, false).await.unwrap();
        assert_eq!(report.orphan_documents, 1, "the sweep finds it, and counts it");
        assert_eq!(stored_text(&tenant, "never-named").await, None, "and removes it");
        assert_eq!(
            stored_text(&tenant, "owned").await.as_deref(),
            Some("keep me"),
            "the row the index does claim is untouched by the sweep"
        );
        assert_eq!(db.org_content_bytes(org_a).await.unwrap(), meter, "an orphan was never metered");
    }

    #[tokio::test]
    async fn every_meter_reads_content_that_lives_in_a_tenant_file() {
        use std::collections::HashMap;
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let file = db.create_file(ws_a, "a.md", "metered", "text", None, 1).await.unwrap();
        // 7 characters, 12 UTF-8 bytes: a size of 0 would mean the listing cannot
        // see content that moved, and 7 would mean it counted characters again.
        let text = "héllo—€".to_string();
        db.store_document_text(&file.doc_id, &text).await.unwrap();
        assert_eq!(stored_text(&registries.org(org_a).await.unwrap(), "metered").await, Some(text.clone()));
        assert_eq!(stored_text(&db, "metered").await, None, "the old subquery could not have found it");

        let listed = db.list_files(ws_a).await.unwrap();
        assert_eq!(listed[0].size, 12, "the file listing measures a routed document");
        assert_eq!(db.get_file(file.id).await.unwrap().unwrap().size, 12, "so does fetching one by id");
        assert_eq!(
            db.org_content_bytes(org_a).await.unwrap(),
            12,
            "and the storage meter, which is what a plan is enforced against"
        );
        assert_eq!(db.org_content_bytes(org_b).await.unwrap(), 0, "the other tenant holds nothing of this");
        assert_eq!(db.count().await.unwrap(), 1, "and the instance still knows how many documents it has");
        // The ceiling has to be enforced against bytes the meter can actually
        // see: 12 stored here, so 12 more fits a 24-byte plan and not a 23.
        assert!(
            matches!(
                db.reserve_content_bytes(org_a, 12, 24).await.unwrap(),
                crate::database::Quota::Admitted(_)
            ),
            "content the meter can see is content the plan can admit"
        );
        assert!(
            matches!(
                db.reserve_content_bytes(org_a, 12, 23).await.unwrap(),
                crate::database::Quota::Over
            ),
            "and a plan it does not fit still says so"
        );

        let copied = db
            .transfer_files(ws_a, &[(file.id, "copy.md".into())], true, true, &HashMap::new(), 1)
            .await
            .unwrap();
        assert_eq!(copied[0].size, 12, "a copy reports the size it copied");
        assert_eq!(db.list_files(ws_a).await.unwrap().len(), 2, "in both rows and sizes");
        assert_eq!(db.org_content_bytes(org_a).await.unwrap(), 24);
        let _ = ws_b;
    }

    #[tokio::test]
    async fn moving_a_document_between_organizations_carries_its_content() {
        use std::collections::HashMap;
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let file = db.create_file(ws_a, "a.md", "moves", "text", None, 1).await.unwrap();
        db.store_document_text(&file.doc_id, "crossing the boundary").await.unwrap();
        assert_eq!(db.org_content_bytes(org_a).await.unwrap(), 21);

        db.transfer_files(ws_b, &[(file.id, "moved.md".into())], false, true, &HashMap::new(), 1)
            .await
            .unwrap();

        let tenant_a = registries.org(org_a).await.unwrap();
        let tenant_b = registries.org(org_b).await.unwrap();
        assert_eq!(
            stored_text(&tenant_b, "moves").await.as_deref(),
            Some("crossing the boundary"),
            "the content arrives with the route"
        );
        assert_eq!(stored_text(&tenant_a, "moves").await, None, "and does not stay behind");
        assert_eq!(db.org_of_doc("moves").await.unwrap(), Some(org_b));
        assert_eq!(db.load(&file.doc_id).await.unwrap().text, "crossing the boundary");
        assert_eq!(db.get_file(file.id).await.unwrap().unwrap().size, 21, "the meter followed it");
        assert_eq!(db.org_content_bytes(org_a).await.unwrap(), 0);
        assert_eq!(db.org_content_bytes(org_b).await.unwrap(), 21);

        // It can still be written, in its new home, and nothing reappeared in the
        // old one.
        db.store_document_text("moves", "edited after the move").await.unwrap();
        assert_eq!(stored_text(&tenant_b, "moves").await.as_deref(), Some("edited after the move"));
        assert_eq!(stored_text(&tenant_a, "moves").await, None);
    }

    #[tokio::test]
    async fn copying_a_document_into_another_organization_writes_it_there() {
        use std::collections::HashMap;
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let file = db.create_file(ws_a, "a.md", "original", "text", None, 1).await.unwrap();
        db.store_document_text("original", "the source text").await.unwrap();

        let copied = db
            .transfer_files(ws_b, &[(file.id, "copy.md".into())], true, true, &HashMap::new(), 1)
            .await
            .unwrap();
        assert_ne!(copied[0].doc_id, "original", "a copy is a new document");
        assert_eq!(db.org_of_doc(&copied[0].doc_id).await.unwrap(), Some(org_b));
        assert_eq!(
            stored_text(&registries.org(org_b).await.unwrap(), &copied[0].doc_id).await,
            Some("the source text".to_string()),
            "in the destination organization's database"
        );
        assert_eq!(
            stored_text(&registries.org(org_a).await.unwrap(), "original").await,
            Some("the source text".to_string()),
            "and the source is untouched"
        );
        assert_eq!(db.load(&copied[0].doc_id).await.unwrap().text, "the source text");
        assert_eq!(copied[0].size, 15);

        // A live editor's unsaved text wins over what was flushed, as it did
        // inside one database.
        let mut snapshots = HashMap::new();
        snapshots.insert(
            copied[0].doc_id.clone(),
            PersistedDocument { text: "typed but not flushed".into(), language: None },
        );
        let twice = db
            .transfer_files(ws_b, &[(copied[0].id, "twice.md".into())], true, true, &snapshots, 1)
            .await
            .unwrap();
        assert_eq!(twice[0].size, 21);
        assert_eq!(db.load(&twice[0].doc_id).await.unwrap().text, "typed but not flushed");
    }

    #[tokio::test]
    async fn a_merged_or_reparented_workspace_takes_its_content_across() {
        let (_file, _orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        let (group_a,): (i64,) = sqlx::query_as("SELECT group_id FROM workspace WHERE id = $1")
            .bind(ws_a)
            .fetch_one(db.write())
            .await
            .unwrap();
        let merged = db.create_file(ws_a, "merge.md", "merged-doc", "text", None, 1).await.unwrap();
        let moved = db.create_file(ws_a, "move.md", "moved-doc", "text", None, 1).await.unwrap();
        db.store_document_text("merged-doc", "into the merge").await.unwrap();
        db.store_document_text("moved-doc", "into the reparent").await.unwrap();
        let tenant_a = registries.org(org_a).await.unwrap();
        let tenant_b = registries.org(org_b).await.unwrap();

        db.merge_workspaces(ws_a, ws_b).await.unwrap();
        assert_eq!(stored_text(&tenant_b, "merged-doc").await.as_deref(), Some("into the merge"));
        assert_eq!(stored_text(&tenant_a, "merged-doc").await, None, "and not left in the old tenant");
        assert_eq!(db.org_of_doc("merged-doc").await.unwrap(), Some(org_b));
        assert_eq!(db.load(&merged.doc_id).await.unwrap().text, "into the merge");

        // The surviving workspace now belongs to org B; reparent it into org A's
        // group and every document in it follows the route, ids unchanged.
        let workspace = db.get_workspace(ws_b).await.unwrap().expect("the merged workspace");
        db.move_workspace_to_group(&workspace, group_a).await.unwrap();
        assert_eq!(db.org_of_doc("moved-doc").await.unwrap(), Some(org_a));
        assert_eq!(stored_text(&tenant_a, "moved-doc").await.as_deref(), Some("into the reparent"));
        assert_eq!(stored_text(&tenant_b, "moved-doc").await, None);
        assert_eq!(db.load(&moved.doc_id).await.unwrap().text, "into the reparent");
        assert_eq!(db.org_content_bytes(org_a).await.unwrap(), 31, "both documents, both sizes");
        assert_eq!(db.org_content_bytes(org_b).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_boot_migration_moves_content_that_predates_the_split() {
        let control = tempfile::NamedTempFile::new().unwrap();
        let uri = format!("sqlite://{}", control.path().to_str().unwrap());
        let db = Database::open_with(&uri, BlobStore::inline()).await.unwrap();
        let (org_a, ws_a, org_b, ws_b) = seed_two_orgs(&db).await;
        db.create_file(ws_a, "a.md", "old-a", "text", None, 1).await.unwrap();
        db.create_file(ws_b, "b.md", "old-b", "text", None, 1).await.unwrap();
        db.store_document_text("old-a", "written before the split").await.unwrap();
        assert_eq!(db.table_rows("document").await.unwrap(), 2, "both rows are here today");
        assert_eq!(db.migrate_content_to_orgs().await.unwrap(), 0, "with no registry, nothing moves");

        let orgs = tempfile::tempdir().unwrap();
        let registries = Databases::files_in(db.clone(), orgs.path().to_path_buf());
        db.attach_registries(registries.clone());
        assert_eq!(db.migrate_content_to_orgs().await.unwrap(), 2, "boot moves both");
        assert_eq!(db.table_rows("document").await.unwrap(), 0, "and control ends up holding none");
        assert_eq!(
            stored_text(&registries.org(org_a).await.unwrap(), "old-a").await.as_deref(),
            Some("written before the split")
        );
        assert_eq!(stored_text(&registries.org(org_b).await.unwrap(), "old-b").await.as_deref(), Some(""));
        assert_eq!(db.load("old-a").await.unwrap().text, "written before the split");
        assert_eq!(db.get_file(db.list_files(ws_a).await.unwrap()[0].id).await.unwrap().unwrap().size, 24);
        assert!(orgs.path().join(format!("org-{org_a}.db")).exists());
        assert_eq!(db.migrate_content_to_orgs().await.unwrap(), 0, "a second pass repairs nothing");

        // A partially migrated database — the copy moved, the row here never
        // deleted, and the tenant's copy written since. The newer one wins.
        db.store_document_text("old-a", "typed after the move").await.unwrap();
        insert_content(&db, "old-a", &PersistedDocument { text: "the stale copy".into(), language: None })
            .await
            .unwrap();
        assert_eq!(db.migrate_content_to_orgs().await.unwrap(), 1);
        assert_eq!(
            stored_text(&registries.org(org_a).await.unwrap(), "old-a").await.as_deref(),
            Some("typed after the move"),
            "a migration never overwrites the copy a tenant is already using"
        );
        assert_eq!(stored_text(&db, "old-a").await, None, "and the duplicate here goes");
    }

    #[tokio::test]
    async fn unrouted_content_stays_in_the_control_database_and_still_reads() {
        let (_file, orgs, db, _registries) = split_databases().await;
        // A workspace whose group chain resolves to no organization: there is no
        // tenant to hand its documents to, so they stay exactly where they are.
        let (lost,): (i64,) = sqlx::query_as(
            "INSERT INTO workspace (group_id, name, slug, created_by, created_at) VALUES (NULL, 'Lost', 'lost', 1, 1) RETURNING id",
        )
        .fetch_one(db.write())
        .await
        .unwrap();
        let file = db.create_file(lost, "x.md", "unrouted", "text", None, 1).await.unwrap();
        db.store_document_text("unrouted", "still readable").await.unwrap();
        assert_eq!(stored_text(&db, "unrouted").await.as_deref(), Some("still readable"));
        assert_eq!(db.load(&file.doc_id).await.unwrap().text, "still readable");
        assert_eq!(db.get_file(file.id).await.unwrap().unwrap().size, 14);
        assert_eq!(db.migrate_content_to_orgs().await.unwrap(), 0, "and a boot does not invent an owner");
        assert_eq!(
            std::fs::read_dir(orgs.path()).unwrap().count(),
            0,
            "no tenant database is created for a document that belongs to none"
        );
    }

    #[tokio::test]
    async fn an_archive_carries_content_stored_in_every_tenant() {
        let (_file, _orgs, db, _registries) = split_databases().await;
        let (org_a, ws_a, _org_b, ws_b) = seed_two_orgs(&db).await;
        db.create_file(ws_a, "a.md", "archived-a", "text", None, 1).await.unwrap();
        db.create_file(ws_b, "b.md", "archived-b", "text", None, 1).await.unwrap();
        db.store_document_text("archived-a", "alpha bytes").await.unwrap();
        db.store_document_text("archived-b", "beta bytes").await.unwrap();
        assert_eq!(db.table_rows("document").await.unwrap(), 0, "the control database holds none of it");

        let snapshot = db.export_snapshot().await.unwrap();
        let rows = snapshot["document"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "and the backup still contains all of it");
        assert!(rows
            .iter()
            .any(|row| row["id"] == serde_json::json!("archived-a") && row["text"] == serde_json::json!("alpha bytes")));

        // Restore into a fresh instance of the same shape: the content has to end
        // up in the tenant that owns it, not in the control file it arrived in.
        let target_file = tempfile::NamedTempFile::new().unwrap();
        let target_uri = format!("sqlite://{}", target_file.path().to_str().unwrap());
        let target = Database::open_with(&target_uri, BlobStore::inline()).await.unwrap();
        let target_orgs = tempfile::tempdir().unwrap();
        let target_registries = Databases::files_in(target.clone(), target_orgs.path().to_path_buf());
        target.attach_registries(target_registries.clone());
        let tables: Vec<(String, Vec<serde_json::Value>)> = Database::MIGRATE_TABLES
            .iter()
            .map(|name| ((*name).to_string(), snapshot[*name].as_array().unwrap().clone()))
            .collect();
        target.import_replace_all(&tables).await.unwrap();
        assert_eq!(target.load("archived-a").await.unwrap().text, "alpha bytes");
        assert_eq!(target.load("archived-b").await.unwrap().text, "beta bytes");
        assert_eq!(target.table_rows("document").await.unwrap(), 0, "and it did not stay in the control plane");
        let owner = target.org_of_doc("archived-a").await.unwrap().expect("restored with its route");
        assert_eq!(
            stored_text(&target_registries.org(owner).await.unwrap(), "archived-a").await.as_deref(),
            Some("alpha bytes"),
            "it landed in the organization that owns it"
        );
        assert_eq!(owner, org_a, "and it is the organization the archive named");
    }

    /// A restore replaces the dataset, so a document the archive does not carry
    /// must not survive in the tenant that was holding it.
    #[tokio::test]
    async fn restoring_an_archive_replaces_what_a_tenant_was_holding() {
        let source_file = tempfile::NamedTempFile::new().unwrap();
        let source_uri = format!("sqlite://{}", source_file.path().to_str().unwrap());
        let source = Database::open_with(&source_uri, BlobStore::inline()).await.unwrap();
        let (org_a, ws_a, _org_b, ws_b) = seed_two_orgs(&source).await;
        source.create_file(ws_a, "keep.md", "keep", "text", None, 1).await.unwrap();
        source.create_uploaded_file(ws_b, "x.bin", "upload", Some("image/png"), None, &[9], 1)
            .await
            .unwrap();
        source.store_document_text("keep", "the archive's text").await.unwrap();
        let snapshot = source.export_snapshot().await.unwrap();
        let tables: Vec<(String, Vec<serde_json::Value>)> = Database::MIGRATE_TABLES
            .iter()
            .map(|name| ((*name).to_string(), snapshot[*name].as_array().unwrap().clone()))
            .collect();

        // The target is a routed instance with content of its own.
        let (_file, _orgs, db, registries) = split_databases().await;
        let (t_org, t_ws, ..) = seed_two_orgs(&db).await;
        db.create_file(t_ws, "old.md", "stale-doc", "text", None, 1).await.unwrap();
        db.store_document_text("stale-doc", "not in the archive").await.unwrap();
        assert_eq!(
            stored_text(&registries.org(t_org).await.unwrap(), "stale-doc").await.as_deref(),
            Some("not in the archive")
        );

        db.import_replace_all(&tables).await.unwrap();
        assert_eq!(
            stored_text(&registries.org(org_a).await.unwrap(), "keep").await.as_deref(),
            Some("the archive's text"),
            "the restored document landed in the tenant that owns it"
        );
        assert_eq!(stored_text(&registries.org(t_org).await.unwrap(), "stale-doc").await, None);
        assert_eq!(db.load("keep").await.unwrap().text, "the archive's text");
        assert_eq!(db.count().await.unwrap(), 1, "one document, not two");
    }

    /// The zip-import path is the same code a restore runs, and the content it
    /// writes has to end up where the route says.
    #[tokio::test]
    async fn a_zip_import_lands_its_content_in_the_organizations_file() {
        use super::ImportedFile;
        let (_file, orgs, db, registries) = split_databases().await;
        let (org_a, ws_a, ..) = seed_two_orgs(&db).await;
        let entries = [
            ImportedFile { path: "hello.txt".into(), mime: None, bytes: b"imported text".to_vec(), is_text: true },
            ImportedFile { path: "icon.png".into(), mime: Some("image/png".into()), bytes: vec![0, 1, 2], is_text: false },
        ];
        let imported = db.import_files(ws_a, &entries, 1).await.unwrap();
        assert_eq!(imported.len(), 2);
        let text = imported.iter().find(|f| f.kind == "text").expect("the note came back");
        assert_eq!(text.size, 13, "an import reports the size it wrote");
        let tenant = registries.org(org_a).await.unwrap();
        assert_eq!(stored_text(&tenant, &text.doc_id).await.as_deref(), Some("imported text"));
        assert_eq!(stored_text(&db, &text.doc_id).await, None, "and not in the control file");
        assert_eq!(db.list_files(ws_a).await.unwrap()[0].size, 13);
        assert_eq!(db.org_content_bytes(org_a).await.unwrap(), 16, "13 bytes of text and 3 of png");
        assert!(orgs.path().join(format!("org-{org_a}.db")).exists());
    }

}
