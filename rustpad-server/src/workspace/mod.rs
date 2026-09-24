//! Org / workspace / file / chat routes.
//!
//! Access model: a user may act within their assigned org; the root owner may
//! act within any org (passing `?org=<id>`). Any org member can create and open
//! every workspace in their org. Chat is org-wide.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Buf;
use futures::TryStreamExt;
use log::warn;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use warp::multipart::{FormData, Part};
use warp::{http::StatusCode, hyper::Body, reply::Reply, Filter, Rejection};

use crate::auth::{with_auth, Forbidden};
use crate::crypto;
use crate::database::{ChatMessage, Database, FileRow, Group, ImportedFile, ReactionView, User, Workspace};
use crate::{current_document, evict_all_boards, evict_boards, evict_documents, flush_and_evict, LiveBoards, LiveDocs};

/// Filter extracting the client's ECDH public key header (present when the
/// client encrypts the payload).
fn epk_header() -> impl Filter<Extract = (Option<String>,), Error = Rejection> + Clone {
    warp::header::optional::<String>("x-cortex-epk")
}

/// Ephemeral "who is typing" state. In-memory only (single process): scope
/// string -> user_id -> last-typed unix time. ponytail: a process-global mutex
/// is plenty for one container; move to Redis only if this ever runs multi-node.
fn typing_state() -> &'static Mutex<HashMap<String, HashMap<i64, i64>>> {
    static S: OnceLock<Mutex<HashMap<String, HashMap<i64, i64>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A typist counts as "typing" for this many seconds after their last keystroke.
const TYPING_TTL: i64 = 6;

fn mark_typing(scope: String, user_id: i64, now: i64) {
    typing_state()
        .lock()
        .unwrap()
        .entry(scope)
        .or_default()
        .insert(user_id, now);
}

/// Who (other than `exclude`) is currently typing in `scope`; also prunes stale entries.
fn who_typing(scope: &str, exclude: i64, now: i64) -> Vec<i64> {
    let mut g = typing_state().lock().unwrap();
    match g.get_mut(scope) {
        Some(m) => {
            m.retain(|_, t| now - *t < TYPING_TTL);
            m.keys().copied().filter(|&id| id != exclude).collect()
        }
        None => Vec::new(),
    }
}

/// Canonical scope key for a 1:1 conversation (order-independent).
fn dm_scope(a: i64, b: i64) -> String {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    format!("dm:{lo}:{hi}")
}

/// Serialize messages to JSON, folding each message's reactions in under a
/// `reactions` key. Kept out of the SQL struct because sqlx can't decode a
/// computed Vec field.
fn attach_reactions(
    messages: Vec<ChatMessage>,
    mut reactions: HashMap<i64, Vec<ReactionView>>,
) -> Vec<serde_json::Value> {
    messages
        .into_iter()
        .map(|m| {
            let r = reactions.remove(&m.id).unwrap_or_default();
            let mut v = serde_json::to_value(&m).unwrap_or_else(|_| json!({}));
            v["reactions"] = json!(r);
            v
        })
        .collect()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time before epoch")
        .as_secs() as i64
}

fn random_doc_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Normalize separators, but *reject* invalid segments rather than silently
/// removing `..` or empty parts (important for zip import and path conflicts).
fn clean_path(raw: &str) -> Option<String> {
    let path = raw.replace('\\', "/");
    if path.is_empty() || path.len() > 512 || path.starts_with('/') {
        return None;
    }
    if path.split('/').any(|part| {
        part.trim().is_empty()
            || part == "."
            || part == ".."
            || part.chars().any(char::is_control)
    }) {
        return None;
    }
    Some(path)
}

fn with_db(db: Database) -> impl Filter<Extract = (Database,), Error = Infallible> + Clone {
    warp::any().map(move || db.clone())
}

fn with_docs(live: LiveDocs) -> impl Filter<Extract = (LiveDocs,), Error = Infallible> + Clone {
    warp::any().map(move || live.clone())
}

fn with_boards(boards: LiveBoards) -> impl Filter<Extract = (LiveBoards,), Error = Infallible> + Clone {
    warp::any().map(move || boards.clone())
}

fn err(status: StatusCode, msg: &str) -> warp::reply::Response {
    warp::reply::with_status(warp::reply::json(&json!({ "error": msg })), status).into_response()
}

/// The org a request acts within: the user's own org, or (for root) `?org=`.
fn acting_org(user: &User, q: &OrgQuery) -> Option<i64> {
    if user.role == "root" {
        q.org
    } else {
        user.org_id
    }
}

/// The visibility rule shared by workspaces and their groups.
/// root bypasses everything; a regular member sees org-scope groups,
/// their own personal groups, and group-scope groups they belong to.
fn scope_ok(scope: &str, created_by: i64, me: i64, is_member: bool) -> bool {
    match scope {
        "org" => true,
        "personal" => created_by == me,
        "group" => is_member,
        _ => false,
    }
}

/// Resolve a workspace the user may access, else reject with Forbidden.
/// Visibility comes from the workspace's group.
async fn ensure_ws(db: &Database, user: &User, ws_id: i64) -> Result<Workspace, Rejection> {
    match db.get_workspace(ws_id).await.ok().flatten() {
        Some(ws) if user.role == "root" => Ok(ws),
        Some(ws) => {
            let group = db.get_group(ws.group_id).await.ok().flatten();
            match group {
                Some(g) if user.org_id == Some(g.org_id) => {
                    // Org admins manage everything in their org (they can already
                    // manage the group itself, clear its chat and delete it);
                    // other members are bound by the group's scope.
                    if user.role == "admin" {
                        return Ok(ws);
                    }
                    let member = g.scope == "group"
                        && db.is_group_member(g.id, user.id).await.unwrap_or(false);
                    if scope_ok(&g.scope, g.created_by, user.id, member) {
                        Ok(ws)
                    } else {
                        Err(warp::reject::custom(Forbidden))
                    }
                }
                _ => Err(warp::reject::custom(Forbidden)),
            }
        }
        _ => Err(warp::reject::custom(Forbidden)),
    }
}

/// Resolve a group the user may access (chat routes are keyed by group).
async fn ensure_group(db: &Database, user: &User, group_id: i64) -> Result<Group, Rejection> {
    match db.get_group(group_id).await.ok().flatten() {
        Some(g) if user.role == "root" => Ok(g),
        Some(g) if user.org_id == Some(g.org_id) => {
            // Same rule as workspaces: org admins manage every group in
            // their org; other members are bound by the group's scope.
            if user.role == "admin" {
                return Ok(g);
            }
            let member = g.scope == "group"
                && db.is_group_member(g.id, user.id).await.unwrap_or(false);
            if scope_ok(&g.scope, g.created_by, user.id, member) {
                Ok(g)
            } else {
                Err(warp::reject::custom(Forbidden))
            }
        }
        _ => Err(warp::reject::custom(Forbidden)),
    }
}

/// Revoke existing text and whiteboard sockets before membership or scope
/// changes; checking only the initial WebSocket handshake is insufficient.
async fn disconnect_group(
    db: &Database, live: &LiveDocs, boards: &LiveBoards, group_id: i64,
) -> Result<(), warp::reply::Response> {
    let ids = db.group_doc_ids(group_id).await.map_err(|e| {
        warn!("disconnect_group docs: {e}");
        err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits")
    })?;
    flush_and_evict(live, db, &ids).await.map_err(|e| {
        warn!("disconnect_group flush: {e}");
        err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits")
    })?;
    let files = db.group_file_ids(group_id).await.map_err(|e| {
        warn!("disconnect_group files: {e}");
        err(StatusCode::INTERNAL_SERVER_ERROR, "could not close board editors")
    })?;
    evict_boards(boards, &files);
    Ok(())
}

/// The owner of a group may manage it: the group's creator or a root/org admin.
async fn group_owner(db: &Database, user: &User, group_id: i64) -> bool {
    user.role == "root"
        || user.role == "admin"
        || db
            .get_group(group_id)
            .await
            .ok()
            .flatten()
            .map(|g| g.created_by == user.id)
            .unwrap_or(false)
}

/// Destructive workspace operations are restricted to its creator or a group
/// manager (not every editor in a shared group).
async fn workspace_manager(db: &Database, user: &User, ws: &Workspace) -> bool {
    user.role == "root"
        || user.role == "admin"
        || ws.created_by == user.id
        || group_owner(db, user, ws.group_id).await
}

#[derive(Deserialize, Default)]
struct OrgQuery {
    org: Option<i64>,
}

#[derive(Deserialize)]
struct WsUpload {
    workspace_id: i64,
    #[serde(default)]
    org: Option<i64>,
}

#[derive(Deserialize)]
struct CreateWorkspace {
    name: String,
    #[serde(default)]
    scope: Option<String>,
}

/// Create a workspace (file project) inside an existing group.
#[derive(Deserialize)]
struct CreateWsInGroup {
    name: String,
}

