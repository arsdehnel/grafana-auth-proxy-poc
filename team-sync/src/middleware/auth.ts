import { Request, Response, NextFunction } from 'express'
import logger from '../logger.js'
import { getCookie } from '../cookie-helpers.js'
import { syncUserTeams } from '../sync-teams.js'
import { GrafanaRole } from '../get-role-from-app-roles.js'
import { mockAppRoles } from '../mock-data.js'

const authLogger = logger.child({ task: 'auth-middleware' })

// ---------------------------------------------------------------------------
// GrafanaUser type — shape of the ts_user signed cookie
// ---------------------------------------------------------------------------
export interface GrafanaUser {
    username: string
    name: string
    email: string
    role: GrafanaRole
}

// ---------------------------------------------------------------------------
// Express Request augmentation — makes req.grafanaUser available app-wide
// ---------------------------------------------------------------------------
declare global {
    namespace Express {
        interface Request {
            grafanaUser?: GrafanaUser
        }
    }
}

const OIDC_PATHS = ['/login', '/callback']
const API_PATH_PREFIX = '/api/'

// ---------------------------------------------------------------------------
// Auth middleware
// Reads ts_user signed cookie to identify the user on every request.
// On hit: populates req.grafanaUser, triggers background sync, continues.
// On miss: API requests get 401, all others redirect to /login.
// ---------------------------------------------------------------------------
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (OIDC_PATHS.includes(req.path)) return next()

    const user = getCookie<GrafanaUser>(req, 'ts_user')
    if (user) {
        authLogger.debug(`Identified "${user.username}" from ts_user cookie`)
        req.grafanaUser = user

        // Background re-sync — non-blocking, uses per-pod cache to rate-limit
        const appRoles = mockAppRoles[user.username] ?? [] // prod: fetch from OIDC claims
        syncUserTeams(user.username, appRoles).catch(e => {
            const msg = e instanceof Error ? e.message : String(e)
            authLogger.error(`Background sync failed for "${user.username}": ${msg}`)
        })

        return next()
    }

    if (req.path.startsWith(API_PATH_PREFIX)) {
        authLogger.debug(`No ts_user cookie for API request ${req.path}, returning 401`)
        res.status(401).json({ message: 'Unauthorized' })
        return
    }

    authLogger.debug(`No ts_user cookie for ${req.path}, redirecting to /login`)
    res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`)
}