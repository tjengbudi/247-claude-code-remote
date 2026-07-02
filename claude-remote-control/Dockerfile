# 247 Agent Dockerfile
# Runs the agent server with terminal support via tmux

FROM node:20-slim

# Install tmux and other dependencies
RUN apt-get update && apt-get install -y \
    tmux \
    git \
    curl \
    bash \
    locales \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# Install pnpm
RUN npm install -g pnpm

# Create app directory
WORKDIR /app

# Copy package files and root config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/agent/package.json ./apps/agent/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/agent/ ./apps/agent/
COPY packages/shared/ ./packages/shared/

# Build
RUN pnpm build

# Create data directory for SQLite
RUN mkdir -p /root/.247/data

# Allow git to operate on mounted volumes owned by host user (different UID)
RUN git config --global safe.directory '*'

# Expose port
EXPOSE 4678

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:4678/health || exit 1

# Start agent
WORKDIR /app/apps/agent
CMD ["node", "dist/index.js"]
