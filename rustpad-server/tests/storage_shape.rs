//! What a single-mode install stores, pinned by content.
//!
//! `CORTEX_ORG_DBS` unset is the default, and the promise that default makes is
//! that nothing about where content lives changes at all. So this runs a fixed
//! script against a fresh database and fingerprints everything it wrote — the
//! schema of every table and every row of every table, in rowid order — then
//! compares it against the value the same script produced in the code that had no
//! per-organization routing. Anything that changes what an install which never
//! set the flag stores fails here: content that went missing, a size that stopped
//! being measured, a column that appeared, a row nobody asked for.
//!
//! The fingerprint is of the *content*, not of the database file, because the
//! file is not a function of the data: `PRAGMA optimize` fills a statistics table
//! from a random sample of rows, and sqlx records how long each migration took.
//! Those two are excluded; everything else is compared exactly.

use anyhow::Result;
use rustpad_server::{
    database::{Database, PersistedDocument},
    databases::Databases,
};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

/// The fingerprint [`script`] leaves behind, taken from the code before content
/// was routed per organization.
///
/// Re-recorded once, when the fingerprint started normalising the schema text:
/// `sqlx::migrate!` embeds each migration exactly as the checkout holds it, so a
/// CRLF working tree stored a `CREATE TABLE` carrying a `\r` per line and an LF
/// one did not. The two values differed (`1ee336a…` against `ba1c12d…`) while
/// every row and every table matched, which is the signature of a canary
/// measuring line endings rather than stored data. Both trees now agree on the
/// value below, so it says what an install stores, not which checkout ran it.
const BEFORE_ROUTING: &str = "56b80e452303b3313e3bbbd2f3131524770ec8b47c60929aeb9bde88a6470a2c";

/// Tables that say nothing about the data an install holds: `PRAGMA optimize`
/// fills the first from a random sample of rows, and sqlx writes how long each
/// migration took into the second.
fn ignored(table: &str) -> bool {
    table.starts_with("sqlite_stat") || table == "_sqlx_migrations"
}

/// One row, as one text line: table, rowid, then every column's bytes in hex.
///
/// The whole expression is built in SQL so that a column arrives as text whatever
/// it holds — `hex(CAST(col AS BLOB))` says the same thing about an integer, a
/// string and a blob, and NULL about a NULL, so no type is a special case and no
/// byte is lost.
fn row_line(table: &str, columns: &[String]) -> String {
    let mut sql = format!("SELECT '{table}|' || rowid");
    for column in columns {
        let column = column.replace('\'', "''");
        sql.push_str(&format!(
            " || '|' || IFNULL(hex(CAST(\"{column}\" AS BLOB)), 'NULL')"
        ));
    }
    sql.push_str(&format!(" FROM \"{table}\" ORDER BY rowid"));
    sql
}

