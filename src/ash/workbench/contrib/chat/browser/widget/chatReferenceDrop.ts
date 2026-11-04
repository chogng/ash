import type { URI } from '../../../../../base/common/uri.js';
import type { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';

type ConversationIdentity = NonNullable<ReturnType<typeof LocalChatSessionUri.parse>>;

/** Authorizes a drop using the original composer's identity and the live host catalog. */
export function resolveChatReferenceDrop(
	resource: URI,
	target: ConversationIdentity | undefined,
	navigation: IChatSessionNavigationService,
) {
	const identity = LocalChatSessionUri.parse(resource);
	if (!identity || !target || (identity.sessionId === target.sessionId && identity.threadId === target.threadId)) return undefined;
	const conversations = navigation.getConversationsForReference?.();
	const destination = conversations?.find(item => item.sessionId === target.sessionId && item.threadId === target.threadId);
	const source = conversations?.find(item => item.sessionId === identity.sessionId && item.threadId === identity.threadId);
	return source && destination && source.providerId === destination.providerId ? source : undefined;
}
