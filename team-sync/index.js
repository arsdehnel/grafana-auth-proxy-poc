import express from 'express'
import { Issuer, generators } from 'openid-client'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { createHmac, timingSafeEqual } from 'crypto'
import axios from 'axios'

const app = express()

const {
    OIDC_ISSUER_INTERNAL, OIDC_ISSUER_EXTERNAL,
    OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI,
    GRAFANA_URL,
    COOKIE_SECRET,           // shared across all pods - must be set in prod
    ENSURE_TEAMS = 'false',
    PORT = 3001
} = process.env

// ---------------------------------------------------------------------------
// Validate required env vars at startup
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['OIDC_ISSUER_INTERNAL', 'OIDC_ISSUER_EXTERNAL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'GRAFANA_URL', 'COOKIE_SECRET']
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
if (missingEnv.length) {
    console.error(`[startup] FATAL: Missing required environment variables: ${missingEnv.join(', ')}`)
    process.exit(1)
}
console.log(`[startup] Environment OK. GRAFANA_URL=${GRAFANA_URL} OIDC_ISSUER_INTERNAL=${OIDC_ISSUER_INTERNAL} OIDC_ISSUER_EXTERNAL=${OIDC_ISSUER_EXTERNAL}`)
console.log(`[startup] OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI} ENSURE_TEAMS=${ENSURE_TEAMS}`)

// ---------------------------------------------------------------------------
// Signed cookie helpers
// All state that needs to survive across requests/pods lives in signed cookies
// on the browser. The COOKIE_SECRET must be identical across all pod replicas.
//
// Cookie inventory:
//   ts_oidc   - OIDC flow state: { state, codeVerifier, returnTo }
//               set on /login, consumed on /callback
//   ts_user   - Authenticated user: { username, name, email, role }
//               set on /callback, read on every subsequent request
// ---------------------------------------------------------------------------
function sign(value) {
    const hmac = createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url')
    return `${value}.${hmac}`
}

function verify(signed) {
    if (!signed) return null
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) return null
    const value = signed.slice(0, lastDot)
    const hmac = signed.slice(lastDot + 1)
    const expected = createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url')
    try {
        if (!timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null
    } catch {
        return null
    }
    return value
}

function setCookie(res, name, value, maxAgeSeconds = 3600) {
    const encoded = sign(Buffer.from(JSON.stringify(value)).toString('base64url'))
    res.setHeader('Set-Cookie', `${name}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`)
}

function getCookie(req, name) {
    const cookies = req.headers.cookie || ''
    const match = cookies.match(new RegExp(`(?:^|; )${name}=([^;]+)`))
    if (!match) return null
    const verified = verify(decodeURIComponent(match[1]))
    if (!verified) {
        console.warn(`[cookie] Signature verification failed for cookie "${name}"`)
        return null
    }
    try {
        return JSON.parse(Buffer.from(verified, 'base64url').toString())
    } catch {
        console.warn(`[cookie] Failed to parse cookie "${name}"`)
        return null
    }
}

function clearCookie(res, name) {
    res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// ---------------------------------------------------------------------------
// Per-pod sync cache - keyed on username
// Cache misses just mean one extra Grafana API call, not a broken experience.
// Each pod warms its own cache independently.
// ---------------------------------------------------------------------------
const syncCache = new Map()
const SYNC_TTL_MS = 30000;//15 * 60 * 1000

// ---------------------------------------------------------------------------
// Mock appRoles - in prod this comes directly from Ping userinfo.
// appRoles values are used as Grafana team names directly.
// ---------------------------------------------------------------------------
const mockAppRoles = {
    adehnel: [
        'sre-editors-pd',
        'sre-editors-np',
        'sre-owners-np',
        '!App-GHE-AD-group-developer',
    ],
    jsmith: [
        'sales-viewers-np',
        '!App-GHE-AD-group-developer',
    ],
}

console.log(`[startup] Mock users configured: ${Object.keys(mockAppRoles).join(', ')}`)

// Accounts that should never be touched by team sync.
const SYNC_SKIP_USERS = new Set(['admin'])

// ---------------------------------------------------------------------------
// Grafana API clients
// ---------------------------------------------------------------------------

// Admin client - basic auth, for team/member management
const grafana = axios.create({
    baseURL: GRAFANA_URL,
    auth: { username: 'admin', password: 'admin' }
})

// Cookie client - no basic auth, for session-based user lookups
const grafanaCookie = axios.create({
    baseURL: GRAFANA_URL,
})

function addInterceptors(client, tag) {
    client.interceptors.request.use(req => {
        console.log(`[${tag}] --> ${req.method?.toUpperCase()} ${req.baseURL}${req.url}`)
        return req
    })
    client.interceptors.response.use(
        res => {
            console.log(`[${tag}] <-- ${res.status} ${res.config.method?.toUpperCase()} ${res.config.url}`)
            return res
        },
        err => {
            const status = err.response?.status
            const url = err.config?.url
            const method = err.config?.method?.toUpperCase()
            const body = JSON.stringify(err.response?.data)
            console.error(`[${tag}] <-- ERROR ${status} ${method} ${url} — ${body}`)
            return Promise.reject(err)
        }
    )
}

addInterceptors(grafana, 'grafana-api')
addInterceptors(grafanaCookie, 'grafana-cookie')

async function ensureTeamsExist(teamNames) {
    console.log(`[teams] ENSURE_TEAMS=true, bootstrapping teams: [${teamNames.join(', ')}]`)
    for (const teamName of teamNames) {
        try {
            await grafana.post('/api/teams', { name: teamName })
            console.log(`[teams] Created team "${teamName}"`)
        } catch (e) {
            if (e.response?.status === 409) {
                console.log(`[teams] Team "${teamName}" already exists, skipping`)
            } else {
                console.error(`[teams] Failed to create team "${teamName}": ${e.message}`)
            }
        }
    }
    console.log(`[teams] Team bootstrap complete`)
}

async function getTeamId(teamName) {
    try {
        const res = await grafana.get(`/api/teams/search?name=${encodeURIComponent(teamName)}`)
        const team = res.data.teams?.[0]
        if (!team) {
            console.warn(`[teams] Team "${teamName}" not found in Grafana — skipping`)
            return null
        }
        console.log(`[teams] Resolved team "${teamName}" → ID ${team.id}`)
        return team.id
    } catch (err) {
        console.error(`[teams] Error looking up team "${teamName}": ${err.message}`)
        throw err
    }
}

async function getUserId(username) {
    try {
        const res = await grafana.get(`/api/users/lookup?loginOrEmail=${encodeURIComponent(username)}`)
        const id = res.data.id ?? null
        if (!id) {
            console.warn(`[sync] User "${username}" found but has no ID — unexpected: ${JSON.stringify(res.data)}`)
        } else {
            console.log(`[sync] Resolved user "${username}" → Grafana ID ${id}`)
        }
        return id
    } catch (err) {
        if (err.response?.status === 404) {
            console.log(`[sync] User "${username}" does not exist in Grafana yet`)
            return null
        }
        console.error(`[sync] Error looking up user "${username}": ${err.message}`)
        throw err
    }
}

async function syncUserTeams(username, appRoles) {
    if (SYNC_SKIP_USERS.has(username)) {
        console.log(`[sync] Skipping sync for "${username}" — in skip list`)
        return
    }

    console.log(`[sync] Starting team sync for "${username}"`)
    console.log(`[sync] appRoles: ${JSON.stringify(appRoles)}`)

    const roleHash = JSON.stringify([...appRoles].sort())
    const cached = syncCache.get(username)

    if (cached && cached.roleHash === roleHash && Date.now() < cached.expiresAt) {
        const remainingMs = cached.expiresAt - Date.now()
        console.log(`[sync] Cache hit for "${username}", skipping (expires in ${Math.round(remainingMs / 1000)}s)`)
        return
    }

    if (cached) {
        console.log(`[sync] Cache miss for "${username}" — ${cached.roleHash !== roleHash ? 'roles changed' : 'TTL expired'}`)
    } else {
        console.log(`[sync] No cache entry for "${username}", running first sync`)
    }

    const desiredTeamNames = appRoles.filter(r => !r.startsWith('!'))
    console.log(`[sync] Desired teams for "${username}": [${desiredTeamNames.join(', ')}]`)

    const userId = await getUserId(username)
    if (!userId) {
        console.log(`[sync] Skipping — "${username}" not in Grafana yet, will retry on next request`)
        return
    }

    const currentRes = await grafana.get(`/api/users/${userId}/teams`)
    const currentTeamNames = currentRes.data.map(t => t.name)
    console.log(`[sync] Current teams for "${username}": [${currentTeamNames.join(', ')}]`)

    const toAdd = desiredTeamNames.filter(t => !currentTeamNames.includes(t))
    const toRemove = currentTeamNames.filter(t => !desiredTeamNames.includes(t))

    if (!toAdd.length && !toRemove.length) {
        console.log(`[sync] No team changes needed for "${username}"`)
        syncCache.set(username, { roleHash, expiresAt: Date.now() + SYNC_TTL_MS })
        return
    }

    console.log(`[sync] Changes for "${username}": add=[${toAdd.join(', ')}] remove=[${toRemove.join(', ')}]`)

    for (const teamName of toAdd) {
        try {
            const teamId = await getTeamId(teamName)
            if (!teamId) { console.warn(`[sync] Skipping add to "${teamName}" — not found`); continue }
            await grafana.post(`/api/teams/${teamId}/members`, { userId })
            console.log(`[sync] ✓ Added "${username}" to "${teamName}"`)
        } catch (err) {
            console.error(`[sync] Failed to add "${username}" to "${teamName}": ${err.message}`)
        }
    }

    for (const teamName of toRemove) {
        try {
            const teamId = await getTeamId(teamName)
            if (!teamId) { console.warn(`[sync] Skipping remove from "${teamName}" — not found`); continue }
            await grafana.delete(`/api/teams/${teamId}/members/${userId}`)
            console.log(`[sync] ✓ Removed "${username}" from "${teamName}"`)
        } catch (err) {
            console.error(`[sync] Failed to remove "${username}" from "${teamName}": ${err.message}`)
        }
    }

    syncCache.set(username, { roleHash, expiresAt: Date.now() + SYNC_TTL_MS })
    console.log(`[sync] Sync complete for "${username}", cache set for ${SYNC_TTL_MS / 1000}s`)
}

function getRoleFromAppRoles(appRoles) {
    // TODO: update role mapping rules for prod AD group names
    const role = 'Viewer'
    console.log(`[auth] Resolved Grafana role: ${role}`)
    return role
}

// ---------------------------------------------------------------------------
// OIDC setup
// ---------------------------------------------------------------------------
let oidcClient

async function initOidc() {
    console.log(`[oidc] Starting OIDC discovery from ${OIDC_ISSUER_INTERNAL}`)
    for (let i = 0; i < 10; i++) {
        try {
            const discoveredIssuer = await Issuer.discover(OIDC_ISSUER_INTERNAL)
            console.log(`[oidc] Discovery successful`)
            console.log(`[oidc] token_endpoint:         ${discoveredIssuer.token_endpoint}`)
            console.log(`[oidc] userinfo_endpoint:      ${discoveredIssuer.userinfo_endpoint}`)
            console.log(`[oidc] authorization_endpoint: ${discoveredIssuer.authorization_endpoint}`)

            const issuer = new Issuer({
                ...discoveredIssuer.metadata,
                issuer: OIDC_ISSUER_EXTERNAL,
                authorization_endpoint: `${OIDC_ISSUER_EXTERNAL}/auth`,
                token_endpoint: `${OIDC_ISSUER_INTERNAL}/token`,
                userinfo_endpoint: `${OIDC_ISSUER_INTERNAL}/userinfo`,
                jwks_uri: `${OIDC_ISSUER_INTERNAL}/keys`,
            })

            console.log(`[oidc] Issuer overrides applied:`)
            console.log(`[oidc]   authorization_endpoint → ${issuer.authorization_endpoint}`)
            console.log(`[oidc]   token_endpoint         → ${issuer.token_endpoint}`)
            console.log(`[oidc]   userinfo_endpoint       → ${issuer.userinfo_endpoint}`)

            oidcClient = new issuer.Client({
                client_id: OIDC_CLIENT_ID,
                client_secret: OIDC_CLIENT_SECRET,
                redirect_uris: [OIDC_REDIRECT_URI],
                response_types: ['code'],
            })

            console.log(`[oidc] Client initialized (client_id=${OIDC_CLIENT_ID})`)

            if (ENSURE_TEAMS === 'true') {
                const allTeams = [...new Set(
                    Object.values(mockAppRoles).flat().filter(r => !r.startsWith('!'))
                )]
                await ensureTeamsExist(allTeams)
            } else {
                console.log(`[teams] ENSURE_TEAMS=false, skipping team bootstrap`)
            }

            return
        } catch (e) {
            console.log(`[oidc] Waiting for Dex... (attempt ${i + 1}/10): ${e.message}`)
            await new Promise(r => setTimeout(r, 3000))
        }
    }
    throw new Error('[oidc] FATAL: Could not connect to Dex after 10 attempts')
}

// ---------------------------------------------------------------------------
// Grafana proxy - injects auth headers on every request using ts_user cookie
// ---------------------------------------------------------------------------
const grafanaProxy = createProxyMiddleware({
    target: GRAFANA_URL,
    changeOrigin: true,
    ws: true,
    on: {
        proxyReq: (proxyReq, req) => {
            proxyReq.removeHeader('X-WEBAUTH-USER')
            proxyReq.removeHeader('X-WEBAUTH-NAME')
            proxyReq.removeHeader('X-WEBAUTH-EMAIL')
            proxyReq.removeHeader('X-WEBAUTH-ROLE')

            if (req.grafanaUser) {
                const { username, name, email, role } = req.grafanaUser
                proxyReq.setHeader('X-WEBAUTH-USER', username)
                proxyReq.setHeader('X-WEBAUTH-NAME', name)
                proxyReq.setHeader('X-WEBAUTH-EMAIL', email)
                proxyReq.setHeader('X-WEBAUTH-ROLE', role)
            }
        },
        proxyRes: (proxyRes, req) => {
            console.log(`[proxy] ${req.method} ${req.path} → ${proxyRes.statusCode}`)
        },
        error: (err, req, res) => {
            console.error(`[proxy] Error proxying ${req.method} ${req.path}: ${err.message}`)
            if (!res.headersSent) res.status(502).send('Bad gateway — could not reach Grafana')
        }
    }
})

// ---------------------------------------------------------------------------
// Auth middleware
// Reads ts_user signed cookie to identify the user on every request.
// On hit: populates req.grafanaUser, triggers background sync, continues.
// On miss: redirects to /login.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    // Never intercept the OIDC flow itself
    if (req.path === '/login' || req.path === '/callback') return next()

    const user = getCookie(req, 'ts_user')
    if (user) {
        console.log(`[auth] Identified "${user.username}" from ts_user cookie`)
        req.grafanaUser = user

        // Background re-sync — non-blocking, uses per-pod cache to rate limit
        const appRoles = mockAppRoles[user.username] ?? [] // prod: fetch from Ping
        syncUserTeams(user.username, appRoles).catch(e =>
            console.error(`[sync] Background sync failed for "${user.username}": ${e.message}`)
        )
        return next()
    }

    console.log(`[auth] No ts_user cookie for ${req.path}, redirecting to /login`)
    res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`)
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// /login - start OIDC flow, storing state in a signed browser cookie
app.get('/login', (req, res) => {
    const state = generators.state()
    const codeVerifier = generators.codeVerifier()
    const codeChallenge = generators.codeChallenge(codeVerifier)
    const returnTo = req.query.returnTo || '/'

    // Store OIDC flow state in a signed cookie on the browser.
    // Any pod can handle the callback since there's no server-side state.
    setCookie(res, 'ts_oidc', { state, codeVerifier, returnTo }, 300) // 5 min TTL

    const authUrl = oidcClient.authorizationUrl({
        scope: 'openid profile email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    })

    console.log(`[auth] Starting OIDC flow (returnTo=${returnTo})`)
    res.redirect(authUrl)
})

// /callback - complete OIDC flow, set ts_user cookie, sync teams
app.get('/callback', async (req, res) => {
    console.log(`[oidc] Callback received`)
    try {
        const oidcState = getCookie(req, 'ts_oidc')
        if (!oidcState) {
            console.error(`[oidc] No ts_oidc cookie found — expired or tampered`)
            return res.status(400).send('Invalid or expired login state. Please try again.')
        }

        const params = oidcClient.callbackParams(req)
        console.log(`[oidc] Callback params: state=${params.state} code=${params.code?.substring(0, 8)}...`)

        if (params.state !== oidcState.state) {
            console.error(`[oidc] State mismatch — expected ${oidcState.state} got ${params.state}`)
            return res.status(400).send('Invalid login state. Please try again.')
        }

        clearCookie(res, 'ts_oidc')
        console.log(`[oidc] State validated, ts_oidc cookie cleared`)

        console.log(`[oidc] Exchanging code for tokens`)
        const tokenSet = await oidcClient.callback(OIDC_REDIRECT_URI, params, {
            code_verifier: oidcState.codeVerifier,
            state: params.state,
        })
        console.log(`[oidc] Token exchange successful (expires_at=${tokenSet.expires_at})`)

        const userinfo = await oidcClient.userinfo(tokenSet)
        console.log(`[oidc] Userinfo received: ${JSON.stringify(userinfo)}`)

        const username = userinfo.preferred_username || userinfo.name || userinfo.sub
        const appRoles = mockAppRoles[username] ?? mockAppRoles[userinfo.name] ?? [] // prod: userinfo.appRoles
        console.log(`[auth] Resolved username="${username}" appRoles=${JSON.stringify(appRoles)}`)

        if (!appRoles.length) {
            console.warn(`[auth] No appRoles found for "${username}" — Viewer role, no team assignments`)
        }

        const role = getRoleFromAppRoles(appRoles)
        const user = {
            username,
            name: userinfo.name || username,
            email: userinfo.email || `${username}@example.com`,
            role,
        }

        // Set ts_user cookie — shared secret means any pod can verify it
        setCookie(res, 'ts_user', user, SYNC_TTL_MS / 1000)
        console.log(`[auth] Set ts_user cookie for "${username}"`)

        console.log(`[sync] Running team sync for "${username}"`)
        await syncUserTeams(username, appRoles).catch(e =>
            console.error(`[sync] Team sync failed (non-fatal): ${e.message}`)
        )

        console.log(`[auth] Login complete for "${username}", redirecting to ${oidcState.returnTo}`)
        res.redirect(oidcState.returnTo)

    } catch (err) {
        console.error(`[oidc] Callback error: ${err.message}`)
        console.error(err.stack)
        res.status(500).send('Authentication error. Please try again.')
    }
})

// Everything else proxies to Grafana
app.use('/', (req, res, next) => {
    console.log(`[proxy] ${req.method} ${req.path}`)
    grafanaProxy(req, res, next)
})

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
initOidc().then(() => {
    app.listen(PORT, () => console.log(`[startup] team-sync listening on :${PORT}`))
}).catch(err => {
    console.error(`[startup] FATAL: ${err.message}`)
    process.exit(1)
})

process.on('unhandledRejection', reason => {
    console.error(`[process] Unhandled promise rejection: ${reason}`)
})

process.on('uncaughtException', err => {
    console.error(`[process] Uncaught exception: ${err.message}`)
    console.error(err.stack)
    process.exit(1)
})