# Deploying Cortex to EC2

> Just want it running? You don't need any of this. One command, no domain:
> `docker run -d -p 3030:3030 -v cortex-data:/data ghcr.io/anshace/cortex:latest`
> and open http://localhost:3030 (sign in `admin` / `admin`). This guide is for
> the extra step of serving it on a **public URL with HTTPS**.

One container + SQLite; Caddy in front provides free auto-renewing HTTPS.
Works with a real domain (e.g. `your-domain.example`) or, with no domain, sslip.io
which maps `<ip>.sslip.io` to your IP automatically. The URL is set via `DOMAIN=`.

## 1. EC2 setup (once)

- Launch **Ubuntu 24.04**, `t3.micro` (free tier) or bigger. 8 GB disk is fine.
- Security group inbound: **22** (your IP only), **80**, **443**. Nothing else.
- Allocate an **Elastic IP** and associate it (free while attached; keeps your
  sslip.io name stable across reboots).

## 2. Install Docker on the instance

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # then log out & back in
```

## 3. Copy the project up

From your machine (PowerShell), excluding local build junk:

```powershell
scp -i key.pem -r . ubuntu@<ELASTIC_IP>:cortex   # or git clone on the server
```

No seed file is needed. On first run (an empty database) the server creates a
default owner account — username `admin`, password `admin`. To set your own
instead, put `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` before the first
start (they're ignored once any user exists). **Change the password on first
login** (Settings → Security); after that the owner creates all other accounts
from the owner console.

## 4. Run

```sh
cd cortex
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d --build
```

First build takes a few minutes. Then open `https://<ELASTIC_IP>.sslip.io`.
Caddy fetches the certificate on the first request (needs ports 80+443 open).

### Custom domain (e.g. your-domain.example)

Same command — just point the domain's **A record at the Elastic IP** first,
then set `DOMAIN` to the domain instead of the sslip.io name:

```sh
DOMAIN=your-domain.example docker compose -f docker-compose.prod.yml up -d --build
```

Caddy issues the cert on the first request, so DNS must already resolve to the
box and ports 80+443 must be open. DNS propagation can take a while (up to a day).

## 5. Backups and in-app maintenance

**Do not copy a live `authpad.db` directly.** SQLite uses WAL: recent writes may
still be in `authpad.db-wal`, so `cp` of only the main file can silently omit
data. The owner can download a portable **Data → Export everything (.zip)**
from the console. It includes account password hashes; 2FA seeds travel only in
sealed form, so they are useless to whoever gets the ZIP without also getting the
data key beside the database. Encrypt and protect it anyway — bcrypt hashes are
offline-crackable — and test restoring it on a separate installation.

For a scheduled *database* backup, use SQLite's online backup API instead of
copying the live file. With the compose stack, run this from the project dir
(the volume name normally includes the compose project prefix; check `docker
volume ls` and replace `cortex_cortex-data` below if yours differs):

```sh
mkdir -p "$HOME/backups" && chmod 700 "$HOME/backups"
docker run --rm -v cortex_cortex-data:/data:ro -v "$HOME/backups:/out" \
  alpine sh -c 'apk add --no-cache -q sqlite >/dev/null && \
    sqlite3 "file:/data/authpad.db?mode=ro" ".backup /out/authpad-$(date +%F).db" && \
    chmod 600 /out/authpad-$(date +%F).db && cp /data/authpad.db.key /out/authpad-$(date +%F).key && \
    { [ -d /data/blobs ] && tar -C /data -cf /out/authpad-$(date +%F).blobs.tar blobs; } ; true'
```

Back up the **data key** with the database: restoring a `.db` whose `.key` is gone
leaves every enrolled account unable to pass 2FA.

A backup schedule is optional and **not** needed for database cleanup. The Rust
server runs maintenance itself (five minutes after startup, then every 24 hours):
prunes expired sessions/orphans/old audit entries, checkpoints WAL and VACUUMs
when enough space is reusable. Set `CORTEX_AUDIT_RETENTION_DAYS` (default 180)
to tune audit history. The owner can force a run from **Settings → Storage →
Compact now**; no cron, sidecar, or Docker-specific script is required.

## Updating

```sh
git pull   # or re-scp
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker image prune -f   # reclaim disk from the old image each `--build` leaves behind
```

`--remove-orphans` clears containers from services that no longer exist (e.g. a
leftover dev container). `docker image prune -f` deletes the now-dangling old
images — without it, every `--build` grows disk until the small box fills up.
Data survives rebuilds — it lives in the `cortex-data` volume.

## Deploy via GitHub Actions + GHCR (recommended for a small box)

