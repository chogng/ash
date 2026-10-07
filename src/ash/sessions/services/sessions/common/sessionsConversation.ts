import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export type SessionsConversationKind = 'code' | 'cowork';

/** Entry navigation selects the conversation UI before revealing or focusing its Part. */
export interface ISessionsConversationService {
	setConversationKind(kind: SessionsConversationKind): Promise<void>;
}

export const ISessionsConversationService = createServiceIdentifier<ISessionsConversationService>('sessionsConversationService');
