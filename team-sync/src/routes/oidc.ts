import { generators } from 'openid-client'
import type { Request, Response } from 'express'
import logger from '../logger.js'
import { config } from '../config.js'
import { getOidcClient } from '../oidc-client.js'
import { getCookie, setCookie, clearCookie } from '../cookie-helpers.js'
import { getRoleFromAppRoles } from '../get-role-from-app-roles.js'
import { syncUserTeams } from '../sync-teams.js'
import { mockAppRoles } from '../mock-data.js'
import type { GrafanaUser } from '../middleware/auth.js'

const oidcLogger = logger.child({ task: 'oidc-routes' })

interface OidcCookieState {
    state: string
    codeVerifier: string
    returnTo: string
}

// ---------------------------------------------------------------------------
// GET /login — start OIDC flow, storing state in a signed browser cookie
// ---------------------------------------------------------------------------
export function loginHandler(req: Request, res: Response): void {
    const existing = getCookie<OidcCookieState>(req, 'ts_oidc')
    if (existing) {
        oidcLogger.debug('ts_oidc cookie already exists, reusing existing flow')
        const authUrl = getOidcClient().authorizationUrl({
            scope: 'openid profile email',
            state: existing.state,
            code_challenge: generators.codeChallenge(existing.codeVerifier),
            code_challenge_method: 'S256',
        })
        res.redirect(authUrl)
        return
    }

    const state = generators.state()
    const codeVerifier = generators.codeVerifier()
    const codeChallenge = generators.codeChallenge(codeVerifier)
    const returnTo = (req.query.returnTo as string) ?? '/'

    // Store OIDC flow state in a signed cookie on the browser.
    // Any pod can handle the callback since there's no server-side state.
    setCookie(res, 'ts_oidc', { state, codeVerifier, returnTo } satisfies OidcCookieState, 300)

    const authUrl = getOidcClient().authorizationUrl({
        scope: 'openid profile email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    })

    oidcLogger.info(`Starting OIDC flow (returnTo=${returnTo})`)
    res.redirect(authUrl)
}

// ---------------------------------------------------------------------------
// GET /callback — complete OIDC flow, set ts_user cookie, sync teams
// ---------------------------------------------------------------------------
export async function callbackHandler(req: Request, res: Response): Promise<void> {
    oidcLogger.debug('Callback received')
    try {
        const oidcState = getCookie<OidcCookieState>(req, 'ts_oidc')
        if (!oidcState) {
            oidcLogger.error('No ts_oidc cookie found — expired or tampered')
            res.status(400).send('Invalid or expired login state. Please try again.')
            return
        }

        const client = getOidcClient()
        const params = client.callbackParams(req)
        oidcLogger.debug(`Callback params: state=${params.state} code=${params.code?.substring(0, 8)}...`)

        if (params.state !== oidcState.state) {
            oidcLogger.error(`State mismatch — expected ${oidcState.state} got ${params.state}`)
            res.status(400).send('Invalid login state. Please try again.')
            return
        }

        clearCookie(res, 'ts_oidc')
        oidcLogger.debug('State validated, ts_oidc cookie cleared')

        oidcLogger.debug('Exchanging code for tokens')
        const tokenSet = await client.callback(config.oidc.redirectUri, params, {
            code_verifier: oidcState.codeVerifier,
            state: params.state,
        })
        oidcLogger.debug(`Token exchange successful (expires_at=${tokenSet.expires_at})`)

        const userinfo = await client.userinfo(tokenSet)
        oidcLogger.debug(`Userinfo received: ${JSON.stringify(userinfo)}`)

        const username = (userinfo.preferred_username ?? userinfo.name ?? userinfo.sub) as string
        const appRoles = mockAppRoles[username] ?? mockAppRoles[userinfo.name ?? ''] ?? [] // prod: userinfo.appRoles
        oidcLogger.info(`Resolved username="${username}" appRoles=${JSON.stringify(appRoles)}`)

        if (!appRoles.length) {
            oidcLogger.warn(`No appRoles found for "${username}" — Viewer role, no team assignments`)
        }

        const role = getRoleFromAppRoles(appRoles)
        if (!role) {
            oidcLogger.warn(`Access denied for "${username}" — not in any authorized group`)
            clearCookie(res, 'ts_oidc')
            res.status(403).send('Access denied. You are not authorized to access Grafana.')
            return
        }

        const user: GrafanaUser = {
            username,
            name: userinfo.name ?? username,
            email: userinfo.email ?? `${username}@example.com`,
            role,
        }

        // Set ts_user cookie — shared secret means any pod can verify it
        setCookie(res, 'ts_user', user, config.sync.sessionTtlSecs)
        oidcLogger.info(`Set ts_user cookie for "${username}"`)

        oidcLogger.info(`Running team sync for "${username}"`)
        await syncUserTeams(username, appRoles).catch(e => {
            const msg = e instanceof Error ? e.message : String(e)
            oidcLogger.error(`Team sync failed (non-fatal): ${msg}`)
        })

        oidcLogger.info(`Login complete for "${username}", redirecting to ${oidcState.returnTo}`)
        res.redirect(oidcState.returnTo)

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        oidcLogger.error(`Callback error: ${msg}`)
        if (stack) oidcLogger.debug(stack)
        res.status(500).send('Authentication error. Please try again.')
    }
}