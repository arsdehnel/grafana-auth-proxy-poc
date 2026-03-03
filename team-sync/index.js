import express from 'express'
import session from 'express-session'
import { Issuer, generators } from 'openid-client'
import { createProxyMiddleware } from 'http-proxy-middleware'
import axios from 'axios'
import FileStore from 'session-file-store'

const FileStoreSession = FileStore(session)

const app = express()

const {
    OIDC_ISSUER_INTERNAL, OIDC_ISSUER_EXTERNAL,
    OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI,          // browser-facing: http://localhost:8080/callback
    GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN,
    SESSION_SECRET, PORT = 3001
} = process.env

// ---------------------------------------------------------------------------
// In-memory sync cache: avoid hitting Grafana API on every request
// key: username, value: { hash, expiresAt }
// ---------------------------------------------------------------------------
const syncCache = new Map()
const SYNC_TTL_MS = 30 * 1000 // 1 hour - match GF_AUTH_PROXY_SYNC_TTL

// ---------------------------------------------------------------------------
// Mock appRoles per user - in prod this comes from Ping userinfo endpoint
// Mimics what you showed earlier from your SSO provider
// ---------------------------------------------------------------------------
const mockAppRoles = {
    adehnel: [
        'gcp-group1-editor-pd',
        'gcp-group1-editor-np',
        'gcp-group1-owner-np',
        '!App-GHE-AD-group-developer',
    ],
    jsmith: [
        'gco-iam-group3-viewer-np',
        '!App-GHE-AD-group-developer',
    ],
}

// ---------------------------------------------------------------------------
// Group → Grafana team name mapping
// Only map the gco-iam-grp-* roles, ignore the !App-* ones
// ---------------------------------------------------------------------------
const GROUP_TO_TEAM = {
    'gcp-group1-editor-pd': 'sre-editors-pd',
    'gcp-group1-editor-np': 'sre-editors-np',
    'gcp-group1-owner-np': 'sre-owners-np',
    'gco-iam-group3-viewer-np': 'sales-viewers-np',
}

// ---------------------------------------------------------------------------
// Grafana API helpers
// ---------------------------------------------------------------------------
const grafana = axios.create({
    baseURL: GRAFANA_URL,
    auth: {
        username: 'admin',
        password: 'admin'
    }
})

async function ensureTeamsExist() {
    for (const teamName of Object.keys(GROUP_TO_TEAM)) {
        console.log(`Ensuring team ${teamName} exists`)
        try {
            await grafana.post('/api/teams', { name: teamName })
        } catch (e) {
            if (e.response?.status !== 409) console.error(`Failed to create team ${teamName}:`, e.message)
            // 409 = already exists, that's fine
        }
    }
}

async function getTeamId(teamName) {
    console.log('Auth header:', grafana.defaults.headers.Authorization)
    try {
        const res = await grafana.get(`/api/teams/search?name=${encodeURIComponent(teamName)}`)
        return res.data.teams?.[0]?.id ?? null
    } catch (err) {
        console.log(`Error fetching user ID: ${err}`);
        throw new Error(err);
    }
}

async function getUserId(username) {
    console.log('Auth header:', grafana.defaults.headers.Authorization)
    try {
        const res = await grafana.get(`/api/users/lookup?loginOrEmail=${encodeURIComponent(username)}`)
        return res.data.id ?? null
    } catch (err) {
        console.log(`Error fetching user ID: ${err}`);
        throw new Error(err);
    }
}

async function syncUserTeams(username, appRoles) {

    console.log(`SA Token ${GRAFANA_SERVICE_ACCOUNT_TOKEN.substring(0, 10)}`)

    const cacheKey = username
    const roleHash = JSON.stringify([...appRoles].sort())
    const cached = syncCache.get(cacheKey)

    if (cached && cached.hash === roleHash && Date.now() < cached.expiresAt) {
        return // already synced, nothing to do
    }

    const desiredTeamNames = appRoles.filter(r => !r.startsWith('!'))

    const userId = await getUserId(username)
    if (!userId) {
        console.log(`User ${username} not in Grafana yet, will sync next request`)
        return
    }
    console.log(`Username: ${username}`)
    console.log(`User ID: ${userId}`)

    // Get current team memberships
    const currentRes = await grafana.get(`/api/users/${userId}/teams`)
    const currentTeamNames = currentRes.data.map(t => t.name)

    console.log(`Current Teams: ${JSON.stringify(currentRes.data, null, 4)}`)

    const toAdd = desiredTeamNames.filter(t => !currentTeamNames.includes(t))
    const toRemove = currentTeamNames.filter(t => !desiredTeamNames.includes(t))

    console.log(`Desired: ${desiredTeamNames.join()}`)
    console.log(`To add: ${toAdd.join()}`);
    console.log(`To remove: ${toRemove.join()}`);

    for (const teamName of toAdd) {
        console.log(`Adding ${teamName}`);
        const teamId = await getTeamId(teamName)
        console.log(`Team ID ${teamId}`)
        if (teamId) {
            await grafana.post(`/api/teams/${teamId}/members`, { userId })
            console.log(`Added ${username} to ${teamName}`)
        }
    }

    for (const teamName of toRemove) {
        console.log(`Removing ${teamName}`);
        const teamId = await getTeamId(teamName)
        console.log(`Team ID ${teamId}`)
        if (teamId) {
            await grafana.delete(`/api/teams/${teamId}/members/${userId}`)
            console.log(`Removed ${username} from ${teamName}`)
        }
    }

    syncCache.set(cacheKey, { hash: roleHash, expiresAt: Date.now() + SYNC_TTL_MS })
}