#[derive(Deserialize)]
struct MemberReq {
    user_id: i64,
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

#[derive(Deserialize)]
struct CreateFile {
    workspace_id: i64,
    path: String,
}

#[derive(Deserialize)]
struct MoveFile {
    path: String,
}

#[derive(Deserialize)]
struct FileTransfer {
    target_workspace_id: i64,
    mode: String,
    #[serde(default)]
    on_conflict: Option<String>,
    items: Vec<TransferItem>,
}

#[derive(Deserialize)]
struct TransferItem {
    id: i64,
    path: String,
}

#[derive(Deserialize)]
struct FileBatch {
    ids: Vec<i64>,
}

#[derive(Deserialize)]
struct MergeWs {
    target_workspace_id: i64,
}

#[derive(Deserialize)]
struct GroupMove {
    group_id: i64,
}

#[derive(Deserialize)]
struct ChatPost {
    body: String,
}

#[derive(Deserialize)]
struct EditBody {
    body: String,
}

#[derive(Deserialize)]
struct ChatQuery {
    group_id: i64,
}

#[derive(Deserialize)]
struct DmQuery {
    with: i64,
    #[serde(default)]
    org: Option<i64>,
}

#[derive(Deserialize, Default)]
struct OverviewReq {
    #[serde(default)]
    group_id: Option<i64>,
    #[serde(default)]
    org: Option<i64>,
    /// Per-group read markers, keyed by group id.
    #[serde(default)]
    group_read: Option<HashMap<i64, i64>>,
    #[serde(default)]
    dm_read: HashMap<i64, i64>,
}

/// Trim a message body to a short one-line preview for the sidebar.
fn preview(body: &str) -> String {
    let s = body.trim().replace('\n', " ");
    if s.chars().count() > 140 {
        s.chars().take(140).collect::<String>() + "…"
    } else {
        s
    }
}

/// The org a DM acts within: the user's own, or (for root) `?org=`.
fn dm_org(user: &User, q: &DmQuery) -> Option<i64> {
    if user.role == "root" {
        q.org
    } else {
        user.org_id
    }
}

/// Org, workspace, file, and chat HTTP routes.
pub(crate) fn routes(db: Database, live: LiveDocs, boards: LiveBoards) -> impl Filter<Extract = (impl Reply,), Error = Rejection> + Clone {
    let get_org = warp::path!("org")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and_then(get_org);

    // Groups are the top-level container: create / view / rename / delete,
    // manage members, and create workspaces (file projects) inside a group.
    let create_group_r = warp::path!("groups")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and(warp::body::json())
        .and_then(create_group);

    let get_group_r = warp::path!("groups" / i64)
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(get_group);

    let rename_group_r = warp::path!("groups" / i64)
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(rename_group);

    let delete_group_r = warp::path!("groups" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(delete_group);

    let add_member = warp::path!("groups" / i64 / "members")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(add_member);

    let remove_member = warp::path!("groups" / i64 / "members" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(remove_member);

    let create_ws_in_group = warp::path!("groups" / i64 / "workspaces")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(create_ws_in_group);

    let get_ws = warp::path!("workspaces" / i64)
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(get_workspace);

    let rename_ws = warp::path!("workspaces" / i64)
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(rename_workspace);

    let delete_ws = warp::path!("workspaces" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(delete_workspace);

    let merge_ws = warp::path!("workspaces" / i64 / "merge")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and(warp::body::json())
        .and_then(merge_workspace);

    let reparent_ws = warp::path!("workspaces" / i64 / "group")
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and(warp::body::json())
        .and_then(reparent_workspace);

    let import_ws = warp::path!("workspaces" / i64 / "import")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::content_length_limit(64 * 1024 * 1024))
        .and(warp::body::bytes())
        .and_then(import_workspace);

    let create_file = warp::path!("files")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(create_file);

    let upload = warp::path!("files" / "upload")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<WsUpload>())
        .and(warp::multipart::form().max_length(32 * 1024 * 1024))
        .and_then(upload_file);

    let raw = warp::path!("files" / i64 / "raw")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and_then(raw_file);

    let download = warp::path!("files" / i64 / "download")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and_then(download_file);

    let export_ws = warp::path!("workspaces" / i64 / "export")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and_then(export_workspace);

    let archive_files = warp::path!("files" / "archive")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(warp::body::content_length_limit(32 * 1024))
        .and(warp::body::json())
        .and_then(archive_files);

    // Solo-editor saves for oversized text files (no live OT session).
    let put_text = warp::path!("files" / i64 / "text")
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(warp::body::json())
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and_then(put_file_text);

    // Whiteboard scene saves: overwrite a binary file's stored blob.
    let put_blob = warp::path!("files" / i64 / "blob")
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::header::optional::<i64>("x-cortex-revision"))
        .and(warp::body::bytes())
        .and_then(put_file_blob);

    let move_file = warp::path!("files" / i64)
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(move_file);

    let delete_file = warp::path!("files" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(delete_file);

    let transfer_r = warp::path!("files" / "transfer")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and(warp::body::content_length_limit(1024 * 1024))
        .and(warp::body::json())
        .and_then(transfer_files);

    let delete_batch_r = warp::path!("files" / "delete-batch")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and(warp::body::content_length_limit(32 * 1024))
        .and(warp::body::json())
        .and_then(delete_file_batch);

    // Workspace group chat.
    let chat_overview_r = warp::path!("chat" / "overview")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(chat_overview);

    let get_chat_r = warp::path!("chat")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and(epk_header())
        .and_then(get_chat);

    let post_chat_r = warp::path!("chat")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(post_chat);

    let clear_chat_r = warp::path!("chat")
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and_then(clear_chat);

    // Org-wide 1:1 direct messages.
    let get_dm_r = warp::path!("dm")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and(epk_header())
        .and_then(get_dm);

    let post_dm_r = warp::path!("dm")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(post_dm);

    let clear_dm_r = warp::path!("dm")
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and_then(clear_dm);

    // Per-message edit / delete (author-scoped). `chat / i64` vs `chat` keeps
    // these distinct from the "clear whole thread" routes above.
    let edit_chat_r = warp::path!("chat" / i64)
        .and(warp::patch())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(edit_chat);

    let delete_chat_msg_r = warp::path!("chat" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(delete_chat_msg);

    let edit_dm_r = warp::path!("dm" / i64)
        .and(warp::patch())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(edit_dm);

    let delete_dm_msg_r = warp::path!("dm" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(delete_dm_msg);

    // Typing pings ("chat"/"dm" + literal "typing" — distinct from the /{id} routes).
    let typing_chat_r = warp::path!("chat" / "typing")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<ChatQuery>())
        .and_then(typing_chat);

    let typing_dm_r = warp::path!("dm" / "typing")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<DmQuery>())
        .and_then(typing_dm);

    // Emoji reactions (toggle).
    let react_r = warp::path!("reaction")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(epk_header())
        .and(warp::body::bytes())
        .and_then(toggle_reaction);

    // Presence: GET the org roster's online state, POST a heartbeat.
    let presence_get_r = warp::path!("presence")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and_then(presence_get);

    let presence_ping_r = warp::path!("presence")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(presence_ping);

    let audit_r = warp::path!("audit")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(audit_log);

    let storage_r = warp::path!("admin" / "storage")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(admin_storage);

    let compact_r = warp::path!("admin" / "compact")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(admin_compact);

    // Whole-instance migration (root only): export every table + blobs as one
    // zip, or restore such a zip into this instance.
    let admin_export_all_r = warp::path!("admin" / "export-all")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(admin_export_all);

    let admin_import_all_r = warp::path!("admin" / "import-all")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(warp::body::content_length_limit(256 * 1024 * 1024))
        .and(warp::body::bytes())
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(admin_import_all);

    // Boxed separately: the main chain sits right at the compiler's nesting
    // limit, so each additional route must erase its type before joining.
    let admin_all_r = admin_export_all_r.or(admin_import_all_r).boxed();

    // Chat images (pasted into chat) — stored separately from workspace files.
    let post_chat_image = warp::path!("chat-image")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::query::<OrgQuery>())
        .and(warp::multipart::form().max_length(16 * 1024 * 1024))
        .and_then(upload_chat_image);

    let get_chat_image_r = warp::path!("chat-image" / i64)
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db))
        .and_then(get_chat_image);

    // Box the two halves: warp's `.or()` builds a deeply-nested type, and past
    // ~two-dozen routes the compiler overflows resolving it (E0275). `.boxed()`
    // erases each half's type so the final combination stays shallow.
    let file_ops = transfer_r.or(delete_batch_r).or(archive_files).boxed();
    let ws_ops = merge_ws.or(reparent_ws).or(import_ws).boxed();
    let workspace_routes = get_org
        .or(create_group_r)
        .or(get_group_r)
        .or(rename_group_r)
        .or(delete_group_r)
        .or(add_member)
        .or(remove_member)
        .or(create_ws_in_group)
        .or(upload)
        .or(put_blob)
        .or(raw)
        .or(download)
        .or(export_ws)
        .or(get_ws)
        .or(rename_ws)
        .or(delete_ws)
        .or(create_file)
        .or(move_file)
        .or(put_text)
        .or(delete_file)
        .or(audit_r)
        .or(storage_r)
        .or(compact_r)
        .or(admin_all_r)
        .or(file_ops)
        .or(ws_ops)
        .boxed();

    let chat_routes = chat_overview_r
        .or(get_chat_r)
        .or(post_chat_r)
        .or(clear_chat_r)
        .or(get_dm_r)
        .or(post_dm_r)
        .or(clear_dm_r)
        .or(edit_chat_r)
        .or(delete_chat_msg_r)
        .or(edit_dm_r)
        .or(delete_dm_msg_r)
        .or(typing_chat_r)
        .or(typing_dm_r)
        .or(react_r)
        .or(presence_get_r)
        .or(presence_ping_r)
        .or(post_chat_image)
        .or(get_chat_image_r)
        .boxed();

    workspace_routes.or(chat_routes)
}

