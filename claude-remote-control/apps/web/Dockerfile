# 247 Web Dockerfile - Next.js 16 standalone output
# Multi-stage build for pnpm monorepo

# Stage 1: Build
FROM node:22-slim AS build

# Install pnpm via corepack
RUN corepack enable

WORKDIR /app

# Copy workspace manifests and root configs first for dependency caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Build shared package first, then web app
RUN pnpm --filter 247-shared build
RUN pnpm --filter 247-web build

# Stage 2: Runtime
FROM node:22-slim AS runtime

WORKDIR /app

# Copy standalone output from build stage
# server.js is at apps/web/server.js (outputFileTracingRoot = monorepo root)
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

# Expose port
EXPOSE 3001

# Set hostname for logs
ENV HOSTNAME="0.0.0.0"
ENV PORT=3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/ || exit 1

# Start the standalone Next.js server
CMD ["node", "apps/web/server.js"]
