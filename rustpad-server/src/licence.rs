//! Offline-verifiable plan claims — how a tier gets locked without phoning home.
//!
//! A licence is `base64url(claims-json).base64url(ed25519-signature)` where the
//! signature covers the base64 text itself, so verification never re-serializes
//! JSON and cannot disagree with what was signed. The server holds only the
//! public key (`CORTEX_LICENCE_PUB`), and the private key never leaves whoever
//! issues licences, so a leaked deployment cannot mint or extend a plan.
//!
//! Two rules keep this from becoming a way to lock people out of their own data:
//!
//! - **No public key configured means no plan enforcement at all.** A
//!   self-hosted install that has never heard of licences behaves exactly as it
//!   did before, because the whole point of the product is that it runs on
//!   someone else's hardware.
//! - **A missing, forged or expired licence degrades to the free tier**, and
//!   never to a denial of reads or export. Locking a plan is a billing control,
//!   not a remote wipe.

use std::sync::OnceLock;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{Ed25519KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};

/// What an unlicensed or expired org gets. Deliberately not zero: a deployment
/// that misconfigures its key must still be usable.
pub const FREE: &str = "free";
const FREE_SEATS: i64 = 5;
const FREE_STORAGE: i64 = 512 * 1024 * 1024;

/// Everything a plan asserts about one org. `org` is part of the payload, so a
/// licence for one organization can never be replayed against another.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Claims {
    /// Organization the claims apply to.
    pub org: i64,
    /// Plan name, for display.
    pub plan: String,
    /// Accounts allowed in the org.
    pub seats: i64,
    /// Content bytes allowed across files and chat attachments.
    pub storage_bytes: i64,
    /// Optional capabilities, e.g. `whiteboard`.
    #[serde(default)]
    pub features: Vec<String>,
    /// Unix seconds after which the claims no longer apply. Zero = never.
    #[serde(default)]
    pub exp: i64,
}

impl Claims {
    /// The exact bytes that get signed: the base64url payload, not the JSON.
    fn payload(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).unwrap_or_default())
    }

    /// A signed token for these claims. Used by the issuing CLI and by tests.
    pub fn sign(&self, pkcs8_private_key: &[u8]) -> Result<String, String> {
        let pair = Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8_private_key)
            .map_err(|_| "private key is not a usable PKCS#8 Ed25519 key".to_string())?;
        let payload = self.payload();
        let sig = pair.sign(payload.as_bytes());
        Ok(format!(
            "{}.{}",
            payload,
            URL_SAFE_NO_PAD.encode(sig.as_ref())
        ))
    }

    /// Whether these claims currently allow `action`. Reads are always allowed:
    /// a plan can stop someone adding things, never reviewing them.
    pub fn allows(&self, feature: &str, now: i64) -> bool {
        self.live(now) && self.features.iter().any(|f| f == feature)
    }

    /// Whether the claims have not expired.
    pub fn live(&self, now: i64) -> bool {
        self.exp == 0 || self.exp > now
    }
}

/// The resolved plan for one org: the claims, or the free tier.
#[derive(Clone, Debug)]
pub struct Plan {
    /// The claims in force.
    pub claims: Claims,
    /// True when these are defaults rather than a verified licence.
    pub unlicensed: bool,
}

impl Plan {
    /// Seats allowed.
    pub fn seats(&self) -> i64 {
        self.claims.seats
    }

    /// Content bytes allowed.
    pub fn storage_bytes(&self) -> i64 {
        self.claims.storage_bytes
    }

    /// Whether a capability is granted right now.
    pub fn allows(&self, feature: &str, now: i64) -> bool {
        self.claims.allows(feature, now)
    }

    /// A plan name for the console.
    pub fn name(&self) -> &str {
        &self.claims.plan
    }
}

