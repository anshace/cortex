//! Server backend for the Rustpad collaborative text editor.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

use dashmap::DashMap;
use log::{error, info};
use rand::Rng;
use serde::Serialize;
use tokio::time::{self, Instant};
use warp::{filters::BoxedFilter, ws::Ws, Filter, Rejection, Reply};

use crate::{board::BoardHub, database::Database, rustpad::Rustpad};

pub mod account;
pub mod auth;
mod board;
pub mod crypto;
pub mod database;
mod ot;
mod rustpad;
pub mod workspace;

/// An entry stored in the global server map.
///
/// Each entry corresponds to a single document. This is garbage collected by a
/// background task after one day of inactivity, to avoid server memory usage
/// growing without bound.
pub(crate) struct Document {
    last_accessed: Instant,
    rustpad: Arc<Rustpad>,
    persister: Option<tokio::task::JoinHandle<()>>,
}

/// Block new WebSocket handshakes while changing permissions or deleting
/// content. Existing editors are closed under the write lock, so none can
/// reconnect using the old scope before the DB mutation commits.
pub(crate) fn access_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}

fn editor_gate() -> impl Filter<Extract = (tokio::sync::RwLockReadGuard<'static, ()>,), Error = Rejection> + Clone {
    warp::any().and_then(|| async {
        Ok::<_, Rejection>(access_gate().read().await)
    })
}

/// Shared live editor registry. Dropping a cached document closes its sockets.
pub(crate) type LiveDocs = Arc<DashMap<String, Document>>;
/// Connected whiteboard presence relays, keyed by file ID.
pub(crate) type LiveBoards = Arc<DashMap<i64, Arc<BoardHub>>>;

pub(crate) fn evict_boards(boards: &LiveBoards, ids: &[i64]) {
    for id in ids {
        if let Some((_, hub)) = boards.remove(id) { hub.close(); }
    }
}

pub(crate) async fn evict_org_boards(
    boards: &LiveBoards, db: &Database, org_id: i64,
) -> anyhow::Result<()> {
    let ids: Vec<i64> = boards.iter().map(|entry| *entry.key()).collect();
    let mut owned = Vec::new();
    for id in ids {
        if db.file_org(id).await? == Some(org_id) { owned.push(id); }
    }
    evict_boards(boards, &owned);
    Ok(())
}

pub(crate) fn evict_all_boards(boards: &LiveBoards) {
    let ids: Vec<i64> = boards.iter().map(|entry| *entry.key()).collect();
    evict_boards(boards, &ids);
}

pub(crate) fn evict_documents(live: &LiveDocs, ids: &[String]) {
    for id in ids {
        live.remove(id);
    }
}

/// Before moving a document to a different access scope, stop its persister,
/// wait for any in-flight write, then save its final OT snapshot. If this fails
/// the caller must abort the move (the client can reconnect to the old scope).
pub(crate) async fn flush_and_evict(
    live: &LiveDocs,
    db: &Database,
    ids: &[String],
) -> anyhow::Result<()> {
    let mut stopped = Vec::new();
    for id in ids {
        if let Some((_, entry)) = live.remove(id) {
            entry.rustpad.kill();
            stopped.push((id.clone(), entry));
        }
    }
    // Wait together, not one sleep interval per document; a persister already
    // writing will finish before the final snapshot below is written.
    let tasks: Vec<_> = stopped.iter_mut().filter_map(|(_, doc)| doc.persister.take()).collect();
    for result in futures::future::join_all(tasks).await {
        result?;
    }
    for (id, doc) in &stopped {
        db.store(id, &doc.rustpad.snapshot()).await?;
    }
    Ok(())
}

/// Prefer the current OT snapshot over the last periodic DB flush for
/// downloads, exports and copies while another user is editing the file.
pub(crate) async fn current_document(
    live: &LiveDocs,
    db: &Database,
    id: &str,
) -> anyhow::Result<database::PersistedDocument> {
    if let Some(entry) = live.get(id) {
        return Ok(entry.rustpad.snapshot());
    }
    db.load(id).await
}

impl Document {
    fn new(rustpad: Arc<Rustpad>, persister: Option<tokio::task::JoinHandle<()>>) -> Self {
        Self {
            last_accessed: Instant::now(),
            rustpad,
            persister,
        }
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        self.rustpad.kill();
        if let Some(task) = self.persister.take() {
            task.abort();
        }
    }
}

#[allow(dead_code)]
#[derive(Debug)]
struct CustomReject(anyhow::Error);

impl warp::reject::Reject for CustomReject {}

