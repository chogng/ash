import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Conversation destinations exposed by the session owner to workbench contributions. */
export interface IChatSessionNavigationService {
	getConversations(): readonly { readonly sessionId: string; readonly threadId: string; readonly title: string }[];
	openConversation(sessionId: string, threadId: string): Promise<void>;
}

export const IChatSessionNavigationService = createServiceIdentifier<IChatSessionNavigationService>('chatSessionNavigationService');
