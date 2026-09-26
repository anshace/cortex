//! Tests for synchronization of user presence.

use anyhow::Result;
use common::*;
use rustpad_server::server;
use serde_json::json;

pub mod common;

#[tokio::test]
async fn test_two_users() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "foobar").await;
    let filter = server(config);

    let mut client = connect(&filter, "foobar").await?;
    assert_eq!(client.recv_frame().await?, json!({ "Identity": 0 }));
    // The persisted document replays its baseline history to every joiner.
    client.recv_frame().await?;

    let alice = json!({
        "name": "Alice",
        "hue": 42
    });
    client.send(&json!({ "ClientInfo": alice })).await;

    let alice_info = json!({
        "UserInfo": {
            "id": 0,
            "info": alice
        }
    });
    assert_eq!(client.recv_frame().await?, alice_info);

    let mut client2 = connect(&filter, "foobar").await?;
    assert_eq!(client2.recv_frame().await?, json!({ "Identity": 1 }));
    // The persisted document replays its baseline history to every joiner.
    client2.recv_frame().await?;
    assert_eq!(client2.recv_frame().await?, alice_info);

    let bob = json!({
        "name": "Bob",
        "hue": 96
    });
    client2.send(&json!({ "ClientInfo": bob })).await;

    let bob_info = json!({
        "UserInfo": {
            "id": 1,
            "info": bob
        }
    });
    assert_eq!(client2.recv_frame().await?, bob_info);
    assert_eq!(client.recv_frame().await?, bob_info);

    Ok(())
}

#[tokio::test]
async fn test_invalid_user() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "foobar").await;
    let filter = server(config);

    let mut client = connect(&filter, "foobar").await?;
    assert_eq!(client.recv_frame().await?, json!({ "Identity": 0 }));
    // The persisted document replays its baseline history to every joiner.
    client.recv_frame().await?;

    let alice = json!({ "name": "Alice" }); // no hue
    client.send(&json!({ "ClientInfo": alice })).await;
    client.recv_closed().await?;

    Ok(())
}

#[tokio::test]
async fn test_leave_rejoin() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "foobar").await;
    let filter = server(config);

    let mut client = connect(&filter, "foobar").await?;
    assert_eq!(client.recv_frame().await?, json!({ "Identity": 0 }));
    // The persisted document replays its baseline history to every joiner.
    client.recv_frame().await?;

    let alice = json!({
        "name": "Alice",
        "hue": 42
    });
    client.send(&json!({ "ClientInfo": alice })).await;

    let alice_info = json!({
        "UserInfo": {
            "id": 0,
            "info": alice
        }
    });
    assert_eq!(client.recv_frame().await?, alice_info);

    client.send(&json!({ "Invalid": "please close" })).await;
    client.recv_closed().await?;

    let mut client2 = connect(&filter, "foobar").await?;
    assert_eq!(client2.recv_frame().await?, json!({ "Identity": 1 }));
    // The persisted document replays its baseline history to every joiner.
    client2.recv_frame().await?;

    let bob = json!({
        "name": "Bob",
        "hue": 96
    });
    client2.send(&json!({ "ClientInfo": bob })).await;

    let bob_info = json!({
        "UserInfo": {
            "id": 1,
            "info": bob
        }
    });
    assert_eq!(client2.recv_frame().await?, bob_info);

    Ok(())
}

#[tokio::test]
async fn test_cursors() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "foobar").await;
    let filter = server(config);

    let mut client = connect(&filter, "foobar").await?;
    assert_eq!(client.recv_frame().await?, json!({ "Identity": 0 }));
    // The persisted document replays its baseline history to every joiner.
    client.recv_frame().await?;

    let cursors = json!({
        "cursors": [4, 6, 7],
        "selections": [[5, 10], [3, 4]]
    });
    client.send(&json!({ "CursorData": cursors })).await;

    let cursors_resp = json!({
        "UserCursor": {
            "id": 0,
            "data": cursors
        }
    });
    assert_eq!(client.recv_frame().await?, cursors_resp);

    let mut client2 = connect(&filter, "foobar").await?;
    assert_eq!(client2.recv_frame().await?, json!({ "Identity": 1 }));
    // The persisted document replays its baseline history to every joiner.
    client2.recv_frame().await?;
    assert_eq!(client2.recv_frame().await?, cursors_resp);

    let cursors2 = json!({
        "cursors": [10],
        "selections": []
    });
    client2.send(&json!({ "CursorData": cursors2 })).await;

    let cursors2_resp = json!({
        "UserCursor": {
            "id": 1,
            "data": cursors2
        }
    });
    assert_eq!(client2.recv_frame().await?, cursors2_resp);
    assert_eq!(client.recv_frame().await?, cursors2_resp);

    client.send(&json!({ "Invalid": "please close" })).await;
    client.recv_closed().await?;

    let msg = json!({
        "Edit": {
            "revision": 0,
            "operation": ["a"]
        }
    });
    client2.send(&msg).await;

    let mut client3 = connect(&filter, "foobar").await?;
    assert_eq!(client3.recv_frame().await?, json!({ "Identity": 2 }));
    // A joiner is replayed the document's whole history: the synthetic baseline
    // operation the persisted file carries, then the edit client2 just made.
    assert_eq!(
        client3.recv_frame().await?,
        json!({
            "History": {
                "start": 0,
                "operations": [
                    { "id": u64::MAX as usize, "operation": [] },
                    { "id": 1, "operation": ["a"] }
                ]
            }
        })
    );
    let transformed_cursors2_resp = json!({
        "UserCursor": {
            "id": 1,
            "data": {
                "cursors": [11],
                "selections": []
            }
        }
    });
    assert_eq!(client3.recv_frame().await?, transformed_cursors2_resp);

    Ok(())
}
