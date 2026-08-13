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

fn with_db(db: Database) -> impl Filter<Extract = (Database,), Error = Infallible> + Clone {
    warp::any().map(move || db.clone())
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
    name: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    org_id: Option<i64>,
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

pub fn routes(db: Database) -> impl Filter<Extract = (impl Reply,), Error = Rejection> + Clone {
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
        .and(warp::body::json())
        .and_then(admin_reset_password);

    let admin_update = warp::path!("admin" / "users" / i64)
        .and(warp::post())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
        .and(warp::body::json())
        .and_then(admin_update_user);

    let admin_delete = warp::path!("admin" / "users" / i64)
        .and(warp::delete())
        .and(with_auth(db.clone()))
        .and(with_db(db.clone()))
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

/// Owner recovery: clear a user's 2FA if they lose their authenticator.
async fn admin_reset_2fa(target: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    if db.clear_totp(target).await.is_err() {
        return Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not reset two-factor",
        ));
    }
    let d = target.to_string();
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "admin_reset_2fa",
            Some(&d),
            now_secs(),
        )
        .await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn admin_list(user: User, db: Database) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let users = db.admin_list_users().await.unwrap_or_default();
    Ok(warp::reply::json(&json!({ "users": users })))
}

async fn admin_create(user: User, db: Database, body: NewUserReq) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let email = body.email.trim().to_lowercase();
    let email = email.as_str();
    let role = if body.role == "admin" {
        "admin"
    } else {
        "user"
    };
    if email.is_empty() || body.password.len() < 8 {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "email required and password must be at least 8 characters",
        ));
    }
    let hash = match hash_password(&body.password) {
        Ok(h) => h,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not hash")),
    };
    match db
        .create_user_if_absent(email, body.name.trim(), &hash, role, body.org_id)
        .await
    {
        Ok(true) => {
            let _ = db
                .audit(
                    user.org_id,
                    Some(user.id),
                    "admin_create_user",
                    Some(email),
                    now_secs(),
                )
                .await;
            Ok(warp::reply::json(&json!({ "ok": true })).into_response())
        }
        Ok(false) => Ok(err(
            StatusCode::CONFLICT,
            "a user with that email already exists",
        )),
        Err(_) => Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not create user",
        )),
    }
}

async fn admin_reset_password(
    target: i64,
    user: User,
    db: Database,
    body: AdminPasswordReq,
) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    if body.password.len() < 8 {
        return Ok(err(
            StatusCode::BAD_REQUEST,
            "password must be at least 8 characters",
        ));
    }
    let hash = match hash_password(&body.password) {
        Ok(h) => h,
        Err(_) => return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "could not hash")),
    };
    if db.update_password(target, &hash).await.is_err() {
        return Ok(err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not reset password",
        ));
    }
    let d = target.to_string();
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "admin_reset_password",
            Some(&d),
            now_secs(),
        )
        .await;
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn admin_update_user(
    target: i64,
    user: User,
    db: Database,
    body: AdminUserUpdate,
) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    if let Some(name) = body.name {
        let _ = db.update_name(target, name.trim()).await;
    }
    if let Some(role) = body.role {
        if role == "admin" || role == "user" {
            let _ = db.admin_set_role(target, &role).await;
        }
    }
    if let Some(org_id) = body.org_id {
        let _ = db.admin_set_org(target, Some(org_id)).await;
    }
    Ok(warp::reply::json(&json!({ "ok": true })).into_response())
}

async fn admin_delete(target: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let _ = db.admin_delete_user(target).await;
    let d = target.to_string();
    let _ = db
        .audit(
            user.org_id,
            Some(user.id),
            "admin_delete_user",
            Some(&d),
            now_secs(),
        )
        .await;
    Ok(warp::reply::json(&json!({ "ok": true })))
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

async fn org_delete(target: i64, user: User, db: Database) -> Result<impl Reply, Rejection> {
    require_root(&user)?;
    let _ = db.delete_org(target).await;
    Ok(warp::reply::json(&json!({ "ok": true })))
}
