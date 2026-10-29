import { URI } from '../../../base/common/uri.js';

export const OPEN_SESSION_LINK_SCHEME = 'agent-host-session';

/** Explicit coordinates in the owning App Server; IDs never encode a chat's role. */
export interface OpenSessionLink {
	readonly connectionAuthority: string;
	readonly sessionId: string;
	readonly threadId: string;
}

/** Encodes IDs as data so reserved characters cannot alter a link's destination. */
export function buildOpenSessionLinkUri(sessionId: string, threadId: string, connectionAuthority: string): URI {
	return URI.from({
		scheme: OPEN_SESSION_LINK_SCHEME,
		authority: connectionAuthority,
		path: '/open',
		query: new URLSearchParams({ sessionId, threadId }).toString(),
	});
}

/** Validates a user-supplied link before any connection lookup or backend read. */
export function parseOpenSessionLinkUri(resource: URI): OpenSessionLink {
	const query = new URLSearchParams(resource.query);
	const sessionId = query.get('sessionId');
	const threadId = query.get('threadId');
	if (
		resource.scheme !== OPEN_SESSION_LINK_SCHEME ||
		!resource.authority ||
		resource.path !== '/open' ||
		resource.fragment ||
		[...query.keys()].length !== 2 ||
		query.getAll('sessionId').length !== 1 ||
		query.getAll('threadId').length !== 1 ||
		!sessionId ||
		!threadId ||
		sessionId.length > 256 ||
		threadId.length > 256 ||
		/[\x00-\x1f\x7f]/u.test(sessionId + threadId)
	) {
		throw new TypeError('Invalid conversation link');
	}
	return { connectionAuthority: resource.authority, sessionId, threadId };
}
