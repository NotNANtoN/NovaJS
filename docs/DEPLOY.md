# Deploying NovaJS on Linode

This deployment uses one Ubuntu LTS Linode shared VM with a 2 GB memory
limit. Caddy is the only publicly reachable application; it terminates TLS,
requires HTTP Basic Auth, and proxies both HTTP and WebSocket traffic to the
Node server on the private Docker network. The VM's port 8200 is bound only to
loopback for the deployment health check.

The 2 GB shared VM is expected to cost about US$12/month before tax. Keeping
the Object Storage bucket for the source archive adds about US$5/month, so the
normal budget is about US$17/month before tax or any account-specific
overages.

## Verified application paths

These are the paths the checked-in source actually uses:

- `nova/server.ts:51-55` makes the source runtime root `nova/` when running the
  normal `dist/server.js` bundle.
- `nova/server.ts:69-70` reads `NOVA_PORT` first, then
  `nova/settings/server.json:2`, whose default is `8200`. The generic `PORT`
  variable is not read. `NOVA_PORT` is therefore used by Compose without a
  game-source change. The older `README.md:105` description of port `8000` is
  stale relative to this runtime configuration.
- `nova/server.ts:70` combines the runtime root with
  `settings.relativeDataPath`; `nova/settings/server.json:3` sets that value
  to `Nova_Data`. The retail data directory is therefore
  `/app/nova/Nova_Data` in this image, with `Nova Files` and `Plug-ins`
  directly below it. The setting is configurable in `server.json`, but there
  is no `NOVA_DATA_PATH` environment override in the server.
- `nova/server.ts:104-105` passes that directory to the parser worker.
  `nova/src/server/setupRoutes.ts:125-130` additionally expects
  `Nova Files/Nova Music.mp3` there when serving the retail music file.
- `nova/src/server/player_store.ts:49-55` uses `NOVA_PLAYER_DATA` when set;
  otherwise it uses `~/NovaJS-data/players.json`. The Compose service sets it
  to `/var/lib/novajs/players.json` inside a named volume.
- `nova/src/server/player_store.ts:118-125` creates the parent directory and
  initial save file, and `nova/src/server/player_store.ts:318-327` replaces
  the JSON file atomically. There is deliberately no database.
- `nova/server.ts:86` attaches `SocketChannelServer` to the same HTTP server.
  `nova/src/communication/SocketChannelClient.ts:32-38` connects to the
  current host at `ws://` or `wss://` with `playerToken` in the query string.
  Caddy's `reverse_proxy` preserves this WebSocket upgrade.

The only source-level follow-up would be needed by a deployment that insists
on the conventional `PORT` variable: the server would have to read `PORT` (or
Compose would have to keep using `NOVA_PORT`). This deployment uses the
already-supported `NOVA_PORT` and does not modify game source.

## 1. Create the Linode

Install and configure the CLI locally. When prompted, supply the API token
from the Linode Cloud Manager; the token is not stored in this repository.

```bash
pipx install linode-cli
linode-cli configure
ssh-keygen -t ed25519 -f "$HOME/.ssh/novajs" -C novajs-deploy
```

Create the 2 GB shared instance. Linode requires a root password at creation
time, but SSH password login is disabled during first boot and root SSH is
disabled afterwards.

```bash
ROOT_PASSWORD="$(openssl rand -base64 32)"
linode-cli linodes create \
  --label novajs \
  --region us-east \
  --type g6-standard-1 \
  --image linode/ubuntu24.04 \
  --root_pass "$ROOT_PASSWORD" \
  --authorized_keys "$(<"$HOME/.ssh/novajs.pub")"
unset ROOT_PASSWORD
linode-cli linodes list
```

Record the instance's public IPv4 address as `LINODE_HOST`. The Linode
hostname shown for the instance can also be used if it resolves publicly.

## 2. Harden first boot and create the deploy user

Connect once as root using the key supplied at creation:

```bash
ssh -i "$HOME/.ssh/novajs" root@LINODE_HOST
```

