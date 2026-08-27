#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
tests_run=0

cleanup() {
    rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    local file="$1"
    local expected="$2"

    grep -Fq -- "$expected" "$file" \
        || fail "${file} does not contain: ${expected}"
}

assert_not_contains() {
    local file="$1"
    local unexpected="$2"

    if grep -Fq -- "$unexpected" "$file"; then
        fail "${file} unexpectedly contains: ${unexpected}"
    fi
}

render_case() {
    local name="$1"
    local hostname="$2"
    local destination="${work_dir}/${name}"

    mkdir -p "$destination"
    CADDY_HOSTNAME="$hostname" \
        NOVA_DEPLOY_DIR="$destination" \
        bash "$repo_root/deploy/render_caddyfile.sh" 2>/dev/null
    assert_contains "${destination}/Caddyfile" ':80 {'
    assert_contains "${destination}/Caddyfile" \
        '@novajs_health path /__novajs_health'
    assert_contains "${destination}/Caddyfile" \
        'respond @novajs_health 204'
    assert_contains "${destination}/Caddyfile" \
        'reverse_proxy novajs:8200'
    assert_contains "${destination}/Caddyfile" 'encode gzip'
}

test_caddy_rendering() {
    render_case empty ''
    assert_not_contains "${work_dir}/empty/Caddyfile" 'default_sni'
    assert_not_contains "${work_dir}/empty/Caddyfile" 'https://'

    render_case hostname 'game.example.com'
    assert_contains "${work_dir}/hostname/Caddyfile" \
        'default_sni game.example.com'
    assert_contains "${work_dir}/hostname/Caddyfile" \
        'https://game.example.com {'
    assert_not_contains "${work_dir}/hostname/Caddyfile" 'profile shortlived'

    render_case ip '66.175.210.138'
    assert_contains "${work_dir}/ip/Caddyfile" \
        'default_sni 66.175.210.138'
    assert_contains "${work_dir}/ip/Caddyfile" \
        'https://66.175.210.138 {'
    assert_contains "${work_dir}/ip/Caddyfile" 'profile shortlived'
    assert_contains "${work_dir}/ip/Caddyfile" \
        'disable_tlsalpn_challenge'
    ((tests_run += 1))
}

test_asset_validation_rejects_bad_compose() {
    local fixture="${work_dir}/assets"
    local fake_bin="${work_dir}/asset-bin"
    local docker_log="${work_dir}/asset-docker.log"

    mkdir -p "${fixture}/scripts" "${fixture}/systemd" "$fake_bin"
    cp "$repo_root/docker-compose.yml" "$repo_root/Caddyfile" "$fixture/"
    cp "$repo_root/scripts/fetch_nova_data.sh" "${fixture}/scripts/"
    cp "$repo_root/deploy/render_caddyfile.sh" "${fixture}/scripts/"
    cp "$repo_root/deploy/novajs-updater.sh" "${fixture}/scripts/"
    cp "$repo_root/deploy/backup_player_data.sh" "${fixture}/scripts/"
    cp "$repo_root/deploy/"*.service "$repo_root/deploy/"*.timer \
        "${fixture}/systemd/"
    cat >"${fake_bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$DOCKER_LOG"
if [[ " $* " == *' config --quiet '* ]]; then
    exit 42
fi
exit 0
EOF
    chmod +x "${fake_bin}/docker"

    if PATH="${fake_bin}:${PATH}" DOCKER_LOG="$docker_log" \
        NOVA_IMAGE='ghcr.io/example/novajs:latest' \
        "$repo_root/deploy/novajs-updater.sh" \
        --validate-assets "$fixture"; then
        fail 'asset validation accepted a broken Compose file'
    fi
    assert_contains "$docker_log" 'config --quiet'
    assert_not_contains "$docker_log" 'pull caddy'
    ((tests_run += 1))
}

hostname_case() {
    local name="$1"
    local route_source="$2"
    local configured="$3"
    local mode="${4:-0644}"
    local fake_bin="${work_dir}/${name}-bin"
    local env_file="${work_dir}/${name}.env"

    mkdir -p "$fake_bin"
    cat >"${fake_bin}/ip" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -z "$ROUTE_SOURCE" ]]; then
    exit 1
