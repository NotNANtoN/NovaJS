# Deploying NovaJS on Linode

The checked-in deployment is pull-based. GitHub Actions builds the image and
publishes it to GHCR; it does not SSH to the server. A Linode created by the
workflow runs a systemd timer which checks the public `latest` tag every five
minutes and redeploys the Compose application when its manifest digest changes.

GitHub Actions receives the Linode API token and the Nova data-source
configuration needed to bootstrap a new host. The API token must have Linodes
read/write permission. Data secrets are written only into the new host's
0600 `/opt/novajs/.env`; they are not printed by the workflow.

Two facts remain deliberately manual:

- The retail Nova data is copyrighted and is not in Git or the image. Its
  archive is uploaded to Object Storage before the workflow runs.
- A public HTTPS deployment needs a DNS hostname and a Caddy Basic Auth
  bcrypt hash. Those values are also entered only in `/opt/novajs/.env`.

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
4. Cloud-init installs Docker, the Compose plugin, AWS CLI, `zstd`, `ufw`, and
   unattended upgrades. It writes Compose, Caddy, the data-fetch script, the
   updater, and its systemd service and timer under `/opt/novajs`, and creates
   `.env` from the data-source secrets.
5. The host updater fetches and verifies the retail data before it pulls or
   starts NovaJS. It then starts one `novajs` container and Caddy. Player data
   remains in the named `novajs_player_data` volume.
6. The workflow waits for an IPv4 address and polls the public
   `http://INSTANCE_IP/__novajs_health` endpoint for up to 15 minutes.

The workflow has a non-canceling `novajs-deploy` concurrency group. The create
request itself is never retried: if its response is lost, the workflow
re-queries the `novajs` label before deciding whether it can continue. It
never deletes, powers off, or replaces an instance. If the post-create query
does not find exactly one instance, the job fails rather than risking a
duplicate.

Cloud-init only runs automatically when an instance is created. An existing
instance with the `novajs` label is reused but is not retrofitted through the
Linode API. If that instance came from the old SSH-based setup, migrate it
manually in Lish before relying on this workflow; do not delete it to force
recreation.

## One-time setup

Complete these steps in order. The workflow has no SSH key or SSH-based
deployment step; Lish is only needed for later manual host changes.

### 1. Create the Object Storage bucket and read-only key

In Linode Cloud Manager, create the bucket in the Object Storage cluster you
intend to use. Create an access key scoped to that bucket with read-only
permission, and record its access key, secret key, bucket name, and
S3-compatible endpoint. The normal endpoint and region pair is:

```text
LINODE_BASE_URL=https://us-east-1.linodeobjects.com
LINODE_REGION=us-east-1
```

The host only needs to read the archive. The upload script needs write access,
so use a separate temporary bucket-scoped write key for the upload below, then
revoke it. Do not use that write key as `LINODE_BUCKET_KEY` or
`LINODE_SECRET_KEY` in GitHub.

### 2. Build and upload the data archive

The archive must contain `Nova Files` and `Plug-ins` directly at its top
level, not inside an extra directory. Install the AWS CLI on the workstation,
then run this from the repository root with the temporary write key:

```bash
export NOVA_DATA_DIR="$PWD/nova/Nova_Data"
export LINODE_BASE_URL='https://us-east-1.linodeobjects.com'
export LINODE_REGION='us-east-1'
export LINODE_BUCKET_NAME='novajs-assets'
export LINODE_OBJECT_NAME='novajs/nova-data.tar.gz'
export LINODE_BUCKET_KEY='temporary-upload-access-key'
export LINODE_SECRET_KEY='temporary-upload-secret-key'
./scripts/upload_nova_data.sh
```

The script builds the archive, uploads it, and prints `Archive SHA256`.
`NOVA_DATA_SHA256` is the SHA-256 of the archive file itself, not of the
extracted directory. Record that value, revoke the temporary write key, and
use the bucket-scoped read-only key for the GitHub secrets in the next step.

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
`LINODE_BUCKET_KEY` and `LINODE_SECRET_KEY` must be the bucket-scoped
read-only runtime key. `LINODE_REGION` is optional and defaults to
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

## First bootstrap

The API request supplies a random root password and the workflow deliberately
does not print it. A fresh instance receives the data configuration in
`/opt/novajs/.env` and should fetch the archive automatically. To configure
the optional host-only Caddy values, use the Linode Cloud Manager's **Reset
Root Password** operation, then open the instance's **Lish Console** and log
in as `root`. The cloud-init firewall allows only ports 80 and 443, and
password SSH is disabled; Lish is the supported bootstrap access path.

### Configure HTTPS and Basic Auth

For an internal test, leave these values blank. The updater then renders a
plain HTTP Caddy site on the IP without Basic Auth. This is not safe for a
public game: traffic, credentials, and game content are not protected by TLS.

For the normal public configuration, set a hostname that resolves to the
Linode and set both Basic Auth values:

