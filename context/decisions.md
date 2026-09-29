# Decisions Log

Every hard technical call, made on purpose, with the cost written down. Nothing
important gets decided in a chat that vanishes.

## Decision record format

```
## D-NN: <title> — <date>
Trigger: what forced this
Options considered: A / B / C
Chosen: <option>, because <reason>
Lost alternative: <option>, honest reason it lost
Cost paid: new moving part / latency / tolerated incorrectness / money
Reversibility: easy | painful (what a rollback costs)
Correctness policy: what may now be slightly wrong (and what never can be)
```

## Flagged assumptions (undecided shortcuts, visible until decided)

### F-01: "sealed chat" copy overstates what chat encryption is — 2026-09-29
`Landing.tsx` and `Login.tsx` say chat is "sealed on your device" / "ECIES-sealed".
What the code actually does is app-layer ECDH against the **server's process key**
(`src/crypto.ts` fetches `/api/crypto/pubkey`), so payloads are opaque to a
TLS-inspecting proxy but readable by the server. Attached to: the agents feature,
because a server-side bot replying in a channel depends on exactly that fact.
Needs the owner to pick: reword the copy, or make chat genuinely device-key E2E
(and then a bot must hold a key pair like a client). Until decided, do not cite
"end-to-end" in docs or specs.

### F-02: whose provider key pays for a bot's turn — 2026-09-29
Provider profiles are per-user and per-org today. An unattended bot has no
requesting user in front of it. Working assumption: the bot uses **its own**
profile, created by the owner, so cost lands on the org that enabled it.
Revisit if agents are ever offered per-user.

---

## Shipped decisions, recorded after the fact (this file was adopted late)

## D-01: Envelope encryption, not SQLCipher — 2026-09-25
Trigger: tenancy plan needed at-rest protection per organization.
Options: SQLCipher / per-org SQLite files / envelope on columns and objects.
Chosen: per-org databases plus a per-org data key wrapping content — because
SQLCipher is a native dependency the single-container image cannot carry cheaply,
and a key per file gives the same destruction property.
Lost alternative: SQLCipher — heavier, and it protects the file rather than the
tenant, so one restored file resurrects every tenant.
Cost paid: one more table (`org_keys`) and a key file operators must back up.
Reversibility: painful — sealed objects cannot be un-sealed without the keys.
Correctness policy: object bytes may be stale-named; a key that decrypts nothing
is never acceptable.

