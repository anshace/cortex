use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use warp::{filters::BoxedFilter, test::WsClient, Reply};

/// The client half of the app-layer protocol `src/crypto.rs` implements: an
/// ephemeral P-256 key announced in the first frame, and an AES-256-GCM key
/// derived from the ECDH secret with the same HKDF parameters as the server.
/// Without this a test client is refused before the handshake completes,
/// because every frame after the first must be an encrypted `{iv,ct}` envelope.
struct ClientKeys {
    epk: String,
    secret: p256::SecretKey,
}

impl ClientKeys {
    fn generate() -> Self {
        let secret = p256::SecretKey::random(&mut rand::thread_rng());
        Self {
            epk: B64.encode(secret.public_key().to_sec1_bytes()),
            secret,
        }
    }

    /// The same derivation the server performs, with the operands swapped: this
    /// client's secret against the server's public key from the same process.
    fn shared_key(&self) -> Result<[u8; 32]> {
        use p256::ecdh::diffie_hellman;
        let raw = B64
            .decode(rustpad_server::crypto::keys().public_b64().trim())
            .map_err(|e| anyhow!("server public key is not base64: {e}"))?;
        let server = p256::PublicKey::from_sec1_bytes(&raw)
            .map_err(|e| anyhow!("server public key is not SEC1: {e}"))?;
        let shared = diffie_hellman(self.secret.to_nonzero_scalar(), server.as_affine());
        let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"cortex-salt-v1"), shared.raw_secret_bytes());
        let mut okm = [0u8; 32];
        hk.expand(b"cortex-payload-v1", &mut okm)
            .map_err(|e| anyhow!("HKDF expand failed: {e}"))?;
        Ok(okm)
    }

    /// A JSON wire frame: this message encrypted for whoever holds the key.
    fn seal(&self, plaintext: &[u8]) -> Result<String> {
        use aes_gcm::{
            aead::{Aead, KeyInit},
            Aes256Gcm, Nonce,
        };
        let cipher = Aes256Gcm::new_from_slice(&self.shared_key()?)
            .map_err(|e| anyhow!("key rejected: {e}"))?;
        let mut nonce = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| anyhow!("encryption failed"))?;
        Ok(json!({ "iv": B64.encode(nonce), "ct": B64.encode(ct) }).to_string())
    }

    fn open(&self, env: &rustpad_server::crypto::Envelope) -> Result<Vec<u8>> {
        use aes_gcm::{
            aead::{Aead, KeyInit},
            Aes256Gcm, Nonce,
        };
        let cipher = Aes256Gcm::new_from_slice(&self.shared_key()?)
            .map_err(|e| anyhow!("key rejected: {e}"))?;
        let nonce = B64
            .decode(env.iv.trim())
            .map_err(|e| anyhow!("nonce is not base64: {e}"))?;
        let ct = B64
            .decode(env.ct.trim())
            .map_err(|e| anyhow!("ciphertext is not base64: {e}"))?;
        cipher
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .map_err(|_| anyhow!("decryption failed"))
    }
}

/// A test WebSocket client that sends and receives JSON messages, encrypted the
/// way the browser client does.
pub struct JsonSocket {
    client: WsClient,
    keys: ClientKeys,
}

impl JsonSocket {
    pub async fn send(&mut self, msg: &Value) {
        let frame = self
            .keys
            .seal(msg.to_string().as_bytes())
            .expect("encrypt a test message");
        self.client.send_text(frame).await
    }

    pub async fn recv(&mut self) -> Result<Value> {
        loop {
            let msg = self.recv_frame().await?;
            // `send_initial` replays the document's state to every joiner: a
            // baseline `History` for a persisted document (whose single
            // synthetic operation carries no author, so its id is the max
            // `usize`), plus `UserInfo`/`UserCursor` for people already in the
            // room. Those are not the messages these suites are about, and
            // their count depends on who else is connected, so a strict
            // one-for-each read cannot express an OT assertion. `Language` is
            // deliberately not skipped: several tests assert it.
            if is_initial_state(&msg) {
                continue;
            }
            return Ok(msg);
        }
    }

    /// The next frame, exactly as the server sent it, with nothing skipped.
    pub async fn recv_frame(&mut self) -> Result<Value> {
        let msg = self.client.recv().await?;
        let text = msg.to_str().map_err(|_| anyhow!("non-string message"))?;
        let env: rustpad_server::crypto::Envelope = serde_json::from_str(text)?;
        let plain = self.keys.open(&env)?;
        Ok(serde_json::from_slice(&plain)?)
    }

    pub async fn recv_closed(&mut self) -> Result<()> {
        self.client.recv_closed().await.map_err(|e| e.into())
    }
}

/// Frames `send_initial` replays to a joiner before any live traffic: the
/// document's baseline history and the presence state of people already in the
/// room. A baseline operation has no author, so its id is the maximum `usize`.
fn is_initial_state(msg: &Value) -> bool {
    if let Some(ops) = msg
        .get("History")
        .and_then(|h| h.get("operations"))
        .and_then(|o| o.as_array())
    {
        return !ops.is_empty()
            && ops
                .iter()
                .all(|op| op.get("id").and_then(|id| id.as_u64()) == Some(u64::MAX));
    }
    msg.get("UserInfo").is_some() || msg.get("UserCursor").is_some()
}

/// Connect a new test client WebSocket and complete the ECDH handshake.
pub async fn connect(
    filter: &BoxedFilter<(impl Reply + 'static,)>,
    id: &str,
) -> Result<JsonSocket> {
    let cookie = root_cookie(filter).await;
    let mut client = warp::test::ws()
        .path(&format!("/api/socket/{}", id))
        .header("cookie", cookie)
        .handshake(filter.clone())
        .await?;
    let keys = ClientKeys::generate();
    client
        .send_text(json!({ "epk": keys.epk }).to_string())
        .await;
    Ok(JsonSocket { client, keys })
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
    // The same registry boot pairs with the control database. With
    // `CORTEX_ORG_DBS` unset — as it is here — it resolves every org to that
    // database, so these suites exercise the routed server, not a variant.
    let databases = rustpad_server::databases::Databases::new(database.clone(), &uri);
    // Seed the default root account (admin/admin) so test requests can
    // authenticate; every data route is session-gated.
    rustpad_server::auth::ensure_default_owner(&database).await;
    rustpad_server::ServerConfig {
        expiry_days,
        database: Some(database),
        databases: Some(databases),
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

/// Create a document the way the current server requires: an organization, a
/// group, a workspace, and a text file naming the document. Both the socket
/// upgrade and `/api/text` refuse a document id that no file points at, so the
/// bare names the legacy suites used (`"foobar"`, `"hello"`) can no longer
/// connect on their own. Returns the id so callers keep reading like a test.
pub async fn seed_doc(config: &rustpad_server::ServerConfig, doc_id: &str) -> String {
    let db = config
        .database
        .clone()
        .expect("test config carries a database");
    let root = db
        .get_user_by_email("admin")
        .await
        .expect("query the root account")
        .expect("the root account is seeded");
    let org = db
        .create_org(doc_id, doc_id, 1)
        .await
        .expect("create the organization");
    let group = db
        .create_group(org.id, doc_id, root.id, 1, "group")
        .await
        .expect("create the group");
    let ws = db
        .create_workspace(group.id, doc_id, root.id, 1)
        .await
        .expect("create the workspace");
    db.create_file(ws.id, &format!("{doc_id}.md"), doc_id, "text", None, 1)
        .await
        .expect("create the text file");
    doc_id.to_string()
}
