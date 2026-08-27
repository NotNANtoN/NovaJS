#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="${NOVA_DEPLOY_DIR:-/opt/novajs}"
env_file="${NOVA_ENV_FILE:-${deploy_dir}/.env}"
state_file="${deploy_dir}/.deployed-image-digest"
lock_file='/run/lock/novajs-updater.lock'
manifest_headers=''
caddy_backup=''
caddy_existed=0
deployment_succeeded=0

cleanup() {
    if [[ -n "$manifest_headers" ]]; then
        rm -f "$manifest_headers"
    fi
    if [[ "$deployment_succeeded" -eq 0 && -n "$caddy_backup" ]]; then
        if [[ "$caddy_existed" -eq 1 ]]; then
            install -m 0644 "$caddy_backup" "${deploy_dir}/Caddyfile"
        else
            rm -f "${deploy_dir}/Caddyfile"
        fi
    fi
    if [[ -n "$caddy_backup" ]]; then
        rm -f "$caddy_backup"
    fi
}
trap cleanup EXIT

exec 9>"$lock_file"
if ! flock -n 9; then
    printf '%s\n' 'Another NovaJS updater is already running.'
    exit 0
fi

if [[ ! -f "$env_file" ]]; then
    printf 'Missing %s; bootstrap values have not been created yet.\n' \
        "$env_file" >&2
    exit 1
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [[ -z "${NOVA_IMAGE:-}" ]]; then
    printf 'NOVA_IMAGE is required in %s.\n' "$env_file" >&2
    exit 1
fi

case "$NOVA_IMAGE" in
    ghcr.io/*:*)
        ;;
    *)
        printf 'NOVA_IMAGE must be a ghcr.io image with a tag: %s\n' \
            "$NOVA_IMAGE" >&2
        exit 1
        ;;
esac

image_path="${NOVA_IMAGE#ghcr.io/}"
image_repository="${image_path%:*}"
image_tag="${image_path##*:}"
if [[ -z "$image_repository" || -z "$image_tag" \
    || "$image_repository" =~ [^a-z0-9._/-] \
    || "$image_tag" =~ [^a-zA-Z0-9._-] ]]; then
    printf 'NOVA_IMAGE contains an unsupported repository or tag: %s\n' \
        "$NOVA_IMAGE" >&2
    exit 1
fi

data_dir="${NOVA_DATA_DIR:-/var/lib/novajs/Nova_Data}"
if ! "$deploy_dir/scripts/fetch_nova_data.sh"; then
    printf '%s\n' \
        'Nova data is not ready; the application will not be started.' >&2
    exit 1
fi

# The runtime image uses the unprivileged node user. Archives normally contain
# readable retail files, but normalize permissions after a successful install
# so a restrictive local mode cannot prevent the container from starting.
chmod -R a+rX "$data_dir"

# GHCR answers 401 to an unauthenticated manifest read even for a public
# package, so ask for the anonymous pull token it expects.
registry_token="$(
    curl --fail --silent --show-error \
        --retry 3 --retry-delay 2 --retry-all-errors \
        "https://ghcr.io/token?service=ghcr.io&scope=repository:${image_repository}:pull" |
        jq -r '.token // empty'
)"
if [[ -z "$registry_token" ]]; then
    printf 'Could not obtain an anonymous GHCR pull token for %s.\n' \
        "$image_repository" >&2
    exit 1
fi

manifest_headers="$(mktemp)"
manifest_url="https://ghcr.io/v2/${image_repository}/manifests/${image_tag}"
if ! curl --fail --silent --show-error --location \
    --retry 3 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer ${registry_token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    -D "$manifest_headers" -o /dev/null "$manifest_url"; then
    printf '%s\n' \
        'Could not read the GHCR manifest. The package must be public,' \
        'or the host has no GHCR credential by design.' >&2
    exit 1
fi

remote_digest="$(
    awk 'tolower($1) == "docker-content-digest:" {print $2; exit}' \
        "$manifest_headers" | tr -d '\r'
)"
if [[ ! "$remote_digest" =~ ^sha256:[[:xdigit:]]{64}$ ]]; then
    printf 'GHCR did not return a usable manifest digest for %s.\n' \
        "$NOVA_IMAGE" >&2
    exit 1
fi

caddy_existed=0
if [[ -f "${deploy_dir}/Caddyfile" ]]; then
    caddy_existed=1
    caddy_backup="$(mktemp)"
    cp "${deploy_dir}/Caddyfile" "$caddy_backup"
fi
before_caddy_digest=''
if [[ "$caddy_existed" -eq 1 ]]; then
    before_caddy_digest="$(sha256sum "${deploy_dir}/Caddyfile" | awk '{print $1}')"
fi
"$deploy_dir/scripts/render_caddyfile.sh"
after_caddy_digest="$(sha256sum "${deploy_dir}/Caddyfile" | awk '{print $1}')"
caddy_changed=0
if [[ "$before_caddy_digest" != "$after_caddy_digest" ]]; then
    caddy_changed=1
fi

compose=(docker compose)
service_running() {
    local service="$1"
    local container_id
    local status

    container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
        return 1
    fi
    status="$(docker inspect --format '{{.State.Status}}' "$container_id" \
        2>/dev/null || true)"
    if [[ "$status" != 'running' ]]; then
        return 1
    fi
    if [[ "$service" == 'novajs' ]]; then
        [[ "$(docker inspect --format \
            '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
            "$container_id" 2>/dev/null || true)" == 'healthy' ]]
    fi
}

current_digest=''
if [[ -f "$state_file" ]]; then
    current_digest="$(tr -d '[:space:]' <"$state_file")"
fi

needs_deploy=0
if [[ "$current_digest" != "$remote_digest" ]] \
    || ! service_running novajs \
    || ! service_running caddy \
    || [[ "$caddy_changed" -eq 1 ]]; then
    needs_deploy=1
fi

if [[ "$needs_deploy" -eq 0 ]]; then
    printf 'NovaJS %s is already deployed.\n' "$remote_digest"
    exit 0
fi

printf 'Deploying %s (%s).\n' "$NOVA_IMAGE" "$remote_digest"
"${compose[@]}" pull novajs caddy
"${compose[@]}" up -d --force-recreate --remove-orphans --scale novajs=1

ready=0
for _ in $(seq 1 180); do
    if curl --fail --silent --show-error --max-time 5 \
        http://127.0.0.1:8200/ >/dev/null; then
        ready=1
        break
    fi
    sleep 2
done

if [[ "$ready" -ne 1 ]] || ! service_running caddy; then
    printf '%s\n' 'NovaJS deployment did not become healthy.' >&2
    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --tail=100 novajs caddy >&2 || true
    exit 1
fi

printf '%s\n' "$remote_digest" >"$state_file"
chmod 0644 "$state_file"
deployment_succeeded=1
printf 'NovaJS deployment is healthy at %s.\n' "$remote_digest"
