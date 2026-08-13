use rustpad_server::{auth, database::Database, server, ServerConfig};

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    pretty_env_logger::init();

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
    };

    warp::serve(server(config)).run(([0, 0, 0, 0], port)).await;
}
