#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="${NOVA_DEPLOY_DIR:-/opt/novajs}"
caddyfile="${deploy_dir}/Caddyfile"
hostname="${CADDY_HOSTNAME:-}"
auth_user="${CADDY_BASIC_AUTH_USER:-}"
auth_hash="${CADDY_BASIC_AUTH_HASH:-}"
ip_literal=0
site_address="$hostname"

if [[ "$hostname" =~ [[:space:]\{\}/,] ]]; then
    printf '%s\n' \
        'CADDY_HOSTNAME contains whitespace or unsupported delimiters.' >&2
    exit 1
fi
if [[ "$auth_user" =~ [[:space:]\{\}] || "$auth_hash" =~ [[:space:]\{\}] ]]; then
    printf '%s\n' \
        'CADDY_BASIC_AUTH_USER/HASH contains whitespace or Caddy delimiters.' \
        >&2
    exit 1
fi

is_ipv4() {
    local octets
    local octet

    [[ "$hostname" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS='.' read -r -a octets <<<"$hostname"
    for octet in "${octets[@]}"; do
        (( 10#$octet <= 255 )) || return 1
    done
}

if [[ -n "$hostname" ]] && is_ipv4; then
    ip_literal=1
elif [[ "$hostname" == *:* && "$hostname" =~ ^[0-9A-Fa-f:]+$ ]]; then
    ip_literal=1
    site_address="[${hostname}]"
fi

umask 022
temporary="$(mktemp "${caddyfile}.XXXXXX")"
cleanup() {
    rm -f "$temporary"
}
trap cleanup EXIT

if [[ -n "$hostname" ]]; then
    cat >"$temporary" <<EOF
{
    default_sni ${hostname}
}

EOF
else
    : >"$temporary"
fi

cat >>"$temporary" <<'EOF'
# This listener is intentionally unauthenticated and HTTP-only. It exists so
# readiness and the game survive a certificate-authority outage.
:80 {
    @novajs_health path /__novajs_health
    respond @novajs_health 204
    encode gzip
    reverse_proxy novajs:8200
}
EOF

if [[ -z "$hostname" ]]; then
    printf '%s\n' \
        'CADDY_HOSTNAME is empty; using unauthenticated HTTP on the IP.' >&2
else
    cat >>"$temporary" <<EOF

https://${site_address} {
EOF
    if [[ "$ip_literal" -eq 1 ]]; then
        cat >>"$temporary" <<'EOF'
    tls {
        issuer acme {
            profile shortlived
            # TLS-ALPN has upstream IP-identifier interoperability bugs.
            # Force HTTP-01, which is served by the listener above.
            disable_tlsalpn_challenge
        }
    }
EOF
    fi
    if [[ -n "$auth_user" && -n "$auth_hash" ]]; then
        cat >>"$temporary" <<EOF
    basic_auth {
        ${auth_user} ${auth_hash}
    }
EOF
    elif [[ -n "$auth_user" || -n "$auth_hash" ]]; then
        printf '%s\n' \
            'Basic Auth is incomplete; serving the configured host without auth.' \
            >&2
    fi
    cat >>"$temporary" <<'EOF'
    encode gzip
    reverse_proxy novajs:8200
}
EOF
fi

install -m 0644 "$temporary" "$caddyfile"
