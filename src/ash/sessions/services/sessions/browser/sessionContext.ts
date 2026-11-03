import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { SessionId } from '../common/session.js';

/** The conversation owned by this surface, including when another pane is active. */
export interface ISessionContext {
	readonly sessionId: SessionId | undefined;
	readonly onDidChange: Event<void>;
}

export const ISessionContext = createServiceIdentifier<ISessionContext>('sessionContext');
