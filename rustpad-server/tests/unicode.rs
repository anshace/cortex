//! Tests for Unicode support and correct cursor transformation.

pub mod common;

use anyhow::Result;
use common::*;
use log::info;
use operational_transform::OperationSeq;
use rustpad_server::server;
use serde_json::json;

#[tokio::test]
async fn test_unicode_length() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "unicode").await;
    let filter = server(config);

    expect_text(&filter, "unicode", "").await;

    let mut client = connect(&filter, "unicode").await?;
    let msg = client.recv().await?;
    assert_eq!(msg, json!({ "Identity": 0 }));

    let mut operation = OperationSeq::default();
    operation.insert("h🎉e🎉l👨‍👨‍👦‍👦lo");
    let msg = json!({
        "Edit": {
            "revision": 0,
            "operation": operation
        }
    });
    info!("sending ClientMsg {}", msg);
    client.send(&msg).await;

    let msg = client.recv().await?;
    assert_eq!(
        msg,
        json!({
            "History": {
                "start": 1,
                "operations": [
                    { "id": 0, "operation": ["h🎉e🎉l👨‍👨‍👦‍👦lo"] }
                ]
            }
        })
    );

    info!("testing that text length is equal to number of Unicode code points...");
    let mut operation = OperationSeq::default();
    operation.delete(14);
    let msg = json!({
        "Edit": {
            "revision": 2,
            "operation": operation
        }
    });
    info!("sending ClientMsg {}", msg);
    client.send(&msg).await;

    let msg = client.recv().await?;
    assert_eq!(
        msg,
        json!({
            "History": {
                "start": 2,
                "operations": [
                    { "id": 0, "operation": [-14] }
                ]
            }
        })
    );

    expect_text(&filter, "unicode", "").await;

    Ok(())
}

#[tokio::test]
async fn test_multiple_operations() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "unicode").await;
    let filter = server(config);

    expect_text(&filter, "unicode", "").await;

    let mut client = connect(&filter, "unicode").await?;
    let msg = client.recv().await?;
    assert_eq!(msg, json!({ "Identity": 0 }));

    let mut operation = OperationSeq::default();
    operation.insert("🎉😍𒀇👨‍👨‍👦‍👦"); // Emoticons and Cuneiform
    let msg = json!({
        "Edit": {
            "revision": 0,
            "operation": operation
        }
    });
    info!("sending ClientMsg {}", msg);
    client.send(&msg).await;

    let msg = client.recv().await?;
    assert_eq!(
        msg,
        json!({
            "History": {
                "start": 1,
                "operations": [
                    { "id": 0, "operation": ["🎉😍𒀇👨‍👨‍👦‍👦"] }
                ]
            }
        })
    );

    let mut operation = OperationSeq::default();
    operation.insert("👯‍♂️");
    operation.retain(3);
    operation.insert("𐅣𐅤𐅥"); // Ancient Greek numbers
    operation.retain(7);
    let msg = json!({
        "Edit": {
            "revision": 2,
            "operation": operation
        }
    });
    info!("sending ClientMsg {}", msg);
    client.send(&msg).await;

    let msg = client.recv().await?;
    assert_eq!(
        msg,
        json!({
            "History": {
                "start": 2,
                "operations": [
                    { "id": 0, "operation": ["👯‍♂️", 3, "𐅣𐅤𐅥", 7] }
                ]
            }
        })
    );

    expect_text(&filter, "unicode", "👯‍♂️🎉😍𒀇𐅣𐅤𐅥👨‍👨‍👦‍👦").await;

    let mut operation = OperationSeq::default();
    operation.retain(2);
    operation.insert("h̷̙̤̏͊̑̍̆̃̉͝ĕ̶̠̌̓̃̓̽̃̚l̸̥̊̓̓͝͠l̸̨̠̣̟̥͠ỏ̴̳̖̪̟̱̰̥̞̙̏̓́͗̽̀̈́͛͐̚̕͝͝ ̶̡͍͙͚̞͙̣̘͙̯͇̙̠̀w̷̨̨̪͚̤͙͖̝͕̜̭̯̝̋̋̿̿̀̾͛̐̏͘͘̕͝ǒ̴̙͉͈̗̖͍̘̥̤̒̈́̒͠r̶̨̡̢̦͔̙̮̦͖͔̩͈̗̖̂̀l̶̡̢͚̬̤͕̜̀͛̌̈́̈́͑͋̈̍̇͊͝͠ď̵̛̛̯͕̭̩͖̝̙͎̊̏̈́̎͊̐̏͊̕͜͝͠͝"); // Lots of ligatures
    operation.retain(8);
    let msg = json!({
        "Edit": {
            "revision": 2,
            "operation": operation
        }
    });
    info!("sending ClientMsg {}", msg);
    client.send(&msg).await;

    let msg = client.recv().await?;
    assert_eq!(
        msg,
        json!({
            "History": {
                "start": 3,
                "operations": [
                    { "id": 0, "operation": [6, "h̷̙̤̏͊̑̍̆̃̉͝ĕ̶̠̌̓̃̓̽̃̚l̸̥̊̓̓͝͠l̸̨̠̣̟̥͠ỏ̴̳̖̪̟̱̰̥̞̙̏̓́͗̽̀̈́͛͐̚̕͝͝ ̶̡͍͙͚̞͙̣̘͙̯͇̙̠̀w̷̨̨̪͚̤͙͖̝͕̜̭̯̝̋̋̿̿̀̾͛̐̏͘͘̕͝ǒ̴̙͉͈̗̖͍̘̥̤̒̈́̒͠r̶̨̡̢̦͔̙̮̦͖͔̩͈̗̖̂̀l̶̡̢͚̬̤͕̜̀͛̌̈́̈́͑͋̈̍̇͊͝͠ď̵̛̛̯͕̭̩͖̝̙͎̊̏̈́̎͊̐̏͊̕͜͝͠͝", 11] }
                ]
            }
        })
    );

    expect_text(&filter, "unicode", "👯‍♂️🎉😍h̷̙̤̏͊̑̍̆̃̉͝ĕ̶̠̌̓̃̓̽̃̚l̸̥̊̓̓͝͠l̸̨̠̣̟̥͠ỏ̴̳̖̪̟̱̰̥̞̙̏̓́͗̽̀̈́͛͐̚̕͝͝ ̶̡͍͙͚̞͙̣̘͙̯͇̙̠̀w̷̨̨̪͚̤͙͖̝͕̜̭̯̝̋̋̿̿̀̾͛̐̏͘͘̕͝ǒ̴̙͉͈̗̖͍̘̥̤̒̈́̒͠r̶̨̡̢̦͔̙̮̦͖͔̩͈̗̖̂̀l̶̡̢͚̬̤͕̜̀͛̌̈́̈́͑͋̈̍̇͊͝͠ď̵̛̛̯͕̭̩͖̝̙͎̊̏̈́̎͊̐̏͊̕͜͝͠͝𒀇𐅣𐅤𐅥👨‍👨‍👦‍👦").await;

    Ok(())
}