Compiling Rust on a `t3.micro` (1 GB RAM) takes ~18 min and thrashes. Instead, let
GitHub build the image and have EC2 only **pull** it. The workflow
`.github/workflows/ci.yml` builds on every push to `main` and pushes to this repo's
**private** GHCR package `ghcr.io/anshace/cortex:latest` (tagged `latest` + short
SHA). It uses the built-in `GITHUB_TOKEN` — **no repo secrets to configure.**

Cost on the Free plan (private repo): Actions ~2,000 Linux min/month (a build is
~5–8 min); GHCR 500 MB storage + 1 GB/month egress. The push from Actions doesn't
count against egress — only the EC2 pull does, and the image is small. Prune old
package versions occasionally (GitHub → repo → Packages → cortex → versions).

**One-time on EC2 — log in to GHCR** (private image needs auth to pull). Create a
token at GitHub → Settings → Developer settings → **Personal access token** with
`read:packages` (classic) or a fine-grained token scoped to this repo's packages:
```sh
echo <TOKEN> | docker login ghcr.io -u anshace --password-stdin   # persists in ~/.docker/config.json
```

**Each deploy** (after CI is green — watch the Actions tab):
```sh
cd /opt/cortex
git pull                                                    # get compose/Caddyfile changes
docker compose -f docker-compose.prod.yml pull app          # fetch the new image from GHCR
DOMAIN=your-domain.example docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker image prune -f
```
No `--build`, so EC2 never compiles — the whole deploy is a ~30 s image pull.
Keep `.env` present on the box for `DOMAIN` (it's gitignored and never baked into
the image); accounts persist in the `cortex-data` volume.

## Keeping a small (t3.micro) box healthy

The Rust build needs more RAM than a `t3.micro` (1 GB) has, so it swaps and
crawls. Two things make deploys fast and stop the disk filling:

**1. Add swap once** (turns a thrashing 20-min build into a few minutes):
```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # persist across reboots
free -h   # confirm Swap shows 4Gi
```

**2. Build off-box (best), then just pull the image.** Build the image on your
laptop or CI where RAM is plentiful, then on EC2 only `docker pull` + `up` —
the tiny box never compiles. Either push to a private registry, or copy the
image directly with no registry:
```sh
# on a beefy machine:
docker build -t cortex:latest .
docker save cortex:latest | gzip | ssh ubuntu@<IP> 'gunzip | sudo docker load'
# then on EC2, point the compose `app` service at image: cortex:latest and `up -d` (no --build)
```

## `git pull` as root: SSH deploy key

The repo is root-owned under `/opt/cortex`, so `git pull` runs as **root** — but
the SSH deploy key usually lives in a non-root user's home, so root gets
`git@github.com: Permission denied (publickey)`. Point git at the key explicitly
(one-time, persists in the repo config):
```sh
sudo -i
# find the deploy key (commonly under the user you first cloned as):
ls -la /home/*/.ssh/
cd /opt/cortex
git config core.sshCommand "ssh -i /home/<user>/.ssh/<deploy_key> -o IdentitiesOnly=yes"
git pull
```
Alternatively copy the key to root and use it everywhere:
```sh
sudo mkdir -p /root/.ssh && sudo cp /home/<user>/.ssh/<deploy_key> /root/.ssh/deploy_key
sudo chmod 600 /root/.ssh/deploy_key
printf 'Host github.com\n  IdentityFile /root/.ssh/deploy_key\n  IdentitiesOnly yes\n' | sudo tee -a /root/.ssh/config
```
(Or switch the remote to HTTPS + a Personal Access Token: `git remote set-url origin https://github.com/anshace/cortex.git`.)

## Two-factor (authenticator app)

Any account can turn on TOTP 2FA from **Account & security** (owner console header
gear, or the account menu in the workspace). The owner can reset a user's 2FA from
the Accounts tab (shield icon) if they lose their phone.

**Owner lost their authenticator (break-glass).** The owner is the only account
nobody else can reset, so recovery is host-level — only you control the EC2 box:

```sh
# one-shot: clears 2FA on the owner account, then start normally again
OWNER_2FA_RESET=1 DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d
# sign in with just the password, re-enroll, then bring it back up WITHOUT the flag
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d
```

## Plans and licences (optional)

A deployment can enforce per-organization limits — seats, content storage, and
capabilities such as whiteboards — from a **signed licence verified offline**. It
is entirely opt-in: with no key configured, nothing about plans runs, and a
self-hosted install behaves as if it had no limits. That is deliberate; a product
that phones home to check entitlement is a different product.

```sh
# once, on the machine that issues licences — the private key never ships
cargo run --release --manifest-path rustpad-server/Cargo.toml --bin licence -- keygen
#   prints a base64 private key (save as licence.key) and its hex public key

# per organization, as long as you like
cargo run --release --manifest-path rustpad-server/Cargo.toml --bin licence -- sign \
  --key licence.key --org 7 --plan team --seats 25 --storage 100GB \
  --features whiteboard,chat --exp 2027-01-01
```

