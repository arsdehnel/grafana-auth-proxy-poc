import express from 'express'
import logger from './logger.js'
import { config } from './config.js'
import { initOidc } from './oidc-client.js'
import { authMiddleware } from './middleware/auth.js'
import { grafanaProxy } from './middleware/proxy.js'
import { loginHandler, callbackHandler } from './routes/oidc.js'
import { mockAppRoles } from './mock-data.js'

const serverLogger = logger.child({ task: 'server' })

const app = express()

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(authMiddleware)

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/login', loginHandler)
app.get('/callback', callbackHandler)
app.use(grafanaProxy)

// ---------------------------------------------------------------------------
// Process handlers
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
    serverLogger.error(`Unhandled promise rejection: ${String(reason)}`)
})

process.on('uncaughtException', (err) => {
    serverLogger.error(`Uncaught exception: ${err.message}`)
    serverLogger.debug(err.stack ?? '')
    process.exit(1)
})

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
serverLogger.info(`Mock users configured: ${Object.keys(mockAppRoles).join(', ')}`)

initOidc()
    .then(() => {
        app.listen(config.server.port, () => {
            serverLogger.info(`team-sync listening on :${config.server.port}`)
        })
    })
    .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        serverLogger.error(`FATAL: ${msg}`)
        process.exit(1)
    })