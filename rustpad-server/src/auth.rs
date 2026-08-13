//! Authentication: password hashing, server-side sessions, first-run owner.
//!
//! On first boot the server creates a default owner account (see
//! [`ensure_default_owner`]); after that, accounts are managed from the owner
//! console. There is no public signup. Every data route is gated behind a valid
//! session cookie.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use log::warn;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use totp_rs::{Algorithm, Secret, TOTP};
use warp::{http::StatusCode, reject::Reject, reply::Reply, Filter, Rejection};

use crate::database::{Database, User};

/// Name of the HttpOnly session cookie.
const SESSION_COOKIE: &str = "authpad_session";
/// Session lifetime in seconds (7 days).
const SESSION_MAX_AGE: i64 = 7 * 24 * 3600;
/// The owner is the master key — its sessions live 12h, not 7 days, to shrink
/// the window a stolen cookie is useful.
const ROOT_SESSION_MAX_AGE: i64 = 12 * 3600;
/// Issuer shown in the authenticator app.
const TOTP_ISSUER: &str = "Cortex";

/// Rejection used when a request lacks a valid session.
#[derive(Debug)]
pub struct Unauthorized;
impl Reject for Unauthorized {}

/// Rejection used when an authenticated user lacks permission for an action.
#[derive(Debug)]
pub struct Forbidden;
impl Reject for Forbidden {}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time before epoch")
        .as_secs() as i64
}

/// Hash a plaintext password with bcrypt.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    Ok(bcrypt::hash(password, bcrypt::DEFAULT_COST)?)
}

/// Constant-ish password check. Returns false on any error (bad hash, etc.).
pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

// ----- TOTP (authenticator-app two-factor) -----

fn build_totp(secret_b32: &str, email: &str) -> anyhow::Result<TOTP> {
    let bytes = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|e| anyhow::anyhow!("bad totp secret: {e:?}"))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1, // ±1 step (30s) of drift tolerance
        30,
        bytes,
        Some(TOTP_ISSUER.to_string()),
        email.to_string(),
    )
    .map_err(|e| anyhow::anyhow!("totp init: {e:?}"))
}

/// Generate a fresh secret; return (base32 secret, otpauth:// URL) for enrollment.
pub fn provision_totp(email: &str) -> anyhow::Result<(String, String)> {
    let mut raw = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut raw);
    let secret_b32 = Secret::Raw(raw.to_vec()).to_encoded().to_string();
    let url = build_totp(&secret_b32, email)?.get_url();
    Ok((secret_b32, url))
}

/// Verify a 6-digit code against the stored secret (±1 step for clock drift).
// ponytail: no replay/last-step tracking — a code stays valid for its ~90s
// window. Add a totp_last_step column if that window matters.
pub fn verify_totp(secret_b32: &str, email: &str, code: &str) -> bool {
    build_totp(secret_b32, email)
        .ok()
        .and_then(|t| t.check_current(code.trim()).ok())
        .unwrap_or(false)
}

/// Break-glass: if OWNER_2FA_RESET is set on the host, clear 2FA on all owner
/// accounts at boot so a lost authenticator can't permanently lock out the owner.
pub async fn maybe_break_glass_owner_2fa(db: &Database) {
    if std::env::var("OWNER_2FA_RESET").is_ok() {
        match db.clear_totp_for_roots().await {
            Ok(n) => warn!("OWNER_2FA_RESET set: cleared 2FA on {n} owner account(s)"),
            Err(e) => warn!("OWNER_2FA_RESET: could not clear owner 2FA: {e}"),
        }
    }
}

/// In-memory login brute-force throttle: after `LOGIN_MAX_FAILS` failed attempts
/// from one client key (IP) inside `LOGIN_WINDOW_SECS`, further attempts are
/// rejected with 429 until the window rolls over. A successful login clears the
/// key. ponytail: process-local fixed-window counter — right for a single-instance
/// deploy; swap in a shared store only if this ever runs multi-instance.
const LOGIN_MAX_FAILS: u32 = 15;
const LOGIN_WINDOW_SECS: i64 = 10 * 60;
type Throttle = Arc<Mutex<HashMap<String, (i64, u32)>>>; // key -> (window_start, fails)

fn throttle_blocked(t: &Throttle, key: &str, now: i64) -> bool {
    let m = t.lock().unwrap();
    match m.get(key) {
        Some((start, fails)) => now - start < LOGIN_WINDOW_SECS && *fails >= LOGIN_MAX_FAILS,
        None => false,
    }
}

fn throttle_record_fail(t: &Throttle, key: &str, now: i64) {
    let mut m = t.lock().unwrap();
    if m.len() > 10_000 {
        m.clear(); // crude memory bound against IP-spray; resets all windows
    }
    let e = m.entry(key.to_string()).or_insert((now, 0));
    if now - e.0 >= LOGIN_WINDOW_SECS {
        *e = (now, 0); // window expired → start fresh
    }
    e.1 += 1;
}