/// The shared state of the server, accessible from within request handlers.
#[derive(Clone)]
struct ServerState {
    /// Concurrent map storing in-memory documents.
    documents: Arc<DashMap<String, Document>>,
    /// Ephemeral presence relays keyed by whiteboard file id.
    boards: LiveBoards,
    /// Connection to the database pool, if persistence is enabled.
    database: Option<Database>,
}

/// Statistics about the server, returned from an API endpoint.
#[derive(Serialize)]
struct Stats {
    /// System time when the server started, in seconds since Unix epoch.
    start_time: u64,
    /// Number of documents currently tracked by the server.
    num_documents: usize,
    /// Number of documents persisted in the database.
    database_size: usize,
}

/// Server configuration.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Number of days to clean up documents after inactivity.
    pub expiry_days: u32,
    /// Database object, for persistence if desired.
    pub database: Option<Database>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            expiry_days: 1,
            database: None,
        }
    }
}

/// A combined filter handling all server routes, with security response headers
/// applied to every reply (static assets and API alike).
pub fn server(config: ServerConfig) -> BoxedFilter<(impl Reply,)> {
    let routes = warp::path("api").and(backend(config)).or(frontend());

    // Content-Security-Policy tuned to the app's real needs:
    // - script-src 'self' 'wasm-unsafe-eval'  → Vite ES-module bundles + the
    //   rustpad-wasm module (WASM instantiation needs wasm-unsafe-eval).
    // - style-src 'self' 'unsafe-inline'      → Chakra/emotion + Monaco inject
    //   inline <style> tags (style injection is not a meaningful XSS vector).
    // - worker-src 'self' blob:               → Monaco language web workers.
    // - connect-src 'self'                     → same-origin API + the OT WebSocket.
    // - img/font data: & blob:                 → inlined assets, pasted images.
    // - frame/object blob:                     → sandboxed HTML and fetched PDF previews.
    // Set CSP_REPORT_ONLY=1 to emit it as report-only first (logs violations in
    // the browser console without blocking) while verifying a deploy.
    const CSP: &str = "default-src 'self'; base-uri 'self'; object-src blob:; \
        frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; \
        font-src 'self' data:; style-src 'self' 'unsafe-inline'; \
        script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; \
        connect-src 'self'; frame-src 'self' blob:";
    let csp_header = if std::env::var("CSP_REPORT_ONLY").is_ok() {
        "content-security-policy-report-only"
    } else {
        "content-security-policy"
    };

    // HSTS is sent unconditionally: browsers ignore it over plain HTTP (so it is a
    // no-op on localhost) and enforce it once served via HTTPS behind Caddy.
    routes
        .with(warp::reply::with::header(
            "x-content-type-options",
            "nosniff",
        ))
        .with(warp::reply::with::header("x-frame-options", "DENY"))
        .with(warp::reply::with::header("referrer-policy", "no-referrer"))
        .with(warp::reply::with::header(
            "permissions-policy",
            "geolocation=(), camera=(), payment=(), usb=()",
        ))
        .with(warp::reply::with::header(
            "strict-transport-security",
            "max-age=63072000; includeSubDomains",
        ))
        .with(warp::reply::with::header(csp_header, CSP))
        .boxed()
}

/// Construct routes for static files from React, with an SPA fallback so deep
/// links (e.g. `/backend`) load index.html instead of 404ing.
fn frontend() -> BoxedFilter<(impl Reply,)> {
    warp::fs::dir("dist")
        .or(warp::get().and(warp::fs::file("dist/index.html")))
        .boxed()
}

