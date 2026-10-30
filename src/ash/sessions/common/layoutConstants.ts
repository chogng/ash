export const sessionsPartIds = ['titlebar', 'sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const;
export type SessionsPartId = (typeof sessionsPartIds)[number] | 'customview';
