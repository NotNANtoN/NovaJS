FROM node:22-alpine AS builder
WORKDIR /app

# Install turbo globally
RUN npm install -g turbo

# Prune the workspace to only include the nova package and its dependencies
COPY . .
RUN turbo prune --scope=nova --docker

# Installer stage
FROM node:22-alpine AS installer
WORKDIR /app

# Install dependencies
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/package-lock.json ./package-lock.json
RUN npm ci

# Build the project
COPY --from=builder /app/out/full/ .
COPY turbo.json turbo.json
RUN npx turbo run build --filter=nova...

# Runner stage
FROM node:22-alpine AS runner
WORKDIR /app

COPY --from=installer /app .

EXPOSE 8000

WORKDIR /app/packages/nova
CMD ["npm", "run", "start"]