#[tokio::test]
async fn test_unicode_cursors() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    seed_doc(&config, "unicode").await;
    let filter = server(config);

    // Every read here is the strict `recv_frame`: this test is about the
    // `UserCursor` frames, and the skipping reader discards exactly those.
    //
    // Measured order for this document, per socket:
    //   join          -> Identity, then the baseline `History`
    //   own edit      -> `History` acknowledging it
    //   own CursorData-> `UserCursor` broadcast back to everyone
    //   someone else joining -> their Identity, the whole history so far, then
    //                            a `UserCursor` replayed from server state
    let mut client = connect(&filter, "unicode").await?;
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
    operation.insert("🎉🎉🎉");
    let msg = json!({
        "Edit": {
            "revision": 0,
            "operation": operation
        }
    });
    info!("sending ClientMsg {}", msg);
    client.send(&msg).await;
    assert_eq!(
        client.recv_frame().await?,
        json!({
            "History": {
                "start": 1,
                "operations": [{ "id": 0, "operation": ["🎉🎉🎉"] }]
            }
        })
    );

    let cursors = json!({
        "cursors": [0, 1, 2, 3],
        "selections": [[0, 1], [2, 3]]
    });
    client.send(&json!({ "CursorData": cursors })).await;

    let cursors_resp = json!({
        "UserCursor": {
            "id": 0,
            "data": cursors
        }
    });
    assert_eq!(client.recv_frame().await?, cursors_resp);

    // The joiner is replayed the state as it stands: the history, then the
    // cursor the first client announced. Nothing about that replay is
    // transformed yet — no edit has happened since.
    let mut client2 = connect(&filter, "unicode").await?;
    assert_eq!(client2.recv_frame().await?, json!({ "Identity": 1 }));
    assert_eq!(
        client2.recv_frame().await?,
        json!({
            "History": {
                "start": 0,
                "operations": [
                    { "id": u64::MAX as usize, "operation": [] },
                    { "id": 0, "operation": ["🎉🎉🎉"] }
                ]
            }
        })
    );
    assert_eq!(client2.recv_frame().await?, cursors_resp);

    // Insert before the cursor positions: every stored index has to move.
    let msg = json!({
        "Edit": {
            "revision": 0,
            "operation": ["🎉"]
        }
    });
    info!("sending ClientMsg {}", msg);
    client2.send(&msg).await;

    let edit_resp = json!({
        "History": {
            "start": 2,
            "operations": [{ "id": 1, "operation": ["🎉", 3] }]
        }
    });
    assert_eq!(client2.recv_frame().await?, edit_resp);
    assert_eq!(client.recv_frame().await?, edit_resp);

    // Whoever joins after that edit is replayed the transformed cursor state,
    // which is the only place the server's cursor bookkeeping is observable.
    let mut client3 = connect(&filter, "unicode").await?;
    assert_eq!(client3.recv_frame().await?, json!({ "Identity": 2 }));
    assert_eq!(
        client3.recv_frame().await?,
        json!({
            "History": {
                "start": 0,
                "operations": [
                    { "id": u64::MAX as usize, "operation": [] },
                    { "id": 0, "operation": ["🎉🎉🎉"] },
                    { "id": 1, "operation": ["🎉", 3] }
                ]
            }
        })
    );

    let transformed_cursors_resp = json!({
        "UserCursor": {
            "id": 0,
            "data": {
                "cursors": [1, 2, 3, 4],
                "selections": [[1, 2], [3, 4]]
            }
        }
    });
    assert_eq!(client3.recv_frame().await?, transformed_cursors_resp);

    Ok(())
}