fi
printf 'local 1.1.1.1 dev eth0 src %s uid 0 \cache\n' "$ROUTE_SOURCE"
EOF
    chmod +x "${fake_bin}/ip"
    printf 'NOVA_IMAGE=ghcr.io/example/novajs:latest\nCADDY_HOSTNAME=%s\n' \
        "$configured" >"$env_file"
    chmod "$mode" "$env_file"

    PATH="${fake_bin}:${PATH}" ROUTE_SOURCE="$route_source" \
        "$repo_root/deploy/novajs-updater.sh" \
        --ensure-hostname "$env_file" >/dev/null 2>&1
    printf '%s\n' "$env_file"
}

test_hostname_detection() {
    local env_file

    env_file="$(hostname_case public '66.175.210.138' '')"
    assert_contains "$env_file" 'CADDY_HOSTNAME=66.175.210.138'

    # A hand-set hostname outranks whatever the interface reports.
    env_file="$(hostname_case configured '66.175.210.138' 'game.example.com')"
    assert_contains "$env_file" 'CADDY_HOSTNAME=game.example.com'
    assert_not_contains "$env_file" '66.175.210.138'

    # A private or missing address must not become a certificate subject.
    env_file="$(hostname_case private '192.168.1.20' '')"
    assert_contains "$env_file" 'CADDY_HOSTNAME='
    assert_not_contains "$env_file" '192.168.1.20'

    env_file="$(hostname_case carrier '100.64.3.9' '')"
    assert_not_contains "$env_file" '100.64.3.9'

    env_file="$(hostname_case absent '' '')"
    assert_contains "$env_file" 'CADDY_HOSTNAME='

    # Credentials live in this file, so rewriting it must not widen access.
    env_file="$(hostname_case perms '66.175.210.138' '' 0600)"
    assert_contains "$env_file" 'CADDY_HOSTNAME=66.175.210.138'
    local mode
    mode="$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file")"
    if [[ "$mode" != '600' ]]; then
        fail "${env_file} became mode ${mode} instead of 600"
    fi
    ((tests_run += 1))
}

test_backup_retention() {
    local fake_bin="${work_dir}/backup-bin"
    local env_file="${work_dir}/backup.env"
    local s3_log="${work_dir}/s3cmd.log"
    local old_date
    local recent_date
    local old_url
    local recent_url

    mkdir -p "$fake_bin"
    old_date="$(
        date -u -v-20d +%F 2>/dev/null \
            || date -u -d '20 days ago' +%F
    )"
    recent_date="$(
        date -u -v-2d +%F 2>/dev/null \
            || date -u -d '2 days ago' +%F
    )"
    old_url='s3://novajs-assets/novajs/player-backups/players-old.json'
    recent_url='s3://novajs-assets/novajs/player-backups/players-recent.json'
    cat >"$env_file" <<'EOF'
LINODE_BASE_URL=https://us-east-1.linodeobjects.com
LINODE_REGION=us-east-1
LINODE_BUCKET_NAME=novajs-assets
LINODE_BUCKET_KEY=test-key
LINODE_SECRET_KEY=test-secret
NOVA_PLAYER_BACKUP_RETENTION_DAYS=14
NOVA_PLAYER_BACKUP_PREFIX=novajs/player-backups
EOF
    cat >"${fake_bin}/s3cmd" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
    if [[ "$argument" == 'ls' ]]; then
        printf '%s 03:17 100 %s\n' "$OLD_DATE" "$OLD_URL"
        printf '%s 03:17 100 %s\n' "$RECENT_DATE" "$RECENT_URL"
        exit 0
    fi
    if [[ "$argument" == 'rm' ]]; then
        printf '%s\n' "${*: -1}" >>"$S3_LOG"
        exit 0
    fi
done
exit 0
EOF
    chmod +x "${fake_bin}/s3cmd"

    PATH="${fake_bin}:${PATH}" \
        NOVA_ENV_FILE="$env_file" \
        OLD_DATE="$old_date" RECENT_DATE="$recent_date" \
        OLD_URL="$old_url" RECENT_URL="$recent_url" S3_LOG="$s3_log" \
        "$repo_root/deploy/backup_player_data.sh" --prune-only \
        >/dev/null
    assert_contains "$s3_log" "$old_url"
    assert_not_contains "$s3_log" "$recent_url"
    ((tests_run += 1))
}

test_caddy_rendering
test_asset_validation_rejects_bad_compose
test_hostname_detection
test_backup_retention
printf 'Ran %s deployment test groups; 0 failed.\n' "$tests_run"