fn throttle_reset(t: &Throttle, key: &str) {
    t.lock().unwrap().remove(key);
}

/// Best-effort client IP: first `X-Forwarded-For` hop (set by Caddy) else the
/// socket peer. Used only as a throttle key, not for authorization — note XFF is
/// client-supplied, so configure Caddy's trusted-proxy handling for a hardened
/// value; this remains useful defense-in-depth regardless.
fn client_ip_filter() -> impl Filter<Extract = (String,), Error = Rejection> + Clone {
    warp::header::optional::<String>("x-forwarded-for")
        .and(warp::addr::remote())
        .map(|xff: Option<String>, addr: Option<SocketAddr>| {
            xff.and_then(|h| h.split(',').next().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .or_else(|| addr.map(|a| a.ip().to_string()))
                .unwrap_or_else(|| "unknown".to_string())
        })
}

/// Generate a 256-bit random session token, hex-encoded.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// First-run bootstrap: if the database has no users, create the default owner
/// so a fresh self-hosted deploy is usable immediately. Username/password
/// default to `admin`/`admin` and can be overridden with the `ADMIN_USERNAME`
/// and `ADMIN_PASSWORD` env vars. Once any user exists this is a no-op, so it
/// never clobbers a changed password on restart.
// ponytail: one default owner, no seed files. The owner creates everyone else
// from the console; the loud warning below says to change the password on first
// login. Upgrade path: force a password change on first login if that matters.
pub async fn ensure_default_owner(db: &Database) {
    match db.count_users().await {
        Ok(0) => {}
        Ok(_) => return, // users already exist — never re-create
        Err(e) => {
            warn!("could not count users; skipping owner bootstrap: {e}");
            return;
        }
    }
    let username = std::env::var("ADMIN_USERNAME")
        .unwrap_or_else(|_| "admin".to_string())
        .trim()
        .to_lowercase();
    let username = if username.is_empty() {
        "admin".to_string()
    } else {
        username
    };
    let password = std::env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "admin".to_string());
    let hash = match hash_password(&password) {
        Ok(h) => h,
        Err(e) => {
            warn!("could not hash default owner password: {e}");
            return;
        }
    };
    match db
        .create_user_if_absent(&username, "Owner", &hash, "root", None)
        .await
    {
        Ok(_) => warn!(
            "first run: created default owner '{username}'. Sign in and CHANGE \
             THE PASSWORD immediately (Settings → Security)."
        ),
        Err(e) => warn!("could not create default owner: {e}"),
    }
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
    /// 6-digit TOTP code, present only on the second step of a 2FA login.
    #[serde(default)]
    code: Option<String>,
}

/// A warp filter that requires a valid session and extracts the [`User`].
///
/// Rejects with [`Unauthorized`] when the cookie is missing, unknown, or expired.
pub fn with_auth(db: Database) -> impl Filter<Extract = (User,), Error = Rejection> + Clone {
    warp::cookie::optional(SESSION_COOKIE)
        .and(warp::any().map(move || db.clone()))
        .and_then(|token: Option<String>, db: Database| async move {
            let token = token.ok_or_else(|| warp::reject::custom(Unauthorized))?;
            match db.get_session_user(&token, now_secs()).await {
                Ok(Some(user)) => Ok(user),
                _ => Err(warp::reject::custom(Unauthorized)),
            }
        })
}

/// Public auth routes: `POST /api/login`, `POST /api/logout`, `GET /api/me`.
pub fn routes(db: Database) -> impl Filter<Extract = (impl Reply,), Error = Rejection> + Clone {
    let auth_db = db.clone();
    let db_filter = warp::any().map(move || db.clone());

    let throttle: Throttle = Arc::new(Mutex::new(HashMap::new()));
    let throttle_filter = warp::any().map(move || throttle.clone());

    let login = warp::path!("login")
        .and(warp::post())
        .and(warp::body::json())
        .and(db_filter.clone())
        .and(throttle_filter)
        .and(client_ip_filter())
        .and_then(login_handler);

    let logout = warp::path!("logout")
        .and(warp::post())
        .and(warp::cookie::optional(SESSION_COOKIE))
        .and(db_filter.clone())
        .and_then(logout_handler);

    let me = warp::path!("me")
        .and(warp::get())
        .and(with_auth(auth_db))
        .and_then(me_handler);

    // Public: the server's ECDH public key for app-layer payload encryption.
    let crypto_pubkey = warp::path!("crypto" / "pubkey")
        .and(warp::get())
        .and_then(crypto_pubkey_handler);

    login.or(logout).or(me).or(crypto_pubkey)
}

async fn crypto_pubkey_handler() -> Result<impl Reply, Rejection> {
    Ok(warp::reply::json(
        &json!({ "pubkey": crate::crypto::keys().public_b64() }),
    ))
}