async fn get_org(user: User, db: Database, q: OrgQuery) -> Result<impl Reply, Rejection> {
    let is_owner = user.role == "root";
    let org_id = acting_org(&user, &q);
    let (org, groups, workspaces, members) = match org_id {
        Some(oid) => {
            // Every person gets their own private "Personal" group — create it
            // on first access so each user always has a personal space.
            let has_personal = if is_owner || user.role == "admin" {
                db.list_groups(oid).await.unwrap_or_default()
            } else {
                db.list_groups_for_user(oid, user.id)
                    .await
                    .unwrap_or_default()
            }
            .iter()
            .any(|g| g.scope == "personal" && g.created_by == user.id);
            if !has_personal {
                let _ = db
                    .create_group(oid, "Personal", user.id, now_secs(), "personal")
                    .await;
            }
            let groups = if is_owner || user.role == "admin" {
                db.list_groups(oid).await.unwrap_or_default()
            } else {
                db.list_groups_for_user(oid, user.id)
                    .await
                    .unwrap_or_default()
            };
            // All workspaces inside the visible groups (so the sidebar can show
            // the group → workspace hierarchy in one round-trip).
            let mut workspaces = Vec::new();
            for g in &groups {
                workspaces.extend(db.list_workspaces(g.id).await.unwrap_or_default());
            }
            (
                db.get_org(oid).await.ok().flatten(),
                groups,
                workspaces,
                db.list_org_members(oid).await.unwrap_or_default(),
            )
        }
        None => (None, Vec::new(), Vec::new(), Vec::new()),
    };
    // Groups with their real member counts (group scope) so the sidebar can
    // show "N members" without an extra request per group.
    let mut groups_json = Vec::new();
    for g in groups {
        let mc = if g.scope == "group" {
            db.group_member_ids(g.id).await.unwrap_or_default().len() as i64
        } else {
            0
        };
        groups_json.push(json!({
            "id": g.id,
            "org_id": g.org_id,
            "name": g.name,
            "scope": g.scope,
            "created_by": g.created_by,
            "member_count": mc,
        }));
    }
    let groups = groups_json;
    Ok(warp::reply::json(&json!({
        "org": org,
        "groups": groups,
        "workspaces": workspaces,
        "members": members,
        "isOwner": is_owner,
    })))
}

async fn create_group(
    user: User,
    db: Database,
    q: OrgQuery,
    body: CreateWorkspace,
) -> Result<impl Reply, Rejection> {
    let org_id = match acting_org(&user, &q) {
        Some(o) => o,
        None => return Ok(err(StatusCode::FORBIDDEN, "you are not assigned to an org")),
    };
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    let scope = body.scope.unwrap_or_else(|| "group".to_string());
    if !["group", "personal"].contains(&scope.as_str()) {
        return Ok(err(StatusCode::BAD_REQUEST, "invalid scope"));
    }
    match db.create_group(org_id, name, user.id, now_secs(), &scope).await {
        Ok(g) => Ok(warp::reply::json(&json!({ "group": g })).into_response()),
        Err(_) => Ok(err(StatusCode::BAD_REQUEST, "could not create group")),
    }
}

async fn get_group(group_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, group_id).await?;
    let workspaces = db.list_workspaces(g.id).await.unwrap_or_default();
    let member_ids = if g.scope == "group" {
        db.group_member_ids(g.id).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(warp::reply::json(
        &json!({ "group": g, "workspaces": workspaces, "member_ids": member_ids }),
    ))
}

async fn rename_group(
    group_id: i64,
    user: User,
    db: Database,
    body: RenameReq,
) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, group_id).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    if !group_owner(&db, &user, g.id).await {
        return Ok(err(StatusCode::FORBIDDEN, "only the group owner can rename"));
    }
    match db.rename_group(g.id, name).await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(e) => {
            warn!("rename_group {group_id}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not rename group"))
        }
    }
}

async fn delete_group(
    group_id: i64,
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, group_id).await?;
    if !group_owner(&db, &user, g.id).await {
        return Ok(err(StatusCode::FORBIDDEN, "only the group owner can delete"));
    }
    let _gate = crate::access_gate().write().await;
    if let Err(response) = disconnect_group(&db, &live, &boards, g.id).await {
        return Ok(response);
    }
    match db.delete_group(g.id).await {
        Ok(ids) => {
            evict_documents(&live, &ids);
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Err(e) => {
            warn!("delete_group {group_id}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not delete group"))
        }
    }
}

async fn create_ws_in_group(
    group_id: i64,
    user: User,
    db: Database,
    body: CreateWsInGroup,
) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, group_id).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    match db.create_workspace(g.id, name, user.id, now_secs()).await {
        Ok(ws) => Ok(warp::reply::json(&json!({ "workspace": ws })).into_response()),
        Err(_) => Ok(err(StatusCode::BAD_REQUEST, "could not create workspace")),
    }
}

async fn get_workspace(ws_id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let files = db.list_files(ws.id).await.unwrap_or_default();
    Ok(warp::reply::json(
        &json!({ "workspace": ws, "files": files }),
    ))
}

async fn add_member(
    group_id: i64,
    user: User,
    db: Database,
    body: MemberReq,
) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, group_id).await?;
    if g.scope != "group" {
        return Ok(err(StatusCode::BAD_REQUEST, "only group-scope groups have members"));
    }
    if !group_owner(&db, &user, g.id).await {
        return Ok(err(StatusCode::FORBIDDEN, "only the group owner can manage members"));
    }
    // Never grant a user from another org access, even if the caller knows the id.
    if db.user_org(body.user_id).await.ok().flatten() != Some(g.org_id) {
        return Ok(err(StatusCode::BAD_REQUEST, "member must belong to this org"));
    }
    match db.add_group_member(g.id, body.user_id, "member").await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(e) => {
            warn!("add_group_member {}: {e}", g.id);
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not add member"))
        }
    }
}

async fn remove_member(
    group_id: i64,
    user_id: i64,
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, group_id).await?;
    if g.scope != "group" {
        return Ok(err(StatusCode::BAD_REQUEST, "only group-scope groups have members"));
    }
    if !group_owner(&db, &user, g.id).await {
        return Ok(err(StatusCode::FORBIDDEN, "only the group owner can manage members"));
    }
    if user_id == g.created_by {
        return Ok(err(StatusCode::CONFLICT, "transfer ownership before removing the owner"));
    }
    let _gate = crate::access_gate().write().await;
    if let Err(response) = disconnect_group(&db, &live, &boards, g.id).await {
        return Ok(response);
    }
    match db.remove_group_member(g.id, user_id).await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(e) => {
            warn!("remove_group_member {}: {e}", g.id);
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not remove member"))
        }
    }
}

async fn rename_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    body: RenameReq,
) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    if !workspace_manager(&db, &user, &ws).await {
        return Ok(err(StatusCode::FORBIDDEN, "only a workspace manager can rename"));
    }
    match db.rename_workspace(ws.id, name).await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(e) => {
            warn!("rename_workspace {ws_id}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not rename workspace"))
        }
    }
}

async fn delete_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    if !workspace_manager(&db, &user, &ws).await {
        return Ok(err(StatusCode::FORBIDDEN, "only a workspace manager can delete"));
    }
    let _gate = crate::access_gate().write().await;
    let files = match db.workspace_file_ids(ws.id).await {
        Ok(ids) => ids,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not list files")),
    };
    match db.delete_workspace(ws.id).await {
        Ok(ids) => {
            evict_documents(&live, &ids);
            evict_boards(&boards, &files);
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Err(e) => {
            warn!("delete_workspace {ws_id}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not delete workspace"))
        }
    }
}

