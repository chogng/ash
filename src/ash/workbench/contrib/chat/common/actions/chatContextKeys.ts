import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

export namespace ChatContextKeys {
	/** The window's Chat implementation is available and its UI preference permits use. */
	export const enabled = new RawContextKey<boolean>('chatIsEnabled', false);
	/** Projects the Chat view's actual layout, independently of list visibility. */
	export const agentSessionsViewerOrientation = new RawContextKey<number | undefined>('agentSessionsViewerOrientation', undefined);
}
