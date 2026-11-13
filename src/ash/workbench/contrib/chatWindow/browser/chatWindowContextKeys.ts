import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';

import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';

export const InChatWindowContext = new RawContextKey<boolean>('chatWindow', false);
export const CanToggleChatWindowConversationContext = new RawContextKey<boolean>('chatWindowCanToggleConversation', false);

export function bindChatWindowContext(context: IContextKeyService): void {
	InChatWindowContext.bindTo(context).set(true);
	IsAuxiliaryWindowContext.bindTo(context).set(true);
}