/// Move a workspace between groups. All live OT editors are flushed and
/// disconnected first so membership changes take effect immediately.
async fn reparent_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
    body: GroupMove,
) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let target = ensure_group(&db, &user, body.group_id).await?;
    if !workspace_manager(&db, &user, &ws).await {
        return Ok(err(StatusCode::FORBIDDEN, "only a workspace manager can move it"));
    }
    if ws.group_id == target.id {
        return Ok(warp::reply::json(&json!({ "workspace": ws })).into_response());
    }
    let _gate = crate::access_gate().write().await;
    let ids = match db.workspace_doc_ids(ws.id).await {
        Ok(ids) => ids,
        Err(e) => {
            warn!("reparent_workspace docs: {e}");
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not move workspace"));
        }
    };
    if let Err(e) = flush_and_evict(&live, &db, &ids).await {
        warn!("reparent_workspace flush: {e}");
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits"));
    }
    let files = match db.workspace_file_ids(ws.id).await {
        Ok(ids) => ids,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not close board editors")),
    };
    evict_boards(&boards, &files);
    match db.move_workspace_to_group(&ws, target.id).await {
        Ok(updated) => {
            let _ = db.audit(Some(target.org_id), Some(user.id), "move_workspace", Some(&ws.name), now_secs()).await;
            Ok(warp::reply::json(&json!({ "workspace": updated })).into_response())
        }
        Err(e) => {
            warn!("reparent_workspace {ws_id}: {e}");
            Ok(err(StatusCode::CONFLICT, "could not move workspace"))
        }
    }
}

/// Merge all files into an existing workspace and remove the empty source.
/// Each conflicting file gets a numbered suffix, never an overwrite.
async fn merge_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
    body: MergeWs,
) -> Result<impl Reply, Rejection> {
    if ws_id == body.target_workspace_id {
        return Ok(err(StatusCode::BAD_REQUEST, "choose a different destination"));
    }
    let source = ensure_ws(&db, &user, ws_id).await?;
    let target = ensure_ws(&db, &user, body.target_workspace_id).await?;
    if !workspace_manager(&db, &user, &source).await {
        return Ok(err(StatusCode::FORBIDDEN, "only a workspace manager can merge it"));
    }
    let _gate = crate::access_gate().write().await;
    let ids = match db.workspace_doc_ids(ws_id).await {
        Ok(ids) => ids,
        Err(e) => {
            warn!("merge_workspace docs: {e}");
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not merge workspaces"));
        }
    };
    if let Err(e) = flush_and_evict(&live, &db, &ids).await {
        warn!("merge_workspace flush: {e}");
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits"));
    }
    let files = match db.workspace_file_ids(source.id).await {
        Ok(ids) => ids,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not close board editors")),
    };
    evict_boards(&boards, &files);
    match db.merge_workspaces(source.id, target.id).await {
        Ok((moved, _)) => {
            let _ = db.audit(user.org_id, Some(user.id), "merge_workspaces", Some(&format!("{} → {} ({moved} files)", source.name, target.name)), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true, "moved": moved })).into_response())
        }
        Err(e) => {
            warn!("merge_workspace {ws_id}: {e}");
            Ok(err(StatusCode::CONFLICT, "merge failed; no files were moved"))
        }
    }
}

/// One atomic server-side copy/move, even for an entire folder. Every source
/// and the destination are checked individually. Copies use the latest OT
/// snapshot rather than the last periodic persistence tick.
async fn transfer_files(
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
    body: FileTransfer,
) -> Result<impl Reply, Rejection> {
    let copy = match body.mode.as_str() {
        "copy" => true,
        "move" => false,
        _ => return Ok(err(StatusCode::BAD_REQUEST, "mode must be copy or move")),
    };
    let rename_conflicts = match body.on_conflict.as_deref().unwrap_or("error") {
        "rename" => true,
        "error" => false,
        _ => return Ok(err(StatusCode::BAD_REQUEST, "invalid conflict policy")),
    };
    if body.items.is_empty() || body.items.len() > 1000 {
        return Ok(err(StatusCode::BAD_REQUEST, "select 1–1000 files"));
    }
    let target = ensure_ws(&db, &user, body.target_workspace_id).await?;
    let mut items = Vec::with_capacity(body.items.len());
    let mut snapshots = HashMap::new();
    let mut to_revoke = Vec::new();
    let mut boards_to_revoke = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut size: i64 = 0;
    for item in body.items {
        if !seen.insert(item.id) {
            return Ok(err(StatusCode::BAD_REQUEST, "duplicate file id"));
        }
        let path = match clean_path(&item.path) {
            Some(p) => p,
            None => return Ok(err(StatusCode::BAD_REQUEST, "invalid destination path")),
        };
        let file = match db.get_file(item.id).await {
            Ok(Some(f)) => f,
            Ok(None) => return Ok(err(StatusCode::NOT_FOUND, "source file not found")),
            Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not read source")),
        };
        let source = ensure_ws(&db, &user, file.workspace_id).await?;
        if copy && file.kind == "text" && live.contains_key(&file.doc_id) {
            match current_document(&live, &db, &file.doc_id).await {
                Ok(doc) => { snapshots.insert(file.doc_id.clone(), doc); }
                Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not read source")),
            }
        }
        if !copy && source.group_id != target.group_id {
            to_revoke.push(file.doc_id.clone());
            boards_to_revoke.push(file.id);
        }
        size += file.size;
        if copy && size > 256 * 1024 * 1024 {
            return Ok(err(StatusCode::PAYLOAD_TOO_LARGE, "copy exceeds 256 MB"));
        }
        items.push((item.id, path));
    }
    let _gate = crate::access_gate().write().await;
    if let Err(e) = flush_and_evict(&live, &db, &to_revoke).await {
        warn!("transfer flush: {e}");
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits"));
    }
    evict_boards(&boards, &boards_to_revoke);
    match db.transfer_files(target.id, &items, copy, rename_conflicts, &snapshots, now_secs()).await {
        Ok(files) => {
            let _ = db.audit(user.org_id, Some(user.id), if copy { "copy_files" } else { "move_files" }, Some(&format!("{} file(s) → workspace {}", files.len(), target.id)), now_secs()).await;
            Ok(warp::reply::json(&json!({ "files": files })).into_response())
        }
        Err(e) => {
            warn!("transfer_files: {e}");
            Ok(err(StatusCode::CONFLICT, "transfer failed; no files were changed (check names and content)"))
        }
    }
}

/// Delete a folder/multi-selection in one transaction, rather than leaving a
/// half-deleted folder after one of hundreds of per-file requests fails.
async fn delete_file_batch(
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
    body: FileBatch,
) -> Result<impl Reply, Rejection> {
    if body.ids.is_empty() || body.ids.len() > 1000 {
        return Ok(err(StatusCode::BAD_REQUEST, "select 1–1000 files"));
    }
    for id in &body.ids {
        if !file_allowed(&db, &user, *id).await {
            return Err(warp::reject::custom(Forbidden));
        }
    }
    let _gate = crate::access_gate().write().await;
    match db.delete_files(&body.ids).await {
        Ok(ids) => {
            evict_documents(&live, &ids);
            evict_boards(&boards, &body.ids);
            let _ = db.audit(user.org_id, Some(user.id), "delete_files", Some(&format!("{} file(s)", ids.len())), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true, "deleted": ids.len() })).into_response())
        }
        Err(e) => {
            warn!("delete_file_batch: {e}");
            Ok(err(StatusCode::CONFLICT, "delete failed; no files were removed"))
        }
    }
}

async fn create_file(user: User, db: Database, body: CreateFile) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, body.workspace_id).await?;
    let path = match clean_path(&body.path) {
        Some(p) => p,
        None => return Ok(err(StatusCode::BAD_REQUEST, "invalid file name")),
    };
    let doc_id = random_doc_id();
    match db
        .create_file(body.workspace_id, &path, &doc_id, "text", None, now_secs())
        .await
    {
        Ok(file) => {
            let _ = db
                .audit(
                    user.org_id,
                    Some(user.id),
                    "create_file",
                    Some(&path),
                    now_secs(),
                )
                .await;
            Ok(warp::reply::json(&json!({ "file": file })).into_response())
        }
        Err(_) => Ok(err(
            StatusCode::BAD_REQUEST,
            "could not create file (name may already exist)",
        )),
    }
}

/// MIME inference for ZIP entries (ZIP itself carries no trusted MIME type).
fn mime_from_path(path: &str) -> Option<String> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => return None,
    };
    Some(mime.to_string())
}