/// Construct backend routes, including WebSocket handlers.
///
/// AuthPad requires a database (for users and sessions). Every data route below
/// is gated behind a valid session via [`auth::with_auth`].
fn backend(config: ServerConfig) -> BoxedFilter<(impl Reply,)> {
    let db = config
        .database
        .clone()
        .expect("AuthPad requires a database; set SQLITE_URI");

    let state = ServerState {
        documents: Default::default(),
        boards: Default::default(),
        database: config.database,
    };
    tokio::spawn(cleaner(state.clone(), config.expiry_days));
    tokio::spawn(scheduled_maintenance(db.clone()));

    let live = state.documents.clone();
    let boards = state.boards.clone();
    let state_filter = warp::any().map(move || state.clone());

    // Public auth endpoints (login / logout / me).
    let auth_routes = auth::routes(db.clone());
    // Handlers share the live editor registry so hard deletes can disconnect
    // editors and downloads/copies can read unsaved OT snapshots.
    let workspace_routes = workspace::routes(db.clone(), live.clone(), boards.clone());
    let account_routes = account::routes(db.clone(), live, boards);

    // A plain db filter used by the document access checks below.
    let db_for_docs = db.clone();
    let db_filter = warp::any().map(move || db_for_docs.clone());

    let socket = warp::path!("socket" / String)
        .and(editor_gate())
        .and(auth::with_auth(db.clone()))
        .and(warp::ws())
        .and(db_filter.clone())
        .and(state_filter.clone())
        .and_then(
            |id: String, gate: tokio::sync::RwLockReadGuard<'static, ()>, user: database::User, ws: Ws, db: Database, state: ServerState| async move {
                let _gate = gate;
                // The document must belong to a workspace in the user's org
                // (root may access any) — otherwise no access.
                if !doc_allowed(&db, &user, &id).await {
                    return Err(warp::reject::custom(auth::Forbidden));
                }
                socket_handler(id, ws, state).await
            },
        );

    let board_socket = warp::path!("board-socket" / i64)
        .and(editor_gate())
        .and(auth::with_auth(db.clone()))
        .and(warp::ws())
        .and(db_filter.clone())
        .and(state_filter.clone())
        .and_then(
            |file_id: i64,
             gate: tokio::sync::RwLockReadGuard<'static, ()>,
             user: database::User,
             ws: Ws,
             db: Database,
             state: ServerState| async move {
                let _gate = gate;
                if !file_allowed(&db, &user, file_id).await {
                    return Err(warp::reject::custom(auth::Forbidden));
                }
                let name = if user.name.trim().is_empty() {
                    user.email
                } else {
                    user.name
                };
                board_socket_handler(file_id, name, ws, state).await
            },
        );

    let text = warp::path!("text" / String)
        .and(auth::with_auth(db.clone()))
        .and(db_filter)
        .and(state_filter.clone())
        .and_then(
            |id: String, user: database::User, db: Database, state: ServerState| async move {
                if !doc_allowed(&db, &user, &id).await {
                    return Err(warp::reject::custom(auth::Forbidden));
                }
                text_handler(id, state).await
            },
        );

    let start_time = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("SystemTime returned before UNIX_EPOCH")
        .as_secs();
    let stats = warp::path!("stats")
        .and(auth::with_auth(db))
        .and(warp::any().map(move || start_time))
        .and(state_filter)
        .and_then(
            |_user: database::User, start_time: u64, state: ServerState| {
                stats_handler(start_time, state)
            },
        );

    auth_routes
        .or(account_routes)
        .or(workspace_routes)
        .or(socket)
        .or(board_socket)
        .or(text)
        .or(stats)
        .recover(auth::handle_rejection)
        .boxed()
}

async fn file_allowed(db: &Database, user: &database::User, file_id: i64) -> bool {
    match db.file_ws_info(file_id).await.ok().flatten() {
        Some((group_id, org, scope, created_by)) => {
            if user.role == "root" {
                return true;
            }
            if Some(org) != user.org_id {
                return false;
            }
            if user.role == "admin" {
                return true;
            }
            match scope.as_str() {
                "org" => true,
                "personal" => created_by == user.id,
                "group" => db
                    .is_group_member(group_id, user.id)
                    .await
                    .unwrap_or(false),
                _ => false,
            }
        }
        None => false,
    }
}

async fn board_socket_handler(
    file_id: i64,
    user_name: String,
    ws: Ws,
    state: ServerState,
) -> Result<impl Reply, Rejection> {
    let hub = state
        .boards
        .entry(file_id)
        .or_insert_with(|| Arc::new(BoardHub::default()))
        .clone();
    Ok(ws.on_upgrade(move |socket| async move { hub.on_connection(socket, user_name).await }))
}

/// Whether a user may access the document `doc_id` (root bypasses; otherwise
/// the same layered org / group / personal check as the REST workspace routes).
async fn doc_allowed(db: &Database, user: &database::User, doc_id: &str) -> bool {
    match db.doc_ws_info(doc_id).await.ok().flatten() {
        Some((group_id, org, scope, created_by)) => {
            if user.role == "root" {
                return true;
            }
            if Some(org) != user.org_id {
                return false;
            }
            if user.role == "admin" {
                return true;
            }
            match scope.as_str() {
                "org" => true,
                "personal" => created_by == user.id,
                "group" => db
                    .is_group_member(group_id, user.id)
                    .await
                    .unwrap_or(false),
                _ => false,
            }
        }
        None => false,
    }
}

