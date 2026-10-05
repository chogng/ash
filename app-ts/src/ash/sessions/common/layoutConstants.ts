export const sessionsPartIds = ['titlebar', 'activitybar', 'sidebar', 'sessions', 'library', 'creator', 'editor', 'auxiliarybar', 'panel'] as const;
export type SessionsPartId = typeof sessionsPartIds[number];

export const SESSION_SIDEBAR_DEFAULT_WIDTH = 260;
export const SESSION_AUXILIARYBAR_DEFAULT_WIDTH = 200;
