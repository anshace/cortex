//! Profile self-service (name, password) and the hidden root owner console
//! (orgs + users). Root accounts are never exposed to normal users.

use std::convert::Infallible;

use serde::Deserialize;
use serde_json::json;
use warp::{http::StatusCode, reply::Reply, Filter, Rejection};

use crate::auth::{
    hash_password, provision_totp, verify_password, verify_totp, with_auth, Forbidden,
};
use crate::database::{Database, User};
use crate::{evict_documents, evict_org_boards, flush_and_evict, LiveBoards, LiveDocs};

fn with_db(db: Database) -> impl Filter<Extract = (Database,), Error = Infallible> + Clone {
    warp::any().map(move || db.clone())
}

fn with_docs(live: LiveDocs) -> impl Filter<Extract = (LiveDocs,), Error = Infallible> + Clone {
    warp::any().map(move || live.clone())
}
fn with_boards(boards: LiveBoards) -> impl Filter<Extract = (LiveBoards,), Error = Infallible> + Clone {
    warp::any().map(move || boards.clone())
}

fn err(status: StatusCode, msg: &str) -> warp::reply::Response {
    warp::reply::with_status(warp::reply::json(&json!({ "error": msg })), status).into_response()
}

fn require_root(user: &User) -> Result<(), Rejection> {
    if user.role == "root" {
        Ok(())
    } else {
        Err(warp::reject::custom(Forbidden))
    }
}

/// None = owner may manage all orgs; Some = org-admin restricted to that org.
fn manager_scope(user: &User) -> Result<Option<i64>, Rejection> {
    match user.role.as_str() {
        "root" => Ok(None),
        "admin" => user.org_id.map(Some).ok_or_else(|| warp::reject::custom(Forbidden)),
        _ => Err(warp::reject::custom(Forbidden)),
    }
}

/// Refresh a role/org after acquiring the access gate. Request authentication
/// may have run before a concurrent owner/admin changed the actor's scope.
async fn current_actor(db: &Database, user: &User) -> Result<User, Rejection> {
    db.admin_target(user.id).await.ok().flatten()
        .ok_or_else(|| warp::reject::custom(Forbidden))
}

/// Read authorization first for a clear error; scoped DB writes check again
/// inside their transaction so reassignment cannot race this check.
async fn checked_target(db: &Database, actor: &User, target: i64) -> Result<User, Rejection> {
    let scope = manager_scope(actor)?;
    if scope.is_some() && target == actor.id {
        // Profile manages self-service; an admin must not reset their own 2FA.
        return Err(warp::reject::custom(Forbidden));
    }
    let target = db.admin_target(target).await.ok().flatten()
        .ok_or_else(|| warp::reject::custom(Forbidden))?;
    if target.role == "root" || (scope.is_some() && target.org_id != scope) {
        return Err(warp::reject::custom(Forbidden));
    }
    Ok(target)
}

