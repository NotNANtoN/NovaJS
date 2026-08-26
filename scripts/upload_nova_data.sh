#!/usr/bin/env bash
set -euo pipefail

data_dir="${NOVA_DATA_DIR:-nova/Nova_Data}"

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

if [[ ! -d "${data_dir}/Nova Files" \
    || ! -d "${data_dir}/Plug-ins" ]]; then
    printf 'Expected Nova Files and Plug-ins under %s.\n' "$data_dir" >&2
    exit 1
fi

missing=''
for variable in LINODE_BASE_URL LINODE_BUCKET_KEY LINODE_SECRET_KEY \
    LINODE_BUCKET_NAME LINODE_OBJECT_NAME; do
    if [[ -z "${!variable:-}" ]]; then
        missing="${missing} ${variable}"
    fi
done
if [[ -n "$missing" ]]; then
    printf 'Missing Linode Object Storage variables:%s\n' "$missing" >&2
    exit 1
fi

archive_name="${NOVA_DATA_ARCHIVE:-}"
if [[ -z "$archive_name" ]]; then
    archive_name="${LINODE_OBJECT_NAME##*/}"
fi
archive_name="$(basename "$archive_name")"
case "$archive_name" in
    *.tar.gz|*.tgz)
        ;;
    *)
        printf 'NOVA_DATA_ARCHIVE must end in .tar.gz or .tgz.\n' >&2
        exit 1
        ;;
esac

command -v aws >/dev/null 2>&1 || {
    printf '%s\n' 'aws CLI is required to upload Nova data.' >&2
    exit 1
}
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
archive_path="${work_dir}/${archive_name}"

tar --exclude='./.nova-data.sha256' -czf "$archive_path" \
    -C "$data_dir" .
checksum="$(sha256_file "$archive_path")"

printf 'Archive SHA256: %s\n' "$checksum"
printf 'Uploading %s\n' "s3://${LINODE_BUCKET_NAME}/${LINODE_OBJECT_NAME}"

AWS_ACCESS_KEY_ID="$LINODE_BUCKET_KEY" \
    AWS_SECRET_ACCESS_KEY="$LINODE_SECRET_KEY" \
    AWS_DEFAULT_REGION="${LINODE_REGION:-us-east-1}" \
    AWS_EC2_METADATA_DISABLED=true \
    aws s3 cp "$archive_path" \
    "s3://${LINODE_BUCKET_NAME}/${LINODE_OBJECT_NAME}" \
    --endpoint-url "$LINODE_BASE_URL" --only-show-errors

printf 'Set NOVA_DATA_SHA256=%s on the server.\n' "$checksum"
