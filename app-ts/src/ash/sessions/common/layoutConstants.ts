export const sessionsPartIds = ['titlebar', 'activitybar', 'sidebar', 'sessions', 'editor', 'auxiliarybar'] as const;
export type SessionsPartId = typeof sessionsPartIds[number];

export const SESSION_SIDEBAR_DEFAULT_WIDTH = 260;
export const SESSION_AUXILIARYBAR_DEFAULT_WIDTH = 200;
