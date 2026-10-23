export const sessionsPartIds = ['titlebar', 'banner', 'sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const;
export type SessionsPartId = typeof sessionsPartIds[number] | 'customview';

export const SESSION_SIDEBAR_DEFAULT_WIDTH = 300;
export const SESSION_AUXILIARYBAR_DEFAULT_WIDTH = 240;
