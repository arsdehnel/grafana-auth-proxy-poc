import logger from './logger.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import type { Request, Response } from 'express'

const cookieLogger = logger.child({ task: 'cookie-helpers' })

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

function sign(value: string): string {
    cookieLogger.debug(`Signing value of length ${value.length}`)
    const hmac = createHmac('sha256', config.server.cookieSecret).update(value).digest('base64url')
    return `${value}.${hmac}`
}

function verify(signed: string | null | undefined): string | null {
    if (!signed) {
        cookieLogger.debug('verify called with empty or null value')
        return null
    }
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) {
        cookieLogger.debug('verify failed: no dot separator found in signed value')
        return null
    }
    const value = signed.slice(0, lastDot)
    const hmac = signed.slice(lastDot + 1)
    const expected = createHmac('sha256', config.server.cookieSecret).update(value).digest('base64url')
    try {
        if (!timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
            cookieLogger.debug('verify failed: HMAC mismatch')
            return null
        }
    } catch {
        cookieLogger.debug('verify failed: timingSafeEqual threw (likely length mismatch)')
        return null
    }
    cookieLogger.debug('verify succeeded')
    return value
}

function setCookie(res: Response, name: string, value: unknown, maxAgeSeconds: number = 3600): void {
    cookieLogger.debug(`Setting cookie "${name}" with maxAge=${maxAgeSeconds}s`)
    const encoded = sign(Buffer.from(JSON.stringify(value)).toString('base64url'))
    res.setHeader('Set-Cookie', `${name}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`)
    cookieLogger.debug(`Cookie "${name}" set successfully`)
}

function getCookie<T = unknown>(req: Request, name: string): T | null {
    cookieLogger.debug(`Getting cookie "${name}"`)
    const cookies = req.headers.cookie ?? ''
    const match = cookies.match(new RegExp(`(?:^|; )${name}=([^;]+)`))
    if (!match) {
        cookieLogger.debug(`Cookie "${name}" not found in request`)
        return null
    }
    const verified = verify(decodeURIComponent(match[1]))
    if (!verified) {
        cookieLogger.warn(`Signature verification failed for cookie "${name}"`)
        return null
    }
    try {
        const parsed = JSON.parse(Buffer.from(verified, 'base64url').toString()) as T
        cookieLogger.debug(`Cookie "${name}" parsed successfully`)
        return parsed
    } catch {
        cookieLogger.warn(`Failed to parse cookie "${name}"`)
        return null
    }
}

function clearCookie(res: Response, name: string): void {
    cookieLogger.debug(`Clearing cookie "${name}"`)
    res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export { sign, verify, setCookie, getCookie, clearCookie }