function getRoleFromAppRoles(appRoles) {
    if (appRoles.includes('gcp-group1-owner-np')) return 'Admin'
    if (appRoles.includes('gcp-group1-editor-pd')) return 'Editor'
    if (appRoles.includes('gcp-group1-editor-np')) return 'Editor'
    return 'Viewer'
}

// ---------------------------------------------------------------------------
// OIDC setup
// ---------------------------------------------------------------------------
let oidcClient

async function initOidc() {
    // Retry loop - dex takes a moment to start
    for (let i = 0; i < 10; i++) {
        try {
            const discoveredIssuer = await Issuer.discover(OIDC_ISSUER_INTERNAL)

            const issuer = new Issuer({
                ...discoveredIssuer.metadata,
                issuer: OIDC_ISSUER_EXTERNAL,
                authorization_endpoint: `${OIDC_ISSUER_EXTERNAL}/auth`,
                token_endpoint: `${OIDC_ISSUER_INTERNAL}/token`,
                userinfo_endpoint: `${OIDC_ISSUER_INTERNAL}/userinfo`,
                jwks_uri: `${OIDC_ISSUER_INTERNAL}/keys`,
            })

            oidcClient = new issuer.Client({
                client_id: OIDC_CLIENT_ID,
                client_secret: OIDC_CLIENT_SECRET,
                redirect_uris: [OIDC_REDIRECT_URI],
                response_types: ['code'],
            })
            console.log('OIDC client initialized')
            await ensureTeamsExist()
            return
        } catch (e) {
            console.log(`Waiting for Dex... (attempt ${i + 1}/10): ${e.message}`)
            await new Promise(r => setTimeout(r, 3000))
        }
    }
    throw new Error('Could not connect to Dex')
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
app.use(session({
    store: new FileStoreSession({
        path: './sessions',
        ttl: 86400,
        retries: 0,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}))

// Grafana proxy - injects auth headers, forwards everything
const grafanaProxy = createProxyMiddleware({
    target: GRAFANA_URL,
    changeOrigin: true,
    ws: true,
    on: {
        proxyReq: (proxyReq, req) => {
            // Strip any incoming auth headers (security: users can't self-auth)
            proxyReq.removeHeader('X-WEBAUTH-USER')
            proxyReq.removeHeader('X-WEBAUTH-NAME')
            proxyReq.removeHeader('X-WEBAUTH-EMAIL')
            proxyReq.removeHeader('X-WEBAUTH-ROLE')

            if (req.session?.user) {
                const { username, name, email, role } = req.session.user
                proxyReq.setHeader('X-WEBAUTH-USER', username)
                proxyReq.setHeader('X-WEBAUTH-NAME', name)
                proxyReq.setHeader('X-WEBAUTH-EMAIL', email)
                proxyReq.setHeader('X-WEBAUTH-ROLE', role)
            }
        }
    }
})

// OIDC callback
app.get('/callback', async (req, res) => {

    try {
        console.log(`In the callback`);
        const params = oidcClient.callbackParams(req)
        console.log(` Making callback request to ${OIDC_REDIRECT_URI} with params ${JSON.stringify(params)}`);
        const tokenSet = await oidcClient.callback(OIDC_REDIRECT_URI, params, {
            code_verifier: req.session.codeVerifier,
            state: req.session.state,
        })
        console.log(`Token set ${JSON.stringify(tokenSet)}`)

        const userinfo = await oidcClient.userinfo(tokenSet)
        const username = userinfo.preferred_username || userinfo.sub

        console.log(`username: ${username}`)
        console.log(`userinfo ${JSON.stringify(userinfo)}`)

        // In prod: appRoles comes from userinfo. Locally: use mock map
        const appRoles = mockAppRoles[username] ?? []

        req.session.user = {
            username,
            name: userinfo.name || username,
            email: userinfo.email || `${username}@example.com`,
            role: getRoleFromAppRoles(appRoles),
            appRoles,
        }

        // Trigger team sync (best-effort, non-blocking)
        syncUserTeams(username, appRoles).catch(e =>
            console.error('Team sync error:', e.message)
        )

        res.redirect(req.session.returnTo || '/')

    } catch (err) {
        console.log(err);
        console.log(`Error in the OIDC callback`)
        res.json()
    }
})

// Auth middleware - everything else requires a session
app.use(async (req, res, next) => {
    if (req.session?.user) {
        // Re-sync on each request is too expensive - sync is cached
        // but kick it off async so it catches role changes eventually
        console.log(`In middleware: ${JSON.stringify(req.session.user, null, 4)}`)
        syncUserTeams(req.session.user.username, mockAppRoles[req.session.user.name])
            .catch(e => console.error('Background sync error:', e.message))
        void 0 // prevent unhandled rejection from crashing process
        return next()
    }

    // Not logged in - start OIDC flow
    const state = generators.state()
    const codeVerifier = generators.codeVerifier()
    const codeChallenge = generators.codeChallenge(codeVerifier)

    req.session.state = state
    req.session.codeVerifier = codeVerifier
    req.session.returnTo = req.originalUrl

    const authUrl = oidcClient.authorizationUrl({
        scope: 'openid profile email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    })

    res.redirect(authUrl)
})

// Proxy everything to Grafana
app.use('/', grafanaProxy)

initOidc().then(() => {
    app.listen(PORT, () => console.log(`team-sync listening on :${PORT}`))
})