/// Extract a bounded ZIP, rejecting traversal, symlinks, duplicate paths and
/// decompression bombs BEFORE any database changes are attempted.
fn unpack_workspace_zip(body: bytes::Bytes) -> anyhow::Result<Vec<ImportedFile>> {
    use std::io::Read as _;
    const MAX_FILE: u64 = 32 * 1024 * 1024;
    const MAX_TOTAL: u64 = 128 * 1024 * 1024;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(body))?;
    if archive.len() > 2000 {
        anyhow::bail!("too many ZIP entries");
    }
    let mut entries = Vec::new();
    let mut dirs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            anyhow::bail!("ZIP contains a symlink");
        }
        // Common ZIP tools prefix paths with "./"; no other dot or parent
        // components are accepted. A literal leading slash is also rejected.
        let name = entry.name().strip_prefix("./").unwrap_or(entry.name());
        let path = clean_path(name.trim_end_matches('/'))
            .ok_or_else(|| anyhow::anyhow!("ZIP contains an unsafe path"))?;
        if !seen.insert(path.clone()) {
            anyhow::bail!("ZIP contains duplicate paths");
        }
        if entry.is_dir() {
            dirs.push(path);
            continue;
        }
        if entry.size() > MAX_FILE || total + entry.size() > MAX_TOTAL {
            anyhow::bail!("ZIP exceeds the size limit");
        }
        let mut bytes = Vec::new();
        (&mut entry).take(MAX_FILE + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE {
            anyhow::bail!("ZIP entry exceeds 32 MB");
        }
        total += bytes.len() as u64;
        if total > MAX_TOTAL {
            anyhow::bail!("ZIP exceeds 128 MB uncompressed");
        }
        let mime = mime_from_path(&path);
        let is_text = mime.is_none()
            && !path.to_ascii_lowercase().ends_with(".board")
            && bytes.len() <= 1_000_000
            && !bytes.contains(&0)
            && std::str::from_utf8(&bytes).is_ok();
        entries.push(ImportedFile {
            mime,
            path,
            bytes,
            is_text,
        });
    }
    for dir in dirs {
        if !entries.iter().any(|e| e.path.starts_with(&format!("{dir}/"))) {
            let path = format!("{dir}/.keep");
            if path.len() > 512 { anyhow::bail!("ZIP directory path is too long"); }
            entries.push(ImportedFile { path, mime: None, bytes: Vec::new(), is_text: true });
        }
    }
    if entries.len() > 1000 {
        anyhow::bail!("ZIP has more than 1000 files");
    }
    Ok(entries)
}

/// Import a ZIP into the workspace atomically. Existing files are never
/// overwritten; numbered names preserve both sides of a collision.
async fn import_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    body: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let files = match unpack_workspace_zip(body) {
        Ok(files) => files,
        Err(e) => return Ok(err(StatusCode::BAD_REQUEST, &format!("invalid ZIP: {e}"))),
    };
    match db.import_files(ws.id, &files, now_secs()).await {
        Ok(added) => {
            let _ = db.audit(user.org_id, Some(user.id), "import_workspace", Some(&format!("{} files", added.len())), now_secs()).await;
            Ok(warp::reply::json(&json!({ "files": added })).into_response())
        }
        Err(e) => {
            warn!("import_workspace {ws_id}: {e}");
            Ok(err(StatusCode::CONFLICT, "ZIP import failed; no files were added"))
        }
    }
}

async fn read_part(part: Part) -> Result<Vec<u8>, warp::Error> {
    part.stream()
        .try_fold(Vec::new(), |mut acc, buf| async move {
            acc.extend_from_slice(buf.chunk());
            Ok(acc)
        })
        .await
}

async fn upload_file(
    user: User,
    db: Database,
    q: WsUpload,
    mut form: FormData,
) -> Result<impl Reply, Rejection> {
    ensure_ws(&db, &user, q.workspace_id).await?;
    let mut found: Option<(String, Option<String>, Vec<u8>)> = None;
    loop {
        match form.try_next().await {
            Ok(Some(part)) => {
                if part.name() == "file" {
                    let filename = clean_path(part.filename().unwrap_or("upload"))
                        .unwrap_or_else(|| "upload".to_string());
                    let mime = part.content_type().map(|s| s.to_string());
                    let bytes = match read_part(part).await {
                        Ok(b) => b,
                        Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "could not read file")),
                    };
                    found = Some((filename, mime, bytes));
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "invalid upload")),
        }
    }
    let (filename, mime, bytes) = match found {
        Some(f) => f,
        None => return Ok(err(StatusCode::BAD_REQUEST, "no file field")),
    };
    // Text uploads (source, .txt, .md, JSON…) open in the editor; store them as
    // seeded OT documents so they're readable and collaboratively editable.
    // Anything that isn't valid UTF-8, contains a NUL byte, or is large stays a
    // binary blob. Whiteboard scenes (.board) stay binary even though the JSON
    // is valid UTF-8 — they're overwritten wholesale by the client via the blob
    // route, never edited as text. ponytail: 1 MB text cap keeps huge files out
    // of the in-memory OT model; raise it if real docs get truncated to binary.
    let is_board = filename.to_lowercase().ends_with(".board");
    let text = if !is_board && bytes.len() <= 1_000_000 {
        std::str::from_utf8(&bytes)
            .ok()
            .filter(|s| !s.contains('\0'))
    } else {
        None
    };
    let doc_id = random_doc_id();
    let file = match db
        .create_uploaded_file(
            q.workspace_id,
            &filename,
            &doc_id,
            mime.as_deref(),
            text,
            &bytes,
            now_secs(),
        )
        .await
    {
        Ok(file) => file,
        Err(e) => {
            warn!("upload_file {filename}: {e}");
            return Ok(err(StatusCode::CONFLICT, "could not store file (name may already exist)"));
        }
    };
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "upload",
            Some(&filename),
            now_secs(),
        )
        .await;
    Ok(warp::reply::json(&json!({ "file": file })).into_response())
}

/// Whether the user may access a file through its workspace scope.
async fn file_allowed(db: &Database, user: &User, file_id: i64) -> bool {
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(file) => file,
        None => return false,
    };
    ensure_ws(db, user, file.workspace_id).await.is_ok()
}

/// Overwrite a binary file's stored blob (whiteboard scene autosaves).
async fn put_file_blob(
    file_id: i64,
    user: User,
    db: Database,
    expected_revision: Option<i64>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(f) => f,
        None => return Ok(err(StatusCode::NOT_FOUND, "no such file")),
    };
    // Never let this route clobber an OT-backed text document.
    if file.kind != "binary" {
        return Ok(err(StatusCode::BAD_REQUEST, "not a binary file"));
    }
    let expected_revision = match expected_revision {
        Some(revision) => revision,
        None => return Ok(err(StatusCode::BAD_REQUEST, "missing file revision")),
    };
    match db
        .store_blob_at_revision(file_id, &raw, expected_revision)
        .await
    {
        Ok(Some(revision)) => {
            Ok(warp::reply::json(&json!({ "ok": true, "revision": revision })).into_response())
        }
        Ok(None) => Ok(err(
            StatusCode::CONFLICT,
            "file changed; retry with latest revision",
        )),
        Err(_) => Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not store file",
        )),
    }
}

async fn raw_file(file_id: i64, user: User, db: Database, live: LiveDocs) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(f) => f,
        None => return Ok(err(StatusCode::NOT_FOUND, "no such file")),
    };
    // Text files are stored as OT documents; serve their current text so the HTML
    // preview can inline sibling CSS/JS. Binary files serve their stored blob.
    let (bytes, mime, revision) = if file.kind == "binary" {
        let (bytes, revision) = match db.load_blob_with_revision(file.id).await {
            Ok(Some(b)) => b,
            _ => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "file content missing")),
        };
        // A client-supplied MIME is not authority to serve active HTML/SVG/JS
        // from our authenticated origin. Previews fetch bytes or use PDF/media.
        let mime = file.mime.unwrap_or_default();
        let safe_mime = if mime == "application/pdf"
            || mime.starts_with("image/") && mime != "image/svg+xml"
            || mime.starts_with("audio/")
            || mime.starts_with("video/")
        {
            mime
        } else {
            "application/octet-stream".to_string()
        };
        (bytes, safe_mime, revision)
    } else {
        let text = match current_document(&live, &db, &file.doc_id).await {
            Ok(d) => d.text,
            Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "file content missing")),
        };
        (text.into_bytes(), "text/plain; charset=utf-8".to_string(), 0)
    };
    let resp = warp::http::Response::builder()
        .header("content-type", mime)
        .header("x-cortex-revision", revision)
        .body(Body::from(bytes))
        .expect("valid response");
    Ok(resp)
}

async fn download_file(file_id: i64, user: User, db: Database, live: LiveDocs) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(f) => f,
        None => return Ok(err(StatusCode::NOT_FOUND, "no such file")),
    };
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "download",
            Some(&file.path),
            now_secs(),
        )
        .await;
    let bytes: Vec<u8> = if file.kind == "binary" {
        match db.load_blob(file.id).await {
            Ok(Some(bytes)) => bytes,
            _ => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "file content missing")),
        }
    } else {
        match current_document(&live, &db, &file.doc_id).await {
            Ok(doc) => doc.text.into_bytes(),
            Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "file content missing")),
        }
    };
    // Keep the header well-formed regardless of what the path contains.
    let filename: String = file
        .path
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .collect();
    let resp = warp::http::Response::builder()
        .header(
            "content-disposition",
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from(bytes))
        .expect("valid response");
    Ok(resp)
}

/// Sanitize a workspace name into a safe zip filename (no path separators,
/// quotes, backslashes, or control chars).
fn zip_filename(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_control() || c == '"' || c == '\\' || c == '/' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        "workspace".to_string()
    } else {
        s
    }
}

