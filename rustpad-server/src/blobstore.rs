//! One seam between "bytes the server stores" and "where they are stored".
//!
//! Binary file content and chat images live in SQLite BLOB columns today, which
//! is what makes the database file grow with content rather than with
//! structure: one pasted screenshot outweighs every document in an org, and no
//! quota can be metered while the two are the same number. This module is the
//! place that changes, so the call sites that read and write bytes never have to
//! care whether the answer is a column or an object.
//!
//! Two backends exist now:
//!
//! - [`BlobStore::inline`] keeps bytes in the row. It is the default, and it
//!   stays the default, because an install that upgrades silently into a
//!   directory-backed store would find its documented backup — `.backup` of the
//!   `.db` file — no longer contains its content.
//! - [`BlobStore::fs`] writes objects under a directory. Set `BLOB_BACKEND=fs`
//!   to opt in, and `BLOB_DIR` to choose where; it defaults beside the database.
//!
//! An S3-compatible backend (R2) belongs here too and is deliberately not
//! invented here: it needs a client dependency chosen first, and its
//! consistency and deletion semantics differ enough to deserve their own change.
//!
//! Deletes are lazy on purpose. A missing object is reported, never silently
//! treated as an empty file, because a lost blob that reads as blank is a data
//! loss story that never gets told.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use rand::RngCore;

static STORE: OnceLock<BlobStore> = OnceLock::new();
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
enum Inner {
    /// Bytes live in the `data` column of the row that owns them.
    Inline,
    /// Bytes live in `dir`, named after the key.
    Fs { dir: PathBuf },
}

/// A place to put bytes, and the keys that find them again.
#[derive(Debug, Clone)]
pub struct BlobStore {
    inner: Inner,
}

impl BlobStore {
    /// Store the bytes in their current column. Always succeeds.
    pub fn inline() -> Self {
        Self { inner: Inner::Inline }
    }

    /// Store the bytes as objects under `dir`, creating it if needed. Fails if
    /// the directory cannot be written, so a host with a read-only filesystem is
    /// discovered at boot instead of at the first upload.
    pub fn fs(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        // Prove it is writable rather than trusting the mode bits: a read-only
        // mount reports the directory as existing and readable.
        let probe = dir.join(".cortex-write-probe");
        fs::write(&probe, b"ok")?;
        let _ = fs::remove_file(&probe);
        Ok(Self {
            inner: Inner::Fs { dir },
        })
    }

    /// Resolve the backend from configuration. Falls back to [`BlobStore::inline`]
    /// with a logged reason, so a misconfiguration degrades to today's behaviour
    /// instead of refusing to start.
    pub fn from_env(db_path: &str) -> Self {
        if std::env::var("BLOB_BACKEND").ok().as_deref() != Some("fs") {
            return BlobStore::inline();
        }
        let dir = match std::env::var("BLOB_DIR") {
            Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
            _ => parent_of(db_path).join("blobs"),
        };
        match BlobStore::fs(&dir) {
            Ok(store) => store,
            Err(e) => {
                log::error!(
                    "BLOB_BACKEND=fs but {} is not writable ({e}); storing blobs inline",
                    dir.display()
                );
                BlobStore::inline()
            }
        }
    }

