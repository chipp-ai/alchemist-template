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

# ── Landing site build stage ──
# Builds the static Astro landing site in landing/ into landing/dist/. app.ts
# serves it at "/" and the SPA at /app (src/lib/landing-site.ts). `npm run
# build` also runs scripts/aeo-check.mjs, so a page that breaks an AEO rule
# fails the image build. The site reads brand tokens from
# web/src/design/design.json at build time, so that file comes along.
FROM node:22-alpine AS landing-builder

WORKDIR /src/landing
COPY landing/package.json landing/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY landing/ ./
COPY web/src/design/design.json /src/web/src/design/design.json
RUN npm run build

# ── Build stage: cache Deno dependencies ──
FROM denoland/deno:2.9.7 AS builder

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
COPY --from=landing-builder /src/landing/dist ./landing/dist

# Typecheck + cache the full application graph
# The storefront route modules load by discovery at boot (see
# src/services/storefront/router.ts), so check them explicitly too.
RUN deno check main.ts src/services/storefront/

# ── Runtime stage ──
FROM denoland/deno:2.9.7

WORKDIR /app

# Avoid running as root. groupadd/useradd, not addgroup/adduser: the Deno 2.7
# base image is Debian trixie, which no longer ships the adduser wrappers.
RUN groupadd --system --gid 1001 deno-app && \
    useradd --system --uid 1001 --gid deno-app --home-dir /home/deno-app \
      --create-home --shell /usr/sbin/nologin deno-app

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
