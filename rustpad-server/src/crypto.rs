//! App-layer payload encryption for sensitive endpoints (chat / DMs).
//!
//! The client does an ephemeral P-256 ECDH against this server's process key,
//! both sides derive an AES-256-GCM key via HKDF-SHA256, and chat/DM bodies
//! travel as opaque `{iv,ct}` envelopes. HTTPS still wraps everything; this adds
//! a layer that stays opaque even to a **passive** TLS-inspecting proxy that
//! decrypts HTTPS to log traffic.
//!
//! Honest limits: it does NOT stop an active MITM that rewrites the served JS
//! (it would just swap the crypto), and the live-edit WebSocket stays TLS-only.

use std::sync::OnceLock;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use p256::{ecdh::diffie_hellman, PublicKey, SecretKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use warp::reply::{Reply, Response};

const HKDF_SALT: &[u8] = b"cortex-salt-v1";
const HKDF_INFO: &[u8] = b"cortex-payload-v1";

/// An encrypted payload: base64 nonce + base64 ciphertext(||GCM tag).
#[derive(Serialize, Deserialize)]
pub struct Envelope {
    pub iv: String,
    pub ct: String,
}

/// The server's process-lifetime ECDH keypair.
pub struct CryptoKeys {
    secret: SecretKey,
    pub_b64: String,
}

impl CryptoKeys {
    fn generate() -> Self {
        let secret = SecretKey::random(&mut rand::thread_rng());
        let pub_b64 = B64.encode(secret.public_key().to_sec1_bytes());
        Self { secret, pub_b64 }
    }

    /// This server's public key (base64 SEC1 uncompressed), served to clients.
    pub fn public_b64(&self) -> &str {
        &self.pub_b64
    }

    /// Derive the shared AES key from a client's ephemeral public key (base64 raw).
    fn derive_key(&self, epk_b64: &str) -> Option<[u8; 32]> {
        let raw = B64.decode(epk_b64.trim()).ok()?;
        let client_pub = PublicKey::from_sec1_bytes(&raw).ok()?;
        let shared = diffie_hellman(self.secret.to_nonzero_scalar(), client_pub.as_affine());
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared.raw_secret_bytes().as_slice());
        let mut okm = [0u8; 32];
        hk.expand(HKDF_INFO, &mut okm).ok()?;
        Some(okm)
    }

    /// Encrypt `plaintext` for the holder of `epk`. None if the key is unusable.
    pub fn seal(&self, epk_b64: &str, plaintext: &[u8]) -> Option<Envelope> {
        let key = self.derive_key(epk_b64)?;
        let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).ok()?;
        Some(Envelope {
            iv: B64.encode(nonce),
            ct: B64.encode(ct),
        })
    }

    /// Decrypt an envelope from the holder of `epk`. None on any failure.
    pub fn open(&self, epk_b64: &str, env: &Envelope) -> Option<Vec<u8>> {
        let key = self.derive_key(epk_b64)?;
        let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
        let nonce = B64.decode(&env.iv).ok()?;
        if nonce.len() != 12 {
            return None;
        }
        let ct = B64.decode(&env.ct).ok()?;
        cipher.decrypt(Nonce::from_slice(&nonce), ct.as_ref()).ok()
    }
}

/// Process-global keys (generated once on first use; new on each restart, which
/// just makes clients re-fetch the pubkey and re-derive).
pub fn keys() -> &'static CryptoKeys {
    static K: OnceLock<CryptoKeys> = OnceLock::new();
    K.get_or_init(CryptoKeys::generate)
}

/// Plaintext of a request body: decrypt if the client sent an `epk` header,
/// else treat the body as plaintext JSON (dev / non-encrypting clients).
pub fn open_request(epk: &Option<String>, body: &[u8]) -> Option<Vec<u8>> {
    match epk {
        Some(e) => {
            let env: Envelope = serde_json::from_slice(body).ok()?;
            keys().open(e, &env)
        }
        None => Some(body.to_vec()),
    }
}

/// Seal a JSON reply back to the client if it did the handshake, else plaintext.
/// When `epk` is present but sealing fails, returns 400 (never leaks plaintext).
pub fn seal_reply(epk: &Option<String>, value: &serde_json::Value) -> Response {
    match epk {
        Some(e) => match keys().seal(e, value.to_string().as_bytes()) {
            Some(env) => warp::reply::json(&env).into_response(),
            None => warp::reply::with_status(
                warp::reply::json(&serde_json::json!({ "error": "handshake" })),
                warp::http::StatusCode::BAD_REQUEST,
            )
            .into_response(),
        },
        None => warp::reply::json(value).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdh_roundtrip_matches_client_derivation() {
        let server = CryptoKeys::generate();
        // A "client": its own P-256 keypair.
        let client = SecretKey::random(&mut rand::thread_rng());
        let client_pub_b64 = B64.encode(client.public_key().to_sec1_bytes());

        // Server seals to the client's pubkey.
        let msg = br#"{"body":"hello secret"}"#;
        let env = server.seal(&client_pub_b64, msg).unwrap();

        // Client independently derives the SAME key (server pub + own secret) and
        // decrypts — proving both sides agree.
        let server_pub =
            PublicKey::from_sec1_bytes(&B64.decode(server.public_b64()).unwrap()).unwrap();
        let shared = diffie_hellman(client.to_nonzero_scalar(), server_pub.as_affine());
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared.raw_secret_bytes().as_slice());
        let mut key = [0u8; 32];
        hk.expand(HKDF_INFO, &mut key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = B64.decode(&env.iv).unwrap();
        let ct = B64.decode(&env.ct).unwrap();
        let pt = cipher
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .unwrap();
        assert_eq!(pt, msg);

        // And the reverse direction: server.open of a client-sealed envelope.
        let env2 = server.seal(&client_pub_b64, b"pong").unwrap();
        assert_eq!(server.open(&client_pub_b64, &env2).unwrap(), b"pong");

        // A tampered ciphertext must fail (GCM auth).
        let mut bad = env2;
        bad.ct = B64.encode(b"garbage-ciphertext");
        assert!(server.open(&client_pub_b64, &bad).is_none());
    }
}
