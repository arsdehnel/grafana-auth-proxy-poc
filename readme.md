# Grafana Auth Proxy — Team Sync

A TypeScript Express service that sits in front of Grafana, owns the OIDC authentication flow, and syncs SSO group claims to Grafana team membership — replicating Grafana Enterprise's built-in team sync without requiring a license.

## Background

Grafana Enterprise's built-in team sync feature (which maps SSO group claims directly to Grafana team membership) requires a paid Enterprise license. Our deployment uses the Enterprise image without a license, so that feature is unavailable.

This proxy service replicates that behavior using Grafana's Auth Proxy feature alongside a custom OIDC middleware layer.

---

## What This Service Does

The proxy sits in front of Grafana and owns the entire authentication flow:

1. Intercepts unauthenticated requests and redirects users to the SSO provider (PingFederate in production, Dex in local dev)
2. Handles the OIDC callback, exchanges the auth code for tokens, and retrieves user info including `appRoles`
3. Syncs the user's `appRoles` to Grafana team memberships via the Grafana HTTP API
4. Injects the `X-WEBAUTH-*` headers that Grafana's Auth Proxy feature uses to identify the user
5. Proxies all requests to Grafana

In production, `appRoles` values from the Ping userinfo endpoint are used directly as Grafana team names. A separate workflow manages team creation and the mapping of AD groups to teams — this service only syncs membership, it does not create or delete teams.

---

## Request Flow

```
Browser → nginx → team-sync proxy → Grafana
```

**First login:**

1. Browser hits any URL → proxy checks for `ts_user` cookie → not found
2. Browser API requests (`/api/*`) receive a `401` — non-API requests redirect to `/login`
3. Proxy generates OIDC state, stores it in a signed `ts_oidc` cookie, redirects to Ping/Dex
4. User authenticates with Ping/Dex
5. Ping/Dex redirects to `/callback`
6. Proxy validates `ts_oidc` cookie, exchanges auth code for tokens
7. Proxy fetches userinfo (including `appRoles`) from Ping/Dex
8. Proxy syncs `appRoles` → Grafana team membership via Grafana API
9. Proxy sets signed `ts_user` cookie containing `{ username, name, email, role }`
10. Proxy redirects to original URL, injecting `X-WEBAUTH-*` headers
11. Grafana receives headers, creates/updates user, issues `grafana_session` cookie
12. Browser now has `grafana_session` — subsequent requests handled by Grafana directly

**Subsequent requests:**

1. Browser sends request with `grafana_session` cookie
2. Proxy strips any incoming `X-WEBAUTH-*` headers (security)
3. Proxy reads `ts_user` cookie and injects `X-WEBAUTH-*` headers
4. Proxy passes request through to Grafana
5. Grafana validates its own session cookie
6. Background team re-sync is triggered if the per-pod cache is stale

---

## Authentication State — Cookies

All authentication state lives in signed browser cookies. There is no server-side session store.

| Cookie            | TTL               | Contents                            | Purpose                                                    |
|-------------------|-------------------|-------------------------------------|------------------------------------------------------------|
| `ts_oidc`         | 5 minutes         | `{ state, codeVerifier, returnTo }` | OIDC flow state — set on `/login`, consumed on `/callback` |
| `ts_user`         | 8 hours (default) | `{ username, name, email, role }`   | Identifies the authenticated user on every proxied request |
| `grafana_session` | Grafana-managed   | Grafana's own session token         | All subsequent request auth after first login              |

Cookies are signed using HMAC-SHA256 with a `COOKIE_SECRET` environment variable. **This secret must be identical across all pod replicas.** Signature verification uses `timingSafeEqual` to prevent timing attacks.

---

## Project Structure

```
src/
├── server.ts              # Express app entrypoint
├── config.ts              # Env var parsing, typing, and validation
├── logger.ts              # Winston logger (structured JSON in prod, pretty in dev)
├── auth-middleware.ts     # Cookie auth, req.grafanaUser population, background sync
├── proxy-middleware.ts    # http-proxy-middleware — injects X-WEBAUTH-* headers
├── oidc-routes.ts         # GET /login and GET /callback route handlers
├── oidc-client.ts         # OIDC client init with retry logic, getOidcClient() singleton
├── cookie-helpers.ts      # Signed cookie get/set/clear/verify
├── grafana-client.ts      # Axios clients for Grafana admin and cookie-based requests
├── get-team-id.ts         # Grafana team lookup by name
├── get-user-id.ts         # Grafana user lookup by username
├── ensure-teams.ts        # Bootstrap teams on startup (dev/ENSURE_TEAMS=true only)
├── sync-cache.ts          # In-memory per-pod sync cache
├── sync-teams.ts          # Team sync orchestration
├── role-mapper.ts         # Maps appRoles to Grafana roles (Admin/Viewer)
└── mock-data.ts           # Dev fallback appRoles (replaced by Ping claims in prod)
```

---

## Configuration

All configuration is read from environment variables at startup. Missing required variables will throw immediately and exit the process.