Then on the deployment: `CORTEX_LICENCE_PUB` holds the hex public key, and
`CORTEX_LICENCE` the token (comma-separated for several orgs). A licence is
`payload.signature` over the base64 payload, so it cannot be edited — changing one
bit of seats or expiry invalidates it — and a token naming another org can never
be replayed against a different one.

What happens on a bad input is the part worth knowing: an unreadable key or a
forged, expired or missing licence **degrades to the free tier** and logs why; it
never denies reads or export, because a plan is a billing control and not a remote
wipe. The Storage tab of the owner console reports which regime the instance is
in, so an owner is never guessing why a seat or an upload was refused.

## Notes

- `COOKIE_SECURE=1` is set in the prod compose (session cookie is HTTPS-only).
- The owner's session is short-lived (12h) vs 7 days for everyone else.
- **The data key.** TOTP seeds are sealed with AES-256-GCM before they are
  stored, so a leaked database file hands out no working second factors. The key
  is `CORTEX_DATA_KEY` (32 bytes, hex or base64) if you set it, and otherwise a
  `<database>.key` file created beside the database on first boot. Set the env
  var on anything you do not fully control, and back the key up separately from
  the database — **if the key is lost, every enrolled account's 2FA stops
  verifying** and must be reset from the owner console (or the break-glass below).
- **Binary content location.** Uploaded files and pasted images live in the
  database by default. Setting `BLOB_BACKEND=fs` moves them into objects under
  `BLOB_DIR` (default `/data/blobs`), keyed by content hash, so the database
  holds structure and the objects hold bytes; a misconfigured or unwritable
  directory logs a warning and stays inline. **When you turn this on, the object
  directory becomes part of every backup** — `.backup` of the `.db` alone no
  longer contains your users' files, though a console ZIP export still does.
- If you later buy a real domain, point an A record at the Elastic IP and just
  change `DOMAIN=`.

---

# Operations & recovery runbook (single-container)

The current image runs **one container** (app + Caddy + auto-HTTPS). No
docker-compose needed on the box. Everything below is copy-paste, tested against a
real deploy. Volume: `cortex-data`; SQLite uses `/data/authpad.db` plus its temporary WAL/SHM
companions while running; the app runs as **uid 1000**.

## Golden rules (read once, save yourself hours)

1. **x86_64 only.** The image is `linux/amd64`. Launching an ARM/Graviton box
   (`t4g.*`) fails with `no matching manifest for linux/arm64`. Use `t3.*`.
2. **After ANY DB edit from a root container, chown it back:**
   `sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d`
   Root-owned `authpad.db` = app can read but not write → logins fail at session
   creation with `{"error":"server error"}`. This is the #1 gotcha.
3. **Restore order: seed the DB first, THEN start the app.** Starting first
   creates a fresh `admin/admin` DB; restoring after that gets overwritten.
4. **Keep the clock synced** (`sudo timedatectl set-ntp true`) — TOTP allows only
   ±30s drift; a skewed clock breaks every 2FA code.

## Fresh box, from zero

```sh
# swap (optional; not needed since we only pull, never build)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out/in

# run (DOMAIN's A record must point here; security group open on 80+443)
sudo docker run -d --name cortex -p 80:80 -p 443:443 \
  -e DOMAIN=your-domain.example \
  -v cortex-data:/data \
  --restart unless-stopped \
  ghcr.io/anshace/cortex:latest
```

## Deploy / update (after CI is green on `main`)

```sh
sudo docker pull ghcr.io/anshace/cortex:latest
sudo docker rm -f cortex
sudo docker run -d --name cortex -p 80:80 -p 443:443 \
  -e DOMAIN=your-domain.example \
  -v cortex-data:/data --restart unless-stopped ghcr.io/anshace/cortex:latest
sudo docker image prune -f
```

## Backup & restore (WAL-safe)

**Never `cp` a running `authpad.db` by itself:** WAL may contain uncheckpointed
transactions. Use the owner console's **Data → Export everything** to download
an importable ZIP, or take an online SQLite backup while the app keeps running:

```sh
mkdir -p "$HOME/backups" && chmod 700 "$HOME/backups"
sudo docker run --rm -v cortex-data:/data:ro -v "$HOME/backups:/out" alpine sh -c \
  'apk add --no-cache -q sqlite >/dev/null && \
   sqlite3 "file:/data/authpad.db?mode=ro" ".backup /out/authpad-$(date +%F).db" && \
   chmod 600 /out/authpad-$(date +%F).db && cp /data/authpad.db.key /out/authpad-$(date +%F).key && \
   { [ -d /data/blobs ] && tar -C /data -cf /out/authpad-$(date +%F).blobs.tar blobs; } ; true'

# Restore an offline .db backup on a NEW box BEFORE first start:
sudo docker run --rm -v cortex-data:/data -v "$HOME/backups:/in:ro" \
  alpine sh -c 'cp /in/authpad-YYYY-MM-DD.db /data/authpad.db && \
    cp /in/authpad-YYYY-MM-DD.key /data/authpad.db.key'
sudo docker run --rm -v cortex-data:/data alpine chown -R 1000:1000 /data
# Start the app only after the database is in place.
```

