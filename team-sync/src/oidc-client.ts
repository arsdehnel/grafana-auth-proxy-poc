import { Issuer, Client } from 'openid-client'
import logger from './logger.js'
import { config } from './config.js'

const oidcLogger = logger.child({ task: 'oidc-client' })

let oidcClient: Client | null = null

export function getOidcClient(): Client {
    if (!oidcClient) throw new Error('OIDC client accessed before initOidc() completed')
    return oidcClient
}

export async function initOidc(): Promise<void> {
    oidcLogger.info(`Starting OIDC discovery from ${config.oidc.issuerInternal}`)

    for (let i = 0; i < config.oidc.maxAttempts; i++) {
        try {
            const discovered = await Issuer.discover(config.oidc.issuerInternal)
            oidcLogger.info('Discovery successful')
            oidcLogger.debug(`token_endpoint:         ${discovered.token_endpoint}`)
            oidcLogger.debug(`userinfo_endpoint:      ${discovered.userinfo_endpoint}`)
            oidcLogger.debug(`authorization_endpoint: ${discovered.authorization_endpoint}`)

            const issuer = new Issuer({
                ...discovered.metadata,
                issuer: config.oidc.issuerExternal,
                authorization_endpoint: `${config.oidc.issuerExternal}/auth`,
                token_endpoint: `${config.oidc.issuerInternal}/token`,
                userinfo_endpoint: `${config.oidc.issuerInternal}/userinfo`,
                jwks_uri: `${config.oidc.issuerInternal}/keys`,
            })

            oidcLogger.debug('Issuer overrides applied:')
            oidcLogger.debug(`  authorization_endpoint → ${issuer.authorization_endpoint}`)
            oidcLogger.debug(`  token_endpoint         → ${issuer.token_endpoint}`)
            oidcLogger.debug(`  userinfo_endpoint      → ${issuer.userinfo_endpoint}`)

            oidcClient = new issuer.Client({
                client_id: config.oidc.clientId,
                client_secret: config.oidc.clientSecret,
                redirect_uris: [config.oidc.redirectUri],
                response_types: ['code'],
            })

            oidcLogger.info(`Client initialized (client_id=${config.oidc.clientId})`)
            return

        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            oidcLogger.warn(`Waiting for OIDC provider... (attempt ${i + 1}/${config.oidc.maxAttempts}): ${msg}`)
            await new Promise(r => setTimeout(r, config.oidc.retryDelayMs))
        }
    }

    throw new Error(`OIDC discovery failed after ${config.oidc.maxAttempts} attempts`)
}