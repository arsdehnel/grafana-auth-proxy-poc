import logger from './logger.js'

const startupLogger = logger.child({ task: 'config' })

function requireEnv(key: string): string {
    const val = process.env[key]
    if (!val) throw new Error(`Missing required environment variable: ${key}`)
    return val
}

function optionalEnv(key: string, defaultValue: string): string {
    return process.env[key] ?? defaultValue
}

function boolEnv(key: string, defaultValue: boolean): boolean {
    const val = process.env[key]
    if (val === undefined) return defaultValue
    return val.toLowerCase() === 'true'
}

function intEnv(key: string, defaultValue: number): number {
    const val = process.env[key]
    if (val === undefined) return defaultValue
    const parsed = parseInt(val, 10)
    if (isNaN(parsed)) throw new Error(`Env var ${key} must be an integer, got: "${val}"`)
    return parsed
}

function setEnv(key: string, defaultValue: string[]): Set<string> {
    const val = process.env[key]
    if (!val) return new Set(defaultValue)
    return new Set(val.split(',').map(s => s.trim()).filter(Boolean))
}

function arrayEnv(key: string): string[] {
    const val = process.env[key]
    if (!val) return []
    return val.split(',').map(s => s.trim()).filter(Boolean)
}

export const config = {
    oidc: {
        issuerInternal: requireEnv('OIDC_ISSUER_INTERNAL'),
        issuerExternal: requireEnv('OIDC_ISSUER_EXTERNAL'),
        clientId: requireEnv('OIDC_CLIENT_ID'),
        clientSecret: requireEnv('OIDC_CLIENT_SECRET'),
        redirectUri: requireEnv('OIDC_REDIRECT_URI'),
        maxAttempts: intEnv('OIDC_MAX_ATTEMPTS', 10),
        retryDelayMs: intEnv('OIDC_RETRY_DELAY_MS', 3000),
    },
    grafana: {
        url: requireEnv('GRAFANA_URL'),
    },
    server: {
        port: intEnv('PORT', 3001),
        cookieSecret: requireEnv('COOKIE_SECRET'),
        ensureTeams: boolEnv('ENSURE_TEAMS', false),
    },
    sync: {
        ttlMs: intEnv('SYNC_TTL_MS', 60_000),
        skipUsers: setEnv('SYNC_SKIP_USERS', ['admin']),
        sessionTtlSecs: intEnv('SESSION_TTL_SECS', 8 * 60 * 60),
    },
    grafanaRoles: {
        adminGroups: arrayEnv('GRAFANA_ADMIN_GROUPS'),
        viewerGroups: arrayEnv('GRAFANA_VIEWER_GROUPS'),
    },
} as const

if (!config.grafanaRoles.adminGroups.length && !config.grafanaRoles.viewerGroups.length) {
    throw new Error('At least one of GRAFANA_ADMIN_GROUPS or GRAFANA_VIEWER_GROUPS must be set')
}

export type Config = typeof config

const REDACTED = ['clientSecret', 'cookieSecret']

Object.entries(config).forEach(([group, values]) => {
    Object.entries(values).forEach(([key, value]) => {
        const display = REDACTED.includes(key) ? '[REDACTED]' : String(value)
        startupLogger.debug(`${group}.${key}: ${display}`)
    })
})

startupLogger.info('Configuration loaded OK')