Alternatively, restore an owner ZIP from **Data → Import archive** on a test or
fresh instance: it replaces application data transactionally and signs everyone
out. The ZIP contains password hashes, and 2FA seeds only in sealed form; store it
encrypted, and carry the data key with the database — a restore onto an install
with a different `<database>.key` leaves every enrolment unverifiable. Test a
restore periodically. This online backup command is separate
from maintenance: scheduled pruning, WAL checkpointing and conditional VACUUM
run **inside Rust** every 24 hours, with **Settings → Storage → Compact now**
(owner only). A backup cron is optional; no maintenance cron or sidecar is used.

## Inspect / edit the DB directly

```sh
# read (no chown needed):
sudo docker run --rm -v cortex-data:/d alpine sh -c \
  "apk add -q sqlite && sqlite3 -header -column /d/authpad.db 'SELECT id,email,name,role,totp_enabled FROM users;'"
```
After ANY write (below), always: `sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d && sudo docker restart cortex`

## 2FA lockout recovery

2FA lives per user in `users`: `totp_enabled`, plus the seed in
`totp_secret_cipher` — sealed, so editing it by hand is useless. The legacy
`totp_secret` column is kept only for old rows and is NULL once they have been
backfilled at startup. Fix time first, then:

```sh
# owner locked out — break-glass (clears owner/root 2FA on boot):
sudo docker rm -f cortex
sudo docker run -d --name cortex -p 80:80 -p 443:443 -e DOMAIN=your-domain.example \
  -e OWNER_2FA_RESET=1 \
  -v cortex-data:/data --restart unless-stopped ghcr.io/anshace/cortex:latest
# log in password-only, re-enroll, then restart WITHOUT the flag.

# disable 2FA for EVERYONE (nuclear):
sudo docker run --rm -v cortex-data:/d alpine sh -c \
  "apk add -q sqlite && sqlite3 /d/authpad.db 'UPDATE users SET totp_secret=NULL, totp_secret_cipher=NULL, totp_enabled=0;'"
sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d && sudo docker restart cortex
```
A regular user's 2FA is reset by the owner in **Owner console → Accounts → shield**.

## Reset a password / create an owner

Passwords are bcrypt; you can only reset, not recover. `htpasswd` makes the hash.

```sh
# reset an existing user's password (change P and the email):
sudo docker run --rm -i -e P='new-pass' -v cortex-data:/d alpine sh <<'EOF'
apk add -q sqlite apache2-utils
H=$(htpasswd -nbBC 12 x "$P" | cut -d: -f2)
sqlite3 /d/authpad.db "UPDATE users SET password_hash='$H' WHERE email='your-owner@example.com';"
EOF
sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d && sudo docker restart cortex

# create a new owner (role root); username must be lowercase (login lowercases it):
sudo docker run --rm -i -e U='owner2' -e P='new-pass' -v cortex-data:/d alpine sh <<'EOF'
apk add -q sqlite apache2-utils
H=$(htpasswd -nbBC 12 x "$P" | cut -d: -f2)
sqlite3 /d/authpad.db "INSERT INTO users (email,password_hash,role,name) VALUES ('$U','$H','root','Owner');"
EOF
sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d && sudo docker restart cortex
```

## Login troubleshooting (message → cause → fix)

| What you see | Cause | Fix |
|---|---|---|
| "too many attempts; try again later" | brute-force throttle (in-memory) | `sudo docker restart cortex` |
| "That username and password don't match" | wrong password / empty hash | reset password (above) |
| `{"error":"server error"}` after correct creds | DB not writable by app (root-owned file) | `chown -R 1000:1000` the volume, then restart |
| editor stuck "Loading…" / "Disconnected" | old image (Monaco from CDN, blocked by CSP) | `docker pull` latest + redeploy |

## Notes on this image

- `COOKIE_SECURE=1` is set automatically when `DOMAIN` is set (HTTPS).
- Caddy's TLS certs live in the same `cortex-data` volume (`/data/caddy`), so they
  survive restarts and travel with the DB backup's volume.
- App binds IPv4 `0.0.0.0:3030`; Caddy proxies `127.0.0.1:3030` (not `localhost`,
  which resolves to IPv6 `::1` where nothing listens).
