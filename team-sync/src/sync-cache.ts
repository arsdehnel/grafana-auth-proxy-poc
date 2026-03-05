import logger from './logger.js'
import { config } from './config.js'

const cacheLogger = logger.child({ task: 'sync-cache' })

interface CacheEntry {
    roleHash: string
    expiresAt: number
}

const syncCache = new Map<string, CacheEntry>()

export function hashRoles(appRoles: string[]): string {
    return JSON.stringify([...appRoles].sort())
}

export function checkCache(username: string, roleHash: string): boolean {
    const cached = syncCache.get(username)
    if (!cached) {
        cacheLogger.debug(`No cache entry for "${username}", running first sync`)
        return false
    }
    if (cached.roleHash !== roleHash) {
        cacheLogger.debug(`Cache miss for "${username}" — roles changed`)
        return false
    }
    if (Date.now() >= cached.expiresAt) {
        cacheLogger.debug(`Cache miss for "${username}" — TTL expired`)
        return false
    }
    const remainingMs = cached.expiresAt - Date.now()
    cacheLogger.debug(`Cache hit for "${username}", skipping (expires in ${Math.round(remainingMs / 1000)}s)`)
    return true
}

export function setCache(username: string, roleHash: string): void {
    syncCache.set(username, { roleHash, expiresAt: Date.now() + config.sync.ttlMs })
    cacheLogger.debug(`Cache set for "${username}", expires in ${config.sync.ttlMs / 1000}s`)
}

export function invalidateCache(username: string): void {
    syncCache.delete(username)
    cacheLogger.debug(`Cache invalidated for "${username}"`)
}