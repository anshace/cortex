//! Encryption for secrets this server stores in its own columns.
//!
//! One 32-byte master key protects the database, and every protected column
//! derives its own subkey from it through HKDF, so ciphertext in one column
//! reveals nothing about another. The key comes from `CORTEX_DATA_KEY` (hex or
//! base64) when that is set, and otherwise from a `cortex.key` file beside the
//! database, created on first boot — which is what lets an existing
//! single-container install pick this up without a new setup step.
//!
//! The threat this closes is a leaked *file*: a stray backup, a snapshot, a
//! stolen volume. It does nothing against a host that is rootable and also holds
//! the key file, which is why the environment variable wins whenever it is
//! present, and why the key belongs somewhere the database does not live.

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

/// Column/domain tag for sealed TOTP seeds. Never reuse for another column:
/// the subkey is derived from it.
pub const TOTP: &str = "users.totp_secret";

const HKDF_SALT: &[u8] = b"cortex-column-v1";
const NONCE_LEN: usize = 12;

static MASTER: OnceLock<[u8; 32]> = OnceLock::new();
static SOURCE: OnceLock<String> = OnceLock::new();

/// Where the key came from, for the boot log.
pub fn source() -> &'static str {
    SOURCE.get().map(String::as_str).unwrap_or("unset")
}

/// Load the master key, or create it. Idempotent: once a key is installed this
/// returns immediately, so calling it per database (per-org files later) is fine.
pub fn ensure_for(sqlite_uri: &str) -> Result<&'static str, String> {
    if MASTER.get().is_some() {
        return Ok(source());
    }

    let (key, origin) = match std::env::var("CORTEX_DATA_KEY") {
        Ok(value) => (
            parse_key(&value).ok_or_else(|| {
                "CORTEX_DATA_KEY must hold 32 bytes, hex-encoded or base64".to_string()
            })?,
            "CORTEX_DATA_KEY".to_string(),
        ),
        // An in-memory database cannot outlive the process, so neither needs its key.
        Err(_) if sqlite_uri.contains(":memory:") => (
            random_key(),
            "ephemeral key (in-memory database)".to_string(),
        ),
        Err(_) => {
            let path = sidecar_path(sqlite_uri);
            match read_key_file(&path) {
                Ok(Some(key)) => (key, path.display().to_string()),
                Ok(None) => {
                    let key = write_key_file(&path, &random_key()).map_err(|e| {
                        format!("cannot create the data key at {}: {e}", path.display())
                    })?;
                    (key, path.display().to_string())
                }
                Err(e) => Err(format!("cannot read the data key at {}: {e}", path.display()))?,
            }
        }
    };

    let _ = MASTER.set(key);
    let _ = SOURCE.set(origin);
    Ok(source())
}

/// Encrypt `plaintext` for the given column tag. None when no key is loaded or
/// the primitive fails — callers must treat that as an error, never as "store it
/// unencrypted anyway".
pub fn seal(tag: &str, plaintext: &str) -> Option<String> {
    let cipher = Aes256Gcm::new_from_slice(&subkey(tag)?).ok()?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let body = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&body);
    Some(B64.encode(out))
}

/// Reverse of [`seal`]. None if the tag, key or bytes do not all line up, which
/// includes a sealed row restored into a different install.
pub fn open(tag: &str, sealed: &str) -> Option<String> {
    let raw = B64.decode(sealed.trim()).ok()?;
    if raw.len() <= NONCE_LEN {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(&subkey(tag)?).ok()?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&raw[..NONCE_LEN]), &raw[NONCE_LEN..])
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Tag organization data keys are wrapped under. One tag for all of them is
/// deliberate: the per-organization secrecy comes from the random key inside
/// each row, not from a different derivation per organization — a key derived
/// from the master would survive every restore of the master and silently
/// un-shred everything.
const ORG_DEK_TAG: &str = "org.dek";

/// Marker on stored bytes that are sealed under an organization key. An object
/// without it predates sealing and is returned as written, so upgrading never
/// turns an install's own history into unreadable data.
pub const SEALED_MAGIC: &[u8] = b"CSX1";

/// A fresh organization key, base64, ready to be wrapped for storage.
pub fn new_dek() -> String {
    B64.encode(random_key())
}

/// The stored form of an organization key. `None` when no master key is loaded,
/// which a caller must treat as "this install cannot seal content, and cannot
/// shred it" — never as permission to write it in the clear and hope.
pub fn wrap_dek(dek_b64: &str) -> Option<String> {
    seal(ORG_DEK_TAG, dek_b64)
}

/// The plaintext organization key. `None` covers a shredded row, a key wrapped
/// by another install's master, and corrupt bytes alike.
pub fn unwrap_dek(sealed: &str) -> Option<[u8; 32]> {
    let raw = B64.decode(open(ORG_DEK_TAG, sealed)?.trim()).ok()?;
    raw.try_into().ok()
}

