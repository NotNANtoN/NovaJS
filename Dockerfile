FROM oven/bun:1.4.0 AS build

WORKDIR /app

COPY package.json bun.lock ./
# The package's prepare hook installs local Git hooks, which are not part of
# the container and must not run during dependency installation.
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
# Invoke the checked-in build script with the Bun runtime in this stage.
RUN bun scripts/build.mjs

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NOVA_PORT=8200 \
    NOVA_PLAYER_DATA=/var/lib/novajs/players.json

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/nova/src/index.html ./nova/src/index.html
COPY --from=build /app/nova/settings ./nova/settings

RUN mkdir -p /app/nova/objects /var/lib/novajs \
    && chown -R node:node /app /var/lib/novajs

USER node

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8200/').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/server.js"]
