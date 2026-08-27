# Deploying NovaJS on Linode

The checked-in deployment is pull-based. GitHub Actions builds the image and
publishes it to GHCR; it does not SSH to the server. A Linode created by the
workflow runs a systemd timer which checks the public `latest` tag every five
minutes and redeploys the Compose application when its manifest digest changes.

GitHub Actions receives the Linode API token and the Nova data-source
configuration needed to bootstrap a new host. The API token must have Linodes
read/write permission. Data secrets are written only into the new host's
0600 `/opt/novajs/.env`; they are not printed by the workflow.

Two facts remain deliberately host-specific:

- The retail Nova data is copyrighted and is not in Git or the image. Its
  archive is uploaded to Object Storage before the workflow runs.
- `CADDY_HOSTNAME` selects the public hostname or IP certificate. A new
  Linode's IP is not known when cloud-init is submitted, so the updater fills
  the value in with the instance's own public IPv4 on its first run. Only a
  DNS name has to be entered by hand.

Until the data is available, the updater does not start either application
container. This makes a first boot fail closed rather than serving a game
without its data.

## What happens automatically

The `Deploy NovaJS` workflow runs on pushes to
`feat-performance-and-modernization` and on manual dispatch:

It uses `curl` against the REST API rather than installing `linode-cli` on a
runner. That keeps the runner dependencies small and makes the
non-retriable create request and post-timeout label recheck explicit.

1. It installs with Bun 1.4.0, runs the supported `npm test` suite, and runs
   `npm run typecheck` as a non-blocking diagnostic.
2. It builds the existing Dockerfile and pushes both
   `ghcr.io/OWNER/NovaJS:<commit-sha>` and
   `ghcr.io/OWNER/NovaJS:latest`. The commit-SHA image remains available for
   rollback.
3. It queries
   `GET /v4/linode/instances?label=novajs&page_size=100`. If exactly one
   instance exists, it uses that instance. If none exists, it makes one
   `POST /v4/linode/instances` call with an Ubuntu 24.04 image, the 2 GB
   `g6-standard-1` plan in `us-east`, and base64-encoded cloud-init in
   `metadata.user_data`.
4. Cloud-init installs Docker, the Compose plugin, `s3cmd`, `zstd`, `ufw`,
   and unattended upgrades. It writes the initial deployment assets and
   updater and backup systemd timers, then creates `.env`.
5. Every updater run pulls the exact manifest digest behind `NOVA_IMAGE`,
   extracts the matching host assets from the image, validates and installs
   them, fetches the retail data, and starts one `novajs` container and Caddy.
   Player data remains in the named `novajs_player_data` volume.
6. The workflow waits for an IPv4 address and polls the public
   `http://INSTANCE_IP/__novajs_health` endpoint for up to 15 minutes.

The workflow has a non-canceling `novajs-deploy` concurrency group. The create
request itself is never retried: if its response is lost, the workflow
re-queries the `novajs` label before deciding whether it can continue. It
never deletes, powers off, or replaces an instance. If the post-create query
does not find exactly one instance, the job fails rather than risking a
duplicate.

Cloud-init only runs automatically when an instance is created. After the
one-time updater bootstrap documented below, an existing instance refreshes
all version-controlled host assets from each image without CI SSH access.

## One-time setup

Complete these steps in order. The workflow has no SSH key or SSH-based
deployment step; Lish is only needed for later manual host changes.

### 1. Create the Object Storage bucket and runtime key

In Linode Cloud Manager, create the bucket in the Object Storage cluster you
intend to use. Create an access key scoped to that bucket with read/write
permission, and record its access key, secret key, bucket name, and
S3-compatible endpoint. The updater reads the retail archive; the nightly
backup needs permission to put and delete player backups. The normal endpoint
and region pair is:

```text
LINODE_BASE_URL=https://us-east-1.linodeobjects.com
LINODE_REGION=us-east-1
```

The same bucket-scoped runtime key can upload the initial archive. A separate
temporary upload key is still preferable if another operator prepares it, but
the host key cannot be read-only because backup upload and retention pruning
would fail visibly in `novajs-player-backup.service`.

### 2. Build and upload the data archive

