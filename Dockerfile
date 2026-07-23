# Dockerfile — multi-stage build for the OpenClaw cron dashboard
#
# The dashboard reads from ~/.openclaw/cron/ and shells out to `openclaw cron run`.
# Those paths must exist inside the container — the recommended pattern is to
# run the container with the host's ~/.openclaw bind-mounted in:
#
#   docker run --rm \
#     -p 3737:3737 \
#     -v "$HOME/.openclaw:/root/.openclaw:ro" \
#     -v "$HOME/.openclaw/cron-dashboard:/root/.openclaw/cron-dashboard" \
#     --env-file .env.local \
#     openclaw-cron-dashboard
#
# `openclaw` itself must be installed in the container (or reachable via PATH).
# The default stage installs OpenClaw via npm so `openclaw cron run` works.

# ─── Stage 1: deps ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ─── Stage 2: build ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3: runtime ───────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3737
ENV HOSTNAME=0.0.0.0

# Install OpenClaw globally so the rerun endpoint can shell out to it.
RUN npm install -g openclaw@latest || echo "WARN: failed to install openclaw globally — reruns will fail"

# Non-root user
RUN groupadd --gid 1001 nodejs \
 && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nextjs

COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Pre-create dirs that the app writes to (alert state file).
RUN mkdir -p /root/.openclaw/cron-dashboard && chown -R nextjs:nodejs /root/.openclaw

USER nextjs
EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/api/cron',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
