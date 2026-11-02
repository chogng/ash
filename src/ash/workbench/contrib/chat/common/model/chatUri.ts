import { URI } from '../../../../../base/common/uri.js';

/** A Chat resource carries both durable IDs; it never depends on the selected window. */
export namespace LocalChatSessionUri {
	export function forSession(sessionId: string, threadId: string): URI {
		return URI.from({ scheme: 'ash-chat-session', path: `/${encodeURIComponent(sessionId)}/${encodeURIComponent(threadId)}` });
	}

	export function parse(resource: URI): { readonly sessionId: string; readonly threadId: string; } | undefined {
		if (resource.scheme !== 'ash-chat-session' || resource.authority || resource.query || resource.fragment) return undefined;
		const segments = resource.path.split('/');
		if (segments.length !== 3) return undefined;
		try {
			const sessionId = decodeURIComponent(segments[1]!);
			const threadId = decodeURIComponent(segments[2]!);
			return sessionId.trim() && threadId.trim() ? { sessionId, threadId } : undefined;
		} catch { return undefined; }
	}
}