```dotenv
CADDY_HOSTNAME=game.example.com
CADDY_BASIC_AUTH_USER=pilot
CADDY_BASIC_AUTH_HASH='$2a$14$PASTE_THE_BCRYPT_HASH_HERE'
```

Generate the hash without putting the plaintext password in Git or `.env`:

```bash
docker run --rm caddy:2-alpine caddy hash-password \
  --plaintext 'choose-a-long-private-password'
```

Caddy obtains a certificate automatically when the hostname resolves to the
Linode and ports 80 and 443 are reachable. The host updater renders
`/opt/novajs/Caddyfile` from these values; edit `.env`, not the generated
Caddyfile. The hash contains `$` characters, so retain the single quotes in
`.env`.

If only one of the two Basic Auth values is set, the host remains available
without authentication and the updater logs a warning. This is a deliberate
safe-to-boot fallback, but it is not a public deployment configuration.

Start the first deployment immediately:

```bash
chmod 0600 /opt/novajs/.env
systemctl start novajs-updater.service
journalctl -u novajs-updater.service -n 100 -f
```

The service first runs `scripts/fetch_nova_data.sh`, then pulls the public
GHCR image, and only then runs Compose. It waits for the app's existing
`GET /` health check before accepting the deployment. A later workflow run
will find the same instance and the external health job should pass.

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

When a hostname and Basic Auth are configured, ordinary external requests
may redirect from HTTP to HTTPS or return `401` without credentials. The
workflow does not know the private Basic Auth password and therefore does
not probe the game page. The open synthetic readiness path on port 80 is the
bounded external assertion. It does not replace checking the authenticated
HTTPS page and WebSocket from a browser.

## Continuous updates

A successful workflow publishes a new commit-SHA image and moves the public
`latest` tag. The host timer reads the manifest digest from the anonymous
GHCR registry API, compares it with
`/opt/novajs/.deployed-image-digest`, and deploys only when needed. It also
retries an incomplete data bootstrap or stopped container on the next timer
run.

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

## Back up player data

The authoritative game world is in memory. Player progress is debounced to
`players.json` in the named `novajs_player_data` volume. A simple root-owned
nightly copy is still appropriate for this small deployment:

```bash
install -d -m 700 /var/backups/novajs
crontab -e
```

Add this line to root's crontab. The escaped percent signs are required by
cron:

```cron
17 3 * * * /usr/bin/docker run --rm -v novajs_player_data:/data:ro -v /var/backups/novajs:/backup alpine:3.22 sh -c 'if [ -f /data/players.json ]; then cp /data/players.json "/backup/players-$(date +\%F).json"; fi; find /backup -type f -name "players-*.json" -mtime +30 -delete'
```

## Security and operational tradeoffs

- **Public GHCR:** anonymous pulls avoid putting a GHCR credential on the
  host, but the image is readable by anyone. A private package requires a new
  host-side credential and a change to the design.
- **Bootstrap data secrets:** Object Storage keys and the checksum are passed
  through Actions only when a new instance is created, then stored in its
  `.env`. Anyone with root/Lish access to the Linode can read them, so protect
  Cloud Manager access and rotate the keys if the host is compromised.
- **Bootstrap fallback:** blank Caddy values intentionally produce
  unauthenticated HTTP on the IP so missing presentation values do not prevent
  data/bootstrap diagnosis. Use it only on a restricted test instance; set
  the hostname and both auth values before sharing the URL.
- **Readiness endpoint:** `/__novajs_health` is intentionally unauthenticated
  on port 80 and reveals only readiness. It is not an authenticated game
  health check.
- **No CI SSH:** the workflow has no inbound SSH dependency and no host-key
  trust decision. Cloud-init disables password SSH and UFW allows only 80/443.
  If SSH is enabled later for administration, add a key manually, verify the
  fingerprint in Lish or the Linode console, and use strict known-host
  checking. Do not reintroduce an Actions SSH deploy path without reviewing
  the secret model.
- **API token:** the token can create and list Linodes within its Linode
  scope. The workflow never calls a destructive endpoint, but the token itself
  must still be protected and rotated if exposed.
- **No automatic DNS provisioning:** Linode API access does not grant DNS or
  know the desired public hostname. Those Caddy values therefore remain
  explicit host-side steps.

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
5. The configured hostname resolves to the instance and Caddy obtains a
   certificate. Test the authenticated HTTPS page and WebSocket separately.
6. The Actions health job receives HTTP 204 from
   `http://INSTANCE_IP/__novajs_health`.

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
that does not resolve to the VM, or incomplete Basic Auth values. The
updater normalizes data permissions for the unprivileged `node` container
after a successful fetch.

### The workflow health job timed out

The job can inspect only the public readiness path and Linode API state. Use
Lish to inspect `cloud-final` and `novajs-updater` logs. A `401`, HTTP
redirect, or TLS certificate error from the game URL is not itself a failure
of the workflow probe; the probe uses the unauthenticated HTTP readiness
path. If that path is not `204`, Caddy has not started or the host firewall,
cloud-init, data fetch, app health check, or Caddy configuration needs
attention.