/// Build a bounded archive. Both selected-file and full-workspace downloads
/// use the live OT snapshot, not the potentially stale 3-second DB copy.
async fn make_archive(files: &[FileRow], db: &Database, live: &LiveDocs) -> anyhow::Result<Vec<u8>> {
    use std::io::Write as _;
    if files.len() > 5000 {
        anyhow::bail!("too many files for one archive");
    }
    let mut buf = Vec::new();
    let mut total = 0usize;
    let mut dirs = std::collections::HashSet::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for f in files {
            let path = clean_path(&f.path).ok_or_else(|| anyhow::anyhow!("invalid stored path"))?;
            if path == ".keep" || path.ends_with("/.keep") {
                if let Some(folder) = path.strip_suffix("/.keep") {
                    if dirs.insert(folder.to_string()) {
                        zip.add_directory(format!("{folder}/"), options)?;
                    }
                }
                continue;
            }
            let bytes = if f.kind == "binary" {
                db.load_blob(f.id).await?.ok_or_else(|| anyhow::anyhow!("blob missing"))?
            } else {
                current_document(live, db, &f.doc_id).await?.text.into_bytes()
            };
            total += bytes.len();
            if total > 256 * 1024 * 1024 {
                anyhow::bail!("archive exceeds 256 MB");
            }
            zip.start_file(path, options)?;
            zip.write_all(&bytes)?;
        }
        zip.finish()?;
    }
    Ok(buf)
}

fn archive_reply(bytes: Vec<u8>, name: &str) -> warp::reply::Response {
    warp::http::Response::builder()
        .header("content-disposition", format!("attachment; filename=\"{}.zip\"", zip_filename(name)))
        .header("content-type", "application/zip")
        .body(Body::from(bytes))
        .expect("valid response")
}

/// Export all workspace files, including markers for empty folders.
async fn export_workspace(
    ws_id: i64,
    user: User,
    db: Database,
    live: LiveDocs,
) -> Result<impl Reply, Rejection> {
    let ws = ensure_ws(&db, &user, ws_id).await?;
    let files = match db.list_files(ws.id).await {
        Ok(files) => files,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not list files")),
    };
    match make_archive(&files, &db, &live).await {
        Ok(buf) => {
            let _ = db.audit(user.org_id, Some(user.id), "export_workspace", Some(&ws.name), now_secs()).await;
            Ok(archive_reply(buf, &ws.name))
        }
        Err(e) => {
            warn!("export_workspace {ws_id}: {e}");
            Ok(err(StatusCode::PAYLOAD_TOO_LARGE, "archive too large or file content missing"))
        }
    }
}

/// Zip just the selected files (one HTTP request instead of N blocked browser
/// downloads). All IDs must be in the same visible workspace.
async fn archive_files(
    user: User,
    db: Database,
    live: LiveDocs,
    body: FileBatch,
) -> Result<impl Reply, Rejection> {
    if body.ids.is_empty() || body.ids.len() > 5000 {
        return Ok(err(StatusCode::BAD_REQUEST, "select 1–5000 files"));
    }
    let mut files = Vec::with_capacity(body.ids.len());
    let mut seen = std::collections::HashSet::new();
    let mut workspace_id = None;
    for id in body.ids {
        if !seen.insert(id) {
            return Ok(err(StatusCode::BAD_REQUEST, "duplicate file id"));
        }
        let file = match db.get_file(id).await {
            Ok(Some(f)) => f,
            _ => return Ok(err(StatusCode::NOT_FOUND, "file not found")),
        };
        ensure_ws(&db, &user, file.workspace_id).await?;
        if workspace_id.is_some() && workspace_id != Some(file.workspace_id) {
            return Ok(err(StatusCode::BAD_REQUEST, "select files in one workspace"));
        }
        workspace_id = Some(file.workspace_id);
        files.push(file);
    }
    match make_archive(&files, &db, &live).await {
        Ok(buf) => {
            let _ = db.audit(user.org_id, Some(user.id), "download_files", Some(&format!("{} files", files.len())), now_secs()).await;
            Ok(archive_reply(buf, "selected-files"))
        }
        Err(e) => {
            warn!("archive_files: {e}");
            Ok(err(StatusCode::PAYLOAD_TOO_LARGE, "archive too large or file content missing"))
        }
    }
}

async fn delete_file(file_id: i64, user: User, db: Database, live: LiveDocs, boards: LiveBoards) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let path = db.get_file(file_id).await.ok().flatten().map(|f| f.path);
    let _gate = crate::access_gate().write().await;
    match db.delete_file(file_id).await {
        Ok(doc_id) => {
            evict_documents(&live, &[doc_id]);
            evict_boards(&boards, &[file_id]);
        }
        Err(e) => {
            warn!("delete_file {file_id}: {e}");
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not delete file"));
        }
    }
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "delete_file",
            path.as_deref(),
            now_secs(),
        )
        .await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Overwrite a text file's collaborative document wholesale. This backs the
/// single-user editor the client falls back to for oversized files, where the
/// live OT session is disabled; the client only calls it when no other editor
/// is expected to be active on the file.
async fn put_file_text(
    file_id: i64,
    user: User,
    body: serde_json::Value,
    db: Database,
    live: LiveDocs,
) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let file = match db.get_file(file_id).await.ok().flatten() {
        Some(f) => f,
        None => return Ok(err(StatusCode::NOT_FOUND, "no such file")),
    };
    if file.kind != "text" {
        return Ok(err(StatusCode::BAD_REQUEST, "not a text file"));
    }
    if live.contains_key(&file.doc_id) {
        return Ok(err(StatusCode::CONFLICT, "this file has a live collaborative editor"));
    }
    let text = match body["text"].as_str() {
        Some(t) => t.to_string(),
        None => return Ok(err(StatusCode::BAD_REQUEST, "missing text")),
    };
    match db.store_document_text(&file.doc_id, &text).await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(_) => Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not save text")),
    }
}

async fn move_file(
    file_id: i64,
    user: User,
    db: Database,
    body: MoveFile,
) -> Result<impl Reply, Rejection> {
    if !file_allowed(&db, &user, file_id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    let path = match clean_path(&body.path) {
        Some(p) => p,
        None => return Ok(err(StatusCode::BAD_REQUEST, "invalid path")),
    };
    match db.rename_file(file_id, &path).await {
        Ok(_) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(_) => Ok(err(
            StatusCode::BAD_REQUEST,
            "a file already exists at that path",
        )),
    }
}

/// Per-thread summary for the sidebar: latest message (id, sender, preview, time)
/// plus the unread count relative to the client's read markers. Carries message
/// previews, so it's ECIES-sealed like the rest of chat.
/// ponytail: one COUNT query per thread — fine for the small locked-down orgs this
/// targets; batch into a single grouped query if peer counts ever get large.
async fn chat_overview(
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let req: OverviewReq = crypto::open_request(&epk, &raw)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    let gs = if let Some(id) = req.group_id {
        if ensure_group(&db, &user, id).await.is_ok() {
            match db.group_last_msg(id).await.ok().flatten() {
                Some((last_id, sender, body, at)) => {
                    let unread = db
                        .group_unread_count(
                            id,
                            user.id,
                            req.group_read
                                .as_ref()
                                .and_then(|m| m.get(&id))
                                .copied()
                                .unwrap_or(0),
                        )
                        .await
                        .unwrap_or(0);
                    Some(
                        json!({ "last_id": last_id, "last_sender": sender, "body": preview(&body), "at": at, "unread": unread }),
                    )
                }
                None => None,
            }
        } else {
            None
        }
    } else {
        None
    };

    let org = if user.role == "root" {
        req.org
    } else {
        user.org_id
    };

    // Per-group summaries for EVERY group the user may see, so the chat
    // sidebar can list personal / group / org conversations with their own
    // preview and unread count.
    let mut gss = Vec::new();
    if let Some(org) = org {
        let groups = if user.role == "root" || user.role == "admin" {
            db.list_groups(org).await.unwrap_or_default()
        } else {
            db.list_groups_for_user(org, user.id)
                .await
                .unwrap_or_default()
        };
        for g in groups {
            let after = req
                .group_read
                .as_ref()
                .and_then(|m| m.get(&g.id))
                .copied()
                .unwrap_or(0);
            let unread = db
                .group_unread_count(g.id, user.id, after)
                .await
                .unwrap_or(0);
            match db.group_last_msg(g.id).await.ok().flatten() {
                Some((last_id, sender, body, at)) => {
                    gss.push(json!({ "group_id": g.id, "name": g.name, "scope": g.scope, "last_id": last_id, "last_sender": sender, "body": preview(&body), "at": at, "unread": unread }));
                }
                None => {
                    gss.push(json!({ "group_id": g.id, "name": g.name, "scope": g.scope, "last_id": 0, "last_sender": serde_json::Value::Null, "body": serde_json::Value::Null, "at": serde_json::Value::Null, "unread": 0 }));
                }
            }
        }
    }

    let mut dms = Vec::new();
    if let Some(org) = org {
        for (peer, last_id, sender, body, at) in
            db.dm_overview(org, user.id).await.unwrap_or_default()
        {
            let after = req.dm_read.get(&peer).copied().unwrap_or(0);
            let unread = db
                .dm_unread_count(org, user.id, peer, after)
                .await
                .unwrap_or(0);
            dms.push(json!({ "peer_id": peer, "last_id": last_id, "last_sender": sender, "body": preview(&body), "at": at, "unread": unread }));
        }
    }
    Ok(crypto::seal_reply(&epk, &json!({ "gs": gs, "gss": gss, "dms": dms })))
}

async fn get_chat(
    user: User,
    db: Database,
    q: ChatQuery,
    epk: Option<String>,
) -> Result<impl Reply, Rejection> {
    ensure_group(&db, &user, q.group_id).await?;
    let messages = db
        .list_messages(q.group_id, 300)
        .await
        .unwrap_or_default();
    let reactions = db
        .reactions_for_group(q.group_id, user.id)
        .await
        .unwrap_or_default();
    let messages = attach_reactions(messages, reactions);
    let typing = who_typing(&format!("g:{}", q.group_id), user.id, now_secs());
    Ok(crypto::seal_reply(
        &epk,
        &json!({ "messages": messages, "typing": typing }),
    ))
}

async fn post_chat(
    user: User,
    db: Database,
    q: ChatQuery,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    ensure_group(&db, &user, q.group_id).await?;
    let body: ChatPost =
        match crypto::open_request(&epk, &raw).and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(v) => v,
            None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
        };
    let text = body.body.trim();
    if text.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "empty message"));
    }
    if text.len() > 8000 {
        return Ok(err(StatusCode::BAD_REQUEST, "message too long"));
    }
    if db
        .create_message(q.group_id, user.id, text, now_secs())
        .await
        .is_err()
    {
        return Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not send message",
        ));
    }
    Ok(crypto::seal_reply(&epk, &json!({ "ok": true })))
}

