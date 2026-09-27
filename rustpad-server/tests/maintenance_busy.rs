//! Housekeeping must not be able to make a request wait for a whole pass.
//!
//! The pool has one connection on purpose (`Database::open_pool`): a second
//! connection in this process can invalidate the snapshot a running transaction
//! has already read. So availability here is a question of how the pass is cut
//! up and how long its one indivisible statement may run — which is what these
//! tests measure, along with the measurement that ruled the second connection
//! out.

use anyhow::Result;
use common::*;
use rustpad_server::database::Database;
use rustpad_server::server;
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Acquire, SqlitePool};
use std::str::FromStr;
use std::time::{Duration, Instant};

pub mod common;

/// One pass at a time in this binary: `CORTEX_VACUUM_MAX_DB_MB` is process-wide.
static UNATTENDED_PASS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `count` rows, in a single statement.
///
/// A test that cares about how long a statement takes cannot afford to build its
/// data a row at a time: forty thousand separately synced inserts would take
/// longer than the sweep they exist to measure.
async fn grow(pool: &SqlitePool, into: &str, count: i64) -> Result<()> {
    let sql = format!(
        "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < $1) \
         INSERT INTO {into}"
    );
    sqlx::query(&sql).bind(count).execute(pool).await?;
    Ok(())
}

/// Enough garbage that every sweep `maintain` runs is a statement worth
/// measuring: tens of thousands of rows in each table it prunes.
async fn seed_garbage(db: &Database) -> Result<()> {
    let pool = db.write();
    // `doc_org` names an organization, and `databases.rs` is the thing that
    // reads it, so the rows have to point at a real one.
    let org = db.create_org("Garbage", "garbage", 1).await?.id;
    let root = "(SELECT id FROM users WHERE email = 'admin')";
    grow(
        pool,
        &format!("session (token, user_id, expires_at) SELECT lower(hex(randomblob(16))), {root}, 1 FROM c"),
        40_000,
    )
    .await?;
    grow(
        pool,
        "document (id, text) SELECT 'orphan-' || i, 'nothing points here' FROM c",
        5_000,
    )
    .await?;
    // Routing rows for documents no file names — the sweep pair that must
    // disappear together.
    grow(
        pool,
        &format!("doc_org (doc_id, org_id, created_at) SELECT 'orphan-' || i, {org}, 1 FROM c"),
        5_000,
    )
    .await?;
    grow(
        pool,
        &format!("reaction (kind, msg_id, user_id, emoji) SELECT 'ws', i, {root}, '+' FROM c"),
        20_000,
    )
    .await?;
    grow(
        pool,
        &format!("chat_image (org_id, mime, data, created_at) SELECT {org}, 'image/png', 'x', 1 FROM c"),
        20_000,
    )
    .await?;
    grow(pool, "audit (action, created_at) SELECT 'old', 1 FROM c", 40_000).await?;
    Ok(())
}

fn options(uri: &str, busy: Duration) -> Result<SqliteConnectOptions> {
    Ok(SqliteConnectOptions::from_str(uri)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(busy))
}

async fn one_connection_pool(uri: &str) -> Result<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(uri, Duration::from_secs(10))?)
        .await?)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// The availability bug, end to end: a request that arrives during a pass may
