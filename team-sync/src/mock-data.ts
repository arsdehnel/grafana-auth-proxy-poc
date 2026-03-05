// ---------------------------------------------------------------------------
// Dev fallback: mock appRoles by username
// In production these come from OIDC claims (Ping)
// ---------------------------------------------------------------------------
export const mockAppRoles: Record<string, string[]> = {
    adehnel: [
        'sre-editors-pd',
        'sre-editors-np',
        'sre-owners-np',
        '!App-GHE-AD-group-developer',
    ],
    jsmith: [
        'sales-viewers-np',
        '!App-GHE-AD-group-developer',
    ],
}