## D-02: Move only `document`; replicate identity — 2026-09-26
Trigger: per-org databases were impossible as a full split — SQLite has no
cross-database FKs or views, and `ATTACH` caps at ten.
Options: split everything / split nothing / move content, replicate identity.
Chosen: move `document` only; copy members into the tenant DB as display rows
(`password_hash = '!'`). Authentication stays a control-plane operation, so a
leaked tenant file authenticates nobody.
Lost alternative: `ATTACH` — a ten-tenant ceiling baked into the storage layer.
Cost paid: membership can lag by a cache invalidation; pruning stale members
became a real job (it did, #29).
Reversibility: painful (content has moved).
Correctness policy: replicated display data may be briefly stale; a credential
never may.

## D-03: Content is written before the control commit — 2026-09-26
Trigger: content and its routing row cannot share a transaction across databases.
Chosen: write content first, let the control commit be the commit point, so a
crash leaves an orphan object rather than a row naming content that never landed.
Lost alternative: the reverse order — it produces rows pointing at nothing, which
reads as data loss.
Cost paid: orphan objects need a collector (maintenance releases them).
Reversibility: easy to reason about, painful to change.
Correctness policy: an orphan object is acceptable and reclaimed; a dangling
reference never is.

## D-04: Housekeeping stays on the app's connection — 2026-09-27
Trigger: a busy pool made logins fail as "wrong password" / "not signed in" (#31).
Options: second pooled connection for VACUUM / shorter interruptible statements /
external cron.
Chosen: keep one connection, split every pass into short separately-interruptible
statements, and **defer** rather than fail — a refused step is logged and retried
next tick. Measured: a VACUUM on a second connection succeeds while an application
transaction that already read is open, and that transaction's next write is never
answered at all. That measurement is an ignored test on purpose.
Lost alternative: second connection — it converts a delay into a wedge.
Cost paid: a request can still queue behind one long statement; `VACUUM` remains
the one uninterruptible thing, bounded by `CORTEX_VACUUM_MAX_DB_MB`.
Reversibility: easy.
Correctness policy: compaction may be skipped; an auth answer may never be wrong
because the database was busy.

## D-05: Organization keys are random, never derived — 2026-09-27
Trigger: a derived key would come back to life whenever an operator restored
`CORTEX_DATA_KEY` or the sidecar from an older backup.
Chosen: 32 random bytes per org, wrapped by the master key, stored per row.
Lost alternative: HKDF from the master — zero new moving parts, and it silently
un-shreds on any restore.
Cost paid: a wrapped-key table and a boot-time dependency on the key file.
Reversibility: painful.
Correctness policy: none — this is the decision the feature is named for.

## D-06: Content dedup stops crossing values — 2026-09-27
Trigger: a random nonce makes identical bytes seal differently, and one object
shared by two organizations survives the deletion of either key.
Chosen: accept it. Sharing survives **by reference** (a file copy reuses the
stored name), so copying stays metadata-only; sharing by value is gone.
Lost alternative: deterministic nonce — keeps dedup and destroys shredding.
Cost paid: storage grows by what dedup used to absorb; metering still reports
logical bytes, so disk runs ahead of the console's number.
Reversibility: painful (objects already written).
Correctness policy: an owner-visible byte gap is fine; a shred that does not
shred is not.

## D-07: A read never mints a key — 2026-09-27
Trigger: a read that "helpfully" created a key turns shredded content into a
mystery instead of a clear failure.
Chosen: reads use `org_dek_stored`; writes use `org_dek`. A missing key errors.
Cost paid: one more method pair to keep straight.
Reversibility: easy.
Correctness policy: an unreadable file must say why.

## D-08: A single-organization archive replaces, and refuses beside another org — 2026-09-27
Trigger: per-org export needed a defined restore, and row ids travel unchanged.
Options: merge / renumber ids / refuse unless the target holds nothing else.
Chosen: refuse. Renumbering across fourteen tables is how one tenant inherits
another's rows; a refusal that names the organizations in the way is honest.
Lost alternative: merge — the only option that would have needed a real conflict
engine, and the one that can be added later without breaking archives already
taken.
Cost paid: a tenant archive cannot be added to a running multi-tenant instance.
Reversibility: easy (the guard is one check).
Correctness policy: an operator may have to export the whole instance instead;
silent row collision never.

## D-09: An inline install mints no keys — 2026-09-27
Trigger: the storage-shape canary failed once `place_for` asked for a key before
checking the backend.
Chosen: seal only when content actually becomes an object.
Lost alternative: always mint — a key over plaintext is a shred claim about bytes
the install still holds in the clear.
Cost paid: two facts (`content_sealed()`, `org_keys` count) the console now has to
report, which it does.
Reversibility: easy.
Correctness policy: the console's byte figures are logical, not physical.

## D-10: The fingerprint normalises line endings — 2026-09-27
Trigger: two checkouts of identical data produced different hashes because
`sqlx::migrate!` embeds DDL as checked out (CRLF vs LF).
Chosen: strip `\r` from schema text before hashing.
Lost alternative: pin checkout line endings — would make a canary measure git
configuration instead of stored data.
Cost paid: none; the canary got sharper.
Reversibility: easy.
Correctness policy: re-recording the constant requires proving the delta
(exclude the new table, get the old value back exactly), not asserting it.

## D-11: Bot identity is a kind of user, not a new table — 2026-09-29 (owner may veto)
Trigger: agents must be @mentionable in chat, and every authorization, membership
and audit path already resolves a `users` row.
Options: a parallel `agents` table with its own FKs everywhere / a `kind` column
on `users` / a service-token type with no identity row.
Chosen: `users.kind` (`human` | `bot`) plus a `bots` profile row holding the
persona (instructions, provider profile, skills). Reusing identity means mentions,
permissions, org scoping and audit all work unchanged; the profile table is where
the agent-specific config lives so `users` keeps meaning "an actor".
Lost alternative: a parallel table — cleanest on paper, and it forces a fork in
~105 route patterns' authorization checks, which is where a missed branch becomes
a cross-tenant read.
Cost paid: every human-only surface must now exclude `kind='bot'` explicitly
(seat counts, login, People list, password/2FA flows). That list is the feature's
main risk and is enumerated in the spec.
Reversibility: painful once rows exist, but the column is additive and defaults
to `'human'`.
Correctness policy: a bot's display name may be reused across orgs; a bot may
never be able to authenticate like a person, and its credential column stays
`'!'`.

## D-12: Bots do not consume seats — 2026-09-29 (owner may veto)
Trigger: `org_user_count` is what plans meter against, so a bot would otherwise
cost a paid seat.
Chosen: exclude `kind='bot'` from seat arithmetic; charge their work through the
storage and turn quotas that already exist on the write path.
Lost alternative: charge a seat — simple, and it makes enabling three agents cost
three licences, which will read as a bug.
Cost paid: a plan's "seats" number no longer equals rows in `users`, so the
console has to say which it is showing.
Reversibility: easy (one predicate).
Correctness policy: seat counts must be exact; turn counts may be eventually
consistent.
