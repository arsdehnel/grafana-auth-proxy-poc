import axios from 'axios'
import logger from './logger.js'
import { grafanaAdminClient } from './grafana-client.js'

const syncLogger = logger.child({ task: 'get-user-id' })

interface GrafanaUserLookupResponse {
    id: number
    login: string
    email: string
    name: string
}

export async function getUserId(username: string): Promise<number | null> {
    try {
        const res = await grafanaAdminClient.get<GrafanaUserLookupResponse>(
            `/api/users/lookup?loginOrEmail=${encodeURIComponent(username)}`
        )
        const id = res.data.id ?? null
        if (!id) {
            syncLogger.warn(`User "${username}" found but has no ID — unexpected: ${JSON.stringify(res.data)}`)
        } else {
            syncLogger.debug(`Resolved user "${username}" → Grafana ID ${id}`)
        }
        return id
    } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
            syncLogger.debug(`User "${username}" does not exist in Grafana yet`)
            return null
        }
        syncLogger.error(`Error looking up user "${username}": ${axios.isAxiosError(err) ? err.message : String(err)}`)
        throw err
    }
}