import logger from './logger.js'
import { config } from './config.js'

const roleLogger = logger.child({ task: 'role-mapper' })

export type GrafanaRole = 'Admin' | 'Viewer'

export function getRoleFromAppRoles(appRoles: string[]): GrafanaRole | null {
    if (config.grafanaRoles.adminGroups.some(g => appRoles.includes(g))) {
        roleLogger.debug('Resolved Grafana role: Admin')
        return 'Admin'
    }
    if (config.grafanaRoles.viewerGroups.some(g => appRoles.includes(g))) {
        roleLogger.debug('Resolved Grafana role: Viewer')
        return 'Viewer'
    }
    roleLogger.debug('User is not in any authorized group — access denied')
    return null
}