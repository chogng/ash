import { LRUCache } from '../../../../base/common/map.js';
import { extUri } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT, type IChatWidgetViewState } from '../../../../workbench/contrib/chat/browser/chat.js';

export const ISessionsChatViewStateService = createServiceIdentifier<ISessionsChatViewStateService>('sessionsChatViewStateService');

/** Window-local presentation state for the durable conversation identified by a Chat resource. */
export interface ISessionsChatViewStateService {
	get(resource: URI): IChatWidgetViewState | undefined;
	set(resource: URI, state: IChatWidgetViewState): void;
}

export class SessionsChatViewStateService implements ISessionsChatViewStateService {
	private readonly states = new LRUCache<string, IChatWidgetViewState>(CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT);

	get(resource: URI): IChatWidgetViewState | undefined {
		return this.states.get(extUri.getComparisonKey(resource));
	}

	set(resource: URI, state: IChatWidgetViewState): void {
		this.states.set(extUri.getComparisonKey(resource), state);
	}
}