/// Clear a group's chat. Admin, root, or the group owner.
async fn clear_chat(user: User, db: Database, q: ChatQuery) -> Result<impl Reply, Rejection> {
    let g = ensure_group(&db, &user, q.group_id).await?;
    if user.role != "admin" && user.role != "root" && !group_owner(&db, &user, g.id).await {
        return Err(warp::reject::custom(Forbidden));
    }
    match db.clear_messages(g.id).await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(e) => {
            warn!("clear_messages {}: {e}", g.id);
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not clear chat"))
        }
    }
}

/// Resolve the org for a DM and verify the peer is a co-member. Returns the org.
async fn dm_ctx(db: &Database, user: &User, q: &DmQuery) -> Result<i64, Rejection> {
    let org = dm_org(user, q).ok_or_else(|| warp::reject::custom(Forbidden))?;
    // The peer must belong to the same org; the actor must too (or be root).
    let peer_ok = db.user_org(q.with).await.ok().flatten() == Some(org);
    let self_ok = user.role == "root" || user.org_id == Some(org);
    if peer_ok && self_ok {
        Ok(org)
    } else {
        Err(warp::reject::custom(Forbidden))
    }
}

async fn get_dm(
    user: User,
    db: Database,
    q: DmQuery,
    epk: Option<String>,
) -> Result<impl Reply, Rejection> {
    let org = dm_ctx(&db, &user, &q).await?;
    let messages = db
        .list_dm(org, user.id, q.with, 300)
        .await
        .unwrap_or_default();
    let reactions = db
        .reactions_for_dm(org, user.id, q.with, user.id)
        .await
        .unwrap_or_default();
    let messages = attach_reactions(messages, reactions);
    let typing = who_typing(&dm_scope(user.id, q.with), user.id, now_secs());
    Ok(crypto::seal_reply(
        &epk,
        &json!({ "messages": messages, "typing": typing }),
    ))
}

async fn post_dm(
    user: User,
    db: Database,
    q: DmQuery,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let org = dm_ctx(&db, &user, &q).await?;
    let body: ChatPost =
        match crypto::open_request(&epk, &raw).and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(v) => v,
            None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
        };
    let text = body.body.trim();
    if text.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "empty message"));
    }
    if text.len() > 8000 {
        return Ok(err(StatusCode::BAD_REQUEST, "message too long"));
    }
    if db
        .create_dm(org, user.id, q.with, text, now_secs())
        .await
        .is_err()
    {
        return Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not send message",
        ));
    }
    Ok(crypto::seal_reply(&epk, &json!({ "ok": true })))
}

/// Clear a 1:1 conversation. Either participant may do this (clears for both).
async fn clear_dm(user: User, db: Database, q: DmQuery) -> Result<impl Reply, Rejection> {
    let org = dm_ctx(&db, &user, &q).await?;
    match db.clear_dm(org, user.id, q.with).await {
        Ok(()) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Err(e) => {
            warn!("clear_dm {org}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not clear conversation"))
        }
    }
}

/// Validate an edited body (shared by chat + DM edits).
fn valid_edit(text: &str) -> Option<&str> {
    let t = text.trim();
    if t.is_empty() || t.len() > 8000 {
        None
    } else {
        Some(t)
    }
}

/// Edit one of your own group-chat messages. Author-scoped in the query, so
/// there's no separate ownership check to get wrong.
async fn edit_chat(
    id: i64,
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let body: EditBody =
        match crypto::open_request(&epk, &raw).and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(v) => v,
            None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
        };
    let text = match valid_edit(&body.body) {
        Some(t) => t,
        None => return Ok(err(StatusCode::BAD_REQUEST, "empty or oversized message")),
    };
    match db.edit_message(id, user.id, text, now_secs()).await {
        Ok(true) => Ok(crypto::seal_reply(&epk, &json!({ "ok": true }))),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot edit this message")),
    }
}

/// Authors can delete their own messages. Group managers can moderate any
/// message in their group; they still cannot read/moderate private DMs.
async fn delete_chat_msg(id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    let group_id = match db.message_group(id).await {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(err(StatusCode::NOT_FOUND, "message not found")),
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not delete message")),
    };
    ensure_group(&db, &user, group_id).await?;
    let moderator = group_owner(&db, &user, group_id).await;
    match db.delete_message(id, user.id, moderator).await {
        Ok(true) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        Ok(false) => Ok(err(StatusCode::FORBIDDEN, "cannot delete this message")),
        Err(e) => {
            warn!("delete_chat_msg {id}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not delete message"))
        }
    }
}

/// Edit one of your own direct messages (sender-scoped).
async fn edit_dm(
    id: i64,
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let body: EditBody =
        match crypto::open_request(&epk, &raw).and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(v) => v,
            None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
        };
    let text = match valid_edit(&body.body) {
        Some(t) => t,
        None => return Ok(err(StatusCode::BAD_REQUEST, "empty or oversized message")),
    };
    match db.edit_dm(id, user.id, text, now_secs()).await {
        Ok(true) => Ok(crypto::seal_reply(&epk, &json!({ "ok": true }))),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot edit this message")),
    }
}

/// Delete one of your own direct messages.
async fn delete_dm_msg(id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    match db.delete_dm_message(id, user.id).await {
        Ok(true) => Ok(warp::reply::json(&json!({ "ok": true })).into_response()),
        _ => Ok(err(StatusCode::FORBIDDEN, "cannot delete this message")),
    }
}