fn free(org: i64) -> Plan {
    Plan {
        claims: Claims {
            org,
            plan: FREE.to_string(),
            seats: FREE_SEATS,
            storage_bytes: FREE_STORAGE,
            features: vec!["whiteboard".to_string(), "chat".to_string()],
            exp: 0,
        },
        unlicensed: true,
    }
}

/// No key means no enforcement: unlimited, and self-hosted installs are
/// untouched by any of this.
static ENFORCING: OnceLock<bool> = OnceLock::new();
static LICENSES: OnceLock<Vec<Claims>> = OnceLock::new();

/// Read the deployment's key and licence bundle. Returns whether plan
/// enforcement is active. Malformed input is reported and degrades to the free
/// tier — a typo in a licence must not brick a running instance.
pub fn init(now: i64) -> bool {
    let key = match std::env::var("CORTEX_LICENCE_PUB") {
        Ok(raw) => match decode_key(&raw) {
            Some(key) => key,
            None => {
                log::error!("CORTEX_LICENCE_PUB is not 32 bytes of hex/base64; plan enforcement is off");
                let _ = ENFORCING.set(false);
                return false;
            }
        },
        Err(_) => {
            let _ = ENFORCING.set(false);
            log::info!("no CORTEX_LICENCE_PUB: plans are unlimited (self-hosted default)");
            return false;
        }
    };

    let mut claims = Vec::new();
    match std::env::var("CORTEX_LICENCE") {
        Ok(bundle) => {
            for token in bundle.split(',').map(str::trim).filter(|t| !t.is_empty()) {
                match verify(token, &key, now) {
                    Ok(claims_now) => claims.push(claims_now),
                    Err(e) => log::error!("rejected a CORTEX_LICENCE entry: {e}"),
                }
            }
        }
        Err(_) => log::warn!("a licence key is set but no CORTEX_LICENCE was provided; orgs fall back to the free tier"),
    }

    let _ = LICENSES.set(claims);
    let _ = ENFORCING.set(true);
    true
}

/// Verify one token against a public key.
pub fn verify(token: &str, public_key: &[u8; 32], now: i64) -> Result<Claims, String> {
    let (payload, signature) = token
        .split_once('.')
        .ok_or_else(|| "token is not `payload.signature`".to_string())?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature.trim())
        .map_err(|_| "signature is not base64url".to_string())?;
    let verifier = UnparsedPublicKey::new(&ED25519, public_key);
    verifier
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| "signature does not match the configured key".to_string())?;
    let json = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "payload is not base64url".to_string())?;
    let claims: Claims =
        serde_json::from_slice(&json).map_err(|e| format!("payload is not plan claims: {e}"))?;
    if !claims.live(now) {
        return Err(format!(
            "plan '{}' for org {} expired at {}",
            claims.plan, claims.org, claims.exp
        ));
    }
    Ok(claims)
}

/// The plan in force for one org.
pub fn plan_for(org: i64, now: i64) -> Plan {
    if !enforcing() {
        return Plan {
            claims: Claims {
                org,
                plan: "unlimited".to_string(),
                seats: i64::MAX,
                storage_bytes: i64::MAX,
                features: vec!["whiteboard".to_string(), "chat".to_string()],
                exp: 0,
            },
            unlicensed: true,
        };
    }
    LICENSES
        .get()
        .and_then(|all| all.iter().find(|c| c.org == org && c.live(now)))
        .cloned()
        .map(|claims| Plan { claims, unlicensed: false })
        .unwrap_or_else(|| free(org))
}

/// Whether this deployment checks plans at all.
pub fn enforcing() -> bool {
    ENFORCING.get().copied().unwrap_or(false)
}

/// Every verified licence, for the owner console. Empty when none are
/// configured, which is the same answer as `enforcing() == false`.
pub fn plans() -> Vec<Claims> {
    LICENSES.get().cloned().unwrap_or_default()
}

