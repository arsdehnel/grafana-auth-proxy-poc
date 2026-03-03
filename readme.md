# Grafana Auth Proxy POC

Exploring the possibility of using the Auth Proxy setup in Grafana to sort of "intercept" requests and sync team membership.

## Background

Grafana Enterprise's built-in team sync feature (which maps SSO group claims directly to Grafana team membership) requires a paid Enterprise license. Our deployment uses the Enterprise image without a license, so that feature is unavailable.

This proxy service was built to replicate that team sync behavior without the license requirement, using Grafana's Auth Proxy feature alongside a custom OIDC middleware layer.

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
Browser → Proxy → Grafana
```

**First login:**

1. Browser hits any URL → proxy checks for `ts_user` cookie → not found
2. Proxy redirects to `/login`
3. Proxy generates OIDC state, stores it in signed `ts_oidc` cookie, redirects to Ping/Dex
4. User authenticates with Ping/Dex
5. Ping/Dex redirects to `/callback`
6. Proxy validates `ts_oidc` cookie, exchanges auth code for tokens
7. Proxy fetches userinfo (including `appRoles`) from Ping/Dex
8. Proxy syncs `appRoles` → Grafana team membership via Grafana API
9. Proxy sets signed `ts_user` cookie containing `{ username, name, email, role }`
10. Proxy redirects to `/login`, injecting `X-WEBAUTH-*` headers
11. Grafana receives headers, creates/updates user, issues `grafana_session` cookie
12. Browser now has `grafana_session` — subsequent requests handled by Grafana directly

**Subsequent requests:**

1. Browser sends request with `grafana_session` cookie
2. Proxy strips any incoming `X-WEBAUTH-*` headers (security)
3. Proxy passes request through to Grafana
4. Grafana validates its own session cookie
5. `proxyRes` handler checks `grafana_session`, triggers background team re-sync if cache stale

---

## Authentication State — Cookies

All authentication state lives in signed browser cookies. There is no server-side session store.

| Cookie            | TTL             | Contents                            | Purpose                                                              |
|-------------------|-----------------|-------------------------------------|----------------------------------------------------------------------|
| `ts_oidc`         | 5 minutes       | `{ state, codeVerifier, returnTo }` | OIDC flow state — set on `/login`, consumed on `/callback`           |
| `ts_user`         | 15 minutes      | `{ username, name, email, role }`   | Bridges the `/callback` → `/login` redirect hop for header injection |
| `grafana_session` | Grafana-managed | Grafana's own session token         | All subsequent request auth after first login                        |

Cookies are signed using HMAC-SHA256 with a `COOKIE_SECRET` environment variable. **This secret must be identical across all pod replicas.** Signature verification uses `timingSafeEqual` to prevent timing attacks.

---

## Team Sync

Sync runs:
- Synchronously on first login, before handing off to Grafana
- In the background on subsequent requests when the per-pod cache has expired

The sync logic:
1. Filters out `!App-*` prefixed roles — only plain role names are treated as team names
2. Looks up the user's current Grafana team memberships
3. Adds the user to any teams they should be in but aren't
4. Removes the user from any teams they're in but shouldn't be
5. Individual team add/remove failures are logged but do not abort the sync

**Sync cache** is per-pod, in-memory, keyed on username with a configurable TTL (default 15 minutes). A cache miss on a cold pod results in one extra Grafana API call — not a broken experience. Each pod warms its own cache independently.

**Skip list** (`SYNC_SKIP_USERS`) prevents the built-in `admin` account and service accounts from having their team membership modified.

---

## Tradeoffs Considered

### Why not Grafana's built-in OAuth/OIDC?
Grafana's generic OAuth provider supports `groups_attribute_path` and team sync, but team sync requires an Enterprise license. Without it, you can map roles (`Viewer`/`Editor`/`Admin`) but not team membership.

### Why not oauth2-proxy?
`oauth2-proxy` handles the OIDC dance well but has no mechanism for calling back into a custom service after authentication. The team sync logic requires a Grafana API call post-auth, which would need a sidecar service anyway. Building a single focused proxy was simpler than wiring `oauth2-proxy` + nginx `auth_request` + a separate sync service.

### Why not server-side sessions?
The service runs as multiple pod replicas in production. Server-side sessions (`express-session`, Redis, etc.) require either sticky routing at the load balancer or a shared session store. Signed browser cookies eliminate both requirements — any pod can handle any request because all state travels with the browser.

### Why not `enable_login_token = false`?
With `enable_login_token=false`, Grafana validates the `X-WEBAUTH-*` headers on every request. This means the proxy must know the current user on every request, which requires either sessions or a Grafana API call per request. With `enable_login_token=true`, Grafana issues its own `grafana_session` cookie after the first authenticated `/login` and handles subsequent requests itself — the proxy only injects headers once per login.

> **Current status:** `enable_login_token` is disabled in the local dev setup pending resolution of session token rotation errors. This should be revisited before production — running with it disabled means the proxy injects `X-WEBAUTH-*` headers on every request rather than just on `/login`.

### Why signed cookies instead of JWTs?
Same security properties for this use case, simpler implementation. No library dependency, no key rotation complexity, no expiry claim parsing — just HMAC-SHA256 with a shared secret and a `Max-Age` on the cookie.

---

## Assumptions

- **Same-pod deployment:** The proxy and Grafana run as containers in the same Kubernetes pod. Grafana is not directly reachable — all traffic goes through the proxy. This means the `GF_AUTH_PROXY_WHITELIST` setting is not needed.
- **Pod scaling:** The proxy scales with Grafana (they are the same pod). The `COOKIE_SECRET` must be consistent across replicas via a Kubernetes secret.
- **OIDC callback routing:** Because OIDC state is in a browser cookie rather than server memory, the `/callback` request can be handled by any pod replica.
- **Team creation is external:** This service does not create or delete Grafana teams. Teams must exist before sync runs. If a team in `appRoles` does not exist in Grafana, that membership is skipped and logged.
- **`appRoles` as team names:** In production, the `appRoles` array from the Ping userinfo endpoint contains values that directly correspond to Grafana team names. No mapping layer is required.
- **Role assignment:** Previously Grafana's `role_attribute_path` JMESPath setting was used to map `appRoles` claims to Grafana roles. This is no longer possible — because the proxy owns the OIDC flow entirely, Grafana never sees the token or `appRoles` claim directly. Role assignment happens in `getRoleFromAppRoles()` using the `GRAFANA_ADMIN_GROUPS` and `GRAFANA_VIEWER_GROUPS` env vars (comma-separated lists of AD group names). Users not present in either list are denied access at the proxy level with a 403.

---

## First Time Setup

To get the service account token that the `team-sync` app will need we have to do a little first-time setup here to solve the chicken/egg problem.

```sh
# Start just Grafana directly first with login enabled
docker compose run -e GF_AUTH_DISABLE_LOGIN_FORM=false -e GF_AUTH_PROXY_ENABLED=false -p 3000:3000 grafana

# Hit localhost:3000, log in as admin/admin
# Go to Administration → Service Accounts → Add service account
# Give it Admin role, create a token, copy it

# Put it in .env
echo "GRAFANA_SA_TOKEN=glsa_xxxx" > .env

# Now bring everything up
docker compose up
```

---

## Production Checklist

- [ ] Replace `mockAppRoles` lookup with `userinfo.appRoles` from Ping
- [ ] Set `GRAFANA_ADMIN_GROUPS` and `GRAFANA_VIEWER_GROUPS` variables on deployment for the `getRoleFromAppRoles()` to use
- [ ] Set `COOKIE_SECRET` as a Kubernetes secret, consistent across all replicas
- [ ] Remove `ENSURE_TEAMS=true` — team bootstrap is handled by separate workflow
- [ ] Remove Dex from the deployment — configure `OIDC_ISSUER_INTERNAL` and `OIDC_ISSUER_EXTERNAL` to point at PingFederate
- [ ] Confirm PingFederate includes `appRoles` in the userinfo response
- [ ] Confirm `preferred_username` is set correctly in the Ping userinfo response so username resolution does not fall back to the opaque `sub` value
- [ ] Ensure Grafana is not directly reachable — only accessible through the proxy