//! The archive format's column decoding, end to end (issue #26).
//!
//! `export_snapshot` reads every column by trying `i64`, then `f64`, then
//! `String`, then bytes. That order is only safe if SQLite refuses to hand a
//! TEXT value to the integer reader — `document.id` and `file.doc_id` are hex
//! strings, so a digit-only id that decoded as a number would come back through
//! `import_replace_all` as an integer sitting in a TEXT column, and every lookup
//! by `'1234567'` would silently miss.

use serde_json::Value;

use rustpad_server::database::Database;

#[tokio::test]
async fn a_digit_only_document_id_survives_an_archive_round_trip_as_text() {
    let source = Database::new("sqlite::memory:")
        .await
        .expect("boot an in-memory control database");
    // An archive with no owner account is refused on import by design — restoring
    // one would leave an instance nobody can administer — so the round trip needs
    // a root user in it.
    source
        .create_user_if_absent("root@corp.example", "Root", "not-a-bcrypt-hash", "root", None)
        .await
        .unwrap();
    sqlx::query("INSERT INTO document (id, text, language) VALUES ('1234567', 'typed, not uploaded', 'txt')")
        .execute(source.write())
        .await
        .unwrap();

    let snapshot = source.export_snapshot().await.unwrap();
    let exported = &snapshot["document"][0]["id"];
    assert!(
        exported.is_string(),
        "export decoded the text id as {exported}; a JSON number restores into a \
         TEXT column as an integer and no lookup by '1234567' can find it again"
    );

    // The other half of the promise: the restored database opens the document by
    // the same string id the archive carried.
    let tables: Vec<(String, Vec<Value>)> = Database::MIGRATE_TABLES
        .iter()
        .map(|name| {
            let rows = snapshot
                .get(*name)
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            (
                (*name).to_string(),
                rows.as_array().unwrap().clone(),
            )
        })
        .collect();
    let target = Database::new("sqlite::memory:")
        .await
        .expect("boot the restoring database");
    target.import_replace_all(&tables).await.unwrap();
    assert_eq!(
        target.load("1234567").await.unwrap().text,
        "typed, not uploaded",
        "a digit-only id must round-trip through an archive as text"
    );
}

/// Restoring an archive that holds no owner account would leave an instance
/// nobody can sign in to or administer, so the import refuses it outright.
#[tokio::test]
async fn an_archive_with_no_owner_account_is_refused_on_import() {
    let source = Database::new("sqlite::memory:").await.unwrap();
    sqlx::query("INSERT INTO document (id, text) VALUES ('orphan', 'no owner exists')")
        .execute(source.write())
        .await
        .unwrap();
    let snapshot = source.export_snapshot().await.unwrap();
    let tables: Vec<(String, Vec<Value>)> = Database::MIGRATE_TABLES
        .iter()
        .map(|name| {
            let rows = snapshot
                .get(*name)
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            ((*name).to_string(), rows.as_array().unwrap().clone())
        })
        .collect();
    let target = Database::new("sqlite::memory:").await.unwrap();
    let err = target
        .import_replace_all(&tables)
        .await
        .expect_err("an ownerless archive must not restore");
    assert!(
        err.to_string().contains("owner"),
        "the refusal should say why: {err}"
    );
    // A refusal must be total: the import runs in a transaction, so the
    // instance's own data is untouched rather than half-replaced.
    let remaining: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM document")
        .fetch_one(target.read_only())
        .await
        .unwrap();
    assert_eq!(remaining.0, 0, "a refused import left rows behind");
}