    /// A short name for logs and the owner console.
    pub fn mode(&self) -> &'static str {
        match &self.inner {
            Inner::Inline => "inline",
            Inner::Fs { .. } => "fs",
        }
    }

    /// True when the row's `data` column is still the source of truth.
    pub fn is_inline(&self) -> bool {
        matches!(self.inner, Inner::Inline)
    }

    /// Where objects live, when they do.
    pub fn dir(&self) -> Option<&Path> {
        match &self.inner {
            Inner::Inline => None,
            Inner::Fs { dir } => Some(dir),
        }
    }

    /// Write `bytes` under `key`. Returns false when nothing was stored, which
    /// tells the caller to keep the bytes in the row.
    pub fn put(&self, key: &str, bytes: &[u8]) -> bool {
        let Inner::Fs { dir } = &self.inner else {
            return false;
        };
        let Some(path) = safe_path(dir, key) else {
            log::error!("refused to write a blob with an unsafe key: {key}");
            return false;
        };
        // Write-then-rename: a reader either sees the whole previous object or
        // the whole new one, never a half-written file.
        let tmp = {
            let nonce = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut random = [0u8; 8];
            rand::thread_rng().fill_bytes(&mut random);
            let suffix = u64::from_be_bytes(random) ^ nonce;
            PathBuf::from(format!("{}.{}.tmp", path.display(), suffix))
        };
        if fs::write(&tmp, bytes).is_err() {
            return false;
        }
        match fs::rename(&tmp, &path) {
            Ok(()) => true,
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                log::error!("cannot move blob into place at {}: {e}", path.display());
                false
            }
        }
    }

    /// Read a stored object. `None` means the key was never stored here; an
    /// existing-but-unreadable object is logged, because those two look the same
    /// to the caller and very different to the person whose file is missing.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let Inner::Fs { dir } = &self.inner else {
            return None;
        };
        let path = safe_path(dir, key)?;
        match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => {
                log::error!("cannot read blob at {}: {e}", path.display());
                None
            }
        }
    }

    /// Drop an object. Missing is success; only a real failure is reported.
    pub fn delete(&self, key: &str) -> io::Result<()> {
        let Inner::Fs { dir } = &self.inner else {
            return Ok(());
        };
        let Some(path) = safe_path(dir, key) else {
            return Ok(());
        };
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Install the process-wide store once, at boot. Returns the mode for logging.
pub fn init(db_path: &str) -> &'static str {
    if let Some(existing) = STORE.get() {
        return existing.mode();
    }
    let store = BlobStore::from_env(db_path);
    let mode = store.mode();
    // A failed set means another caller won the race; either way one mode stands.
    let _ = STORE.set(store);
    mode
}

/// The configured store. Until boot has chosen one, bytes stay inline.
pub fn store() -> &'static BlobStore {
    STORE.get_or_init(BlobStore::inline)
}

/// Keys become file names, so anything path-shaped is refused outright rather
/// than sanitised — the callers generate them, so a separator here is a bug.
fn safe_path(dir: &Path, key: &str) -> Option<PathBuf> {
    let ok = !key.is_empty()
        && !key.contains('/')
        && !key.contains('\\')
        && !key.contains("..")
        && !key.starts_with('.')
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if ok {
        Some(dir.join(key))
    } else {
        None
    }
}

fn parent_of(path: &str) -> PathBuf {
    Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let mut random = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut random);
        dir.push(format!("cortex-blobs-{:016x}", u64::from_be_bytes(random)));
        dir
    }

    #[test]
    fn inline_backend_stores_nothing_outside_the_row() {
        let store = BlobStore::inline();
        assert!(store.is_inline());
        assert!(!store.put("f1", b"payload"));
        assert_eq!(store.get("f1"), None);
        assert!(store.delete("f1").is_ok());
    }

    #[test]
    fn fs_backend_round_trips_and_replaces() {
        let dir = temp_dir();
        let store = BlobStore::fs(&dir).expect("writable probe dir");
        assert!(!store.is_inline());
        assert!(store.put("f1", b"first".as_slice()));
        assert_eq!(store.get("f1").as_deref(), Some(b"first".as_slice()));
        assert!(store.put("f1", b"second".as_slice()));
        assert_eq!(store.get("f1").as_deref(), Some(b"second".as_slice()));
        // No temporary files are left behind by a replacement.
        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        store.delete("f1").unwrap();
        assert_eq!(store.get("f1"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_keys_never_escape_the_directory() {
        let dir = temp_dir();
        let store = BlobStore::fs(&dir).unwrap();
        for key in ["../escape", "a/b", "..", ".hidden", ""] {
            assert!(!store.put(key, b"x"), "{key} must be refused");
        }
        assert!(!dir.join("..").join("escape").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_only_directory_degrades_rather_than_failing_boot() {
        // A file cannot serve as the object directory, so the probe write fails.
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("blobs");
        fs::write(&blocker, b"not a directory").unwrap();
        let store = BlobStore::fs(&blocker);
        assert!(store.is_err(), "a non-writable target must be rejected");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_missing_object_is_not_an_error() {
        let dir = temp_dir();
        let store = BlobStore::fs(&dir).unwrap();
        assert!(store.delete("never-existed").is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