Install Docker Compose, the Object Storage client, and the tools used by the
fetch script:

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl docker.io docker-compose-v2 \
  awscli ufw unattended-upgrades zstd
systemctl enable --now docker
systemctl enable --now unattended-upgrades
```

Create a deploy user with the same authorized key, and prepare the host data
directory. The deploy user needs Docker access because the GitHub workflow
updates the Compose application over SSH.

```bash
adduser --disabled-password --gecos "" novadeploy
usermod -aG docker novadeploy
install -d -m 700 -o novadeploy -g novadeploy /home/novadeploy/.ssh
install -m 600 -o novadeploy -g novadeploy \
  /root/.ssh/authorized_keys /home/novadeploy/.ssh/authorized_keys
install -d -m 750 -o novadeploy -g novadeploy /var/lib/novajs
install -d -m 750 -o novadeploy -g novadeploy /opt/novajs/scripts
```

Disable password and root SSH login. Keep the current root session open until
a new deploy-user login succeeds.

```bash
cat >/etc/ssh/sshd_config.d/novajs-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers novadeploy
EOF
sshd -t
systemctl restart ssh
```

Allow only administration and Caddy's public ports through the firewall:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

From a second local terminal, verify the key-only deploy login before closing
the root session:

```bash
ssh -i "$HOME/.ssh/novajs" novadeploy@LINODE_HOST
docker compose version
```

## 3. Install the deployment files on the VM

Run these commands from the NovaJS checkout on the laptop:

```bash
ssh -i "$HOME/.ssh/novajs" novadeploy@LINODE_HOST \
  'mkdir -p /opt/novajs/scripts'
scp -i "$HOME/.ssh/novajs" docker-compose.yml Caddyfile \
  novadeploy@LINODE_HOST:/opt/novajs/
scp -i "$HOME/.ssh/novajs" scripts/fetch_nova_data.sh \
  novadeploy@LINODE_HOST:/opt/novajs/scripts/
ssh -i "$HOME/.ssh/novajs" novadeploy@LINODE_HOST \
  'chmod 0755 /opt/novajs/scripts/fetch_nova_data.sh'
```

The workflow repeats this configuration copy on every deployment, so the
host's `.env` file remains the only manually maintained deployment state.

## 4. Create the host environment file

Create a Basic Auth hash locally or on the VM. The plaintext password is not
put in Caddyfile, Git, or GitHub:

```bash
docker run --rm caddy:2-alpine caddy hash-password \
  --plaintext 'choose-a-long-private-password'
```

Create `/opt/novajs/.env` as `novadeploy`. Use single quotes around the
bcrypt hash because it contains `$` characters. Replace every placeholder,
and do not commit this file.

```bash
umask 077
cat >/opt/novajs/.env <<'EOF'
NOVA_IMAGE=ghcr.io/OWNER/NovaJS:replace-on-first-deploy
NOVA_DATA_DIR=/var/lib/novajs/Nova_Data
CADDY_HOSTNAME=IP-WITH-DASHES.ip.linodeusercontent.com
CADDY_BASIC_AUTH_USER=pilot
CADDY_BASIC_AUTH_HASH='PASTE_THE_BCRYPT_HASH_HERE'

