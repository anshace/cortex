//! Tests to ensure that documents are garbage collected.

use anyhow::Result;
use common::*;
use operational_transform::OperationSeq;
use rustpad_server::server;
use serde_json::{json, Value};
use warp::{filters::BoxedFilter, Reply};

pub mod common;

/// Documents the server is still holding in memory, from `/api/stats`. This is
/// the only public view of the garbage collector: an evicted document keeps
/// serving its text, because eviction flushes it to the database rather than
/// deleting it.
async fn live_documents(
    filter: &BoxedFilter<(impl Reply + 'static,)>,
    cookie: &str,
) -> usize {
    let resp = warp::test::request()
        .path("/api/stats")
        .header("cookie", cookie)
        .reply(filter)
        .await;
    assert_eq!(resp.status(), 200, "stats is a session-gated route");
    let body: Value = serde_json::from_slice(resp.body()).expect("stats is JSON");
    body["num_documents"]
        .as_u64()
        .expect("stats reports the live document count") as usize
}

#[tokio::test]
async fn test_cleanup() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(2).await;
    seed_doc(&config, "old").await;
    let filter = server(config);

    expect_text(&filter, "old", "").await;
    let cookie = root_cookie(&filter).await;

    let mut client = connect(&filter, "old").await?;
    assert_eq!(client.recv_frame().await?, json!({ "Identity": 0 }));
    assert_eq!(
        client.recv_frame().await?,
        json!({
            "History": {
                "start": 0,
                "operations": [{ "id": u64::MAX as usize, "operation": [] }]
            }
        })
    );

    let mut operation = OperationSeq::default();
    operation.insert("hello");
    let msg = json!({
        "Edit": {
            "revision": 0,
            "operation": operation
        }
    });
    client.send(&msg).await;

    assert_eq!(
        client.recv_frame().await?,
        json!({
            "History": {
                "start": 1,
                "operations": [{ "id": 0, "operation": ["hello"] }]
            }
        })
    );
    expect_text(&filter, "old", "hello").await;

    // Opening the document put it in the server's live registry.
    assert_eq!(live_documents(&filter, &cookie).await, 1);

    // The server was built with a two-day expiry, so at 47 hours the session
    // this document was edited in is still the one the server is serving.
    advance_hours(47).await;
    assert_eq!(
        live_documents(&filter, &cookie).await,
        1,
        "a document idle for 47 hours is inside the two-day expiry"
    );
    expect_text(&filter, "old", "hello").await;

    // At 50 hours the cleaner has dropped it. Garbage collected does not mean
    // deleted: eviction flushes the document on its way out, so the text
    // outlives the in-memory session.
    advance_hours(3).await;
    assert_eq!(
        live_documents(&filter, &cookie).await,
        0,
        "a document idle past the expiry is collected"
    );
    expect_text(&filter, "old", "hello").await;

    // The next socket is served by a fresh session rebuilt from the database,
    // which is where this text now comes from: user ids start over, and the
    // whole document is the single operation that seeded it.
    let mut client2 = connect(&filter, "old").await?;
    assert_eq!(client2.recv_frame().await?, json!({ "Identity": 0 }));
    assert_eq!(
        client2.recv_frame().await?,
        json!({
            "History": {
                "start": 0,
                "operations": [{ "id": u64::MAX as usize, "operation": ["hello"] }]
            }
        })
    );

    Ok(())
}