/// Every table and every row of a database, hashed.
async fn fingerprint(db: &Database) -> Result<String> {
    let mut hasher = Sha256::new();
    let objects: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT type, name, sql FROM sqlite_master \
         WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' \
         ORDER BY type, name",
    )
    .fetch_all(db.read_only())
    .await?;
    for (kind, name, sql) in &objects {
        // Normalise line endings: the embedded DDL text depends on how the
        // migration file was checked out, and that is not a fact about storage.
        let ddl = sql.clone().unwrap_or_default().replace('\r', "");
        hasher.update(format!("schema {kind} {name} = {ddl};\n").as_bytes());
    }
    // Only tables hold rows worth fingerprinting. An index is a property of one,
    // and its own definition went through the schema pass above.
    let tables: Vec<String> = objects
        .into_iter()
        .filter(|(kind, _, _)| kind == "table")
        .map(|(_, name, _)| name)
        .collect();
    for name in &tables {
        if ignored(name) {
            continue;
        }
        let columns: Vec<(String,)> = sqlx::query_as(&format!(
            "SELECT name FROM pragma_table_info('{}') ORDER BY cid",
            name.replace('\'', "''")
        ))
        .fetch_all(db.read_only())
        .await?;
        let columns: Vec<String> = columns.into_iter().map(|(name,)| name).collect();
        let rows: Vec<String> = sqlx::query_scalar(&row_line(name, &columns))
            .fetch_all(db.read_only())
            .await?;
        for line in rows {
            hasher.update(line.as_bytes());
            hasher.update(b"\n");
        }
        hasher.update(format!("end {name}\n").as_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// A database laid out the way a boot lays one out, and the fingerprint of what
/// it ends up holding.
///
/// With `with_registry` the instance is built exactly as `main` builds it — the
/// registry attached, `migrate_all` and the content migration run — with the flag
/// left off, which is the claim being made: a registry that resolved to `Single`
/// has to be indistinguishable from a process that never built one.
async fn laid_out(with_registry: bool) -> Result<String> {
    let file = NamedTempFile::new()?;
    let uri = format!("sqlite://{}", file.path().to_str().unwrap());
    let orgs = tempfile::tempdir()?;
    let db = Database::new(&uri).await?;
    if with_registry {
        let registries = Databases::new(db.clone(), &uri);
        assert!(
            !registries.is_split(),
            "no CORTEX_ORG_DBS in the test environment means one database"
        );
        assert!(db.attach_registries(registries.clone()), "a registry is attached once");
        assert_eq!(registries.migrate_all().await?, 0, "single mode has nothing to migrate");
        assert_eq!(db.migrate_content_to_orgs().await?, 0, "and nothing to move");
    }
    script(&db).await?;
    let sum = fingerprint(&db).await?;
    assert_eq!(
        orgs.path().read_dir()?.count(),
        0,
        "a single-mode install created a tenant database anyway"
    );
    Ok(sum)
}

/// Every content path a plain install uses, in one fixed order: create, persist
/// by OT, persist directly, upload, list, meter, count, delete, maintain.
async fn script(db: &Database) -> Result<()> {
    db.create_user_if_absent("owner", "Owner", "pw", "root", None).await?;
    let owner = db.get_user_by_email("owner").await?.expect("the owner exists");
    let org = db.create_org("Alpha", "alpha", 1).await?;
    let group = db.create_group(org.id, "Team", owner.id, 1, "group").await?;
    let ws = db.create_workspace(group.id, "Project", owner.id, 1).await?;
    let note = db.create_file(ws.id, "note.md", "fp-1", "text", None, 1).await?;
    db.create_file(ws.id, "other.md", "fp-2", "text", None, 1).await?;
    db.store(
        &note.doc_id,
        &PersistedDocument { text: "first revision".into(), language: Some("markdown".into()) },
    )
    .await?;
    db.store_document_text("fp-2", "second file's text").await?;
    db.create_uploaded_file(ws.id, "deck.pdf", "fp-3", Some("application/pdf"), None, b"pdf bytes", 1)
        .await?;
    let listed = db.list_files(ws.id).await?;
    assert_eq!(listed.len(), 3, "two notes and an upload");
    assert_eq!(
        listed.iter().find(|f| f.doc_id == "fp-2").map(|f| f.size),
        Some(18),
        "the size a client picks a viewer with is the text's byte length"
    );
    assert_eq!(db.org_content_bytes(org.id).await?, 41, "and the meter agrees with it");
    assert_eq!(db.count().await?, 2, "two documents stored");
    let doomed = db.create_file(ws.id, "doomed.md", "fp-4", "text", None, 1).await?;
    db.delete_file(doomed.id).await?;
    db.maintain(2_000_000_000, 180, false).await?;
    assert_eq!(db.load("fp-1").await?.text, "first revision", "and the survivors read back");
    assert!(db.load("fp-4").await.is_err(), "the deleted one stays deleted");
    assert_eq!(db.table_rows("document").await?, 2, "its content went with it");
    assert_eq!(db.org_of_doc("fp-4").await?.map(|_| 1), None, "and so did its route");
    Ok(())
}

#[tokio::test]
async fn a_single_mode_install_stores_what_it_always_stored() -> Result<()> {
    let once = laid_out(false).await?;
    assert_eq!(
        once, BEFORE_ROUTING,
        "an install that never turned on per-organization databases stores something else now"
    );
    assert_eq!(laid_out(false).await?, once, "the fingerprint is not stable run to run");
    Ok(())
}

#[tokio::test]
async fn a_registry_that_resolved_to_single_changes_nothing() -> Result<()> {
    assert_eq!(
        laid_out(true).await?,
        laid_out(false).await?,
        "a `Single` registry is not the same as no registry at all"
    );
    Ok(())
}