LINODE_BASE_URL=https://us-east-1.linodeobjects.com
LINODE_REGION=us-east-1
LINODE_BUCKET_NAME=novajs-assets
LINODE_OBJECT_NAME=novajs/nova-data.tar.gz
LINODE_BUCKET_KEY=PASTE_OBJECT_STORAGE_ACCESS_KEY
LINODE_SECRET_KEY=PASTE_OBJECT_STORAGE_SECRET_KEY
NOVA_DATA_SHA256=PASTE_ARCHIVE_SHA256_HERE
EOF
chmod 0600 /opt/novajs/.env
```

`CADDY_HOSTNAME` may be the Linode-provided
`<ip-with-dashes>.ip.linodeusercontent.com` hostname; a separate domain
purchase is not required. Caddy obtains the certificate automatically when
DNS resolves to the VM and ports 80 and 443 are reachable.

Create an Object Storage bucket and access key in the Linode Cloud Manager.
Put the bucket's S3-compatible endpoint, bucket name, access key, and secret
key in the four `LINODE_*` entries above. The secret key stays on the VM and
is never passed to GitHub Actions.

## 5. Upload and fetch the retail data once

The retail data is intentionally outside Git. The upload script creates a
gzip tar archive from the local `nova/Nova_Data` directory, excludes the
deployment checksum marker, prints the archive SHA256, and uploads the
archive. Install the AWS-compatible CLI first (`brew install awscli` on
macOS, or `sudo apt-get install awscli` on Ubuntu). Run it from the repository
root on the laptop:

```bash
export NOVA_DATA_DIR="$PWD/nova/Nova_Data"
export LINODE_BASE_URL='https://us-east-1.linodeobjects.com'
export LINODE_REGION='us-east-1'
export LINODE_BUCKET_NAME='novajs-assets'
export LINODE_OBJECT_NAME='novajs/nova-data.tar.gz'
export LINODE_BUCKET_KEY='access-key-from-linode'
export LINODE_SECRET_KEY='secret-key-from-linode'
./scripts/upload_nova_data.sh
```

Copy the printed `Archive SHA256` into `NOVA_DATA_SHA256` in
`/opt/novajs/.env`. Then fetch and verify it on the VM:

```bash
ssh -i "$HOME/.ssh/novajs" novadeploy@LINODE_HOST
set -a
. /opt/novajs/.env
set +a
/opt/novajs/scripts/fetch_nova_data.sh
test -d "$NOVA_DATA_DIR/Nova Files"
test -d "$NOVA_DATA_DIR/Plug-ins"
```

`fetch_nova_data.sh` verifies the archive before extraction and writes
`.nova-data.sha256` only after a complete install. Re-running it with the
same checksum skips the download. To intentionally replace the data, update
the archive and checksum, then remove the old data directory before running
the fetch again.

For a plain archive URL instead of Object Storage, set `NOVA_DATA_URL` and
keep the same required `NOVA_DATA_SHA256`; the URL must end in `.tar.gz` or
`.tar.zst`. The S3 credential variables are not needed in that mode.

Set the ownership of the data directory if it was created by another user:

```bash
chown -R novadeploy:novadeploy /var/lib/novajs/Nova_Data
```

The Compose bind mount is read-only inside the container. The image never
contains `nova/Nova_Data`, any retail asset, or any other binary from that
directory.

## 6. Configure GitHub Actions

Create these repository secrets under **Settings → Secrets and variables →
Actions**:

- `LINODE_HOST`: the VM's public IPv4 address or resolvable hostname.
- `LINODE_SSH_USER`: `novadeploy`.
- `LINODE_SSH_PRIVATE_KEY`: the complete private key corresponding to
  `~/.ssh/novajs.pub`; paste the multiline value without changing it.
- `LINODE_KNOWN_HOSTS`: trusted output of
  `ssh-keyscan -H LINODE_HOST`, after checking the host-key fingerprint in
  the Linode console. This prevents the workflow from accepting an
  unexpected SSH host key.
- `LINODE_DEPLOY_PATH`: `/opt/novajs`.

The workflow does not require a manually created GHCR token. Its `publish`
job uses the built-in `GITHUB_TOKEN` with `packages: write`, and the deploy
job logs in to GHCR on the VM with that short-lived token before pulling the
image. The Caddy hash, Object Storage credentials, hostname, and data
checksum remain in the VM-only `.env`.

The repository must allow the package to be pulled by that workflow token.
If the GHCR package is later made private across repository boundaries, the
host login should be changed to use a separately managed package-read token
instead of weakening the repository permissions.

The workflow runs on pushes to
`feat-performance-and-modernization` and on manual dispatch:

1. Install with Bun 1.4.0, run `npm run typecheck`, and run the full
   supported `npm test` suite.
2. Build the existing Docker build with Bun and push the commit-SHA image to
   GHCR.
3. Copy the Compose/Caddy/fetch configuration over SSH, fetch data if the
   host directory is absent, pull the image, and run
   `docker compose up -d --scale novajs=1`.
4. Poll `http://127.0.0.1:8200/` for up to one minute. This is the app's
   health endpoint because the current server has no dedicated health route.

