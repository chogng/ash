export const sessionsPartIds = ['titlebar', 'sidebar', 'sessions', 'editor', 'auxiliarybar'] as const;
export type SessionsPartId = (typeof sessionsPartIds)[number] | 'customview';
