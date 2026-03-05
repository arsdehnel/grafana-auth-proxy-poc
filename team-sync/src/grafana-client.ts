import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse } from 'axios'
import logger from './logger.js'
import { config } from './config.js'

const grafanaClientLogger = logger.child({ task: 'grafana-client' })

// ---------------------------------------------------------------------------
// Grafana API client
// ---------------------------------------------------------------------------

const grafanaAdminClient = axios.create({
    baseURL: config.grafana.url,
    auth: { username: 'admin', password: 'admin' }
})

function addInterceptors(client: AxiosInstance, tag: string): void {
    client.interceptors.request.use((req: InternalAxiosRequestConfig) => {
        grafanaClientLogger.debug(`--> ${req.method?.toUpperCase()} ${req.baseURL}${req.url}`)
        return req
    })
    client.interceptors.response.use(
        (res: AxiosResponse) => {
            grafanaClientLogger.debug(`<-- ${res.status} ${res.config.method?.toUpperCase()} ${res.config.url}`)
            return res
        },
        (err: unknown) => {
            const status = axios.isAxiosError(err) ? err.response?.status : 'unknown'
            const url = axios.isAxiosError(err) ? err.config?.url : 'unknown'
            const method = axios.isAxiosError(err) ? err.config?.method?.toUpperCase() : 'unknown'
            const body = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : ''
            grafanaClientLogger.error(`<-- ERROR ${status} ${method} ${url} — ${body}`)
            return Promise.reject(err)
        }
    )
}

addInterceptors(grafanaAdminClient, 'grafana-api')

export { grafanaAdminClient }