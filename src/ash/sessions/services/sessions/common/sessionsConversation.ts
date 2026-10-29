import type { IActiveSessionThread, IUntitledChatSession } from './session.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export type SessionsConversationKind = 'code' | 'cowork';

/** Entry navigation selects the conversation UI before revealing or focusing its Part. */
export interface ISessionsConversationService {
	openInNewWindow(selection: { readonly kind: 'session'; readonly active: IActiveSessionThread; } | { readonly kind: 'untitled'; readonly session: IUntitledChatSession; }): Promise<void>;
	setConversationKind(kind: SessionsConversationKind): Promise<void>;
}

export const ISessionsConversationService = createServiceIdentifier<ISessionsConversationService>('sessionsConversationService');