async fn disconnect_org(
    db: &Database, live: &LiveDocs, boards: &LiveBoards, org_id: Option<i64>,
) -> Result<(), warp::reply::Response> {
    if let Some(id) = org_id {
        let ids = db.org_doc_ids(id).await.map_err(|e| {
            log::warn!("could not list org docs before access change: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits")
        })?;
        flush_and_evict(live, db, &ids).await.map_err(|e| {
            log::warn!("could not flush org docs before access change: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "could not save live edits")
        })?;
        evict_org_boards(boards, db, id).await.map_err(|e| {
            log::warn!("could not close org boards before access change: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "could not disconnect board editors")
        })?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct NameReq {
    name: String,
}

#[derive(Deserialize)]
struct PasswordReq {
    current: String,
    new: String,
}

#[derive(Deserialize)]
struct NewUserReq {
    email: String,
    password: String,
    #[serde(default)]
    name: String,
    #[serde(default = "default_role")]
    role: String,
    #[serde(default)]
    org_id: Option<i64>,
}

fn default_role() -> String {
    "user".to_string()
}

#[derive(Deserialize)]
struct AdminUserUpdate {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    role: Option<String>,
    // Some(None) explicitly unassigns a user (owner only).
    #[serde(default)]
    org_id: Option<Option<i64>>,
}

#[derive(Deserialize)]
struct AdminPasswordReq {
    password: String,
}

#[derive(Deserialize)]
struct CodeReq {
    code: String,
}

#[derive(Deserialize)]
struct DisableReq {
    password: String,
}

#[derive(Deserialize)]
struct CreateOrg {
    name: String,
    slug: String,
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

pub(crate) fn routes(db: Database, live: LiveDocs, boards: LiveBoards) -> impl Filter<Extract = (impl Reply,), Error = Rejection> + Clone {
    let update_name = warp::path!("profile")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(update_name);

    let change_username = warp::path!("profile" / "username")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(update_username);

    let change_pw = warp::path!("profile" / "password")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(change_password);

    let tfa_setup = warp::path!("2fa" / "setup")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(setup_2fa);

    let tfa_enable = warp::path!("2fa" / "enable")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(enable_2fa);

    let tfa_disable = warp::path!("2fa" / "disable")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(disable_2fa);

    let admin_reset_tfa = warp::path!("admin" / "users" / i64 / "2fa" / "reset")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(admin_reset_2fa);

    let admin_list = warp::path!("admin" / "users")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(admin_list);

    let admin_create = warp::path!("admin" / "users")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(admin_create);

    let admin_reset_pw = warp::path!("admin" / "users" / i64 / "password")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and(warp::body::json())
        .and_then(admin_reset_password);

    let admin_update = warp::path!("admin" / "users" / i64)
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and(warp::body::json())
        .and_then(admin_update_user);

    let admin_delete = warp::path!("admin" / "users" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(admin_delete);

    let org_list = warp::path!("admin" / "orgs")
        .and(warp::get())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and_then(org_list);

    let org_create = warp::path!("admin" / "orgs")
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(org_create);

    let org_rename = warp::path!("admin" / "orgs" / i64)
        .and(warp::put())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(org_rename);

    let org_delete = warp::path!("admin" / "orgs" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db))
        .and(with_docs(live.clone()))
        .and(with_boards(boards.clone()))
        .and_then(org_delete);

    update_name
        .or(change_username)
        .or(change_pw)
        .or(tfa_setup)
        .or(tfa_enable)
        .or(tfa_disable)
        .or(admin_reset_tfa)
        .or(admin_list)
        .or(admin_create)
        .or(admin_reset_pw)
        .or(admin_update)
        .or(admin_delete)
        .or(org_list)
        .or(org_create)
        .or(org_rename)
        .or(org_delete)
}

async fn update_name(user: User, db: Database, body: NameReq) -> Result<impl Reply, Rejection> {
    let name = body.name.trim();
    if name.len() > 80 {
        return Ok(err(StatusCode::BAD_REQUEST, "name too long"));
    }
    if db.update_name(user.id, name).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not update"));
    }
    Ok(warp::reply::json(&json!({ "ok": true, "name": name })).into_response())
}

#[derive(serde::Deserialize)]
struct UsernameReq {
    username: String,
}

/// Change the caller's own login username (the `email` column). Enforced-unique.
async fn update_username(
    user: User,
    db: Database,
    body: UsernameReq,
) -> Result<impl Reply, Rejection> {
    let uname = body.username.trim().to_lowercase();
    if uname.is_empty() || uname.len() > 120 {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "username must be 1–120 characters",
        ));
    }
    if uname.chars().any(char::is_whitespace) {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "username can't contain spaces",
        ));
    }
    match db.update_email(user.id, &uname).await {
        Ok(true) => {
            let _ = db
                .audit(
                    user.org_id,
                    Some(user.id),
                    "change_username",
                    Some(&uname),
                    now_secs(),
                )
                .await;
            Ok(warp::reply::json(&json!({ "ok": true, "username": uname })).into_response())
        }
        Ok(false) => Ok(err(StatusCode::CONFLICT, "that username is already taken")),
        Err(_) => Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not update")),
    }
}