/// Seal content bytes for one organization.
///
/// The nonce is random per call, so storing identical content twice produces two
/// objects. That is the cost of shredding: one object shared by two organizations
/// is content that survives the deletion of either one's key. Sharing still works
/// *by reference* — a file copy reuses the stored name — which is why copying a
/// file remains a metadata-only operation.
pub fn seal_bytes(key: &[u8; 32], plain: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("32 bytes is a valid AES-256 key");
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let body = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .expect("AES-GCM encryption does not fail on input this size");
    let mut out = SEALED_MAGIC.to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    out
}

/// Reverse of [`seal_bytes`]. `None` when the marker is missing, the key is gone,
/// or the tag does not check — all of which mean the same thing to a caller:
/// these bytes cannot be read, and saying so is the whole point.
pub fn open_bytes(key: &[u8; 32], stored: &[u8]) -> Option<Vec<u8>> {
    let rest = stored.strip_prefix(SEALED_MAGIC)?;
    if rest.len() <= NONCE_LEN {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    cipher
        .decrypt(Nonce::from_slice(&rest[..NONCE_LEN]), &rest[NONCE_LEN..])
        .ok()
}

/// True when stored bytes are sealed rather than plain.
pub fn is_sealed(stored: &[u8]) -> bool {
    stored.starts_with(SEALED_MAGIC)
}

/// Per-column subkey, so one column's plaintext recovery is not another's.
fn subkey(tag: &str) -> Option<[u8; 32]> {
    let master = MASTER.get()?;
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), master);
    let mut okm = [0u8; 32];
    hk.expand(tag.as_bytes(), &mut okm).ok()?;
    Some(okm)
}

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

/// Accepts hex or base64 so operators can paste whichever their secret store
/// hands them; both must decode to exactly 32 bytes.
fn parse_key(value: &str) -> Option<[u8; 32]> {
    let value = value.trim();
    let raw = match value.len() {
        64 if value.bytes().all(|b| b.is_ascii_hexdigit()) => hex_bytes(value)?,
        _ => B64.decode(value).ok()?,
    };
    raw.try_into().ok()
}

fn hex_bytes(value: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(value.len() / 2);
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

/// The key sits beside the database file it protects, which is a deliberate
/// concession for single-container installs — documented in `keystore`'s header.
/// Naming it after the database keeps two databases in one directory separate.
fn sidecar_path(sqlite_uri: &str) -> PathBuf {
    // `sqlite:///data/authpad.db` -> /data/authpad.db.key,
    // `sqlite://authpad.db` -> authpad.db.key (relative to the process's cwd).
    let path = sqlite_uri
        .strip_prefix("sqlite://")
        .unwrap_or(sqlite_uri)
        .split('?')
        .next()
        .unwrap_or("authpad.db");
    let mut key = PathBuf::from(path);
    let mut name = key
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.push_str(".key");
    key.set_file_name(name);
    key
}

fn read_key_file(path: &std::path::Path) -> io::Result<Option<[u8; 32]>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse_key(&text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_key_file(path: &std::path::Path, key: &[u8; 32]) -> io::Result<[u8; 32]> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(hex(key).as_bytes())?;
            restrict_to_owner(path)?;
            Ok(*key)
        }
        // Two processes booting against one volume — a restart loop, or the
        // per-org databases this is heading toward — must agree on the key, so
        // the loser adopts the winner's rather than keeping its own.
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            read_key_file(path)?.ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, format!("{} is empty", path.display()))
            })
        }
        Err(e) => Err(e),
    }
}

fn restrict_to_owner(path: &std::path::Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_round_trips_and_is_not_the_plaintext() {
        let key = random_key();
        let _ = MASTER.set(key);
        let seed = "JBSWY3DPEHPK3PXP";
        let sealed = seal(TOTP, seed).expect("seal with a key present");
        assert_ne!(sealed, seed);
        assert!(!sealed.contains("JBSWY3D"));
        assert_eq!(open(TOTP, &sealed).as_deref(), Some(seed));
    }

    #[test]
    fn a_different_column_tag_cannot_read_it() {
        let _ = MASTER.set(random_key());
        let sealed = seal(TOTP, "secret").expect("seal");
        assert_eq!(open("users.other", &sealed), None);
    }

    #[test]
    fn tampering_is_detected() {
        let _ = MASTER.set(random_key());
        let sealed = seal(TOTP, "secret").expect("seal");
        let mut raw = B64.decode(&sealed).expect("base64");
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert_eq!(open(TOTP, &B64.encode(&raw)), None);
    }

    #[test]
    fn hex_and_base64_keys_agree() {
        let key = random_key();
        assert_eq!(parse_key(&hex(&key)), Some(key));
        assert_eq!(parse_key(&B64.encode(key)), Some(key));
        assert_eq!(parse_key("too-short"), None);
    }
}
