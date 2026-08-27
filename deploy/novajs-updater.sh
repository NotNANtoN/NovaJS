#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="${NOVA_DEPLOY_DIR:-/opt/novajs}"
env_file="${NOVA_ENV_FILE:-${deploy_dir}/.env}"
state_file="${deploy_dir}/.deployed-image-digest"
lock_file='/run/lock/novajs-updater.lock'
asset_root='/usr/local/share/novajs/deploy'
manifest_headers=''
staging_dir=''
backup_dir=''
extract_container=''
assets_installed=0
deployment_succeeded=0
backup_timer_was_enabled=0
asset_sources=()
asset_targets=()
asset_modes=()
asset_existed=()

restore_assets() {
    local index

    for ((index = ${#asset_targets[@]} - 1; index >= 0; index--)); do
        if [[ "${asset_existed[$index]}" -eq 1 ]]; then
            install -m "${asset_modes[$index]}" \
                "${backup_dir}/${index}" "${asset_targets[$index]}"
        else
            rm -f "${asset_targets[$index]}"
        fi
    done
    systemctl daemon-reload 2>/dev/null || true
    if [[ "$backup_timer_was_enabled" -eq 0 ]]; then
        systemctl disable --now novajs-player-backup.timer \
            >/dev/null 2>&1 || true
    fi
    printf '%s\n' 'Restored the previous NovaJS deployment assets.' >&2
}

cleanup() {
    local exit_status=$?

    trap - EXIT
    set +e
    if [[ -n "$extract_container" ]]; then
        docker rm -f "$extract_container" >/dev/null 2>&1 || true
    fi
    if [[ "$deployment_succeeded" -eq 0 \
        && "$assets_installed" -eq 1 ]]; then
        restore_assets
    fi
    if [[ -n "$manifest_headers" ]]; then
        rm -f "$manifest_headers"
    fi
    if [[ -n "$staging_dir" ]]; then
        rm -rf "$staging_dir"
    fi
    if [[ -n "$backup_dir" ]]; then
        rm -rf "$backup_dir"
    fi
    exit "$exit_status"
}
trap cleanup EXIT

validate_shell_assets() {
    local candidate_dir="$1"
    local script
    local required
    local scripts=()

    required=(
        docker-compose.yml
        Caddyfile
        scripts/fetch_nova_data.sh
        scripts/render_caddyfile.sh
        scripts/novajs-updater.sh
        scripts/backup_player_data.sh
        systemd/novajs-updater.service
        systemd/novajs-updater.timer
        systemd/novajs-player-backup.service
        systemd/novajs-player-backup.timer
    )
    for required in "${required[@]}"; do
        if [[ ! -f "${candidate_dir}/${required}" ]]; then
            printf 'Image deployment assets are missing %s.\n' "$required" >&2
            return 1
        fi
    done

    shopt -s nullglob
    scripts=("${candidate_dir}"/scripts/*.sh)
    shopt -u nullglob
    for script in "${scripts[@]}"; do
        bash -n "$script"
    done
}

is_private_ipv4() {
    local first
    local second

    IFS='.' read -r first second _ _ <<<"$1"
    if (( 10#$first == 0 || 10#$first == 10 || 10#$first == 127 \
        || 10#$first >= 224 )); then
        return 0
    fi
    if (( 10#$first == 169 && 10#$second == 254 )); then
        return 0
    fi
    if (( 10#$first == 172 && 10#$second >= 16 && 10#$second <= 31 )); then
        return 0
    fi
    if (( 10#$first == 192 && 10#$second == 168 )); then
        return 0
    fi
    if (( 10#$first == 100 && 10#$second >= 64 && 10#$second <= 127 )); then
        return 0
    fi
    return 1
}

# Linode binds the public address straight to the instance interface, so the
# source address of the default route is the address players connect to.
detect_public_ipv4() {
    local address

    address="$(
        ip -4 -oneline route get 1.1.1.1 2>/dev/null |
            sed -n 's/.*[[:space:]]src[[:space:]]\{1,\}\([0-9.]\{1,\}\).*/\1/p' |
            head -n 1
    )"
    if [[ ! "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] \
        || is_private_ipv4 "$address"; then
        return 1
    fi
    printf '%s\n' "$address"
}

# HTTPS would otherwise exist only where a human edited .env by hand, so a
# recreated instance would quietly fall back to cleartext.
ensure_caddy_hostname() {
    local file="$1"
    local configured
    local detected
    local temporary

    configured="$(sed -n 's/^[[:space:]]*CADDY_HOSTNAME=//p' "$file" \
        | tail -n 1)"
    if [[ -n "$configured" ]]; then
        return 0
    fi
    if ! detected="$(detect_public_ipv4)"; then
        printf '%s\n' \
            'No public IPv4 was detected; serving plain HTTP only.' >&2
        return 0
    fi

    # mktemp keeps the credentials in .env unreadable to other users.
    temporary="$(mktemp "${file}.XXXXXX")"
    if grep -q '^[[:space:]]*CADDY_HOSTNAME=' "$file"; then
        sed "s|^[[:space:]]*CADDY_HOSTNAME=.*|CADDY_HOSTNAME=${detected}|" \
            "$file" >"$temporary"
    else
        cat "$file" >"$temporary"
        printf 'CADDY_HOSTNAME=%s\n' "$detected" >>"$temporary"
    fi
    mv "$temporary" "$file"
    printf 'Enabled HTTPS for the detected public address %s.\n' "$detected"
}

validate_deploy_assets() {
    local candidate_dir="$1"
    local candidate_compose=(
        docker compose
        --project-directory "$candidate_dir"
        -f "${candidate_dir}/docker-compose.yml"
    )

    validate_shell_assets "$candidate_dir"
    "${candidate_compose[@]}" config --quiet >/dev/null

    local caddy_image
    caddy_image="$("${candidate_compose[@]}" config --images \
        | grep -m1 caddy)"
    if [[ -z "$caddy_image" ]]; then
        printf 'Could not determine the Caddy image to validate with.\n' >&2
        return 1
    fi
    docker pull --quiet "$caddy_image" >/dev/null

    # Deliberately not `docker compose run`: compose names the project after
    # the directory, so validating from a fresh temporary directory created a
    # new docker network every run. Those are never torn down, and once the
    # address pool was subnetted out every later update failed. A plain
    # container needs no project and no network. The Caddy image has no
    # entrypoint, so the binary name is part of the command.
    docker run --rm --network none \
        -v "${candidate_dir}/Caddyfile:/etc/caddy/Caddyfile:ro" \
        "$caddy_image" \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

if [[ "${1:-}" == '--validate-assets' ]]; then
    if [[ $# -ne 2 ]]; then
        printf 'Usage: %s --validate-assets DIRECTORY\n' "$0" >&2
        exit 2
    fi
    validate_deploy_assets "$2"
    exit 0
fi
if [[ "${1:-}" == '--ensure-hostname' ]]; then
    if [[ $# -ne 2 ]]; then
        printf 'Usage: %s --ensure-hostname ENV_FILE\n' "$0" >&2
        exit 2
    fi
    ensure_caddy_hostname "$2"
    exit 0
fi
if (( $# > 0 )); then
    printf 'Usage: %s [--validate-assets DIRECTORY | --ensure-hostname FILE]\n' \
        "$0" >&2
    exit 2
fi

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

ensure_caddy_hostname "$env_file"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [[ -z "${NOVA_IMAGE:-}" ]]; then
    printf 'NOVA_IMAGE is required in %s.\n' "$env_file" >&2
    exit 1
fi

configured_image="$NOVA_IMAGE"
case "$configured_image" in
    ghcr.io/*:*)
        ;;
    *)
        printf 'NOVA_IMAGE must be a ghcr.io image with a tag: %s\n' \
            "$configured_image" >&2
        exit 1
        ;;
esac

image_path="${configured_image#ghcr.io/}"
image_repository="${image_path%:*}"
image_tag="${image_path##*:}"
if [[ -z "$image_repository" || -z "$image_tag" \
    || "$image_repository" =~ [^a-z0-9._/-] \
    || "$image_tag" =~ [^a-zA-Z0-9._-] ]]; then
    printf 'NOVA_IMAGE contains an unsupported repository or tag: %s\n' \
        "$configured_image" >&2
    exit 1
fi

# GHCR answers 401 to an unauthenticated manifest read even for a public
# package, so ask for the anonymous pull token it expects.
token_url='https://ghcr.io/token?service=ghcr.io'
token_url+="&scope=repository:${image_repository}:pull"
registry_token="$(
    curl --fail --silent --show-error \
        --retry 3 --retry-delay 2 --retry-all-errors \
        "$token_url" |
        jq -r '.token // empty'
)"
if [[ -z "$registry_token" ]]; then
    printf 'Could not obtain an anonymous GHCR pull token for %s.\n' \
        "$image_repository" >&2
    exit 1
fi

manifest_headers="$(mktemp)"
manifest_url="https://ghcr.io/v2/${image_repository}/manifests/${image_tag}"
manifest_accept='application/vnd.oci.image.index.v1+json'
manifest_accept+=', application/vnd.docker.distribution.manifest.list.v2+json'
manifest_accept+=', application/vnd.oci.image.manifest.v1+json'
manifest_accept+=', application/vnd.docker.distribution.manifest.v2+json'
if ! curl --fail --silent --show-error --location \
    --retry 3 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer ${registry_token}" \
    -H "Accept: ${manifest_accept}" \
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
        "$configured_image" >&2
    exit 1
fi

target_image="ghcr.io/${image_repository}@${remote_digest}"
printf 'Refreshing deployment assets from %s.\n' "$target_image"
docker pull "$target_image"
staging_dir="$(mktemp -d)"
extract_container="$(docker create "$target_image")"
docker cp "${extract_container}:${asset_root}/." "$staging_dir"
docker rm "$extract_container" >/dev/null
extract_container=''

export NOVA_IMAGE="$target_image"
validate_shell_assets "$staging_dir"
NOVA_DEPLOY_DIR="$staging_dir" \
    bash "${staging_dir}/scripts/render_caddyfile.sh"
validate_deploy_assets "$staging_dir"

asset_sources=(
    "${staging_dir}/docker-compose.yml"
    "${staging_dir}/Caddyfile"
    "${staging_dir}/scripts/fetch_nova_data.sh"
    "${staging_dir}/scripts/render_caddyfile.sh"
    "${staging_dir}/scripts/backup_player_data.sh"
    "${staging_dir}/scripts/novajs-updater.sh"
    "${staging_dir}/systemd/novajs-updater.service"
    "${staging_dir}/systemd/novajs-updater.timer"
    "${staging_dir}/systemd/novajs-player-backup.service"
    "${staging_dir}/systemd/novajs-player-backup.timer"
)
asset_targets=(
    "${deploy_dir}/docker-compose.yml"
    "${deploy_dir}/Caddyfile"
    "${deploy_dir}/scripts/fetch_nova_data.sh"
    "${deploy_dir}/scripts/render_caddyfile.sh"
    "${deploy_dir}/scripts/backup_player_data.sh"
    "${deploy_dir}/scripts/novajs-updater.sh"
    /etc/systemd/system/novajs-updater.service
    /etc/systemd/system/novajs-updater.timer
    /etc/systemd/system/novajs-player-backup.service
    /etc/systemd/system/novajs-player-backup.timer
)
asset_modes=(0644 0644 0755 0755 0755 0755 0644 0644 0644 0644)

backup_dir="$(mktemp -d)"
if systemctl is-enabled --quiet novajs-player-backup.timer 2>/dev/null; then
    backup_timer_was_enabled=1
fi
assets_changed=0
for index in "${!asset_targets[@]}"; do
    if [[ -f "${asset_targets[$index]}" ]]; then
        asset_existed[$index]=1
        cp -p "${asset_targets[$index]}" "${backup_dir}/${index}"
        if ! cmp -s "${asset_sources[$index]}" "${asset_targets[$index]}"; then
            assets_changed=1
        fi
    else
        asset_existed[$index]=0
        assets_changed=1
    fi
done

assets_installed=1
for index in "${!asset_targets[@]}"; do
    if [[ "${asset_targets[$index]}" == "${deploy_dir}/scripts/novajs-updater.sh" \
        || "${asset_targets[$index]}" == /etc/systemd/system/* ]]; then
        continue
    fi
    install -m "${asset_modes[$index]}" \
        "${asset_sources[$index]}" "${asset_targets[$index]}"
done

if ! "${deploy_dir}/scripts/fetch_nova_data.sh"; then
    printf '%s\n' \
        'Nova data is not ready; the application will not be started.' >&2
    exit 1
fi
data_dir="${NOVA_DATA_DIR:-/var/lib/novajs/Nova_Data}"
# The runtime image uses the unprivileged node user. Normalize successful
# archive installs so restrictive source modes cannot block startup.
chmod -R a+rX "$data_dir"

compose=(
    docker compose
    --project-directory "$deploy_dir"
    -f "${deploy_dir}/docker-compose.yml"
)
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
if [[ "$current_digest" != "$remote_digest" \
    || "$assets_changed" -eq 1 ]] \
    || ! service_running novajs \
    || ! service_running caddy; then
    needs_deploy=1
fi

if [[ "$needs_deploy" -eq 1 ]]; then
    printf 'Deploying %s (%s).\n' "$configured_image" "$remote_digest"
    "${compose[@]}" pull caddy
    "${compose[@]}" up -d --force-recreate --remove-orphans --scale novajs=1

    ready=0
    # Probes before the listeners bind are expected, so they stay quiet. The
    # reason is reported once below if the deployment never becomes ready.
    for _ in $(seq 1 180); do
        if curl --fail --silent --max-time 5 \
            http://127.0.0.1:8200/ >/dev/null 2>&1 \
            && curl --fail --silent --max-time 5 \
                http://127.0.0.1/__novajs_health >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 2
    done

    if [[ "$ready" -ne 1 ]] || ! service_running caddy; then
        printf '%s\n' 'NovaJS deployment did not become healthy.' >&2
        curl --fail --silent --show-error --max-time 5 \
            http://127.0.0.1:8200/ >/dev/null || true
        curl --fail --silent --show-error --max-time 5 \
            http://127.0.0.1/__novajs_health >/dev/null || true
        "${compose[@]}" ps >&2 || true
        "${compose[@]}" logs --tail=100 novajs caddy >&2 || true
        exit 1
    fi
fi

# Replace the updater only after this process proved the candidate assets and
# application healthy. A future run can be recovered from an immutable image.
for index in "${!asset_targets[@]}"; do
    if [[ "${asset_targets[$index]}" != "${deploy_dir}/scripts/novajs-updater.sh" \
        && "${asset_targets[$index]}" != /etc/systemd/system/* ]]; then
        continue
    fi
    install -m "${asset_modes[$index]}" \
        "${asset_sources[$index]}" "${asset_targets[$index]}"
done
systemctl daemon-reload
systemctl enable --now novajs-player-backup.timer

printf '%s\n' "$remote_digest" >"$state_file"
chmod 0644 "$state_file"
deployment_succeeded=1
if [[ "$needs_deploy" -eq 1 ]]; then
    printf 'NovaJS deployment is healthy at %s.\n' "$remote_digest"
else
    printf 'NovaJS %s and its host assets are current.\n' "$remote_digest"
fi