async fn login_handler(
    body: LoginReq,
    db: Database,
    throttle: Throttle,
    ip: String,
) -> Result<impl Reply, Rejection> {
    let now = now_secs();
    // Brute-force guard: too many recent failures from this IP → 429 before we
    // even hash, so a spray can't burn CPU or grind through passwords.
    if throttle_blocked(&throttle, &ip, now) {
        let reply = warp::reply::json(&json!({ "error": "too many attempts; try again later" }));
        return Ok(warp::reply::with_status(reply, StatusCode::TOO_MANY_REQUESTS).into_response());
    }

    // Email is case-insensitive and trimmed (stored lowercase).
    let email = body.email.trim().to_lowercase();
    let user = db.get_user_by_email(&email).await.ok().flatten();
    let authed = match &user {
        Some(u) => verify_password(&body.password, &u.password_hash),
        // Spend a real bcrypt on unknown emails so timing doesn't leak which
        // emails exist.
        None => {
            let _ = hash_password(&body.password);
            false
        }
    };
    if !authed {
        throttle_record_fail(&throttle, &ip, now);
        let reply = warp::reply::json(&json!({ "error": "invalid credentials" }));
        return Ok(warp::reply::with_status(reply, StatusCode::UNAUTHORIZED).into_response());
    }
    let user = user.expect("authed implies user present");

    // Second factor. Password was correct; now require the authenticator code
    // if this account has 2FA on.
    if user.totp_enabled {
        match body.code.as_deref().map(str::trim) {
            Some(code) if !code.is_empty() => {
                let ok = user
                    .totp_secret
                    .as_deref()
                    .map(|s| verify_totp(s, &user.email, code))
                    .unwrap_or(false);
                if !ok {
                    throttle_record_fail(&throttle, &ip, now);
                    let reply = warp::reply::json(&json!({ "error": "invalid code" }));
                    return Ok(
                        warp::reply::with_status(reply, StatusCode::UNAUTHORIZED).into_response()
                    );
                }
            }
            // Correct password, but we still need the code — no session issued yet.
            _ => {
                let reply = warp::reply::json(&json!({ "mfa_required": true }));
                return Ok(warp::reply::with_status(reply, StatusCode::OK).into_response());
            }
        }
    }

    let _ = db.purge_expired_sessions(now_secs()).await; // housekeeping
    let max_age = if user.role == "root" {
        ROOT_SESSION_MAX_AGE
    } else {
        SESSION_MAX_AGE
    };
    let token = random_token();
    if db
        .create_session(&token, user.id, now_secs() + max_age)
        .await
        .is_err()
    {
        let reply = warp::reply::json(&json!({ "error": "server error" }));
        return Ok(
            warp::reply::with_status(reply, StatusCode::INTERNAL_SERVER_ERROR).into_response(),
        );
    }
    throttle_reset(&throttle, &ip); // clean login clears the IP's failure count
    let _ = db
        .audit(user.org_id, Some(user.id), "login", None, now_secs())
        .await;
    // Set COOKIE_SECURE=1 when serving over HTTPS (i.e. any real deployment).
    let secure = if std::env::var("COOKIE_SECURE").is_ok() {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}"
    );
    let reply =
        warp::reply::json(&json!({ "email": user.email, "name": user.name, "role": user.role }));
    Ok(warp::reply::with_header(reply, "set-cookie", cookie).into_response())
}

async fn logout_handler(token: Option<String>, db: Database) -> Result<impl Reply, Rejection> {
    if let Some(t) = token {
        let _ = db.delete_session(&t).await;
    }
    let cleared = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    let reply = warp::reply::json(&json!({ "ok": true }));
    Ok(warp::reply::with_header(reply, "set-cookie", cleared).into_response())
}

async fn me_handler(user: User) -> Result<impl Reply, Rejection> {
    Ok(warp::reply::json(&json!({
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "mfa": user.totp_enabled,
    })))
}

/// Convert [`Unauthorized`]/[`Forbidden`] rejections into JSON error responses.
pub async fn handle_rejection(err: Rejection) -> Result<impl Reply, Rejection> {
    if err.find::<Unauthorized>().is_some() {
        let reply = warp::reply::json(&json!({ "error": "unauthorized" }));
        return Ok(warp::reply::with_status(reply, StatusCode::UNAUTHORIZED));
    }
    if err.find::<Forbidden>().is_some() {
        let reply = warp::reply::json(&json!({ "error": "forbidden" }));
        return Ok(warp::reply::with_status(reply, StatusCode::FORBIDDEN));
    }
    Err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
        // A malformed hash must never verify as true.
        assert!(!verify_password("anything", "not-a-real-hash"));
    }

    #[test]
    fn tokens_are_unique_and_long() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
