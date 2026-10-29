export const sessionsPartIds = ['titlebar', 'banner', 'sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const;
export type SessionsPartId = (typeof sessionsPartIds)[number] | 'customview';
