//! Backend SQLite database handlers.
//!
//! Model: **Org → Workspaces → files**, plus one org-wide chat. Every user is
//! assigned to at most one org (by the root owner). Access to a workspace is by
//! org membership; the root owner bypasses org checks (full cross-org access).

use std::collections::HashMap;
use std::str::FromStr;

use anyhow::{bail, Result};
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, SqlitePool};

/// Represents a document persisted in database storage.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct PersistedDocument {
    /// Text content of the document.
    pub text: String,
    /// Language of the document for editor syntax highlighting.
    pub language: Option<String>,
}

/// A seeded application user.
#[derive(sqlx::FromRow, PartialEq, Eq, Clone, Debug)]
pub struct User {
    /// Primary key.
    pub id: i64,
    /// Login email (unique).
    pub email: String,
    /// Display name (editable in profile).
    pub name: String,
    /// bcrypt hash of the password.
    pub password_hash: String,
    /// "root" (hidden owner), "admin", or "user".
    pub role: String,
    /// Org the user is assigned to (None for root / unassigned).
    pub org_id: Option<i64>,
    /// Base32 TOTP secret, if the user has started 2FA enrollment (None = never set).
    pub totp_secret: Option<String>,
    /// True once the user has confirmed 2FA with a valid code; login then requires it.
    pub totp_enabled: bool,
}

/// A user as shown in the root admin console (never includes root accounts).
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AdminUser {
    /// Primary key.
    pub id: i64,
    /// Login email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Role ("admin" or "user").
    pub role: String,
    /// Assigned org id (nullable).
    pub org_id: Option<i64>,
    /// Assigned org name (nullable).
    pub org_name: Option<String>,
}

/// An org.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Org {
    /// Primary key.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// URL slug (unique), e.g. "dev".
    pub slug: String,
}

/// An org as shown in the owner console, with counts.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AdminOrg {
    /// Primary key.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// URL slug.
    pub slug: String,
    /// Number of assigned users.
    pub members: i64,
    /// Number of workspaces.
    pub workspaces: i64,
}

/// A group: the people + conversation hub inside an org, scoped to one of
/// three layers — `org` (whole org), `group` (visible to group_member rows)
/// or `personal` (visible only to `created_by`). A group holds one or more
/// workspaces (file/code projects) beneath it, and its own chat.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Group {
    /// Primary key.
    pub id: i64,
    /// Owning org.
    pub org_id: i64,
    /// Display name.
    pub name: String,
    /// Visibility layer: "org" | "group" | "personal".
    pub scope: String,
    /// Creator; owner for personal/group scopes.
    pub created_by: i64,
}

/// A workspace (file project) inside a group.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Workspace {
    /// Primary key.
    pub id: i64,
    /// Owning group.
    pub group_id: i64,
    /// Display name.
    pub name: String,
    /// URL slug, unique within the group (e.g. "backend").
    pub slug: String,
    /// Creator.
    pub created_by: i64,
}

/// Turn a name into a URL slug.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() {
        "workspace".to_string()
    } else {
        t
    }
}

/// A file within a workspace.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct FileRow {
    /// Primary key.
    pub id: i64,
    /// Owning workspace.
    pub workspace_id: i64,
    /// Path/name within the workspace.
    pub path: String,
    /// Id of the collaborative document holding this file's text.
    pub doc_id: String,
    /// "text" (collaborative) or "binary" (uploaded document).
    pub kind: String,
    /// MIME type for binary files.
    pub mime: Option<String>,
}

/// A chat message with its author's name/email.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct ChatMessage {
    /// Primary key.
    pub id: i64,
    /// Markdown body.
    pub body: String,
    /// Author display name (falls back to email on the client).
    pub author: String,
    /// Author email.
    pub email: String,
    /// Unix seconds.
    pub created_at: i64,
    /// When the message was last edited (None if never).
    pub edited_at: Option<i64>,
}

/// One emoji's tally on a message, from the requesting user's point of view.
#[derive(Serialize, PartialEq, Eq, Clone, Debug)]
pub struct ReactionView {
    /// The emoji.
    pub emoji: String,
    /// How many people reacted with it.
    pub count: i64,
    /// Whether the requesting user is one of them.
    pub mine: bool,
}

/// Group flat (msg_id, emoji, user_id) rows into per-message reaction tallies,
/// marking which are the requesting user's. Preserves first-seen emoji order.
fn group_reactions(rows: Vec<(i64, String, i64)>, me: i64) -> HashMap<i64, Vec<ReactionView>> {
    let mut map: HashMap<i64, Vec<ReactionView>> = HashMap::new();
    for (msg_id, emoji, user_id) in rows {
        let list = map.entry(msg_id).or_default();
        if let Some(rv) = list.iter_mut().find(|rv| rv.emoji == emoji) {
            rv.count += 1;
            rv.mine |= user_id == me;
        } else {
            list.push(ReactionView {
                emoji,
                count: 1,
                mine: user_id == me,
            });
        }
    }
    map
}

