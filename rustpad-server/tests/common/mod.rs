use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use warp::{filters::BoxedFilter, test::WsClient, Reply};

/// A test WebSocket client that sends and receives JSON messages.
pub struct JsonSocket(WsClient);

impl JsonSocket {
    pub async fn send(&mut self, msg: &Value) {
        self.0.send_text(msg.to_string()).await
    }

    pub async fn recv(&mut self) -> Result<Value> {
        let msg = self.0.recv().await?;
        let msg = msg.to_str().map_err(|_| anyhow!("non-string message"))?;
        Ok(serde_json::from_str(msg)?)
    }

    pub async fn recv_closed(&mut self) -> Result<()> {
        self.0.recv_closed().await.map_err(|e| e.into())
    }
}

/// Connect a new test client WebSocket.
pub async fn connect(
    filter: &BoxedFilter<(impl Reply + 'static,)>,
    id: &str,
) -> Result<JsonSocket> {
    let cookie = root_cookie(filter).await;
    let client = warp::test::ws()
        .path(&format!("/api/socket/{}", id))
        .header("cookie", cookie)
        .handshake(filter.clone())
        .await?;
    Ok(JsonSocket(client))
}

/// Check the text route.
pub async fn expect_text(filter: &BoxedFilter<(impl Reply + 'static,)>, id: &str, text: &str) {
    let cookie = root_cookie(filter).await;
    let resp = warp::test::request()
        .path(&format!("/api/text/{}", id))
        .header("cookie", cookie)
        .reply(filter)
        .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.body(), text);
}

/// A ServerConfig backed by a throwaway SQLite database. `server()` requires a
/// database, so every test filter needs one of these.
pub async fn sqlite_config(expiry_days: u32) -> rustpad_server::ServerConfig {
    use rustpad_server::database::Database;

    let uri = format!(
        "sqlite://{}",
        tempfile::NamedTempFile::new()
            .expect("create temporary database")
            .into_temp_path()
            .to_str()
            .expect("temporary path is valid UTF-8")
    );
    let database = Database::new(&uri).await.expect("open test database");
    // Seed the default root account (admin/admin) so test requests can
    // authenticate; every data route is session-gated.
    rustpad_server::auth::ensure_default_owner(&database).await;
    rustpad_server::ServerConfig {
        expiry_days,
        database: Some(database),
    }
}

/// Log in as the seeded root account and return the `session` cookie pair.
pub async fn root_cookie(filter: &BoxedFilter<(impl Reply + 'static,)>) -> String {
    let resp = warp::test::request()
        .method("POST")
        .path("/api/login")
        .json(&json!({ "email": "admin", "password": "admin" }))
        .reply(&filter.clone())
        .await;
    assert_eq!(
        resp.status(),
        200,
        "seeded root login should succeed; body: {}",
        String::from_utf8_lossy(resp.body())
    );
    let header = resp
        .headers()
        .get("set-cookie")
        .expect("login sets a session cookie")
        .to_str()
        .expect("cookie header is valid UTF-8");
    header.split(';').next().unwrap_or("").to_string()
}
