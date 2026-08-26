#!/usr/bin/env bash
set -euo pipefail

data_dir="${NOVA_DATA_DIR:-/var/lib/novajs/Nova_Data}"
expected="${NOVA_DATA_SHA256:-}"
marker="${data_dir}/.nova-data.sha256"

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        printf '%s\n' 'sha256sum or shasum is required.' >&2
        exit 1
    fi
}

if [[ -z "$expected" ]]; then
    printf '%s\n' \
        'NOVA_DATA_SHA256 is required; set it to the archive SHA256.' >&2
    exit 1
fi
if [[ ! "$expected" =~ ^[[:xdigit:]]{64}$ ]]; then
    printf '%s\n' \
        'NOVA_DATA_SHA256 must be exactly 64 hexadecimal characters.' >&2
    exit 1
fi
expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"

if [[ -f "$marker" && -d "${data_dir}/Nova Files" \
    && -d "${data_dir}/Plug-ins" ]]; then
    recorded="$(tr -d '[:space:]' < "$marker")"
    if [[ "$recorded" == "$expected" ]]; then
        printf 'Nova data already matches %s\n' "$expected"
        exit 0
    fi
fi

archive_name=''
if [[ -n "${NOVA_DATA_URL:-}" ]]; then
    archive_name="${NOVA_DATA_URL##*/}"
    archive_name="${archive_name%%\?*}"
    if [[ -z "$archive_name" || "$archive_name" == "$NOVA_DATA_URL" ]]; then
        printf '%s\n' \
            'NOVA_DATA_URL must end in a .tar.gz or .tar.zst filename.' >&2
        exit 1
    fi
else
    missing=''
    for variable in LINODE_BASE_URL LINODE_BUCKET_KEY LINODE_SECRET_KEY \
        LINODE_BUCKET_NAME LINODE_OBJECT_NAME; do
        if [[ -z "${!variable:-}" ]]; then
            missing="${missing} ${variable}"
        fi
    done
    if [[ -n "$missing" ]]; then
        printf 'Set NOVA_DATA_URL, or set these Linode variables:%s\n' \
            "$missing" >&2
        exit 1
    fi
    archive_name="${LINODE_OBJECT_NAME##*/}"
fi

archive_name="$(basename "$archive_name")"
case "$archive_name" in
    *.tar.gz|*.tgz|*.tar.zst|*.tzst)
        ;;
    *)
        printf 'Unsupported archive name %s; use tar.gz or tar.zst.\n' \
            "$archive_name" >&2
        exit 1
        ;;
esac

parent="$(dirname "$data_dir")"
mkdir -p "$parent"
work_dir="$(mktemp -d)"
staging_dir="$(mktemp -d "${parent}/.novajs-data-staging.XXXXXX")"
archive_path="${work_dir}/${archive_name}"
backup_dir=''
original_moved=0
installed_target=0

cleanup() {
    rm -rf "$work_dir"
    if [[ -n "$staging_dir" && -e "$staging_dir" ]]; then
        rm -rf "$staging_dir"
    fi
    if [[ "$installed_target" -eq 0 && -e "$data_dir" ]]; then
        rm -rf "$data_dir"
    fi
    if [[ "$original_moved" -eq 1 && -e "$backup_dir" \
        && ! -e "$data_dir" ]]; then
        mv "$backup_dir" "$data_dir"
    fi
}
trap cleanup EXIT

if [[ -n "${NOVA_DATA_URL:-}" ]]; then
    command -v curl >/dev/null 2>&1 || {
        printf '%s\n' 'curl is required for NOVA_DATA_URL.' >&2
        exit 1
    }
    curl --fail --location --retry 3 --retry-delay 2 \
        --silent --show-error --output "$archive_path" "$NOVA_DATA_URL"
else
    command -v aws >/dev/null 2>&1 || {
        printf '%s\n' 'aws CLI is required for Linode Object Storage.' >&2
        exit 1
    }
    AWS_ACCESS_KEY_ID="$LINODE_BUCKET_KEY" \
        AWS_SECRET_ACCESS_KEY="$LINODE_SECRET_KEY" \
        AWS_DEFAULT_REGION="${LINODE_REGION:-us-east-1}" \
        AWS_EC2_METADATA_DISABLED=true \
        aws s3 cp \
        "s3://${LINODE_BUCKET_NAME}/${LINODE_OBJECT_NAME}" "$archive_path" \
        --endpoint-url "$LINODE_BASE_URL"
fi

actual="$(sha256_file "$archive_path")"
if [[ "$actual" != "$expected" ]]; then
    printf 'Nova data checksum mismatch: expected %s, got %s.\n' \
        "$expected" "$actual" >&2
    exit 1
fi

case "$archive_name" in
    *.tar.gz|*.tgz)
        tar -xzf "$archive_path" -C "$staging_dir"
        ;;
    *.tar.zst|*.tzst)
        tar --zstd -xf "$archive_path" -C "$staging_dir"
        ;;
esac

if [[ ! -d "${staging_dir}/Nova Files" \
    || ! -d "${staging_dir}/Plug-ins" ]]; then
    printf '%s\n' \
        'Archive must contain Nova Files and Plug-ins at its top level.' >&2
    exit 1
fi

if [[ -e "$data_dir" ]]; then
    backup_dir="$(mktemp -d "${parent}/.novajs-data-backup.XXXXXX")"
    rmdir "$backup_dir"
    mv "$data_dir" "$backup_dir"
    original_moved=1
fi
mv "$staging_dir" "$data_dir"
staging_dir=''
printf '%s\n' "$expected" > "${data_dir}/.nova-data.sha256"
chmod 0644 "${data_dir}/.nova-data.sha256"
installed_target=1

if [[ "$original_moved" -eq 1 ]]; then
    rm -rf "$backup_dir"
    backup_dir=''
fi

printf 'Nova data installed at %s\n' "$data_dir"