The typecheck is intentionally non-blocking to match the existing
`.github/workflows/quality.yml` convention. The test command is gating. The
test runner skips five already-documented environment-specific specs; use
`node scripts/one_test.mjs path/to/test_test.ts` for a focused local test.

## 7. Redeploy, inspect, and back up

After the first setup, push a commit to the deployment branch. GitHub Actions
builds and deploys the new image; the workflow does not overwrite `.env` or
the player volume.

```bash
git push origin feat-performance-and-modernization
```

Inspect the service and logs on the VM:

```bash
ssh -i "$HOME/.ssh/novajs" novadeploy@LINODE_HOST
cd /opt/novajs
docker compose ps
docker compose logs --tail=100 novajs
docker compose logs --tail=100 caddy
docker compose logs -f novajs
```

The only persistent game state is the named Docker volume
`novajs_player_data`, containing `players.json`. Create a root-owned backup
directory and a nightly cron entry on the VM:

```bash
sudo install -d -m 700 /var/backups/novajs
sudo crontab -e
```

Add this line to root's crontab. The escaped percent signs are required by
cron:

```cron
17 3 * * * /usr/bin/docker run --rm -v novajs_player_data:/data:ro -v /var/backups/novajs:/backup alpine:3.22 sh -c 'if [ -f /data/players.json ]; then cp /data/players.json "/backup/players-$(date +\%F).json"; fi; find /backup -type f -name "players-*.json" -mtime +30 -delete'
```

The server's authoritative world is in memory, while player progress is
debounced to one atomically replaced JSON file. A nightly copy is sufficient
for this private two-player deployment and avoids introducing a database that
would not hold the in-memory world state.

## Troubleshooting

### Server dies at boot

Run `docker compose logs novajs`. The usual causes are a missing
`Nova Files` or `Plug-ins` directory, an incorrect `NOVA_DATA_DIR`, or a
permission problem. Confirm the data is directly below
`/var/lib/novajs/Nova_Data`, not one directory deeper, and re-run
`/opt/novajs/scripts/fetch_nova_data.sh`. The server uses `NOVA_PORT`, not
`PORT`.

### Health check fails

Check `docker compose ps` and `docker inspect --format '{{json .State.Health}}' \
$(docker compose ps -q novajs)`. From the VM, `curl --fail
http://127.0.0.1:8200/` should return the game HTML. If it does not, inspect
the NovaJS logs and confirm that the parser completed before the HTTP server
started.

### WebSocket fails through the proxy

Open the HTTPS URL and complete the Basic Auth prompt before waiting for the
game to connect. The browser caches the same-origin credentials, so the
WebSocket handshake at `wss://HOST/?playerToken=...` is authorized by the
same Caddy `basic_auth` block. Do not add a separate `/ws` path: NovaJS
attaches WebSocket handling to the root HTTP server. Check
`docker compose logs caddy` and ensure ports 80 and 443 are allowed by UFW.

### Game data is missing

Run:

```bash
set -a
. /opt/novajs/.env
set +a
ls -ld "$NOVA_DATA_DIR" "$NOVA_DATA_DIR/Nova Files" \
  "$NOVA_DATA_DIR/Plug-ins"
/opt/novajs/scripts/fetch_nova_data.sh
```

If the fetch fails before download, check `LINODE_BASE_URL`,
`LINODE_BUCKET_NAME`, `LINODE_OBJECT_NAME`, `LINODE_BUCKET_KEY`, and
`LINODE_SECRET_KEY` without printing their values. If it fails checksum
verification, replace `NOVA_DATA_SHA256` with the value printed by the
upload script and retry.