/// One audit-log entry, joined to its actor's identity for display.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct AuditEntry {
    /// Primary key.
    pub id: i64,
    /// Action slug, e.g. "login", "download", "delete_file".
    pub action: String,
    /// Optional human detail (a path, a target email, …).
    pub detail: Option<String>,
    /// Actor email ("system" for actorless events).
    pub email: String,
    /// Actor display name.
    pub name: String,
    /// Unix seconds.
    pub created_at: i64,
}

/// A member of an org, as returned to the client.
#[derive(sqlx::FromRow, Serialize, PartialEq, Eq, Clone, Debug)]
pub struct Member {
    /// User id.
    pub id: i64,
    /// User email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// User role ("admin" or "user").
    pub role: String,
}

/// A driver for database operations wrapping a pool connection.
#[derive(Clone, Debug)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Construct a new database, creating the file and running migrations.
    pub async fn new(uri: &str) -> Result<Self> {
        {
            let mut conn = SqliteConnectOptions::from_str(uri)?
                .create_if_missing(true)
                .connect()
                .await?;
            sqlx::migrate!().run(&mut conn).await?;
        }
        Ok(Database {
            pool: SqlitePool::connect(uri).await?,
        })
    }

    // ----- Documents (OT content) -----

    /// Load the text of a document from the database.
    pub async fn load(&self, document_id: &str) -> Result<PersistedDocument> {
        sqlx::query_as(r#"SELECT text, language FROM document WHERE id = $1"#)
            .bind(document_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Store the text of a document in the database.
    pub async fn store(&self, document_id: &str, document: &PersistedDocument) -> Result<()> {
        let result = sqlx::query(
            r#"INSERT INTO document (id, text, language) VALUES ($1, $2, $3)
               ON CONFLICT(id) DO UPDATE SET text = excluded.text, language = excluded.language"#,
        )
        .bind(document_id)
        .bind(&document.text)
        .bind(&document.language)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            bail!(
                "expected store() to affect 1 row, but affected {}",
                result.rows_affected()
            );
        }
        Ok(())
    }

    /// Count the number of documents in the database.
    pub async fn count(&self) -> Result<usize> {
        let row: (i64,) = sqlx::query_as("SELECT count(*) FROM document")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0 as usize)
    }

    // ----- Users / auth -----

    /// Insert a user if the email doesn't already exist. Returns true if inserted.
    pub async fn create_user_if_absent(
        &self,
        email: &str,
        name: &str,
        password_hash: &str,
        role: &str,
        org_id: Option<i64>,
    ) -> Result<bool> {
        let result = sqlx::query(
            r#"INSERT INTO users (email, name, password_hash, role, org_id)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT(email) DO NOTHING"#,
        )
        .bind(email)
        .bind(name)
        .bind(password_hash)
        .bind(role)
        .bind(org_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Number of user accounts. Used to decide the first-run owner bootstrap.
    pub async fn count_users(&self) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM users")
            .fetch_one(&self.pool)
            .await?;
        Ok(n)
    }

    /// Look up a user by email for login.
    pub async fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        sqlx::query_as(
            r#"SELECT id, email, name, password_hash, role, org_id, totp_secret, totp_enabled FROM users WHERE email = $1"#,
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Update a user's display name.
    pub async fn update_name(&self, user_id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Change a user's login username (the `email` column). Returns Ok(false) if
    /// the username is already taken by someone else (the column is UNIQUE).
    pub async fn update_email(&self, user_id: i64, email: &str) -> Result<bool> {
        let taken: Option<(i64,)> =
            sqlx::query_as(r#"SELECT id FROM users WHERE email = $1 AND id <> $2"#)
                .bind(email)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        if taken.is_some() {
            return Ok(false);
        }
        sqlx::query(r#"UPDATE users SET email = $1 WHERE id = $2"#)
            .bind(email)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(true)
    }

    /// Update a user's password hash.
    pub async fn update_password(&self, user_id: i64, password_hash: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET password_hash = $1 WHERE id = $2"#)
            .bind(password_hash)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Store a pending TOTP secret (enrollment started but not yet confirmed).
    pub async fn set_totp_pending(&self, user_id: i64, secret: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET totp_secret = $1, totp_enabled = 0 WHERE id = $2"#)
            .bind(secret)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Flip TOTP on after the first code is verified.
    pub async fn enable_totp(&self, user_id: i64) -> Result<()> {
        sqlx::query(r#"UPDATE users SET totp_enabled = 1 WHERE id = $1"#)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove TOTP entirely (user turn-off, or owner recovery / break-glass reset).
    pub async fn clear_totp(&self, user_id: i64) -> Result<()> {
        sqlx::query(r#"UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = $1"#)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Clear TOTP for every root/owner account. Host-level break-glass on boot.
    pub async fn clear_totp_for_roots(&self) -> Result<u64> {
        let r = sqlx::query(
            r#"UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE role = 'root'"#,
        )
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Create a session row.
    pub async fn create_session(&self, token: &str, user_id: i64, expires_at: i64) -> Result<()> {
        sqlx::query(r#"INSERT INTO session (token, user_id, expires_at) VALUES ($1, $2, $3)"#)
            .bind(token)
            .bind(user_id)
            .bind(expires_at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Resolve a session token to its user, only if the session is unexpired.
    pub async fn get_session_user(&self, token: &str, now: i64) -> Result<Option<User>> {
        sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.password_hash, u.role, u.org_id, u.totp_secret, u.totp_enabled
               FROM session s JOIN users u ON u.id = s.user_id
               WHERE s.token = $1 AND s.expires_at > $2"#,
        )
        .bind(token)
        .bind(now)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Delete all expired sessions (housekeeping, run on login).
    pub async fn purge_expired_sessions(&self, now: i64) -> Result<()> {
        sqlx::query(r#"DELETE FROM session WHERE expires_at <= $1"#)
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a session (logout).
    pub async fn delete_session(&self, token: &str) -> Result<()> {
        sqlx::query(r#"DELETE FROM session WHERE token = $1"#)
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ----- Root admin: users -----

    /// List all non-root users, with their org name.
    pub async fn admin_list_users(&self) -> Result<Vec<AdminUser>> {
        sqlx::query_as(
            r#"SELECT u.id, u.email, u.name, u.role, u.org_id, o.name AS org_name
               FROM users u LEFT JOIN org o ON o.id = u.org_id
               WHERE u.role != 'root' ORDER BY u.email"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Change a user's role (never touches root accounts).
    pub async fn admin_set_role(&self, id: i64, role: &str) -> Result<()> {
        sqlx::query(r#"UPDATE users SET role = $1 WHERE id = $2 AND role != 'root'"#)
            .bind(role)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Assign a user to an org (or None to unassign). Never touches root.
    pub async fn admin_set_org(&self, id: i64, org_id: Option<i64>) -> Result<()> {
        sqlx::query(r#"UPDATE users SET org_id = $1 WHERE id = $2 AND role != 'root'"#)
            .bind(org_id)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a user and their sessions. Never deletes root.
    pub async fn admin_delete_user(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(r#"DELETE FROM session WHERE user_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM users WHERE id = $1 AND role != 'root'"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // ----- Orgs -----

    /// Create an org.
    pub async fn create_org(&self, name: &str, slug: &str, now: i64) -> Result<Org> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO org (name, slug, created_at) VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(slug)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(Org {
            id: row.0,
            name: name.to_string(),
            slug: slug.to_string(),
        })
    }

    /// List all orgs with member and workspace counts.
    pub async fn list_orgs(&self) -> Result<Vec<AdminOrg>> {
        sqlx::query_as(
            r#"SELECT o.id, o.name, o.slug,
                      (SELECT count(*) FROM users u WHERE u.org_id = o.id) AS members,
                      (SELECT count(*) FROM workspace w JOIN groups g ON g.id = w.group_id WHERE g.org_id = o.id) AS workspaces
               FROM org o ORDER BY o.name"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch an org by id.
    pub async fn get_org(&self, id: i64) -> Result<Option<Org>> {
        sqlx::query_as(r#"SELECT id, name, slug FROM org WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.into())
    }

    /// Rename an org.
    pub async fn rename_org(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE org SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete an org and everything in it (groups, workspaces, files, chat),
    /// and unassign its users.
    pub async fn delete_org(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"DELETE FROM file_blob WHERE file_id IN
               (SELECT f.id FROM file f
                  JOIN workspace w ON w.id = f.workspace_id
                  JOIN groups g ON g.id = w.group_id WHERE g.org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM document WHERE id IN
               (SELECT f.doc_id FROM file f
                  JOIN workspace w ON w.id = f.workspace_id
                  JOIN groups g ON g.id = w.group_id WHERE g.org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM file WHERE workspace_id IN
               (SELECT w.id FROM workspace w JOIN groups g ON g.id = w.group_id WHERE g.org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM workspace WHERE group_id IN (SELECT id FROM groups WHERE org_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(r#"DELETE FROM group_member WHERE group_id IN (SELECT id FROM groups WHERE org_id = $1)"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM groups WHERE org_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM message WHERE org_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"UPDATE users SET org_id = NULL WHERE org_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM org WHERE id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// List the members (non-root users) of an org.
    pub async fn list_org_members(&self, org_id: i64) -> Result<Vec<Member>> {
        sqlx::query_as(
            r#"SELECT id, email, name, role FROM users
               WHERE org_id = $1 AND role != 'root' ORDER BY email"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    // ----- Groups (the people + conversation hub) -----

    /// Create a group in an org with a visibility scope
    /// ("org" | "group" | "personal"). For "group" the creator is added as
    /// a member (owner) so they can see it immediately.
    pub async fn create_group(
        &self,
        org_id: i64,
        name: &str,
        created_by: i64,
        now: i64,
        scope: &str,
    ) -> Result<Group> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO groups (org_id, name, scope, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        )
        .bind(org_id)
        .bind(name)
        .bind(scope)
        .bind(created_by)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        if scope == "group" {
            let _ = self.add_group_member(row.0, created_by, "owner").await;
        }
        Ok(Group {
            id: row.0,
            org_id,
            name: name.to_string(),
            scope: scope.to_string(),
            created_by,
        })
    }

    /// List the groups in an org (used by the root owner, who bypasses scoping).
    pub async fn list_groups(&self, org_id: i64) -> Result<Vec<Group>> {
        sqlx::query_as(
            r#"SELECT id, org_id, name, scope, created_by FROM groups WHERE org_id = $1 ORDER BY name"#,
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// List the groups in an org that a regular member may see: every org-wide
    /// group, their own personal groups, and every group they belong to.
    pub async fn list_groups_for_user(
        &self,
        org_id: i64,
        user_id: i64,
    ) -> Result<Vec<Group>> {
        sqlx::query_as(
            r#"SELECT g.id, g.org_id, g.name, g.scope, g.created_by
               FROM groups g
               WHERE g.org_id = $1
                 AND (g.scope = 'org'
                      OR (g.scope = 'personal' AND g.created_by = $2)
                      OR (g.scope = 'group' AND EXISTS (
                          SELECT 1 FROM group_member m
                          WHERE m.group_id = g.id AND m.user_id = $2)))
               ORDER BY g.name"#,
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a group by id.
    pub async fn get_group(&self, id: i64) -> Result<Option<Group>> {
        sqlx::query_as(
            r#"SELECT id, org_id, name, scope, created_by FROM groups WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Add a member to a group (no-op when already a member).
    pub async fn add_group_member(&self, group_id: i64, user_id: i64, role: &str) -> Result<()> {
        sqlx::query(
            r#"INSERT OR IGNORE INTO group_member (group_id, user_id, role)
               VALUES ($1, $2, $3)"#,
        )
        .bind(group_id)
        .bind(user_id)
        .bind(role)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove a member from a group.
    pub async fn remove_group_member(&self, group_id: i64, user_id: i64) -> Result<()> {
        sqlx::query(
            r#"DELETE FROM group_member WHERE group_id = $1 AND user_id = $2"#,
        )
        .bind(group_id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// True when the user is a member of the group (group scope).
    pub async fn is_group_member(&self, group_id: i64, user_id: i64) -> Result<bool> {
        let row: (i64,) = sqlx::query_as(
            r#"SELECT count(*) FROM group_member WHERE group_id = $1 AND user_id = $2"#,
        )
        .bind(group_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0 > 0)
    }

    /// Member user-ids of a group (empty for other scopes).
    pub async fn group_member_ids(&self, group_id: i64) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            r#"SELECT user_id FROM group_member WHERE group_id = $1 ORDER BY user_id"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    /// Rename a group.
    pub async fn rename_group(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE groups SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a group: its chat, memberships, workspaces and all their
    /// files/blobs/documents.
    pub async fn delete_group(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(r#"DELETE FROM group_member WHERE group_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM message WHERE group_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(
            r#"DELETE FROM file_blob WHERE file_id IN (
                SELECT f.id FROM file f JOIN workspace w ON w.id = f.workspace_id WHERE w.group_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM document WHERE id IN (
                SELECT f.doc_id FROM file f JOIN workspace w ON w.id = f.workspace_id WHERE w.group_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM file WHERE workspace_id IN (SELECT id FROM workspace WHERE group_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(r#"DELETE FROM workspace WHERE group_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM groups WHERE id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The org that owns a group, if it exists.
    pub async fn group_org(&self, group_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(r#"SELECT org_id FROM groups WHERE id = $1"#)
            .bind(group_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.0))
    }

    // ----- Workspaces (file projects inside a group) -----

    /// Create a workspace inside a group, with a slug unique within that group.
    pub async fn create_workspace(
        &self,
        group_id: i64,
        name: &str,
        created_by: i64,
        now: i64,
    ) -> Result<Workspace> {
        let base = slugify(name);
        let mut slug = base.clone();
        let mut n = 2;
        while self.slug_taken(group_id, &slug).await? {
            slug = format!("{base}-{n}");
            n += 1;
        }
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO workspace (group_id, name, slug, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        )
        .bind(group_id)
        .bind(name)
        .bind(&slug)
        .bind(created_by)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(Workspace {
            id: row.0,
            group_id,
            name: name.to_string(),
            slug,
            created_by,
        })
    }

    async fn slug_taken(&self, group_id: i64, slug: &str) -> Result<bool> {
        let row: (i64,) =
            sqlx::query_as(r#"SELECT count(*) FROM workspace WHERE group_id = $1 AND slug = $2"#)
                .bind(group_id)
                .bind(slug)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.0 > 0)
    }

    /// List the workspaces inside a group.
    pub async fn list_workspaces(&self, group_id: i64) -> Result<Vec<Workspace>> {
        sqlx::query_as(
            r#"SELECT id, group_id, name, slug, created_by FROM workspace WHERE group_id = $1 ORDER BY name"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a workspace by id.
    pub async fn get_workspace(&self, id: i64) -> Result<Option<Workspace>> {
        sqlx::query_as(
            r#"SELECT id, group_id, name, slug, created_by FROM workspace WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Rename a workspace.
    pub async fn rename_workspace(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query(r#"UPDATE workspace SET name = $1 WHERE id = $2"#)
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete a workspace and all its files/blobs/documents.
    pub async fn delete_workspace(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"DELETE FROM file_blob WHERE file_id IN (SELECT id FROM file WHERE workspace_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(
            r#"DELETE FROM document WHERE id IN (SELECT doc_id FROM file WHERE workspace_id = $1)"#,
        )
        .bind(id)
        .execute(&mut tx)
        .await?;
        sqlx::query(r#"DELETE FROM file WHERE workspace_id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        sqlx::query(r#"DELETE FROM workspace WHERE id = $1"#)
            .bind(id)
            .execute(&mut tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The org that owns the group containing a workspace, if it exists.
    pub async fn workspace_org(&self, workspace_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT g.org_id FROM workspace w JOIN groups g ON g.id = w.group_id
               WHERE w.id = $1"#,
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The group that owns a workspace, if it exists.
    pub async fn workspace_group(&self, workspace_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(r#"SELECT group_id FROM workspace WHERE id = $1"#)
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.0))
    }    /// The org that owns the group containing the workspace of a file, if any.
    pub async fn file_org(&self, file_id: i64) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT g.org_id FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.id = $1"#,
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The org that owns the group containing the workspace of a document.
    pub async fn doc_org(&self, doc_id: &str) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"SELECT g.org_id FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.doc_id = $1"#,
        )
        .bind(doc_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// The group, org, visibility scope and creator of the group that owns
    /// the workspace of a document — used for the layered access check on the
    /// collaborative socket. Returns (group_id, org_id, scope, created_by).
    #[allow(clippy::type_complexity)]
    pub async fn doc_ws_info(
        &self,
        doc_id: &str,

    ) -> Result<Option<(i64, i64, String, i64)>> {
        let row: Option<(i64, i64, String, i64)> = sqlx::query_as(
            r#"SELECT g.id, g.org_id, g.scope, g.created_by
               FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.doc_id = $1"#,
        )
        .bind(doc_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// The group, org, visibility scope and creator for a file's workspace.
    #[allow(clippy::type_complexity)]
    pub async fn file_ws_info(
        &self,
        file_id: i64,
    ) -> Result<Option<(i64, i64, String, i64)>> {
        let row: Option<(i64, i64, String, i64)> = sqlx::query_as(
            r#"SELECT g.id, g.org_id, g.scope, g.created_by
               FROM file f
               JOIN workspace w ON w.id = f.workspace_id
               JOIN groups g ON g.id = w.group_id
               WHERE f.id = $1"#,
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    // ----- Files -----

    /// Create a file row in a workspace.
    pub async fn create_file(
        &self,
        workspace_id: i64,
        path: &str,
        doc_id: &str,
        kind: &str,
        mime: Option<&str>,
        now: i64,
    ) -> Result<FileRow> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO file (workspace_id, path, doc_id, kind, mime, created_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
        )
        .bind(workspace_id)
        .bind(path)
        .bind(doc_id)
        .bind(kind)
        .bind(mime)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(FileRow {
            id: row.0,
            workspace_id,
            path: path.to_string(),
            doc_id: doc_id.to_string(),
            kind: kind.to_string(),
            mime: mime.map(str::to_string),
        })
    }

    /// List files in a workspace, ordered by path.
    pub async fn list_files(&self, workspace_id: i64) -> Result<Vec<FileRow>> {
        sqlx::query_as(
            r#"SELECT id, workspace_id, path, doc_id, kind, mime FROM file
               WHERE workspace_id = $1 ORDER BY path"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Fetch a file by id.
    pub async fn get_file(&self, id: i64) -> Result<Option<FileRow>> {
        sqlx::query_as(
            r#"SELECT id, workspace_id, path, doc_id, kind, mime FROM file WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.into())
    }

    /// Move/rename a file (change its path within the workspace).
    pub async fn rename_file(&self, id: i64, path: &str) -> Result<()> {
        sqlx::query(r#"UPDATE file SET path = $1 WHERE id = $2"#)
            .bind(path)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Store raw bytes for a binary file.
    pub async fn store_blob(&self, file_id: i64, data: &[u8]) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO file_blob (file_id, data) VALUES ($1, $2)
               ON CONFLICT(file_id) DO UPDATE SET
                 data = excluded.data,
                 revision = file_blob.revision + 1"#,
        )
        .bind(file_id)
        .bind(data)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Replace a blob only if it still has the revision read by the client.
    pub async fn store_blob_at_revision(
        &self,
        file_id: i64,
        data: &[u8],
        expected_revision: i64,
    ) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as(
            r#"UPDATE file_blob
               SET data = $1, revision = revision + 1
               WHERE file_id = $2 AND revision = $3
               RETURNING revision"#,
        )
        .bind(data)
        .bind(file_id)
        .bind(expected_revision)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|result| result.0))
    }

    /// Load raw bytes for a binary file.
    pub async fn load_blob(&self, file_id: i64) -> Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as(r#"SELECT data FROM file_blob WHERE file_id = $1"#)
                .bind(file_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }

    /// Load a binary file's bytes together with its concurrency revision.
    pub async fn load_blob_with_revision(&self, file_id: i64) -> Result<Option<(Vec<u8>, i64)>> {
        Ok(
            sqlx::query_as(r#"SELECT data, revision FROM file_blob WHERE file_id = $1"#)
                .bind(file_id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    /// Delete a file row and its underlying content (OT document or blob).
    pub async fn delete_file(&self, id: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let file: Option<FileRow> = sqlx::query_as(
            r#"SELECT id, workspace_id, path, doc_id, kind, mime FROM file WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&mut tx)
        .await?;
        if let Some(f) = file {
            sqlx::query(r#"DELETE FROM file_blob WHERE file_id = $1"#)
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query(r#"DELETE FROM file WHERE id = $1"#)
                .bind(id)
                .execute(&mut tx)
                .await?;
            sqlx::query(r#"DELETE FROM document WHERE id = $1"#)
                .bind(&f.doc_id)
                .execute(&mut tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Current SQLite database file size in bytes.
    pub async fn db_size_bytes(&self) -> Result<i64> {
        let (pages,): (i64,) = sqlx::query_as("PRAGMA page_count")
            .fetch_one(&self.pool)
            .await?;
        let (size,): (i64,) = sqlx::query_as("PRAGMA page_size")
            .fetch_one(&self.pool)
            .await?;
        Ok(pages * size)
    }

    /// Row count for a single table (table name is a fixed constant, never user input).
    pub async fn table_rows(&self, table: &str) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", table);
        let (n,): (i64,) = sqlx::query_as(&sql).fetch_one(&self.pool).await?;
        Ok(n)
    }

    /// Total bytes stored in binary blobs (uploaded files + pasted chat images).
    pub async fn blob_bytes(&self) -> Result<i64> {
        let (a,): (i64,) = sqlx::query_as("SELECT COALESCE(SUM(LENGTH(data)),0) FROM file_blob")
            .fetch_one(&self.pool)
            .await?;
        let (b,): (i64,) = sqlx::query_as("SELECT COALESCE(SUM(LENGTH(data)),0) FROM chat_image")
            .fetch_one(&self.pool)
            .await?;
        Ok(a + b)
    }

    // ----- Group chat -----

    /// Post a message to a group's chat (org_id derived from the group).
    pub async fn create_message(
        &self,
        group_id: i64,
        user_id: i64,
        body: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO message (group_id, org_id, user_id, body, created_at)
               VALUES ($1, (SELECT org_id FROM groups WHERE id = $1), $2, $3, $4)"#,
        )
        .bind(group_id)
        .bind(user_id)
        .bind(body)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The most recent messages in a group, oldest-first.
    pub async fn list_messages(&self, group_id: i64, limit: i64) -> Result<Vec<ChatMessage>> {
        let mut rows: Vec<ChatMessage> = sqlx::query_as(
            r#"SELECT m.id, m.body, u.name AS author, u.email AS email, m.created_at, m.edited_at
               FROM message m JOIN users u ON u.id = m.user_id
               WHERE m.group_id = $1 ORDER BY m.id DESC LIMIT $2"#,
        )
        .bind(group_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// The latest message in a group: (id, author id, body, created_at).
    pub async fn group_last_msg(
        &self,
        group_id: i64,
    ) -> Result<Option<(i64, i64, String, i64)>> {
        Ok(sqlx::query_as(
            r#"SELECT id, user_id, body, created_at FROM message
               WHERE group_id = $1 ORDER BY id DESC LIMIT 1"#,
        )
        .bind(group_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Count of group messages after `after` not sent by `me` (unread).
    pub async fn group_unread_count(&self, group_id: i64, me: i64, after: i64) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            r#"SELECT COUNT(*) FROM message WHERE group_id = $1 AND id > $2 AND user_id <> $3"#,
        )
        .bind(group_id)
        .bind(after)
        .bind(me)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    /// For each DM peer of `me`, the latest message: (peer, id, sender, body, created_at).
    pub async fn dm_overview(
        &self,
        org_id: i64,
        me: i64,
    ) -> Result<Vec<(i64, i64, i64, String, i64)>> {
        let rows: Vec<(i64, i64, i64, String, i64)> = sqlx::query_as(
            r#"SELECT
                 CASE WHEN d.sender_id = $2 THEN d.recipient_id ELSE d.sender_id END AS peer_id,
                 d.id AS last_id,
                 d.sender_id AS last_sender,
                 d.body AS body,
                 d.created_at AS created_at
               FROM dm d
               JOIN (
                 SELECT MAX(id) AS mid FROM dm
                 WHERE org_id = $1 AND (sender_id = $2 OR recipient_id = $2)
                 GROUP BY (CASE WHEN sender_id = $2 THEN recipient_id ELSE sender_id END)
               ) x ON d.id = x.mid"#,
        )
        .bind(org_id)
        .bind(me)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Count of DMs from `peer` to `me` after `after` (unread from that peer).
    pub async fn dm_unread_count(
        &self,
        org_id: i64,
        me: i64,
        peer: i64,
        after: i64,
    ) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            r#"SELECT COUNT(*) FROM dm
               WHERE org_id = $1 AND recipient_id = $2 AND sender_id = $3 AND id > $4"#,
        )
        .bind(org_id)
        .bind(me)
        .bind(peer)
        .bind(after)
        .fetch_one(&self.pool)
        .await?;
        Ok(n)
    }

    /// Edit a group-chat message's body — only the author may do so. Returns
    /// true if a row was actually changed (false = not yours / not found).
    pub async fn edit_message(&self, id: i64, user_id: i64, body: &str, now: i64) -> Result<bool> {
        let r = sqlx::query(
            r#"UPDATE message SET body = $1, edited_at = $2 WHERE id = $3 AND user_id = $4"#,
        )
        .bind(body)
        .bind(now)
        .bind(id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Delete a group-chat message — only the author. Returns true if removed.
    pub async fn delete_message(&self, id: i64, user_id: i64) -> Result<bool> {
        let r = sqlx::query(r#"DELETE FROM message WHERE id = $1 AND user_id = $2"#)
            .bind(id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Clear a group's chat (admin/root only — enforced at the route).
    pub async fn clear_messages(&self, group_id: i64) -> Result<()> {
        sqlx::query(r#"DELETE FROM message WHERE group_id = $1"#)
            .bind(group_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ----- Direct messages (org-wide, 1:1) -----

    /// The org a user belongs to (for validating a DM peer is a co-member).
    pub async fn user_org(&self, user_id: i64) -> Result<Option<i64>> {
        let row: Option<(Option<i64>,)> =
            sqlx::query_as(r#"SELECT org_id FROM users WHERE id = $1"#)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|r| r.0))
    }

    /// Send a direct message from `sender` to `recipient` within an org.
    pub async fn create_dm(
        &self,
        org_id: i64,
        sender: i64,
        recipient: i64,
        body: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO dm (org_id, sender_id, recipient_id, body, created_at)
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(org_id)
        .bind(sender)
        .bind(recipient)
        .bind(body)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The conversation between two users in an org, oldest-first.
    pub async fn list_dm(
        &self,
        org_id: i64,
        a: i64,
        b: i64,
        limit: i64,
    ) -> Result<Vec<ChatMessage>> {
        let mut rows: Vec<ChatMessage> = sqlx::query_as(
            r#"SELECT d.id, d.body, u.name AS author, u.email AS email, d.created_at, d.edited_at
               FROM dm d JOIN users u ON u.id = d.sender_id
               WHERE d.org_id = $1
                 AND ((d.sender_id = $2 AND d.recipient_id = $3)
                   OR (d.sender_id = $3 AND d.recipient_id = $2))
               ORDER BY d.id DESC LIMIT $4"#,
        )
        .bind(org_id)
        .bind(a)
        .bind(b)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// Edit a direct message's body — only the sender. Returns true if changed.
    pub async fn edit_dm(&self, id: i64, sender_id: i64, body: &str, now: i64) -> Result<bool> {
        let r = sqlx::query(
            r#"UPDATE dm SET body = $1, edited_at = $2 WHERE id = $3 AND sender_id = $4"#,
        )
        .bind(body)
        .bind(now)
        .bind(id)
        .bind(sender_id)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Delete a direct message — only the sender. Returns true if removed.
    pub async fn delete_dm_message(&self, id: i64, sender_id: i64) -> Result<bool> {
        let r = sqlx::query(r#"DELETE FROM dm WHERE id = $1 AND sender_id = $2"#)
            .bind(id)
            .bind(sender_id)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Clear the whole conversation between two users (either party may do this).
    pub async fn clear_dm(&self, org_id: i64, a: i64, b: i64) -> Result<()> {
        sqlx::query(
            r#"DELETE FROM dm WHERE org_id = $1
               AND ((sender_id = $2 AND recipient_id = $3)
                 OR (sender_id = $3 AND recipient_id = $2))"#,
        )
        .bind(org_id)
        .bind(a)
        .bind(b)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ----- Presence (heartbeat) -----

    /// Record that a user was just seen (heartbeat).
    pub async fn touch_last_seen(&self, user_id: i64, now: i64) -> Result<()> {
        sqlx::query(r#"UPDATE users SET last_seen = $1 WHERE id = $2"#)
            .bind(now)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// (user_id, last_seen) for everyone in an org.
    pub async fn org_presence(&self, org_id: i64) -> Result<Vec<(i64, i64)>> {
        let rows: Vec<(i64, i64)> =
            sqlx::query_as(r#"SELECT id, last_seen FROM users WHERE org_id = $1"#)
                .bind(org_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows)
    }

    // ----- Reactions -----

    /// Toggle a user's emoji reaction on a message (add if absent, else remove).
    pub async fn toggle_reaction(
        &self,
        kind: &str,
        msg_id: i64,
        user_id: i64,
        emoji: &str,
    ) -> Result<()> {
        let del = sqlx::query(
            r#"DELETE FROM reaction WHERE kind = $1 AND msg_id = $2 AND user_id = $3 AND emoji = $4"#,
        )
        .bind(kind)
        .bind(msg_id)
        .bind(user_id)
        .bind(emoji)
        .execute(&self.pool)
        .await?;
        if del.rows_affected() == 0 {
            sqlx::query(
                r#"INSERT INTO reaction (kind, msg_id, user_id, emoji) VALUES ($1, $2, $3, $4)"#,
            )
            .bind(kind)
            .bind(msg_id)
            .bind(user_id)
            .bind(emoji)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Reactions for every message in a group's chat, keyed by msg id.
    pub async fn reactions_for_group(
        &self,
        group_id: i64,
        me: i64,
    ) -> Result<HashMap<i64, Vec<ReactionView>>> {
        let rows: Vec<(i64, String, i64)> = sqlx::query_as(
            r#"SELECT r.msg_id, r.emoji, r.user_id
               FROM reaction r JOIN message m ON m.id = r.msg_id
               WHERE r.kind = 'ws' AND m.group_id = $1"#,
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(group_reactions(rows, me))
    }

    /// Reactions for every message in a 1:1 conversation, keyed by msg id.
    pub async fn reactions_for_dm(
        &self,
        org_id: i64,
        a: i64,
        b: i64,
        me: i64,
    ) -> Result<HashMap<i64, Vec<ReactionView>>> {
        let rows: Vec<(i64, String, i64)> = sqlx::query_as(
            r#"SELECT r.msg_id, r.emoji, r.user_id
               FROM reaction r JOIN dm d ON d.id = r.msg_id
               WHERE r.kind = 'dm' AND d.org_id = $1
                 AND ((d.sender_id = $2 AND d.recipient_id = $3)
                   OR (d.sender_id = $3 AND d.recipient_id = $2))"#,
        )
        .bind(org_id)
        .bind(a)
        .bind(b)
        .fetch_all(&self.pool)
        .await?;
        Ok(group_reactions(rows, me))
    }

    // ----- Audit log -----

    /// Append an audit entry. Best-effort — callers ignore the result.
    pub async fn audit(
        &self,
        org_id: Option<i64>,
        user_id: Option<i64>,
        action: &str,
        detail: Option<&str>,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO audit (org_id, user_id, action, detail, created_at) VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(org_id)
        .bind(user_id)
        .bind(action)
        .bind(detail)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Recent audit entries: an org's when `all` is false, otherwise every org's
    /// (root view). Newest first.
    pub async fn list_audit(
        &self,
        org_id: Option<i64>,
        all: bool,
        limit: i64,
    ) -> Result<Vec<AuditEntry>> {
        let base = r#"SELECT a.id, a.action, a.detail,
                             COALESCE(u.email, 'system') AS email,
                             COALESCE(u.name, 'system') AS name,
                             a.created_at
                      FROM audit a LEFT JOIN users u ON u.id = a.user_id"#;
        let rows = if all {
            sqlx::query_as::<_, AuditEntry>(&format!("{base} ORDER BY a.id DESC LIMIT $1"))
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query_as::<_, AuditEntry>(&format!(
                "{base} WHERE a.org_id = $1 ORDER BY a.id DESC LIMIT $2"
            ))
            .bind(org_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        };
        Ok(rows)
    }

    // ----- Chat images (org-scoped blobs, separate from workspace files) -----

    /// Store a pasted chat image and return its id.
    pub async fn create_chat_image(
        &self,
        org_id: i64,
        mime: Option<&str>,
        data: &[u8],
        now: i64,
    ) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(
            r#"INSERT INTO chat_image (org_id, mime, data, created_at) VALUES ($1, $2, $3, $4) RETURNING id"#,
        )
        .bind(org_id)
        .bind(mime)
        .bind(data)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0)
    }

    /// Load a chat image: (org_id, mime, bytes).
    pub async fn get_chat_image(&self, id: i64) -> Result<Option<(i64, Option<String>, Vec<u8>)>> {
        let row: Option<(i64, Option<String>, Vec<u8>)> =
            sqlx::query_as(r#"SELECT org_id, mime, data FROM chat_image WHERE id = $1"#)
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row)
    }
}

#[cfg(test)]
mod tests {
    use super::Database;

    #[tokio::test]
    async fn migrations_remove_ai_schema() {
        let file = tempfile::NamedTempFile::new().expect("create temporary database");
        let uri = format!(
            "sqlite://{}",
            file.path()
                .to_str()
                .expect("temporary database path is valid UTF-8")
        );
        let db = Database::new(&uri).await.expect("run database migrations");

        let (ai_tables,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%'",
        )
        .fetch_one(&db.pool)
        .await
        .expect("inspect migrated schema");
        assert_eq!(ai_tables, 0);

        let (cleanup_applied,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 26")
                .fetch_one(&db.pool)
                .await
                .expect("inspect migration history");
        assert_eq!(cleanup_applied, 1);
    }
}
