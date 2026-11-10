# Library version idioms

## Library version idioms — fight your training-data defaults

Every dependency below is pinned to a major version where the API changed in a way that LLM training data still gets wrong by default. Read this section *before* reaching for muscle memory on any of these libraries. When training data and this section disagree, **this section wins** — the build will fail at deploy time if you guess wrong.

### Deno 2 (`denoland/deno:2.9.7` runtime)

The Deno version lives in `.dvmrc`, and only there. CI reads it; the
Dockerfile must match it (`scripts/check-deno-version.sh`). It is the Chipp
platform's one Deno version, the same one the build sandbox and the runtime
image use. Never pin a different Deno anywhere in this repo.

`Deno.run` was REMOVED in Deno 2. Most training data is Deno 1.x.

| Subprocess | Deno 2 (use this) | Deno 1 (do NOT use) |
|---|---|---|
| Spawn + capture | `await new Deno.Command("git", { args: ["status"], stdout: "piped" }).output()` | `Deno.run({ cmd: ["git", "status"], stdout: "piped" })` |
| Spawn + stream | `new Deno.Command(...).spawn()` | `Deno.run(...)` |

`Deno.serve` is the default HTTP server — already used in `main.ts`. Don't fall back to `Deno.listen` + `serveHttp`.

`Deno.env.get()` is unchanged. `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readDir` are unchanged. The breakage is concentrated on `Deno.run` and a few Deno-namespace helpers — when in doubt, run `deno doc --builtin Deno.<symbol>` to confirm the symbol still exists.

### Hono 4 (`hono@^4.6.0`)

`app.fire()` was removed. The custom-context typing pattern is now:

```typescript
type AppEnv = { Variables: { user: User; session: Session } };
const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("user", currentUser);
  await next();
});

app.get("/me", (c) => c.json({ user: c.get("user") }));
```

NOT the v3 `Hono.Variables` global augmentation pattern. Middleware that mutates the context type without the `Hono<{ Variables: ... }>` generic will type-check but `c.get(...)` will return `unknown` everywhere.

### Arctic 2 (`arctic@^2.0.0`)

Arctic 2.0 was a near-total rewrite (Sept 2024). The OOTB providers in `src/lib/oauth-providers.ts` are already on v2 — DO NOT rewrite them. If a ticket asks for a new provider, mirror the v2 pattern from the existing files, NOT the older v1 pattern from public docs.

The v2 idiom for token validation:

```typescript
const tokens = await provider.validateAuthorizationCode(code, codeVerifier);
const accessToken = tokens.accessToken();
const accessTokenExpiresAt = tokens.accessTokenExpiresAt();
const refreshToken = tokens.hasRefreshToken() ? tokens.refreshToken() : null;
```

NOT `tokens.accessToken` (property), NOT `OAuth2Tokens` returned as a plain object, NOT v1's `validateAuthorizationCode(code)` two-arg-less signature.

### date-fns 3 (`date-fns@^3.0.0`)

The default export was DROPPED. Use named imports only.

```typescript
// Correct
import { format, parseISO, differenceInDays } from "date-fns";
format(new Date(), "yyyy-MM-dd");

// Wrong — silently typechecks under Deno's npm: types but throws at runtime
import dateFns from "date-fns";
dateFns.format(new Date(), "yyyy-MM-dd");
```

date-fns 3 is also ESM-first. If you need locale support: `import { enUS } from "date-fns/locale"` (no `/dist/`).

### Stripe 17 (`stripe@^17.0.0`)

Pin the API version when constructing the client — the SDK major version and the API version must agree, otherwise the `Stripe.Checkout.Session.create({...})` call will type-check but fail at runtime with `parameter_invalid` for fields the older API didn't know about.

```typescript
import Stripe from "stripe";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion,
});
```

The platform does NOT inject a Stripe key. An app that sells with its own key gets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from the person through `request_secrets`; call `get_payments_status` for the real webhook URL. An app on Chipp Payments has no key at all (see "Selling through Chipp Payments"). Never hardcode a key.
