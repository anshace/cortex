use rustpad_server::{
    auth, database::Database, databases::Databases, licence, server, ServerConfig,
};

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    pretty_env_logger::init();

    // Plan claims are verified once at boot. Whether they mean anything at all is
    // decided by the presence of a public key, so a self-hosted install with no
    // licence configuration keeps behaving as if it had no plan.
    licence::init(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or(0),
    );

    let port = std::env::var("PORT")
        .unwrap_or_else(|_| String::from("3030"))
        .parse()
        .expect("Unable to parse PORT");

    // AuthPad requires a database (users + sessions). Default to a local file.
    let sqlite_uri =
        std::env::var("SQLITE_URI").unwrap_or_else(|_| String::from("sqlite://authpad.db"));
    let database = Database::new(&sqlite_uri)
        .await
        .expect("Unable to connect to SQLITE_URI");

    // One database per organization, or the control database standing in for
    // all of them. Built before anything can serve a request, so the first
    // tenant to open a file never waits on a storage decision.
    let databases = Databases::new(database.clone(), &sqlite_uri);
    // The control database is what every handler is handed, so it is what has to
    // know where a document's content lives. The dependency is circular — the
    // registry holds this handle — so the registry can only be attached after
    // both exist, which is what the line below is for.
    database.attach_registries(databases.clone());
    // Content moves to a tenant database and does not move back. Starting in
    // single mode beside those files would serve a control database that has no
    // text in it, so every document would open blank and look destroyed.
    let orphans = databases.orphaned_tenants();
    if !orphans.is_empty() {
        log::error!(
            "refusing to start: per-organization storage is off, but {} tenant database(s) exist: {:?}. \
             Their documents are readable only with CORTEX_ORG_DBS=1. Nothing has been deleted — set the \
             flag back on, or move these files aside deliberately.",
            orphans.len(),
            orphans,
        );
        std::process::exit(2);
    }
    match databases.migrate_all().await {
        Ok(moved) => {
            if moved > 0 {
                log::info!("migrated {moved} organization database(s) to this schema");
            }
        }
        // A tenant left short of this binary's schema is an operator problem,
        // and the console says so per org. It is not a reason to keep the other
        // hundred organizations from signing in.
        Err(e) => log::error!("organization database migration failed: {e}"),
    }
    // Content an older build wrote into the control database has to move before
    // a routed read can find it, or an instance that turns the flag on shows its
    // users empty files. Restartable by design: a failure here says "try again",
    // and every row still here is found by the next boot.
    match database.migrate_content_to_orgs().await {
        Ok(moved) => {
            if moved > 0 {
                log::info!("moved {moved} existing document(s) into their organization databases");
            }
        }
        Err(e) => log::error!("document content migration failed: {e}"),
    }

    // First run only: create the default owner account (admin/admin, override
    // with ADMIN_USERNAME/ADMIN_PASSWORD) so a fresh deploy is usable at once.
    auth::ensure_default_owner(&database).await;

    // Break-glass: set OWNER_2FA_RESET=1 on the host to clear the owner's 2FA if
    // the authenticator device is ever lost. Only the owner controls the host.
    auth::maybe_break_glass_owner_2fa(&database).await;

    let config = ServerConfig {
        expiry_days: std::env::var("EXPIRY_DAYS")
            .unwrap_or_else(|_| String::from("1"))
            .parse()
            .expect("Unable to parse EXPIRY_DAYS"),
        database: Some(database),
        databases: Some(databases),
    };

    warp::serve(server(config)).run(([0, 0, 0, 0], port)).await;
}