/// "I'm typing" ping for a group chat (ephemeral, no body).
async fn typing_chat(user: User, db: Database, q: ChatQuery) -> Result<impl Reply, Rejection> {
    ensure_group(&db, &user, q.group_id).await?;
    mark_typing(format!("g:{}", q.group_id), user.id, now_secs());
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// "I'm typing" ping for a 1:1 conversation.
async fn typing_dm(user: User, db: Database, q: DmQuery) -> Result<impl Reply, Rejection> {
    let _ = dm_ctx(&db, &user, &q).await?;
    mark_typing(dm_scope(user.id, q.with), user.id, now_secs());
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct ReactBody {
    kind: String,
    msg_id: i64,
    emoji: String,
}

/// Toggle a reaction only after checking visibility of the underlying message.
async fn toggle_reaction(
    user: User,
    db: Database,
    epk: Option<String>,
    raw: bytes::Bytes,
) -> Result<impl Reply, Rejection> {
    let body: ReactBody =
        match crypto::open_request(&epk, &raw).and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(v) => v,
            None => return Ok(err(StatusCode::BAD_REQUEST, "bad payload")),
        };
    if body.kind != "ws" && body.kind != "dm" {
        return Ok(err(StatusCode::BAD_REQUEST, "bad kind"));
    }
    let emoji = body.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 8 {
        return Ok(err(StatusCode::BAD_REQUEST, "bad emoji"));
    }
    let ctx = match db.reaction_context(&body.kind, body.msg_id).await {
        Ok(Some(ctx)) => ctx,
        Ok(None) => return Ok(err(StatusCode::NOT_FOUND, "message not found")),
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not react")),
    };
    let allowed = if body.kind == "ws" {
        ensure_group(&db, &user, ctx.0).await.is_ok()
    } else {
        // Private DMs are accessible only to the sender/recipient, not admins.
        (user.id == ctx.0 || user.id == ctx.2)
            && (user.role == "root" || user.org_id == Some(ctx.1))
    };
    if !allowed {
        return Err(warp::reject::custom(Forbidden));
    }
    match db.toggle_reaction(&body.kind, body.msg_id, user.id, emoji).await {
        Ok(()) => Ok(crypto::seal_reply(&epk, &json!({ "ok": true }))),
        Err(e) => {
            warn!("toggle_reaction {}: {e}", body.msg_id);
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not react"))
        }
    }
}

/// Heartbeat: record that the caller is currently online.
async fn presence_ping(user: User, db: Database) -> Result<impl Reply, Rejection> {
    let _ = db.touch_last_seen(user.id, now_secs()).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Who in the org is online / when they were last seen.
async fn presence_get(user: User, db: Database, q: OrgQuery) -> Result<impl Reply, Rejection> {
    let now = now_secs();
    let list = match acting_org(&user, &q) {
        Some(org) => db.org_presence(org).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let presence: Vec<_> = list
        .into_iter()
        .map(|(id, seen)| json!({ "id": id, "last_seen": seen, "online": now - seen < 45 }))
        .collect();
    Ok(warp::reply::json(&json!({ "presence": presence })).into_response())
}

/// Recent audit entries. Admins see their org; root sees every org.
async fn audit_log(user: User, db: Database) -> Result<impl Reply, Rejection> {
    if user.role != "admin" && user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    let all = user.role == "root";
    let entries = db
        .list_audit(user.org_id, all, 300)
        .await
        .unwrap_or_default();
    Ok(warp::reply::json(&json!({ "entries": entries })).into_response())
}

/// Owner-only instance-wide storage readout (never expose other orgs' usage).
async fn admin_storage(user: User, db: Database) -> Result<impl Reply, Rejection> {
    if user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    const TABLES: &[&str] = &[
        "users",
        "org",
        "groups",
        "group_member",
        "workspace",
        "file",
        "document",
        "message",
        "dm",
        "reaction",
        "chat_image",
        "file_blob",
        "audit",
        "session",
    ];
    let mut tables = Vec::new();
    for table in TABLES {
        if let Ok(rows) = db.table_rows(table).await {
            tables.push(json!({ "name": table, "rows": rows }));
        }
    }
    Ok(warp::reply::json(&json!({
        "db_bytes": db.db_size_bytes().await.unwrap_or(0),
        "free_bytes": db.free_bytes().await.unwrap_or(0),
        "blob_bytes": db.blob_bytes().await.unwrap_or(0),
        "tables": tables,
    }))
    .into_response())
}

/// Owner-only forced compaction. No external process should open the live DB.
async fn admin_compact(user: User, db: Database) -> Result<impl Reply, Rejection> {
    if user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    let retention = std::env::var("CORTEX_AUDIT_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|&n| (1..=3650).contains(&n))
        .unwrap_or(180);
    match db.maintain(now_secs(), retention, true).await {
        Ok(report) => {
            let _ = db.audit(None, Some(user.id), "compact", None, now_secs()).await;
            Ok(warp::reply::json(&report).into_response())
        }
        Err(e) => {
            warn!("owner compact: {e}");
            Ok(err(StatusCode::SERVICE_UNAVAILABLE, "compaction failed; see server log"))
        }
    }
}

/// Whole-instance export (root only): every migrated table plus blobs,
/// packaged as a single zip with a manifest.json.
async fn admin_export_all(user: User, db: Database) -> Result<impl Reply, Rejection> {
    if user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    let tables_obj = match db.export_snapshot().await {
        Ok(tables) => tables,
        Err(e) => {
            warn!("admin_export_all snapshot: {e}");
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "export failed"));
        }
    };
    let manifest = json!({
        "cortex_export": 1,
        "exported_at": now_secs(),
        "tables": serde_json::Value::Object(tables_obj),
    });
    let body = match serde_json::to_vec(&manifest) {
        Ok(b) => b,
        Err(_) => {
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "export failed"));
        }
    };
    let mut buf: Vec<u8> = Vec::new();
    {
        use std::io::Write as _;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if zip.start_file("manifest.json", options).is_err()
            || zip.write_all(&body).is_err()
            || zip.finish().is_err()
        {
            return Ok(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to create archive",
            ));
        }
    }
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "export_all",
            Some("full instance export"),
            now_secs(),
        )
        .await;
    let resp = warp::http::Response::builder()
        .header("content-disposition", "attachment; filename=\"cortex-export.zip\"")
        .header("content-type", "application/zip")
        .body(Body::from(buf))
        .expect("valid response");
    Ok(resp.into_response())
}

/// Whole-instance import (root only): replace everything in this instance with
/// the contents of a previous export. Destructive — the current dataset is
/// wiped first (inside one transaction) and all users are signed out.
async fn admin_import_all(
    user: User,
    body: bytes::Bytes,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    if user.role != "root" {
        return Err(warp::reject::custom(Forbidden));
    }
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(body)) {
        Ok(a) => a,
        Err(_) => {
            return Ok(err(StatusCode::BAD_REQUEST, "not a valid export archive"));
        }
    };
    let manifest: serde_json::Value = match archive
        .by_name("manifest.json")
        .ok()
        .map(|f| serde_json::from_reader(std::io::Read::take(f, 512 * 1024 * 1024)))
    {
        Some(Ok(m)) => m,
        _ => {
            return Ok(err(StatusCode::BAD_REQUEST, "missing manifest.json"));
        }
    };
    if manifest["cortex_export"] != json!(1) {
        return Ok(err(StatusCode::BAD_REQUEST, "unrecognized export format"));
    }
    let tables = manifest["tables"].as_object();
    let mut restore: Vec<(String, Vec<serde_json::Value>)> = Vec::new();
    for table in Database::MIGRATE_TABLES {
        let rows = tables
            .and_then(|t| t.get(*table))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        restore.push(((*table).to_string(), rows));
    }
    // Stop editors and persisters BEFORE replacing row ids. Otherwise a
    // pending save from the old dataset can overwrite a newly imported doc
    // with the same id after the import transaction commits.
    let _gate = crate::access_gate().write().await;
    let live_ids: Vec<String> = live.iter().map(|item| item.key().clone()).collect();
    if let Err(e) = flush_and_evict(&live, &db, &live_ids).await {
        warn!("admin_import_all flush: {e}");
        return Ok(err(StatusCode::SERVICE_UNAVAILABLE, "could not save live edits"));
    }
    evict_all_boards(&boards);
    if let Err(e) = db.import_replace_all(&restore).await {
        warn!("admin_import_all: {e}");
        return Ok(err(StatusCode::BAD_REQUEST, "import failed; nothing changed"));
    }
    let _ = db
        .audit(
            None,
            Some(user.id),
            "import_all",
            Some("full instance import"),
            now_secs(),
        )
        .await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Store an image pasted into chat; returns its id + URL.
async fn upload_chat_image(
    user: User,
    db: Database,
    q: OrgQuery,
    mut form: FormData,
) -> Result<impl Reply, Rejection> {
    let org = match acting_org(&user, &q) {
        Some(o) => o,
        None => return Ok(err(StatusCode::FORBIDDEN, "no org")),
    };
    let mut found: Option<(Option<String>, Vec<u8>)> = None;
    loop {
        match form.try_next().await {
            Ok(Some(part)) => {
                if part.name() == "file" {
                    let mime = part.content_type().map(|s| s.to_string());
                    let bytes = match read_part(part).await {
                        Ok(b) => b,
                        Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "could not read image")),
                    };
                    found = Some((mime, bytes));
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "invalid upload")),
        }
    }
    let (mime, bytes) = match found {
        Some(f) => f,
        None => return Ok(err(StatusCode::BAD_REQUEST, "no file field")),
    };
    match db
        .create_chat_image(org, mime.as_deref(), &bytes, now_secs())
        .await
    {
        Ok(id) => Ok(warp::reply::json(
            &json!({ "id": id, "url": format!("/api/chat-image/{}", id) }),
        )
        .into_response()),
        Err(_) => Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not store image",
        )),
    }
}

/// Serve a chat image to members of its org (root may view any).
async fn get_chat_image(id: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    match db.get_chat_image(id).await.ok().flatten() {
        Some((org, mime, data)) if user.role == "root" || Some(org) == user.org_id => {
            let mime = mime.unwrap_or_else(|| "application/octet-stream".to_string());
            let resp = warp::http::Response::builder()
                .header("content-type", mime)
                .header("cache-control", "private, max-age=86400")
                .body(Body::from(data))
                .expect("valid response");
            Ok(resp)
        }
        Some(_) => Err(warp::reject::custom(Forbidden)),
        None => Ok(err(StatusCode::NOT_FOUND, "no such image")),
    }
}