The archive must contain `Nova Files` and `Plug-ins` directly at its top
level, not inside an extra directory. Install the AWS CLI on the workstation,
then run this from the repository root with a bucket-scoped write key:

```bash
export NOVA_DATA_DIR="$PWD/nova/Nova_Data"
export LINODE_BASE_URL='https://us-east-1.linodeobjects.com'
export LINODE_REGION='us-east-1'
export LINODE_BUCKET_NAME='novajs-assets'
export LINODE_OBJECT_NAME='novajs/nova-data.tar.gz'
export LINODE_BUCKET_KEY='bucket-access-key'
export LINODE_SECRET_KEY='bucket-secret-key'
./scripts/upload_nova_data.sh
```

The script builds the archive, uploads it, and prints `Archive SHA256`.
`NOVA_DATA_SHA256` is the SHA-256 of the archive file itself, not of the
extracted directory. Record that value. If a temporary key uploaded it,
revoke that key and use the bucket-scoped runtime key for GitHub secrets.

### 3. Set the GitHub Actions secrets

Under **Settings → Secrets and variables → Actions**, create these repository
secrets with these exact names:

```text
LINODE_API_TOKEN
NOVA_DATA_SHA256
LINODE_BASE_URL
LINODE_REGION
LINODE_BUCKET_NAME
LINODE_OBJECT_NAME
LINODE_BUCKET_KEY
LINODE_SECRET_KEY
```

`LINODE_API_TOKEN` must have **Linodes: Read/Write** permission; the workflow
also accepts it under the name `LINODE_API_KEY`.

The host installs the public SSH keys published by the GitHub account that
owns the repository (`https://github.com/<owner>.keys`) for root, key-only
access, and opens port 22. Nothing else can log in, and adding or revoking an
admin means changing that account's keys rather than touching the server. To
throw the host away and rebuild it from scratch, run the workflow manually
with **recreate_instance** checked; everything on it, saved pilots included,
is deleted.
`LINODE_BUCKET_KEY` and `LINODE_SECRET_KEY` must be the bucket-scoped runtime
key with read, write, and delete access. `LINODE_REGION` is optional and defaults to
`us-east-1` when omitted. The other seven names are required for a new
instance. Do not add quotes to the secret values. The workflow supports
`/`, `+`, `=`, and `@`, but rejects whitespace, quotes, `#`, newlines, and
other characters that would make the generated `.env` unsafe to source.

Do not create `LINODE_HOST`, SSH key, known-hosts, deploy-path, GHCR, or
`NOVA_DATA_URL` secrets. `NOVA_DATA_URL` remains blank because this setup uses
Linode Object Storage. The Caddy values also remain blank until HTTPS is
configured manually.

### 4. Push the deployment branch

Push `feat-performance-and-modernization` after the bucket, archive, and
secrets are ready:

```bash
git push origin feat-performance-and-modernization
```

The `publish` job builds the image first. The `provision` job then creates a
new `novajs` instance with the Object Storage values in cloud-init. It
validates those values only when no instance with the `novajs` label exists;
an existing instance is reused without rerunning cloud-init.

### 5. Make the GHCR package public after the first successful publish

The VM has no GHCR credential. This is intentional: the host must read its
manifests and pull its images anonymously. After the first `publish` job
succeeds, open the `OWNER/NovaJS` package's **Package settings**, choose
**Change visibility**, and make it public.

The health job may have started before the visibility change and fail to read
the private package. The host timer retries after the package becomes public;
rerun the workflow if you want a fresh external health result. Making the
package public means anyone can pull and inspect the image. A private package
would require a separate host-side read credential, which this design does not
provision.

## HTTP abuse limits

Compose enables per-client HTTP request and response-byte limits. The defaults
provide a 1200-request burst that refills over 60 seconds, and 209715200 bytes
(200 MiB) per rolling 3600000 milliseconds (one hour). A measured cold launch
and 40 seconds of play used 215 requests and about 12 MiB. The defaults leave
ample request headroom and permit about 16 such sessions per hour from one IP,
including a few players sharing one NAT address. A 10-minute byte window would
have allowed one abusive IP to transfer roughly 1.2 GiB per hour.

Set any of these values in `/opt/novajs/.env` and restart through the updater:

```dotenv
NOVA_HTTP_LIMIT_ENABLED=true
NOVA_HTTP_RATE_LIMIT_REQUESTS=1200
NOVA_HTTP_RATE_LIMIT_WINDOW_MS=60000
NOVA_HTTP_BYTE_LIMIT_BYTES=209715200
NOVA_HTTP_BYTE_LIMIT_WINDOW_MS=3600000
NOVA_HTTP_LIMIT_CLIENT_TTL_MS=3900000
NOVA_HTTP_LIMIT_MAX_CLIENTS=4096
```

`NOVA_HTTP_LIMIT_CLIENT_TTL_MS` controls stale-client eviction. Once
`NOVA_HTTP_LIMIT_MAX_CLIENTS` active entries are tracked, previously unseen
addresses receive `429` until capacity becomes available. Invalid, zero, or
negative numeric values stop startup rather than silently weakening the limit.

For unrestricted local single-player development, disable the limiter:

```bash
NOVA_HTTP_LIMIT_ENABLED=false npm run dev
```

The public readiness path at `/__novajs_health` and WebSocket upgrades are
not limited. The readiness response is produced by Caddy without reaching the
Express process.

## First bootstrap

The API request supplies a random root password and the workflow deliberately
does not print it. A fresh instance receives the data configuration in
`/opt/novajs/.env` and should fetch the archive automatically. To configure
host-only values, connect as root with one of the GitHub account's published
SSH keys. Lish and a reset root password are the break-glass alternative.
Password SSH is disabled; the firewall allows key-only SSH and ports 80/443.

### Configure HTTPS on an IP or hostname

HTTPS on the bare IP needs no action. While `CADDY_HOSTNAME` is empty, the
updater reads the source address of the host's default route — on Linode the
public address is bound straight to the instance interface — and writes it into
`/opt/novajs/.env`, so a recreated instance comes back with HTTPS unattended.
A private or absent address is never written, which leaves plain HTTP serving.

Set the value by hand only to override it, for example with a DNS name:

```dotenv
CADDY_HOSTNAME=game.example.com
CADDY_BASIC_AUTH_USER=
CADDY_BASIC_AUTH_HASH=
```

An IP literal gets a Let's Encrypt six-day certificate from the `shortlived`
ACME profile. A DNS hostname gets Caddy's normal certificate configuration
instead. `default_sni` is set to the configured value so clients without SNI
do not make the container select its private Docker IP.

For an IP, the generated HTTPS site is:

```caddyfile
{
    default_sni 66.175.210.138
}

https://66.175.210.138 {
    tls {
        issuer acme {
            profile shortlived
            disable_tlsalpn_challenge
        }
    }
    encode gzip
    reverse_proxy novajs:8200
}
```

The separate `:80` site always serves both `/__novajs_health` and the game
without authentication. It is installed before Caddy starts ACME issuance,
so an ACME outage or rejected order does not take HTTP or deployment health
offline. `disable_tlsalpn_challenge` forces HTTP-01 because Caddy upstream has
had TLS-ALPN interoperability failures for IP identifiers. Port 80 must remain
public for validation.

The Compose image is pinned to `caddy:2.11.4-alpine`. The floating
`caddy:2-alpine` tag currently resolves to the same version and is new enough,
but the explicit patch version makes that verified behavior repeatable.

Leave both Basic Auth values blank for this public game. They remain available
for a private deployment:

```dotenv
CADDY_HOSTNAME=game.example.com
CADDY_BASIC_AUTH_USER=pilot
CADDY_BASIC_AUTH_HASH='$2a$14$PASTE_THE_BCRYPT_HASH_HERE'
```

Generate the hash without putting the plaintext password in Git or `.env`:

```bash
docker run --rm caddy:2.11.4-alpine caddy hash-password \
  --plaintext 'choose-a-long-private-password'
```

If only one of the two Basic Auth values is set, the host remains available
without authentication and the updater logs a warning. This is a deliberate
safe-to-boot fallback. Basic Auth applies only to HTTPS; HTTP remains public
to preserve the certificate-failure fallback.

Start the first deployment immediately:

```bash
chmod 0600 /opt/novajs/.env
systemctl start novajs-updater.service
journalctl -u novajs-updater.service -n 100 -f
```

Confirm issuance and its six-day validity:

```bash
journalctl -u novajs-updater.service -n 200
docker compose -f /opt/novajs/docker-compose.yml logs --tail=200 caddy
openssl s_client -connect 66.175.210.138:443 \
  -servername 66.175.210.138 </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
curl --include http://66.175.210.138/__novajs_health
curl --fail https://66.175.210.138/
```

When no public address can be detected and none is configured, the safe
fallback remains unauthenticated HTTP only, so a host with an unexpected
network layout still serves the game.

### Change the data source later

Changing a data-related GitHub secret does not reconfigure an existing host.
Cloud-init runs only when an instance is created, and the workflow reuses an
existing instance with the `novajs` label without overwriting its `.env`.
Use Lish to edit `/opt/novajs/.env`, update the changed data values, preserve
its `0600` mode, and start the updater:

```bash
chmod 0600 /opt/novajs/.env
systemctl start novajs-updater.service
journalctl -u novajs-updater.service -n 100 -f
```

For a rotated key, update both Object Storage key values. For a new archive,
update `LINODE_OBJECT_NAME` if applicable and `NOVA_DATA_SHA256`; do not
delete the instance just to copy GitHub secrets onto it.

## Find the instance and inspect it

The provisioning job prints the instance ID and IPv4 address. The same
address is visible in Linode Cloud Manager under the `novajs` instance. No
`LINODE_HOST` variable is needed.

From Lish, inspect cloud-init, the updater, and the containers:

```bash
cloud-init status --long
journalctl -u cloud-final.service -n 100
systemctl status novajs-updater.timer
journalctl -u novajs-updater.service -n 100
journalctl -u novajs-updater.service -f
cd /opt/novajs
docker compose ps
docker compose logs --tail=100 novajs
docker compose logs --tail=100 caddy
curl --fail http://127.0.0.1:8200/
curl --include http://127.0.0.1/__novajs_health
```

The external workflow probe expects exactly HTTP `204` from
`/__novajs_health`. The path is implemented by Caddy, not NovaJS; NovaJS has
no dedicated health route. It is useful because Caddy has a
`depends_on: service_healthy` relationship with the app, so Caddy can expose
that path only after the app's local health check has passed.

HTTP never redirects automatically because it is the certificate-failure
fallback. When Basic Auth is configured, only HTTPS returns `401` without
credentials. The workflow still probes the open synthetic readiness path.

## Continuous updates

A successful workflow publishes a new commit-SHA image and moves the public
`latest` tag. On every run, the host timer resolves that tag through the
anonymous GHCR API and pulls the returned digest, not the mutable tag. It
extracts `/usr/local/share/novajs/deploy` from that exact image into staging.
This directory contains Compose, the Caddy bootstrap, helper scripts, the
updater, and systemd units, so host behavior is atomic with application code.

Before installation, every staged shell script must pass `bash -n`, Compose
must pass `docker compose config`, and the rendered Caddyfile must pass
`caddy validate`. The updater backs up every prior target, installs Compose,
Caddy, and non-updater helpers, and deploys the exact image digest. It
replaces its own script and systemd units only after NovaJS and Caddy are
healthy. Any failure first restores the complete previous asset set. `.env`,
retail data, Docker certificate state, and `novajs_player_data` are never
overwritten.

A script can pass `bash -n` and still contain a semantic bug. Deferring the
self-update means such a script cannot interrupt the deployment that installs
it, but it could fail on the next timer run. To recover, extract
`scripts/novajs-updater.sh` from a known-good commit-SHA image with the
bootstrap procedure below, install it, and start the service.

### Bootstrap an existing frozen-cloud-init host once

The already-running host cannot learn this extraction mechanism from its old
updater. After this commit's image is public, connect with a root SSH key
published by the repository owner's GitHub account. Set the IP and verify the
existing Object Storage key has read, write, and delete permission. Then
install only the new updater:

```bash
cd /opt/novajs
sed -i 's/^CADDY_HOSTNAME=.*/CADDY_HOSTNAME=66.175.210.138/' .env
set -a
. ./.env
set +a
docker pull "$NOVA_IMAGE"
bootstrap_container="$(docker create "$NOVA_IMAGE")"
bootstrap_dir="$(mktemp -d)"
docker cp \
  "${bootstrap_container}:/usr/local/share/novajs/deploy/." \
  "$bootstrap_dir"
docker rm "$bootstrap_container"
bash -n "$bootstrap_dir/scripts/novajs-updater.sh"
install -m 0755 "$bootstrap_dir/scripts/novajs-updater.sh" \
  /opt/novajs/scripts/novajs-updater.sh
rm -rf "$bootstrap_dir"
systemctl start novajs-updater.service
journalctl -u novajs-updater.service -n 200 -f
```

This is the only manual retrofit. The new updater installs all remaining
assets and enables the backup timer. Prefer an immutable commit-SHA image for
break-glass recovery; change `NOVA_IMAGE` in `.env` to that SHA tag before
running the same extraction commands.

The updater does not overwrite `.env`, the retail data, or the named player
volume. A failed image pull leaves the currently running containers in place.
If a new image fails its local health check, the old image is still present
but the service remains failed; use the rollback below.

## Roll back to a commit-SHA image

Find the desired full commit SHA in the workflow history or GHCR tags. On the
host, change only `NOVA_IMAGE`:

```dotenv
NOVA_IMAGE=ghcr.io/OWNER/NovaJS:FULL_COMMIT_SHA
```

Then run:

```bash
chmod 0600 /opt/novajs/.env
systemctl start novajs-updater.service
journalctl -u novajs-updater.service -n 100 -f
```

The SHA tag is immutable for normal workflow operation, so the timer will
continue running that version. To resume continuous deployment, change the
line back to `:latest` and start the service again. Rollback does not touch
the retail data or `novajs_player_data`.

## Back up and restore player data

`novajs-player-backup.timer` runs nightly at 03:17 UTC with up to 15 minutes
of jitter. It mounts `novajs_player_data` read-only in a short-lived
`alpine:3.22` container, copies `players.json` to a private temporary
directory, validates that it is a JSON object, and uploads a key such as:

```text
novajs/player-backups/players-2026-08-27T03-22-14Z.json
```

`PlayerStore` writes a new temporary file and publishes it with atomic
`rename(2)`. The backup opens only the published path, so it reads one
complete old or new inode, never a file being modified. It does not stop or
restart the game. Backups older than 14 days are deleted after each successful
upload. Inspect success, upload errors, and pruning in journald:

```bash
systemctl status novajs-player-backup.timer
journalctl -u novajs-player-backup.service -n 100
systemctl start novajs-player-backup.service
```

Defaults can be overridden in `/opt/novajs/.env`:

```dotenv
NOVA_PLAYER_BACKUP_PREFIX=novajs/player-backups
NOVA_PLAYER_BACKUP_RETENTION_DAYS=14
```

To restore, select and download a backup to a root-only host path, stop the
Compose application, replace the file through a one-shot volume mount, and
start the application again:

```bash
cd /opt/novajs
set -a
. ./.env
set +a
endpoint_host="${LINODE_BASE_URL#*://}"
endpoint_host="${endpoint_host%/}"
install -d -m 0700 /var/backups/novajs-restore
s3cmd --host="$endpoint_host" \
  --host-bucket="%(bucket)s.${endpoint_host}" \
  --access_key="$LINODE_BUCKET_KEY" \
  --secret_key="$LINODE_SECRET_KEY" \
  --region="${LINODE_REGION:-us-east-1}" \
  get \
  "s3://${LINODE_BUCKET_NAME}/novajs/player-backups/players-TIMESTAMP.json" \
  /var/backups/novajs-restore/players.json
jq -e 'type == "object"' /var/backups/novajs-restore/players.json
docker compose stop novajs caddy
docker run --rm \
  -v novajs_player_data:/data \
  -v /var/backups/novajs-restore:/restore:ro \
  alpine:3.22 \
  sh -c 'cp /restore/players.json /data/players.json \
    && chmod 0600 /data/players.json \
    && chown 1000:1000 /data/players.json'
docker compose up -d
rm -rf /var/backups/novajs-restore
```

If `NOVA_PLAYER_BACKUP_PREFIX` was changed, use that prefix in the object URL.
Stopping first prevents the in-memory world from immediately overwriting the
restored file. Starting NovaJS reloads it before accepting players.

## Security and operational tradeoffs

