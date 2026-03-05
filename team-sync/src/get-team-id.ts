import axios from 'axios'
import logger from './logger.js'
import { grafanaAdminClient } from './grafana-client.js'

const teamsLogger = logger.child({ task: 'get-team-id' })

interface GrafanaTeam {
    id: number
    name: string
}

interface GrafanaTeamSearchResponse {
    teams: GrafanaTeam[]
    totalCount: number
}

export async function getTeamId(teamName: string): Promise<number | null> {
    try {
        const res = await grafanaAdminClient.get<GrafanaTeamSearchResponse>(
            `/api/teams/search?name=${encodeURIComponent(teamName)}`
        )
        const team = res.data.teams?.[0]
        if (!team) {
            teamsLogger.warn(`Team "${teamName}" not found in Grafana — skipping`)
            return null
        }
        teamsLogger.debug(`Resolved team "${teamName}" → ID ${team.id}`)
        return team.id
    } catch (err) {
        teamsLogger.error(`Error looking up team "${teamName}": ${axios.isAxiosError(err) ? err.message : String(err)}`)
        throw err
    }
}