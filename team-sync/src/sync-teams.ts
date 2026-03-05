import axios from 'axios'
import logger from './logger.js'
import { config } from './config.js'
import { grafanaAdminClient } from './grafana-client.js'
import { getUserId } from './get-user-id.js'
import { getTeamId } from './get-team-id.js'
import { hashRoles, checkCache, setCache } from './sync-cache.js'

const syncLogger = logger.child({ task: 'sync-teams' })

interface GrafanaTeam {
    id: number
    name: string
}

async function getCurrentTeamNames(userId: number): Promise<string[]> {
    const res = await grafanaAdminClient.get<GrafanaTeam[]>(`/api/users/${userId}/teams`)
    return res.data.map(t => t.name)
}

async function addToTeam(username: string, teamName: string, userId: number): Promise<void> {
    const teamId = await getTeamId(teamName)
    if (!teamId) {
        syncLogger.warn(`Skipping add to "${teamName}" — not found`)
        return
    }
    await grafanaAdminClient.post(`/api/teams/${teamId}/members`, { userId })
    syncLogger.info(`Added "${username}" to "${teamName}"`)
}

async function removeFromTeam(username: string, teamName: string, userId: number): Promise<void> {
    const teamId = await getTeamId(teamName)
    if (!teamId) {
        syncLogger.warn(`Skipping remove from "${teamName}" — not found`)
        return
    }
    await grafanaAdminClient.delete(`/api/teams/${teamId}/members/${userId}`)
    syncLogger.info(`Removed "${username}" from "${teamName}"`)
}

export async function syncUserTeams(username: string, appRoles: string[]): Promise<void> {
    if (config.sync.skipUsers.has(username)) {
        syncLogger.info(`Skipping sync for "${username}" — in skip list`)
        return
    }

    syncLogger.info(`Starting team sync for "${username}"`)
    syncLogger.debug(`appRoles: ${JSON.stringify(appRoles)}`)

    const roleHash = hashRoles(appRoles)
    if (checkCache(username, roleHash)) return

    const desiredTeamNames = appRoles.filter(r => !r.startsWith('!'))
    syncLogger.debug(`Desired teams for "${username}": [${desiredTeamNames.join(', ')}]`)

    const userId = await getUserId(username)
    if (!userId) {
        syncLogger.info(`Skipping — "${username}" not in Grafana yet, will retry on next request`)
        return
    }

    const currentTeamNames = await getCurrentTeamNames(userId)
    syncLogger.debug(`Current teams for "${username}": [${currentTeamNames.join(', ')}]`)

    const toAdd = desiredTeamNames.filter(t => !currentTeamNames.includes(t))
    const toRemove = currentTeamNames.filter(t => !desiredTeamNames.includes(t))

    if (!toAdd.length && !toRemove.length) {
        syncLogger.info(`No team changes needed for "${username}"`)
        setCache(username, roleHash)
        return
    }

    syncLogger.info(`Changes for "${username}": add=[${toAdd.join(', ')}] remove=[${toRemove.join(', ')}]`)

    for (const teamName of toAdd) {
        try {
            await addToTeam(username, teamName, userId)
        } catch (err) {
            syncLogger.error(`Failed to add "${username}" to "${teamName}": ${axios.isAxiosError(err) ? err.message : String(err)}`)
        }
    }

    for (const teamName of toRemove) {
        try {
            await removeFromTeam(username, teamName, userId)
        } catch (err) {
            syncLogger.error(`Failed to remove "${username}" from "${teamName}": ${axios.isAxiosError(err) ? err.message : String(err)}`)
        }
    }

    setCache(username, roleHash)
    syncLogger.info(`Sync complete for "${username}"`)
}