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

## 5. Backups (the whole DB is one file)

```sh
crontab -e
# daily 03:00 snapshot of the SQLite volume:
0 3 * * * docker run --rm -v cortex_cortex-data:/data -v $HOME/backups:/out alpine cp /data/authpad.db /out/authpad-$(date +\%F).db
```

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

## Notes

- `COOKIE_SECURE=1` is set in the prod compose (session cookie is HTTPS-only).
- The owner's session is short-lived (12h) vs 7 days for everyone else.
- The app publishes no ports in prod; only Caddy reaches it on the compose network.
- If you later buy a real domain, point an A record at the Elastic IP and just
  change `DOMAIN=`.

---

# Operations & recovery runbook (single-container)

The current image runs **one container** (app + Caddy + auto-HTTPS). No
docker-compose needed on the box. Everything below is copy-paste, tested against a
real deploy. Volume: `cortex-data`; the whole DB is one file, `/data/authpad.db`;
the app runs as **uid 1000**.

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

## Backup & restore (the DB is one file)

```sh
# daily backup (crontab -e):
0 3 * * * docker run --rm -v cortex-data:/d -v $HOME/backups:/out alpine cp /d/authpad.db /out/authpad-$(date +\%F).db

# manual export (to move boxes):
sudo docker run --rm -v cortex-data:/d -v /var/tmp/alpha:/out alpine cp /d/authpad.db /out/authpad.db

# restore onto a (new) box — seed BEFORE first start, then chown:
sudo docker run --rm -v cortex-data:/d -v /var/tmp/alpha:/in alpine cp /in/authpad.db /d/authpad.db
sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d   # <-- never skip
# then the `docker run ...` above
```

## Inspect / edit the DB directly

```sh
# read (no chown needed):
sudo docker run --rm -v cortex-data:/d alpine sh -c \
  "apk add -q sqlite && sqlite3 -header -column /d/authpad.db 'SELECT id,email,name,role,totp_enabled FROM users;'"
```
After ANY write (below), always: `sudo docker run --rm -v cortex-data:/d alpine chown -R 1000:1000 /d && sudo docker restart cortex`

## 2FA lockout recovery

`totp_secret`/`totp_enabled` live per user in `users`. Fix time first, then:

```sh
# owner locked out — break-glass (clears owner/root 2FA on boot):
sudo docker rm -f cortex
sudo docker run -d --name cortex -p 80:80 -p 443:443 -e DOMAIN=your-domain.example \
  -e OWNER_2FA_RESET=1 \
  -v cortex-data:/data --restart unless-stopped ghcr.io/anshace/cortex:latest
# log in password-only, re-enroll, then restart WITHOUT the flag.

# disable 2FA for EVERYONE (nuclear):
sudo docker run --rm -v cortex-data:/d alpine sh -c \
  "apk add -q sqlite && sqlite3 /d/authpad.db 'UPDATE users SET totp_secret=NULL, totp_enabled=0;'"
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
