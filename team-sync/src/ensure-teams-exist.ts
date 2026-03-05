import axios from 'axios'
import logger from './logger.js'
import { grafanaAdminClient } from './grafana-client.js'

const teamsLogger = logger.child({ task: 'ensure-teams' })

export async function ensureTeamsExist(teamNames: string[]): Promise<void> {
    teamsLogger.info(`ENSURE_TEAMS=true, bootstrapping teams: [${teamNames.join(', ')}]`)
    for (const teamName of teamNames) {
        try {
            await grafanaAdminClient.post('/api/teams', { name: teamName })
            teamsLogger.info(`Created team "${teamName}"`)
        } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 409) {
                teamsLogger.debug(`Team "${teamName}" already exists, skipping`)
            } else {
                teamsLogger.error(`Failed to create team "${teamName}": ${axios.isAxiosError(e) ? e.message : String(e)}`)
            }
        }
    }
    teamsLogger.info(`Team bootstrap complete`)
}