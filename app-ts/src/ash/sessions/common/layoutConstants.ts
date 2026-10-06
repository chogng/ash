export const sessionsPartIds = ['titlebar', 'activitybar', 'sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const;
export type SessionsPartId = typeof sessionsPartIds[number];

export const SESSION_SIDEBAR_DEFAULT_WIDTH = 240;
export const SESSION_AUXILIARYBAR_DEFAULT_WIDTH = SESSION_SIDEBAR_DEFAULT_WIDTH;