/// have to wait for one statement, never for the pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_does_not_wait_for_a_whole_maintenance_pass() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let _serial = UNATTENDED_PASS.lock().await;
    let config = sqlite_config(1).await;
    let db = config
        .database
        .clone()
        .expect("test config carries a database");
    let filter = server(config);
    // Sign in first: a login sweeps expired sessions itself, and the seeded
    // garbage below is the pass's work, not the login's.
    let cookie = root_cookie(&filter).await;
    seed_garbage(&db).await?;

    let started = Instant::now();
    let pass = {
        let db = db.clone();
        tokio::spawn(async move { db.maintain(now_secs(), 180, false).await })
    };
    // Ask for the connection the moment the pass has it. This is the read that
    // costs nothing but the connection — a sign-in would also spend a few
    // hundred milliseconds on bcrypt, which is not what is being measured here.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let sample = Instant::now();
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        warp::test::request()
            .path("/api/me")
            .header("cookie", cookie)
            .reply(&filter),
    )
    .await
    .expect("the server answers eventually");
    let waited = sample.elapsed();
    assert_eq!(
        resp.status(),
        200,
        "a session check during housekeeping is not an invalid session; body: {}",
        String::from_utf8_lossy(resp.body())
    );
    let report = pass.await??;
    let running_for = started.elapsed();

    // Preconditions first: a pass that was over before anything was asked of it
    // proves nothing, and a ratio measured over two milliseconds is noise.
    assert!(
        running_for > Duration::from_millis(400),
        "the whole pass took {running_for:?}, which is too short to show queueing: the seeded \
         garbage has to make each sweep a statement of its own"
    );
    assert!(
        waited * 2 < running_for,
        "the request waited {waited:?} of a {running_for:?} pass: housekeeping is holding the \
         connection for the pass instead of releasing it between statements"
    );
    assert!(
        report.expired_sessions >= 40_000
            && report.orphan_documents >= 5_000
            && report.orphan_reactions >= 20_000
            && report.orphan_chat_images >= 20_000
            && report.pruned_audit >= 40_000,
        "a pass that yields between statements must still do every sweep: {} sessions, {} docs, \
         {} reactions, {} images, {} audit entries",
        report.expired_sessions,
        report.orphan_documents,
        report.orphan_reactions,
        report.orphan_chat_images,
        report.pruned_audit
    );
    // And the database still serves a sign-in afterwards.
    let resp = warp::test::request()
        .method("POST")
        .path("/api/login")
        .json(&json!({ "email": "admin", "password": "admin" }))
        .reply(&filter)
        .await;
    assert_eq!(
        resp.status(),
        200,
        "the correct password still works after a pass; body: {}",
        String::from_utf8_lossy(resp.body())
    );
    Ok(())
}

/// The checkpoint is not what disqualifies a second connection: measured here, a
/// PASSIVE or TRUNCATE checkpoint run there leaves an application transaction
/// that read beforehand able to write afterwards. (The compaction is the part
/// that does not, below — and this result is a measurement of the two modes
/// `maintain` uses, not a licence to move work off the pool on the strength of
/// a favourable sample.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_connection_checkpoint_leaves_a_straddling_write_alone() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let uri = format!("sqlite://{}", dir.path().join("checkpoint.db").display());
    // The application's one connection, and the connection housekeeping would
    // have used instead.
    let app = one_connection_pool(&uri).await?;
    let other = one_connection_pool(&uri).await?;
    sqlx::query("CREATE TABLE doc (id INTEGER PRIMARY KEY, text BLOB)")
        .execute(&app)
        .await?;
    grow(&app, "doc (id, text) SELECT i, randomblob(30000) FROM c", 400).await?;

    for (index, mode) in ["PASSIVE", "TRUNCATE"].iter().enumerate() {
        // Dirty the WAL again, so each mode has a real checkpoint to do, and so
        // the ids stay unique across the two rounds.
        grow(
            &app,
            &format!(
                "doc (id, text) SELECT i + {}, randomblob(30000) FROM c",
                1_000_000 * (index as i64 + 1)
            ),
            60,
        )
        .await?;
        let (read_first, wrote) = checkpoint_under_an_open_transaction(&app, &other, mode).await?;
        assert!(
            read_first > 0 && wrote,
            "{mode}: a transaction that read {read_first} rows before a checkpoint on another              connection could not write after it"
        );
    }
    app.close().await;
    other.close().await;
    Ok(())
}

