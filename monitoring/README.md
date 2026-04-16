# Monitoring Stack

Self-healing observability for Alchemist AI tenant applications. Errors flow from customer apps through Loki to Grafana, which fires webhooks to the Alchemist platform dispatcher. The dispatcher creates bug tickets that Claude Code autonomously fixes and ships as PRs.

## The Self-Healing Loop

```
Customer App (error logged)
       |
       v
  Promtail sidecar (scrapes pod logs)
       |
       v
  Shared Loki instance (stores structured logs)
       |
       v
  Grafana alert rules (evaluate LogQL every 1 min)
       |
       v
  Webhook to Alchemist dispatcher
       |
       v
  Dispatcher creates a ticket (bug or performance)
       |
       v
  Claude Code picks up the ticket
       |
       v
  Autonomous fix -> PR -> review -> merge -> deploy
```

The loop is fully automated. No human intervention is required for common error patterns. Alerts carry the `tenant_id` and `app_slug` labels so the dispatcher knows which customer's codebase to patch.

## Label Schema

Every log line emitted by the structured logger (`src/lib/logger.ts`) includes these fields in production NDJSON output:

| Field | Loki Treatment | Description |
|-------|----------------|-------------|
| `tenant_id` | **Stream label** (indexed) | UUID of the customer org. Set via `ALCHEMIST_TENANT_ID` env var. |
| `app_slug` | **Stream label** (indexed) | Human-readable project slug. Set via `ALCHEMIST_APP_SLUG` env var. |
| `level` | **Stream label** (indexed) | Log level: `debug`, `info`, `warn`, `error`. |
| `source` | Structured metadata | Domain of the log: `startup`, `db`, `billing`, `auth`, etc. |
| `feature` | Structured metadata | Sub-feature within a domain. Optional. |
| `error_message` | Structured metadata | Error message string (when an Error is passed as 3rd arg). |
| `error_stack` | Structured metadata | Stack trace (when an Error is passed as 3rd arg). |
| `version` | Structured metadata | Git SHA (first 7 chars) of the running build. |
| `msg` | Log line content | Human-readable message. |
| `ts` | Log line content | ISO 8601 timestamp. |

**Stream labels** (`tenant_id`, `app_slug`, `level`) are promoted by Promtail and indexed by Loki for fast filtering. All other fields are extracted at query time via `| json` in LogQL.

**Critical:** `source` and `feature` are NOT stream labels. They are high-cardinality and would cause label explosion in Loki. They are extracted at query time.

## Environment Variables

Two env vars must be set on every deployed customer pod:

| Variable | Example | Description |
|----------|---------|-------------|
| `ALCHEMIST_TENANT_ID` | `c740b0c6-1234-...` | UUID assigned when the customer signs up. |
| `ALCHEMIST_APP_SLUG` | `acme-crm` | Slug of the deployed app. Matches the repo name. |

These are injected by the Alchemist platform at provisioning time. They flow into every log line via the logger module.

The monitoring infrastructure also requires:

| Variable | Set On | Description |
|----------|--------|-------------|
| `LOKI_URL` | Promtail sidecar | URL of the shared Loki push endpoint (e.g., `http://loki-gateway.monitoring.svc.cluster.local:3100`). |
| `ALCHEMIST_DISPATCHER_URL` | Grafana contact point | Base URL of the Alchemist platform dispatcher API. |
| `ALCHEMIST_DISPATCHER_TOKEN` | Grafana contact point | Bearer token for authenticating webhook calls to the dispatcher. |

## Directory Structure

```
monitoring/
  README.md                                 # This file
  promtail/
    config.yml                              # Promtail sidecar config
  grafana/
    alerts/
      error-rate.yml                        # Error rate + spike alerts
      slow-queries.yml                      # Slow DB queries + pool abuse
      health.yml                            # App down + startup failure
    contact-points/
      alchemist-dispatcher.yml              # Webhook to dispatcher
    dashboards/
      tenant-health.json                    # Per-tenant health dashboard
  k8s/
    promtail-sidecar.yml                    # K8s sidecar + ConfigMap
```

## Alert Rules

| Alert | Severity | Ticket Type | Fires When |
|-------|----------|-------------|------------|
| Tenant Error Rate | critical | bug | > 5 errors in 5 minutes |
| Tenant Error Spike | critical | bug | > 20 errors in 1 minute (immediate) |
| Tenant Slow DB Queries | warning | performance | > 3 queries over 2s in 5 minutes |
| Tenant DB Pool Abuse | critical | performance | > 5 pool/statement timeouts in 5 minutes (immediate) |
| Tenant App Down | critical | bug | Zero logs for 3 minutes |
| Tenant Startup Failure | critical | bug | Any startup error (immediate) |

## Testing Alerts Locally

### 1. Run Loki + Grafana locally

```bash
docker compose -f monitoring/docker-compose.yml up -d
```

(Create a `docker-compose.yml` in `monitoring/` with Loki + Grafana + Promtail if you need local testing. Not included in the template -- the shared cluster handles this in production.)

### 2. Inject test log lines

```bash
# Simulate an error burst (triggers Tenant Error Rate)
for i in $(seq 1 10); do
  echo '{"level":"error","ts":"2026-01-01T00:00:00Z","msg":"test error","tenant_id":"test-tenant","app_slug":"test-app","source":"test"}' \
    | curl -s -X POST http://localhost:3100/loki/api/v1/push \
      -H "Content-Type: application/json" \
      -d @- 2>/dev/null
done

# Simulate a slow query (triggers Tenant Slow DB Queries)
echo '{"level":"warn","ts":"2026-01-01T00:00:00Z","msg":"Slow query","tenant_id":"test-tenant","app_slug":"test-app","source":"db","latency_ms":3500}' \
  | curl -s -X POST http://localhost:3100/loki/api/v1/push \
    -H "Content-Type: application/json" \
    -d @-
```

### 3. Verify in Grafana

Open `http://localhost:3000`, navigate to Alerting > Alert Rules, and check that your test alerts transition to FIRING.

### 4. Verify webhook delivery

Set `ALCHEMIST_DISPATCHER_URL` to a local endpoint (e.g., a `nc -l 9999` listener or a RequestBin URL) and confirm the webhook payload arrives with the correct `tenant_id`, `app_slug`, and `severity`.

## Adding a New Alert

1. Create or edit a YAML file in `monitoring/grafana/alerts/`.
2. Follow the existing pattern: one `apiVersion: 1` file with `groups` containing `rules`.
3. Use `${tenant_id}` in LogQL queries for per-tenant scoping.
4. Set `labels.severity` (`warning` or `critical`) and `labels.ticket_type` (`bug` or `performance`).
5. Set the `contactPoint` to `alchemist-dispatcher`.
6. Test locally before deploying.

## How Alerts Reach the Dispatcher

Grafana evaluates alert rules on a 1-minute interval. When a rule transitions to FIRING, Grafana sends a POST to the `alchemist-dispatcher` contact point with a JSON payload containing:

- Alert name and description
- All labels (`tenant_id`, `app_slug`, `severity`, `ticket_type`)
- Annotations (summary, LogQL link)
- Firing start time

The dispatcher uses `tenant_id` to look up the customer's repo and creates a ticket with the alert context. Claude Code picks up the ticket and works autonomously to fix the underlying issue.
