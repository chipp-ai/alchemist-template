# ── SPA build stage ──
# Builds the Svelte frontend in web/ into web/dist/ so the runtime image
# can serve static assets at /. Without this, visiting the customer URL
# in a browser hits the API's 404 fallback because Hono only has API
# routes registered. The Vite output goes to web/dist/.
FROM node:20-alpine AS web-builder

WORKDIR /web

# Cache dependencies — copy package manifests first so layer caching
# survives source-only changes.
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build the SPA
COPY web/ ./
RUN npm run build

# ── Build stage: cache Deno dependencies ──
FROM denoland/deno:2.3.1 AS builder

WORKDIR /app

# Copy only dependency manifests first for layer caching
COPY deno.json deno.lock ./

# Cache all imports before copying source
RUN deno cache --allow-import deno.json || true

# Copy source
COPY . .

# Pull in the built SPA from the web-builder stage so `deno check` and
# the runtime image both see web/dist/ as part of the application.
COPY --from=web-builder /web/dist ./web/dist

# Typecheck + cache the full application graph
RUN deno check main.ts

# ── Runtime stage ──
FROM denoland/deno:2.3.1

WORKDIR /app

# Avoid running as root
RUN addgroup --system --gid 1001 deno-app && \
    adduser --system --uid 1001 --ingroup deno-app deno-app

# Copy compiled application (includes web/dist/ from the SPA build stage,
# folded in during the Deno builder stage above).
COPY --chown=deno-app:deno-app --from=builder /app .
# Copy cached Deno dependencies. The denoland/deno base image sets
# DENO_DIR=/deno-dir, so the builder's `deno cache` / `deno check` populate
# /deno-dir (NOT /root/.cache/deno). Copy from there and keep the same path so
# the runtime's deno (same DENO_DIR) finds the pre-cached graph and never
# re-downloads at startup.
COPY --chown=deno-app:deno-app --from=builder /deno-dir /deno-dir

USER deno-app

# Health check — matches the /health endpoint in src/api/routes/health/index.ts
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8000}/health || exit 1

EXPOSE 8000

# Run database migrations before starting the server.
# The entrypoint script runs migrate first; if it fails the container exits.
CMD ["sh", "-c", "deno run --allow-net --allow-env --allow-read db/migrate.ts && deno run --allow-net --allow-env --allow-read --allow-ffi --allow-sys main.ts"]