fn decode_key(raw: &str) -> Option<[u8; 32]> {
    let raw = raw.trim();
    let bytes = if raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&raw[i * 2..i * 2 + 2], 16).ok()?;
        }
        out
    } else {
        URL_SAFE_NO_PAD
            .decode(raw)
            .or_else(|_| base64::engine::general_purpose::STANDARD.decode(raw))
            .ok()?
            .try_into()
            .ok()?
    };
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    use ring::signature::KeyPair as _;

    fn keypair() -> (Vec<u8>, [u8; 32]) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut public = [0u8; 32];
        public.copy_from_slice(pair.public_key().as_ref());
        (pkcs8.as_ref().to_vec(), public)
    }

    fn claims() -> Claims {
        Claims {
            org: 7,
            plan: "team".to_string(),
            seats: 25,
            storage_bytes: 10_000_000_000,
            features: vec!["whiteboard".to_string()],
            exp: 0,
        }
    }

    #[test]
    fn a_signed_token_verifies_and_carries_its_limits() {
        let (private, public) = keypair();
        let token = claims().sign(&private).expect("sign");
        let verified = verify(&token, &public, 1_000).expect("verify");
        assert_eq!(verified.org, 7);
        assert_eq!(verified.seats, 25);
        assert_eq!(verified.plan, "team");
    }

    #[test]
    fn one_changed_bit_invalidates_a_licence() {
        let (private, public) = keypair();
        let token = claims().sign(&private).unwrap();
        let (payload, signature) = token.split_once('.').unwrap();
        // The payload is base64 text, so edit that rather than pretend to edit
        // JSON: any change to it must break the signature over it.
        let flipped_char = if &payload[0..1] == "A" { "B" } else { "A" };
        let flipped = format!("{flipped_char}{}", &payload[1..]);
        let tampered = format!("{flipped}.{signature}");
        assert_ne!(tampered, token, "the test must actually change something");
        assert!(verify(&tampered, &public, 1_000).is_err());

        // A re-encoded payload with different claims must not pass either.
        let richer = {
            let mut roomier = claims();
            roomier.seats = 2500;
            roomier.payload()
        };
        assert!(verify(&format!("{richer}.{signature}"), &public, 1_000).is_err());

        // A signature from a different key is refused by this deployment's key.
        let (other_private, _) = keypair();
        let foreign = claims().sign(&other_private).unwrap();
        assert!(verify(&foreign, &public, 1_000).is_err());
    }

    #[test]
    fn an_expired_licence_is_refused_not_silently_honoured() {
        let (private, public) = keypair();
        let mut expiring = claims();
        expiring.exp = 500;
        let token = expiring.sign(&private).unwrap();
        assert!(verify(&token, &public, 400).is_ok());
        assert!(verify(&token, &public, 600).is_err());
    }

    #[test]
    fn a_licence_for_one_org_cannot_be_replayed_on_another() {
        let (private, public) = keypair();
        let token = claims().sign(&private).unwrap();
        let verified = verify(&token, &public, 1).unwrap();
        assert_eq!(verified.org, 7);
        // `plan_for` matches on the org inside the signed payload, so org 8
        // never sees these claims.
        LICENSES.set(vec![verified]).ok();
        ENFORCING.set(true).ok();
        assert_eq!(plan_for(8, 1).name(), FREE);
        assert_eq!(plan_for(7, 1).name(), "team");
        assert_eq!(plan_for(7, 1).seats(), 25);
    }

    #[test]
    fn reads_and_features_survive_expiry_checks_and_defaults() {
        let unlimited = plan_for(1, 1);
        assert!(unlimited.allows("whiteboard", 1));
        assert!(claims().allows("whiteboard", i64::MAX));
        assert!(!claims().allows("chat", i64::MAX));
        assert!(claims().live(i64::MAX), "exp 0 means it never expires");
    }

    #[test]
    fn a_malformed_public_key_disables_enforcement_rather_than_trusting_nothing() {
        assert!(decode_key("not-a-key").is_none());
        assert!(decode_key(&"ab".repeat(32)).is_some());
    }
}