| Variable                | Required | Default        | Description                                                        |
|-------------------------|----------|----------------|--------------------------------------------------------------------|
| `OIDC_ISSUER_INTERNAL`  | ✓        |                | OIDC issuer URL for server-to-server calls (token, userinfo, jwks) |
| `OIDC_ISSUER_EXTERNAL`  | ✓        |                | OIDC issuer URL for browser redirects (authorization endpoint)     |
| `OIDC_CLIENT_ID`        | ✓        |                | OIDC client ID                                                     |
| `OIDC_CLIENT_SECRET`    | ✓        |                | OIDC client secret                                                 |
| `OIDC_REDIRECT_URI`     | ✓        |                | OIDC redirect URI (must match provider config)                     |
| `GRAFANA_URL`           | ✓        |                | Internal Grafana URL (e.g. `http://grafana:3000`)                  |
| `COOKIE_SECRET`         | ✓        |                | HMAC signing secret — must be identical across all replicas        |
| `GRAFANA_ADMIN_GROUPS`  | †        |                | Comma-separated list of appRoles values that grant Admin access    |
| `GRAFANA_VIEWER_GROUPS` | †        |                | Comma-separated list of appRoles values that grant Viewer access   |
| `PORT`                  |          | `3001`         | Port the proxy listens on                                          |
| `SESSION_TTL_SECS`      |          | `28800` (8h)   | `ts_user` cookie lifetime in seconds                               |
| `SYNC_TTL_MS`           |          | `60000`        | Per-pod sync cache TTL in milliseconds                             |
| `SYNC_SKIP_USERS`       |          | `admin`        | Comma-separated list of usernames to exclude from team sync        |
| `OIDC_MAX_ATTEMPTS`     |          | `10`           | Number of OIDC discovery retries on startup                        |
| `OIDC_RETRY_DELAY_MS`   |          | `3000`         | Delay between OIDC discovery retries                               |
| `ENSURE_TEAMS`          |          | `false`        | Bootstrap teams from appRoles on startup (dev only)                |
| `LOG_LEVEL`             |          | `debug`/`info` | Log level — defaults to `debug` in dev, `info` in prod             |
| `NODE_ENV`              |          | —              | Set to `development` for pretty logs, `production` for JSON logs   |

† At least one of `GRAFANA_ADMIN_GROUPS` or `GRAFANA_VIEWER_GROUPS` must be set.

---

## Team Sync

Sync runs:
- Synchronously on first login, before handing off to Grafana
- In the background on subsequent requests when the per-pod cache has expired

The sync logic:
1. Filters out `!`-prefixed roles — only plain role names are treated as team names
2. Looks up the user's current Grafana team memberships
3. Adds the user to any teams they should be in but aren't
4. Removes the user from any teams they're in but shouldn't be
5. Individual team add/remove failures are logged but do not abort the sync

**Sync cache** is per-pod, in-memory, keyed on username with a configurable TTL (default 60 seconds). A cache miss on a cold pod results in one extra Grafana API call — not a broken experience. Each pod warms its own cache independently.

**Skip list** (`SYNC_SKIP_USERS`) prevents the built-in `admin` account and service accounts from having their team membership modified.

---

## Local Development

### Prerequisites

- Docker + Docker Compose
- Node.js 22+

### First-time setup

Grafana needs a service account token before the proxy can manage teams. This is a one-time bootstrap step:

```sh
# Start Grafana directly with login enabled
docker compose run \
  -e GF_AUTH_DISABLE_LOGIN_FORM=false \
  -e GF_AUTH_PROXY_ENABLED=false \
  -p 3000:3000 grafana

# Visit localhost:3000, log in as admin/admin
# Go to Administration → Service Accounts → Add service account
# Give it Admin role, create a token, copy it

# Save it to .env
echo "GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxx" > .env

# Bring everything up
docker compose up
```

### Running

```sh
docker compose up --build
```

The dev Docker target mounts `src/` and runs `tsx watch` so changes are picked up without a rebuild.

### Scripts

```sh
npm run dev          # Run with tsx watch (used inside the dev container)
npm run build        # Compile TypeScript to dist/
npm run type-check   # Type check without emitting
npm run biome:check  # Lint + format + import organization
npm run biome:format # Format only
npm run biome:lint   # Lint only
```

---

## Tradeoffs Considered

### Why not Grafana's built-in OAuth/OIDC?
Grafana's generic OAuth provider supports `groups_attribute_path` and team sync, but team sync requires an Enterprise license. Without it, you can map roles but not team membership.

### Why not oauth2-proxy?
`oauth2-proxy` handles the OIDC dance well but has no mechanism for calling back into a custom service after authentication. The team sync logic requires a Grafana API call post-auth, which would need a sidecar anyway. A single focused proxy is simpler than wiring `oauth2-proxy` + nginx `auth_request` + a separate sync service.

### Why not server-side sessions?
The service runs as multiple pod replicas in production. Server-side sessions require either sticky routing or a shared session store. Signed browser cookies eliminate both requirements — any pod can handle any request because all state travels with the browser.

### Why signed cookies instead of JWTs?
Same security properties for this use case, simpler implementation. No library dependency, no key rotation complexity, no expiry claim parsing — just HMAC-SHA256 with a shared secret and a `Max-Age` on the cookie.

---

## Production Checklist

- [ ] Replace `mockAppRoles` lookup in `mock-data.ts` with `userinfo.appRoles` from Ping
- [ ] Set `GRAFANA_ADMIN_GROUPS` and `GRAFANA_VIEWER_GROUPS` on deployment
- [ ] Set `COOKIE_SECRET` as a Kubernetes secret, consistent across all replicas
- [ ] Remove `ENSURE_TEAMS=true` — team bootstrap is handled by a separate workflow
- [ ] Remove Dex — configure `OIDC_ISSUER_INTERNAL` and `OIDC_ISSUER_EXTERNAL` to point at PingFederate
- [ ] Confirm PingFederate includes `appRoles` in the userinfo response
- [ ] Confirm `preferred_username` is set correctly in the Ping userinfo response so username resolution does not fall back to the opaque `sub` value
- [ ] Ensure Grafana is not directly reachable — only accessible through the proxy
- [ ] Review `SESSION_TTL_SECS` and `SYNC_TTL_MS` values for your session length requirements