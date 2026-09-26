//! A storage layer that is busy must not be reported as a wrong password.

use anyhow::Result;
use common::*;
use rustpad_server::server;
use serde_json::json;

pub mod common;

#[tokio::test]
async fn busy_database_is_not_a_bad_password() -> Result<()> {
    pretty_env_logger::try_init().ok();
    let config = sqlite_config(1).await;
    let db = config
        .database
        .clone()
        .expect("test config carries a database");
    let filter = server(config);

    // Stand in for housekeeping holding the one pooled connection: the
    // credential lookup below can no longer obtain it, which is exactly what a
    // VACUUM in progress does to a sign-in.
    let held = db.read_only().acquire().await?;

    let resp = warp::test::request()
        .method("POST")
        .path("/api/login")
        .json(&json!({ "email": "admin", "password": "admin" }))
        .reply(&filter)
        .await;
    let body = String::from_utf8_lossy(resp.body()).to_string();
    assert_eq!(
        resp.status(),
        503,
        "a busy database must not answer {body}"
    );
    assert!(body.contains("database busy"), "body: {body}");
    drop(held);

    // And the refusal must not be charged against the address's failure count,
    // or a long enough housekeeping pass would lock a shared office IP out
    // behind the brute-force guard after the database had already recovered.
    let resp = warp::test::request()
        .method("POST")
        .path("/api/login")
        .json(&json!({ "email": "admin", "password": "admin" }))
        .reply(&filter)
        .await;
    assert_eq!(
        resp.status(),
        200,
        "the correct password must still work afterwards; body: {}",
        String::from_utf8_lossy(resp.body())
    );
    // The session check sits in front of every data route, so it is the first
    // place a held connection becomes an answer the user can see: a valid
    // session must not turn into "you are not signed in".
    let cookie = root_cookie(&filter).await;
    let held = db.read_only().acquire().await?;
    let resp = warp::test::request()
        .path("/api/me")
        .header("cookie", cookie)
        .reply(&filter)
        .await;
    let body = String::from_utf8_lossy(resp.body()).to_string();
    assert_eq!(
        resp.status(),
        503,
        "a valid session during a busy database is not an invalid session; got {body}"
    );
    assert!(body.contains("database busy"), "body: {body}");
    drop(held);

    // And it must not be charged against the address's failure count,
    // ...
    Ok(())
}
