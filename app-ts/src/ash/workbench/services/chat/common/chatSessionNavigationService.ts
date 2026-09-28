import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';

/** Conversation destinations exposed by the session owner to workbench contributions. */
export interface IChatSessionNavigationService {
	getConversations(): readonly { readonly sessionId: string; readonly threadId: string; readonly title: string }[];
	getActiveConversation(): { readonly sessionId: string; readonly threadId: string } | undefined;
	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined>;
	openConversation(sessionId: string, threadId: string): Promise<void>;
}

export const IChatSessionNavigationService = createServiceIdentifier<IChatSessionNavigationService>('chatSessionNavigationService');