async fn change_password(
    user: User,
    db: Database,
    body: PasswordReq,
) -> Result<impl Reply, Rejection> {
    if !verify_password(&body.current, &user.password_hash) {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "current password is incorrect",
        ));
    }
    if body.new.len() < 8 {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "new password must be at least 8 characters",
        ));
    }
    let hash = match hash_password(&body.new) {
        Ok(h) => h,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not hash")),
    };
    if db.update_password(user.id, &hash).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not update"));
    }
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

// ----- two-factor (TOTP) self-service -----

async fn setup_2fa(user: User, db: Database) -> Result<impl Reply, Rejection> {
    let (secret, url) = match provision_totp(&user.email) {
        Ok(v) => v,
        Err(_) => {
            return Ok(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not start setup",
            ))
        }
    };
    if db.set_totp_pending(user.id, &secret).await.is_err() {
        return Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not start setup",
        ));
    }
    Ok(warp::reply::json(&json!({ "secret": secret, "otpauth_url": url })).into_response())
}

async fn enable_2fa(user: User, db: Database, body: CodeReq) -> Result<impl Reply, Rejection> {
    let secret = match &user.totp_secret {
        Some(_) if user.totp_enabled => {
            return Ok(err(StatusCode::BAD_REQUEST, "two-factor is already on"))
        }
        Some(s) => s,
        None => return Ok(err(StatusCode::BAD_REQUEST, "start setup first")),
    };
    if !verify_totp(secret, &user.email, body.code.trim()) {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "that code isn't right — enter the current one",
        ));
    }
    if db.enable_totp(user.id).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not enable"));
    }
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn disable_2fa(user: User, db: Database, body: DisableReq) -> Result<impl Reply, Rejection> {
    // Require the password so a walk-up session can't silently strip 2FA.
    if !verify_password(&body.password, &user.password_hash) {
        return Ok(err(StatusCode::BAD_REQUEST, "password is incorrect"));
    }
    if db.clear_totp(user.id).await.is_err() {
        return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not disable"));
    }
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

/// Owner/org-admin recovery: clear another member's 2FA after a lost device.
/// All existing sessions are revoked; org admins cannot target other orgs,
/// owner accounts, or themselves.
async fn admin_reset_2fa(
    target: i64, user: User, db: Database, live: LiveDocs, boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    let _gate = crate::access_gate().write().await;
    let user = current_actor(&db, &user).await?;
    let other = checked_target(&db, &user, target).await?;
    let scope = manager_scope(&user)?;
    if let Err(response) = disconnect_org(&db, &live, &boards, other.org_id).await { return Ok(response); }
    match db.admin_reset_credentials(target, None, scope).await {
        Ok(true) => {
            let _ = db.audit(other.org_id, Some(user.id), "admin_reset_2fa", Some(&other.email), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Ok(false) => Ok(err(StatusCode::FORBIDDEN, "account no longer in your org")),
        Err(e) => { log::warn!("admin_reset_2fa: {e}"); Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not reset two-factor")) },
    }
}

async fn admin_list(user: User, db: Database) -> Result<impl Reply, Rejection> {
    let _gate = crate::access_gate().read().await;
    let user = current_actor(&db, &user).await?;
    let scope = manager_scope(&user)?;
    let result = match scope {
        Some(org_id) => db.admin_list_users_in_org(org_id).await,
        None => db.admin_list_users().await,
    };
    match result {
        Ok(users) => Ok(warp::reply::json(&json!({ "users": users })).into_response()),
        Err(e) => { log::warn!("admin_list_users: {e}"); Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not list users")) },
    }
}

async fn admin_create(user: User, db: Database, body: NewUserReq) -> Result<impl Reply, Rejection> {
    manager_scope(&user)?; // reject non-admins before hashing
    let email = body.email.trim().to_lowercase();
    let role = match body.role.as_str() {
        "user" | "admin" => body.role.as_str(),
        _ => return Ok(err(StatusCode::BAD_REQUEST, "invalid role")),
    };
    let name = body.name.trim();
    if email.is_empty() || email.len() > 120 || email.chars().any(char::is_whitespace)
        || name.len() > 80 || body.password.len() < 8
    {
        return Ok(err(StatusCode::BAD_REQUEST, "username (max 120, no spaces), name (max 80) and password (min 8) are required"));
    }
    let hash = match hash_password(&body.password) {
        Ok(h) => h,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not hash")),
    };
    let _gate = crate::access_gate().write().await;
    let user = current_actor(&db, &user).await?;
    let scope = manager_scope(&user)?;
    if scope.is_some_and(|id| body.org_id.is_some_and(|requested| requested != id)) {
        return Ok(err(StatusCode::FORBIDDEN, "cannot create users in another org"));
    }
    let org_id = scope.or(body.org_id);
    match db.create_user_if_absent(&email, name, &hash, role, org_id).await {
        Ok(true) => {
            let _ = db.audit(org_id, Some(user.id), "admin_create_user", Some(&email), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Ok(false) => Ok(err(StatusCode::CONFLICT, "a user with that username already exists")),
        Err(e) => { log::warn!("admin_create_user: {e}"); Ok(err(StatusCode::CONFLICT, "could not create user; check the org")) },
    }
}

async fn admin_reset_password(
    target: i64, user: User, db: Database, live: LiveDocs, boards: LiveBoards, body: AdminPasswordReq,
) -> Result<impl Reply, Rejection> {
    checked_target(&db, &user, target).await?; // reject before password hashing
    if body.password.len() < 8 {
        return Ok(err(StatusCode::BAD_REQUEST, "password must be at least 8 characters"));
    }
    let hash = match hash_password(&body.password) {
        Ok(h) => h,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not hash")),
    };
    let _gate = crate::access_gate().write().await;
    let user = current_actor(&db, &user).await?;
    let other = checked_target(&db, &user, target).await?;
    let scope = manager_scope(&user)?;
    if let Err(response) = disconnect_org(&db, &live, &boards, other.org_id).await { return Ok(response); }
    match db.admin_reset_credentials(target, Some(&hash), scope).await {
        Ok(true) => {
            let _ = db.audit(other.org_id, Some(user.id), "admin_reset_password", Some(&other.email), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Ok(false) => Ok(err(StatusCode::FORBIDDEN, "account no longer in your org")),
        Err(e) => { log::warn!("admin_reset_password: {e}"); Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not reset password")) },
    }
}

async fn admin_update_user(
    target: i64, user: User, db: Database, live: LiveDocs, boards: LiveBoards, body: AdminUserUpdate,
) -> Result<impl Reply, Rejection> {
    checked_target(&db, &user, target).await?;
    let scope = manager_scope(&user)?;
    if scope.is_some() && body.org_id.is_some() {
        return Ok(err(StatusCode::FORBIDDEN, "only the owner can assign orgs"));
    }
    if body.role.as_deref().is_some_and(|role| role != "admin" && role != "user") {
        return Ok(err(StatusCode::BAD_REQUEST, "invalid role"));
    }
    let name = body.name.as_deref().map(str::trim);
    let email = body.email.as_deref().map(str::trim).map(str::to_lowercase);
    if name.is_some_and(|n| n.len() > 80) {
        return Ok(err(StatusCode::BAD_REQUEST, "name too long"));
    }
    if email.as_deref().is_some_and(|value| value.is_empty() || value.len() > 120 || value.chars().any(char::is_whitespace)) {
        return Ok(err(StatusCode::BAD_REQUEST, "username must be 1–120 characters with no spaces"));
    }
    let _gate = crate::access_gate().write().await;
    let user = current_actor(&db, &user).await?;
    let other = checked_target(&db, &user, target).await?;
    let scope = manager_scope(&user)?;
    if scope.is_some() && body.org_id.is_some() {
        return Ok(err(StatusCode::FORBIDDEN, "only the owner can assign orgs"));
    }
    if body.role.is_some() || body.org_id.is_some() || email.is_some() {
        if let Err(response) = disconnect_org(&db, &live, &boards, other.org_id).await { return Ok(response); }
    }
    match db.admin_update_user(target, email.as_deref(), name, body.role.as_deref(), body.org_id, scope).await {
        Ok(true) => {
            let _ = db.audit(other.org_id, Some(user.id), "admin_update_user", Some(&other.email), now_secs()).await;
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Ok(false) => Ok(err(StatusCode::FORBIDDEN, "account no longer in your org")),
        Err(e) => { log::warn!("admin_update_user: {e}"); Ok(err(StatusCode::CONFLICT, "could not update account")) },
    }
}

async fn admin_delete(
    target: i64, user: User, db: Database, live: LiveDocs, boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    let _gate = crate::access_gate().write().await;
    let user = current_actor(&db, &user).await?;
    let other = checked_target(&db, &user, target).await?;
    let scope = manager_scope(&user)?;
    if let Err(response) = disconnect_org(&db, &live, &boards, other.org_id).await { return Ok(response); }
    let ids = match db.admin_delete_user(target, scope).await {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("admin_delete_user {target}: {e}");
            return Ok(err(StatusCode::CONFLICT, "could not delete account"));
        }
    };
    evict_documents(&live, &ids);
    let _ = db.audit(other.org_id, Some(user.id), "admin_delete_user", Some(&other.email), now_secs()).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time before epoch")
        .as_secs() as i64
}

async fn org_list(user: User, db: Database) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let orgs = db.list_orgs().await.unwrap_or_default();
    Ok(warp::reply::json(&json!({ "orgs": orgs })))
}

async fn org_create(user: User, db: Database, body: CreateOrg) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let name = body.name.trim();
    let slug = body.slug.trim().to_lowercase();
    if name.is_empty() || slug.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name and slug are required"));
    }
    match db.create_org(name, &slug, now_secs()).await {
        Ok(org) => Ok(warp::reply::json(&json!({ "org": org })).into_response()),
        Err(_) => Ok(err(StatusCode::CONFLICT, "that slug is already taken")),
    }
}

async fn org_rename(
    target: i64,
    user: User,
    db: Database,
    body: RenameReq,
) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    let _ = db.rename_org(target, name).await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn org_delete(
    target: i64,
    user: User,
    db: Database,
    live: LiveDocs,
    boards: LiveBoards,
) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let _gate = crate::access_gate().write().await;
    if let Err(response) = disconnect_org(&db, &live, &boards, Some(target)).await { return Ok(response); }
    match db.delete_org(target).await {
        Ok(ids) => {
            evict_documents(&live, &ids);
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Err(e) => {
            log::warn!("delete_org {target}: {e}");
            Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not delete org"))
        }
    }
}

#[cfg(test)]
mod account_routes_tests {
    use super::*;
    use warp::http::StatusCode;

    #[tokio::test]
    async fn admin_create_rejects_an_actor_demoted_after_authentication() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Database::new(&format!("sqlite://{}", tmp.path().display())).await.unwrap();
        db.create_user_if_absent("owner", "Owner", "hash", "root", None).await.unwrap();
        let org = db.create_org("Org", "org", 1).await.unwrap();
        db.create_user_if_absent("admin", "Admin", "hash", "admin", Some(org.id)).await.unwrap();
        let stale_actor = db.get_user_by_email("admin").await.unwrap().unwrap();
        db.admin_update_user(stale_actor.id, None, None, Some("user"), None, None).await.unwrap();
        let result = admin_create(stale_actor, db.clone(), NewUserReq {
            email: "should-not-exist".into(), password: "password123".into(),
            name: "Unwanted".into(), role: "user".into(), org_id: None,
        }).await;
        assert!(result.err().unwrap().find::<Forbidden>().is_some());
        assert!(db.get_user_by_email("should-not-exist").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn org_admin_endpoints_are_scoped_and_owner_sees_all() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Database::new(&format!("sqlite://{}", tmp.path().display())).await.unwrap();
        db.create_user_if_absent("owner", "Owner", "hash", "root", None).await.unwrap();
        let first = db.create_org("First", "first", 1).await.unwrap();
        let second = db.create_org("Second", "second", 1).await.unwrap();
        db.create_user_if_absent("admin1", "Admin", "hash", "admin", Some(first.id)).await.unwrap();
        db.create_user_if_absent("member1", "Member", "hash", "user", Some(first.id)).await.unwrap();
        db.create_user_if_absent("member2", "Member", "hash", "user", Some(second.id)).await.unwrap();
        for (email, token) in [("owner", "owner-token"), ("admin1", "admin-token"), ("member1", "member-token")] {
            let user = db.get_user_by_email(email).await.unwrap().unwrap();
            db.create_session(token, user.id, now_secs() + 3600).await.unwrap();
        }
        let member2 = db.get_user_by_email("member2").await.unwrap().unwrap();
        let live: LiveDocs = Default::default();
        let boards: LiveBoards = Default::default();
        let api = routes(db.clone(), live, boards).recover(crate::auth::handle_rejection);

        let list = warp::test::request().method("GET").path("/admin/users")
            .header("cookie", "authpad_session=admin-token").reply(&api).await;
        assert_eq!(list.status(), StatusCode::OK);
        let data: serde_json::Value = serde_json::from_slice(list.body()).unwrap();
        assert_eq!(data["users"].as_array().unwrap().len(), 2);
        assert!(!data.to_string().contains("member2"));
        assert!(!data.to_string().contains("owner"));

        let forbidden = warp::test::request().method("GET").path("/admin/users")
            .header("cookie", "authpad_session=member-token").reply(&api).await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let forbidden = warp::test::request().method("GET").path("/admin/orgs")
            .header("cookie", "authpad_session=admin-token").reply(&api).await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let forbidden = warp::test::request().method("POST").path(&format!("/admin/users/{}", member2.id))
            .header("cookie", "authpad_session=admin-token").json(&json!({"role":"admin"})).reply(&api).await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let forbidden = warp::test::request().method("DELETE").path(&format!("/admin/users/{}", member2.id))
            .header("cookie", "authpad_session=admin-token").reply(&api).await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let forbidden = warp::test::request().method("POST").path("/admin/users")
            .header("cookie", "authpad_session=admin-token")
            .json(&json!({"email":"outsider", "name":"Outsider", "password":"password123", "role":"user", "org_id":second.id}))
            .reply(&api).await;
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        assert!(db.get_user_by_email("outsider").await.unwrap().is_none());

        let owner_list = warp::test::request().method("GET").path("/admin/users")
            .header("cookie", "authpad_session=owner-token").reply(&api).await;
        assert_eq!(owner_list.status(), StatusCode::OK);
        let data: serde_json::Value = serde_json::from_slice(owner_list.body()).unwrap();
        assert_eq!(data["users"].as_array().unwrap().len(), 3);
        let created = warp::test::request().method("POST").path("/admin/users")
            .header("cookie", "authpad_session=admin-token")
            .json(&json!({"email":"colleague", "name":"Colleague", "password":"password123", "role":"user"}))
            .reply(&api).await;
        assert_eq!(created.status(), StatusCode::OK);
        assert_eq!(db.get_user_by_email("colleague").await.unwrap().unwrap().org_id, Some(first.id));
    }
}
