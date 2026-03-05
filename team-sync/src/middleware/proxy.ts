import { createProxyMiddleware } from 'http-proxy-middleware'
import type { Request, Response } from 'express'
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import logger from '../logger.js'
import { config } from '../config.js'

const proxyLogger = logger.child({ task: 'proxy-middleware' })

const WEBAUTH_HEADERS = ['X-WEBAUTH-USER', 'X-WEBAUTH-NAME', 'X-WEBAUTH-EMAIL', 'X-WEBAUTH-ROLE'] as const

export const grafanaProxy = createProxyMiddleware({
    target: config.grafana.url,
    changeOrigin: true,
    ws: true,
    on: {
        proxyReq: (proxyReq: ClientRequest, req: IncomingMessage) => {
            const expressReq = req as Request
            WEBAUTH_HEADERS.forEach(h => proxyReq.removeHeader(h))

            if (expressReq.grafanaUser) {
                const { username, name, email, role } = expressReq.grafanaUser
                proxyLogger.debug(`Injecting auth headers for "${username}" (role=${role})`)
                proxyReq.setHeader('X-WEBAUTH-USER', username)
                proxyReq.setHeader('X-WEBAUTH-NAME', name)
                proxyReq.setHeader('X-WEBAUTH-EMAIL', email)
                proxyReq.setHeader('X-WEBAUTH-ROLE', role)
            } else {
                proxyLogger.debug(`No grafanaUser on request — forwarding without auth headers`)
            }
        },
        proxyRes: (proxyRes: IncomingMessage, req: IncomingMessage) => {
            const expressReq = req as Request
            proxyLogger.debug(`${expressReq.method} ${expressReq.path} → ${proxyRes.statusCode}`)
        },
        error: (err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
            const expressReq = req as Request
            proxyLogger.error(`Error proxying ${expressReq.method} ${expressReq.path}: ${err.message}`)
            if (res instanceof ServerResponse) {
                const expressRes = res as Response
                if (!expressRes.headersSent) expressRes.status(502).send('Bad gateway — could not reach Grafana')
            }
        }
    }
})