- **Public GHCR:** anonymous pulls avoid putting a GHCR credential on the
  host, but the image is readable by anyone. A private package requires a new
  host-side credential and a change to the design.
- **Bootstrap data secrets:** Object Storage keys and the checksum are passed
  through Actions only when a new instance is created, then stored in its
  `.env`. Anyone with root/Lish access to the Linode can read them, so protect
  Cloud Manager access and rotate the keys if the host is compromised.
- **Bootstrap fallback:** when no public address is detected or configured,
  Caddy intentionally serves unauthenticated HTTP so missing presentation
  values do not prevent data/bootstrap diagnosis.
- **Readiness endpoint:** `/__novajs_health` is intentionally unauthenticated
  on port 80 and reveals only readiness. It is not an authenticated game
  health check.
- **No CI SSH:** the workflow has no inbound SSH dependency and no host-key
  trust decision. Cloud-init disables password SSH and allows port 22 only for
  the public keys fetched from the GitHub account. Use strict host-key
  checking for manual administration. Do not add SSH to Actions.
- **API token:** the token can create and list Linodes within its Linode
  scope. The workflow never calls a destructive endpoint, but the token itself
  must still be protected and rotated if exposed.
- **Host-specific TLS name:** the Linode IP is assigned after cloud-init is
  submitted, and API access does not select a DNS name. The updater therefore
  derives the IP on the host itself; `CADDY_HOSTNAME` only has to be set by
  hand for a DNS name.

## What has not been verified here

This change deliberately does not call the Linode API, create a resource, or
run a deployment. The first real run should verify:

1. The API token can list and create Linodes in `us-east` and the selected
   `g6-standard-1` plan is available to the account.
2. `cloud-init status --long` shows completion and
   `systemctl status novajs-updater.timer` shows an active timer.
3. The GHCR package is public and the updater can read the anonymous
   `latest` manifest.
4. The archive checksum and Object Storage values allow a complete fetch, and
   `Nova Files` and `Plug-ins` are directly under
   `/var/lib/novajs/Nova_Data`.
5. Caddy obtains a browser-trusted six-day certificate for the configured IP
   or a normal certificate for a configured hostname. Test HTTPS and its
   WebSocket from a browser.
6. The Actions health job receives HTTP 204 from
   `http://INSTANCE_IP/__novajs_health`.
7. The backup timer uploads an object and can delete an expired test backup.

The app's direct local health check remains `http://127.0.0.1:8200/`; there is
no application `/health` route.

## Troubleshooting

### Cloud-init did not finish

Use Lish:

```bash
cloud-init status --long
journalctl -u cloud-final.service -n 200
```

Check that Ubuntu 24.04 can install `docker.io` and `docker-compose-v2` in
the selected Linode region. The workflow does not retry the create request;
if the instance exists, re-running the workflow reuses it.

### The updater reports missing data

Check variable names without printing values:

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
`LINODE_SECRET_KEY`. If checksum verification fails, replace
`NOVA_DATA_SHA256` with the checksum printed by the upload script.

### The GHCR manifest cannot be read

Confirm the package is public and that `NOVA_IMAGE` is the lower-case
`ghcr.io/OWNER/repository:tag` form. A private package cannot work without a
separate host credential. The workflow's `GITHUB_TOKEN` is used only by the
publish job and is never available to the updater.

### NovaJS or Caddy is unhealthy

```bash
cd /opt/novajs
docker compose ps
docker compose logs --tail=200 novajs caddy
curl --fail http://127.0.0.1:8200/
curl --include http://127.0.0.1/__novajs_health
```

The usual causes are a missing `Nova Files` or `Plug-ins` directory, a
directory one level too deep, restrictive data permissions, a Caddy hostname
that does not resolve to the VM, a configured IP that does not match the
public interface, or incomplete Basic Auth values. The updater normalizes data
permissions for the unprivileged `node` container after a successful fetch.

### The workflow health job timed out

The job can inspect only the public readiness path and Linode API state. Use
Lish to inspect `cloud-final` and `novajs-updater` logs. A TLS certificate
error from the game URL is not itself a failure of the workflow probe; the
probe uses the unauthenticated HTTP readiness path. If that path is not `204`,
Caddy has not started or the host firewall, cloud-init, data fetch, app health
check, or Caddy configuration needs attention.
