#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="${NOVA_DEPLOY_DIR:-/opt/novajs}"
env_file="${NOVA_ENV_FILE:-${deploy_dir}/.env}"
retention_days="${NOVA_PLAYER_BACKUP_RETENTION_DAYS:-14}"
object_prefix="${NOVA_PLAYER_BACKUP_PREFIX:-novajs/player-backups}"
work_dir=''
listing_file=''

cleanup() {
    if [[ -n "$work_dir" ]]; then
        rm -rf "$work_dir"
    fi
    if [[ -n "$listing_file" ]]; then
        rm -f "$listing_file"
    fi
}
trap cleanup EXIT

if [[ ! -f "$env_file" ]]; then
    printf 'Missing %s; player backup cannot run.\n' "$env_file" >&2
    exit 1
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [[ ! "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' \
        'NOVA_PLAYER_BACKUP_RETENTION_DAYS must be a positive integer.' >&2
    exit 1
fi
if [[ "$object_prefix" =~ [[:space:]] || "$object_prefix" == *'..'* ]]; then
    printf '%s\n' \
        'NOVA_PLAYER_BACKUP_PREFIX cannot contain whitespace or "..".' >&2
    exit 1
fi
object_prefix="${object_prefix#/}"
object_prefix="${object_prefix%/}"
if [[ -z "$object_prefix" ]]; then
    printf '%s\n' 'NOVA_PLAYER_BACKUP_PREFIX cannot be empty.' >&2
    exit 1
fi

missing=()
for variable in LINODE_BASE_URL LINODE_BUCKET_NAME LINODE_BUCKET_KEY \
    LINODE_SECRET_KEY; do
    if [[ -z "${!variable:-}" ]]; then
        missing+=("$variable")
    fi
done
if (( ${#missing[@]} > 0 )); then
    printf 'Player backup is missing Object Storage values: %s\n' \
        "${missing[*]}" >&2
    exit 1
fi

command -v s3cmd >/dev/null 2>&1 || {
    printf '%s\n' 's3cmd is required for player backups.' >&2
    exit 1
}

endpoint_host="${LINODE_BASE_URL#*://}"
endpoint_host="${endpoint_host%/}"
s3cmd=(
    s3cmd
    "--host=${endpoint_host}"
    "--host-bucket=%(bucket)s.${endpoint_host}"
    "--access_key=${LINODE_BUCKET_KEY}"
    "--secret_key=${LINODE_SECRET_KEY}"
    "--region=${LINODE_REGION:-us-east-1}"
    --no-progress
)
storage_root="s3://${LINODE_BUCKET_NAME}/${object_prefix}"

parse_utc_epoch() {
    local timestamp="$1"

    if date -u -d "$timestamp" +%s >/dev/null 2>&1; then
        date -u -d "$timestamp" +%s
    else
        date -j -u -f '%Y-%m-%d %H:%M:%S' "$timestamp" +%s
    fi
}

prune_backups() {
    local cutoff_epoch
    local modified_date
    local modified_time
    local object_size
    local object_url
    local modified_epoch
    local pruned=0

    cutoff_epoch="$(( $(date -u +%s) - retention_days * 86400 ))"
    listing_file="$(mktemp)"
    "${s3cmd[@]}" ls "${storage_root}/" >"$listing_file"
    while read -r modified_date modified_time object_size object_url; do
        if [[ ! "$modified_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ \
            || ! "$modified_time" =~ ^[0-9]{2}:[0-9]{2}$ \
            || ! "$object_size" =~ ^[0-9]+$ \
            || "$object_url" != "${storage_root}/players-"*.json ]]; then
            continue
        fi
        modified_epoch="$(
            parse_utc_epoch "${modified_date} ${modified_time}:00"
        )"
        if (( modified_epoch < cutoff_epoch )); then
            "${s3cmd[@]}" rm "$object_url"
            printf 'Pruned expired player backup %s.\n' "$object_url"
            ((pruned += 1))
        fi
    done <"$listing_file"
    rm -f "$listing_file"
    listing_file=''
    printf 'Player backup retention pruned %s object(s).\n' "$pruned"
}

if [[ "${1:-}" == '--prune-only' ]]; then
    prune_backups
    exit 0
fi
if (( $# > 0 )); then
    printf 'Usage: %s [--prune-only]\n' "$0" >&2
    exit 2
fi

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' 'docker is required for player backups.' >&2
    exit 1
}
command -v jq >/dev/null 2>&1 || {
    printf '%s\n' 'jq is required to validate player backups.' >&2
    exit 1
}

work_dir="$(mktemp -d)"
snapshot_name="players-$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
snapshot_path="${work_dir}/${snapshot_name}"
object_url="${storage_root}/${snapshot_name}"

# PlayerStore publishes only completed files with rename(2). Opening the
# current path in this read-only mount therefore copies one complete inode.
docker run --rm --network none \
    -v novajs_player_data:/data:ro \
    -v "${work_dir}:/backup" \
    alpine:3.22 \
    sh -c 'test -f /data/players.json \
        && cp /data/players.json "/backup/$1"' sh "$snapshot_name"

jq -e 'type == "object"' "$snapshot_path" >/dev/null
chmod 0600 "$snapshot_path"
"${s3cmd[@]}" put "$snapshot_path" "$object_url"
printf 'Uploaded consistent player backup to %s.\n' "$object_url"
prune_backups