/// Handler for the `/api/socket/{id}` endpoint.
async fn socket_handler(id: String, ws: Ws, state: ServerState) -> Result<impl Reply, Rejection> {
    use dashmap::mapref::entry::Entry;

    let mut entry = match state.documents.entry(id.clone()) {
        Entry::Occupied(e) => e.into_ref(),
        Entry::Vacant(e) => {
            let rustpad = Arc::new(match &state.database {
                Some(db) => db.load(&id).await.map(Rustpad::from).unwrap_or_default(),
                None => Rustpad::default(),
            });
            let task = state.database.as_ref().map(|db| {
                tokio::spawn(persister(id, Arc::clone(&rustpad), db.clone()))
            });
            e.insert(Document::new(rustpad, task))
        }
    };

    let value = entry.value_mut();
    value.last_accessed = Instant::now();
    let rustpad = Arc::clone(&value.rustpad);
    Ok(ws.on_upgrade(|socket| async move { rustpad.on_connection(socket).await }))
}

/// Handler for the `/api/text/{id}` endpoint.
async fn text_handler(id: String, state: ServerState) -> Result<impl Reply, Rejection> {
    Ok(match state.documents.get(&id) {
        Some(value) => value.rustpad.text(),
        None => {
            if let Some(db) = &state.database {
                db.load(&id)
                    .await
                    .map(|document| document.text)
                    .unwrap_or_default()
            } else {
                String::new()
            }
        }
    })
}

/// Handler for the `/api/stats` endpoint.
async fn stats_handler(start_time: u64, state: ServerState) -> Result<impl Reply, Rejection> {
    let num_documents = state.documents.len();
    let database_size = match state.database {
        None => 0,
        Some(db) => match db.count().await {
            Ok(size) => size,
            Err(e) => return Err(warp::reject::custom(CustomReject(e))),
        },
    };
    Ok(warp::reply::json(&Stats {
        start_time,
        num_documents,
        database_size,
    }))
}

const HOUR: Duration = Duration::from_secs(3600);

/// Runs on the server, not from a separate Docker cron/sidecar, so the same
/// housekeeping applies to the one-container image and bare-metal installs.
/// First run is delayed to let migrations/bootstrap finish and serve traffic.
async fn scheduled_maintenance(db: Database) {
    time::sleep(Duration::from_secs(5 * 60)).await;
    let retention = std::env::var("CORTEX_AUDIT_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|&n| (1..=3650).contains(&n))
        .unwrap_or(180);
    loop {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        match db.maintain(now, retention, false).await {
            Ok(result) => info!(
                "maintenance: vacuumed={}, freed={} bytes, removed {} orphan docs, {} sessions",
                result.vacuumed,
                result.db_bytes_before - result.db_bytes_after,
                result.orphan_documents,
                result.expired_sessions
            ),
            Err(e) => error!("scheduled maintenance failed: {e}"),
        }
        time::sleep(HOUR * 24).await;
    }
}

/// Reclaims memory for documents.
async fn cleaner(state: ServerState, expiry_days: u32) {
    loop {
        time::sleep(HOUR).await;
        let mut keys = Vec::new();
        for entry in &*state.documents {
            if entry.last_accessed.elapsed() > HOUR * 24 * expiry_days
                && !entry.rustpad.has_users()
            {
                keys.push(entry.key().clone());
            }
        }
        if !keys.is_empty() {
            info!("cleaner evicting {} idle documents", keys.len());
            if let Some(db) = &state.database {
                if let Err(e) = flush_and_evict(&state.documents, db, &keys).await {
                    error!("when flushing idle documents: {e}");
                }
            } else {
                evict_documents(&state.documents, &keys);
            }
        }
    }
}

const PERSIST_INTERVAL: Duration = Duration::from_secs(3);
const PERSIST_INTERVAL_JITTER: Duration = Duration::from_secs(1);

/// Persists changed documents after a fixed time interval.
async fn persister(id: String, rustpad: Arc<Rustpad>, db: Database) {
    let mut last_revision = 0;
    while !rustpad.killed() {
        let interval = PERSIST_INTERVAL
            + rand::thread_rng().gen_range(Duration::ZERO..=PERSIST_INTERVAL_JITTER);
        time::sleep(interval).await;
        let revision = rustpad.revision();
        if revision > last_revision {
            info!("persisting revision {} for id = {}", revision, id);
            if let Err(e) = db.store(&id, &rustpad.snapshot()).await {
                error!("when persisting document {}: {}", id, e);
            } else {
                last_revision = revision;
            }
        }
    }
}
