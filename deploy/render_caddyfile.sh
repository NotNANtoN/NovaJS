#!/usr/bin/env bash
set -euo pipefail

deploy_dir="${NOVA_DEPLOY_DIR:-/opt/novajs}"
caddyfile="${deploy_dir}/Caddyfile"
hostname="${CADDY_HOSTNAME:-}"
auth_user="${CADDY_BASIC_AUTH_USER:-}"
auth_hash="${CADDY_BASIC_AUTH_HASH:-}"

if [[ "$hostname" =~ [[:space:]\{\}] ]]; then
    printf '%s\n' \
        'CADDY_HOSTNAME contains whitespace or Caddy delimiters.' >&2
    exit 1
fi
if [[ "$auth_user" =~ [[:space:]\{\}] || "$auth_hash" =~ [[:space:]\{\}] ]]; then
    printf '%s\n' \
        'CADDY_BASIC_AUTH_USER/HASH contains whitespace or Caddy delimiters.' \
        >&2
    exit 1
fi

umask 022
temporary="$(mktemp "${caddyfile}.XXXXXX")"
cleanup() {
    rm -f "$temporary"
}
trap cleanup EXIT

cat >"$temporary" <<'EOF'
# This listener is intentionally unauthenticated and HTTP-only. It exists so
# the deployment can probe readiness without knowing the Basic Auth password.
:80 {
    @novajs_health path /__novajs_health
    respond @novajs_health 204
EOF

if [[ -z "$hostname" ]]; then
    cat >>"$temporary" <<'EOF'
    # Internal-testing fallback. Set CADDY_HOSTNAME before exposing the game.
    reverse_proxy novajs:8200
}
EOF
    printf '%s\n' \
        'CADDY_HOSTNAME is empty; using unauthenticated HTTP on the IP.' >&2
elif [[ -z "$auth_user" || -z "$auth_hash" ]]; then
    cat >>"$temporary" <<EOF
}

${hostname} {
    # Set both Basic Auth values to protect the public HTTPS site.
    encode gzip
    reverse_proxy novajs:8200
}
EOF
    printf '%s\n' \
        'Basic Auth is incomplete; serving the configured host without auth.' \
        >&2
else
    cat >>"$temporary" <<EOF
}

${hostname} {
    basic_auth {
        ${auth_user} ${auth_hash}
    }
    encode gzip
    reverse_proxy novajs:8200
}
EOF
fi

install -m 0644 "$temporary" "$caddyfile"
