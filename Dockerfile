# ── Build stage: cache dependencies ──
FROM denoland/deno:2.3.1 AS builder

WORKDIR /app

# Copy only dependency manifests first for layer caching
COPY deno.json deno.lock ./

# Cache all imports before copying source
RUN deno cache --allow-import deno.json || true

# Copy source
COPY . .

# Typecheck + cache the full application graph
RUN deno check main.ts

# ── Runtime stage ──
FROM denoland/deno:2.3.1

WORKDIR /app

# Avoid running as root
RUN addgroup --system --gid 1001 deno-app && \
    adduser --system --uid 1001 --ingroup deno-app deno-app

# Copy compiled application
COPY --chown=deno-app:deno-app --from=builder /app .
# Copy cached Deno dependencies
COPY --chown=deno-app:deno-app --from=builder /root/.cache/deno /home/deno-app/.cache/deno

USER deno-app

# Health check — matches the /health endpoint in src/api/routes/health/index.ts
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8000}/health || exit 1

EXPOSE 8000

# Run database migrations before starting the server.
# The entrypoint script runs migrate first; if it fails the container exits.
CMD ["sh", "-c", "deno run --allow-net --allow-env --allow-read db/migrate.ts && deno run --allow-net --allow-env --allow-read --allow-ffi --allow-sys main.ts"]
