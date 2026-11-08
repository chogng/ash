import type { URI } from '../../../../../base/common/uri.js';
import type { IAgentSession } from './agentSessionsModel.js';
import type { IAgentSessionsService } from './agentSessionsService.js';

interface ISessionOpenOptions {
	readonly allowArchived?: boolean;
	readonly preserveFocus?: boolean;
	readonly overrideSessionOpen?: (session: IAgentSession) => Promise<void>;
}

/** Resolve the current catalog entry before the caller changes its presentation or focus. */
export function prepareSessionOpen(
	sessions: IAgentSessionsService,
	resource: URI,
	{ allowArchived, preserveFocus, overrideSessionOpen }: ISessionOpenOptions,
): (() => void | Promise<void>) | undefined {
	const session = sessions.getSession(resource);
	if (!session || (!allowArchived && session.isArchived())) {
		return undefined;
	}
	if (overrideSessionOpen) {
		return () => overrideSessionOpen(session);
	}
	return () => session.open(preserveFocus === undefined ? undefined : { preserveFocus });
}