/// Read on the application's connection, checkpoint from the other one, then
/// write in the transaction that read — and roll it all back.
async fn checkpoint_under_an_open_transaction(
    app: &SqlitePool,
    other: &SqlitePool,
    mode: &str,
) -> Result<(i64, bool)> {
    let mut conn = app.acquire().await?;
    let mut tx = conn.begin().await?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM doc")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query_as::<_, (i64, i64, i64)>(&format!("PRAGMA wal_checkpoint({mode})"))
        .fetch_one(other)
        .await?;
    let wrote = sqlx::query("UPDATE doc SET text = randomblob(4) WHERE id = (SELECT min(id) FROM doc)")
        .execute(&mut *tx)
        .await
        .map(|rows| rows.rows_affected() == 1)
        .unwrap_or(false);
    drop(tx);
    Ok((n, wrote))
}

/// Why the sweeps cannot simply move to a second connection, part two: the
/// compaction does not even refuse the straddling write, it stalls it. Ignored
/// because it cannot be run: the blocked call holds a runtime thread, so nothing
/// — not even a timeout — can observe it coming back. Run it only to re-learn
/// that.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "documents the hazard the single pooled connection exists for: VACUUM on a second \
            connection succeeds while an application transaction holds a read snapshot, and that \
            transaction's next write is then never answered at all (measured: the test process \
            has to be killed; SQLITE_BUSY_SNAPSHOT, code 517, is what a checkpoint on the second \
            connection instead refuses it with). Housekeeping therefore yields between statements \
            rather than moving to another connection"]
async fn a_second_connection_compaction_stalls_an_open_transaction() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let uri = format!("sqlite://{}", dir.path().join("snapshot.db").display());
    let app = one_connection_pool(&uri).await?;
    let housekeeping = one_connection_pool(&uri).await?;
    sqlx::query("CREATE TABLE doc (id INTEGER PRIMARY KEY, text BLOB)")
        .execute(&app)
        .await?;
    grow(&app, "doc (id, text) SELECT i, randomblob(30000) FROM c", 1_000).await?;
    sqlx::query("DELETE FROM doc WHERE id % 2 = 0")
        .execute(&app)
        .await?;

    // The rename/delete/import shape the application uses: read, then write.
    let mut conn = app.acquire().await?;
    let mut tx = conn.begin().await?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM doc")
        .fetch_one(&mut *tx)
        .await?;
    assert!(n > 0, "the transaction has read, and holds that snapshot");

    // Housekeeping compacts the same file on its own connection: an open WAL
    // reader does not stop a writer, so this succeeds.
    sqlx::query("VACUUM").execute(&housekeeping).await?;

    // The application's write now reaches for a snapshot that no longer
    // describes the file.
    let wrote = tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::query("UPDATE doc SET text = randomblob(1) WHERE id = 1").execute(&mut *tx),
    )
    .await;
    match wrote {
        Ok(Ok(_)) => panic!("the straddling write succeeded: the hazard has moved, not gone"),
        Ok(Err(err)) => {
            let text = format!("{err:?}");
            assert!(
                text.contains("517"),
                "expected SQLITE_BUSY_SNAPSHOT (SQLITE_BUSY | 0x200 = 517), got {text}"
            );
        }
        Err(_) => panic!(
            "the straddling write was still blocked after 5s: a second connection's compaction \
             stalls the application instead of merely refusing it"
        ),
    }
    drop(tx);
    app.close().await;
    housekeeping.close().await;
    Ok(())
}

/// The compaction a request cannot be queued behind is the one the pass does not
/// start: `CORTEX_VACUUM_MAX_DB_MB` bounds the file an unattended pass will
/// rewrite, and an unset bound is exactly today's behaviour.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_size_bound_keeps_an_unattended_pass_off_a_big_database() -> Result<()> {
    let _serial = UNATTENDED_PASS.lock().await;
    let _bound = Bound::set(4);
    let dir = tempfile::tempdir()?;
    let db = Database::new(&format!(
        "sqlite://{}",
        dir.path().join("bound.db").display()
    ))
    .await?;
    sqlx::query("CREATE TABLE doc (id INTEGER PRIMARY KEY, text BLOB)")
        .execute(db.write())
        .await?;
    // Content that is then all deleted, so the rewrite the bound prevents would
    // be cheap: the only reason not to run it can be the bound.
    grow(
        db.write(),
        "doc (id, text) SELECT i, randomblob(30000) FROM c",
        1_200,
    )
    .await?;
    sqlx::query("DELETE FROM doc WHERE id > 100")
        .execute(db.write())
        .await?;
    let (free, bytes) = pages(db.write()).await?;
    assert!(
        free >= 16 * 1024 * 1024 && free * 5 >= bytes && bytes > 4 * 1024 * 1024,
        "the free-page heuristic must want this compaction: {free} free of {bytes} bytes"
    );
    let report = db.maintain(2_000_000_000, 180, false).await?;
    assert!(
        !report.vacuumed,
        "a {bytes} byte database is past a 4 MiB bound: a scheduled pass must leave the file alone"
    );
    drop(_bound);
    let report = db.maintain(2_000_000_000, 180, false).await?;
    assert!(
        report.vacuumed,
        "with CORTEX_VACUUM_MAX_DB_MB unset, an unattended pass compacts as it always has"
    );
    Ok(())
}

/// Free pages and file size, for asserting what the heuristics will decide.
async fn pages(pool: &SqlitePool) -> Result<(i64, i64)> {
    let _: (i64,) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(pool)
        .await?;
    let (pages,): (i64,) = sqlx::query_as("PRAGMA freelist_count")
        .fetch_one(pool)
        .await?;
    let (size,): (i64,) = sqlx::query_as("PRAGMA page_size").fetch_one(pool).await?;
    let (count,): (i64,) = sqlx::query_as("PRAGMA page_count").fetch_one(pool).await?;
    Ok((pages * size, count * size))
}

/// The two sweeps that share a transaction: a routing row must not outlive its
/// document by even the gap between two statements, because that gap names a
/// tenant database the control plane still believes it must keep.
#[tokio::test]
async fn a_document_and_its_routing_row_disappear_together() -> Result<()> {
    let config = sqlite_config(1).await;
    let db = config
        .database
        .clone()
        .expect("test config carries a database");
    seed_doc(&config, "routed").await;
    let org: i64 = sqlx::query_as::<_, (i64,)>("SELECT id FROM org LIMIT 1")
        .fetch_one(db.write())
        .await?
        .0;
    grow(db.write(), "document (id, text) SELECT 'orphan-' || i, 'x' FROM c", 300).await?;
    grow(
        db.write(),
        &format!("doc_org (doc_id, org_id, created_at) SELECT 'orphan-' || i, {org}, 1 FROM c"),
        300,
    )
    .await?;
    assert_eq!(
        db.count_documents_of(org).await?,
        301,
        "routing claims the document the file table names, plus the orphans"
    );

    db.maintain(2_000_000_000, 180, false).await?;

    assert_eq!(
        db.table_rows("document").await?,
        1,
        "only the document a file still names survives"
    );
    assert_eq!(
        db.count_documents_of(org).await?,
        1,
        "and every pointer to a deleted document went with it, in the same transaction"
    );
    Ok(())
}

/// `CORTEX_VACUUM_MAX_DB_MB` is read per pass, so a test that sets it has to hand
/// it back — including when an assertion fires.
struct Bound;

impl Bound {
    fn set(mb: i64) -> Self {
        std::env::set_var("CORTEX_VACUUM_MAX_DB_MB", mb.to_string());
        Self
    }
}

impl Drop for Bound {
    fn drop(&mut self) {
        std::env::remove_var("CORTEX_VACUUM_MAX_DB_MB");
    }
}
