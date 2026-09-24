import { randomUUID } from 'node:crypto';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { LoopbackOAuthCallback } from './loopbackOAuthCallback.js';

/** Owns bounded local HTTP callback listeners for one window. OAuth flow state stays in the renderer and backend. */
export class OAuthCallbackHost extends Disposable {
	private readonly callbacks = new Map<string, LoopbackOAuthCallback>();
	private opening = 0;
	constructor() {
		super();
		this._register(toDisposable(() => { for (const callback of this.callbacks.values()) { callback.close(); } this.callbacks.clear(); }));
	}
	public routes(): readonly IpcRoute<unknown, unknown>[] {
		const validate = (value: unknown): string => {
			if (!isRecord(value) || typeof value.id !== 'string') { throw new Error('Invalid callback identity'); }
			return value.id;
		};
		return [{ channel: 'ash:oauth-callback:listen', validate: () => undefined, invoke: async () => {
			this.assertNotDisposed();
			if (this.callbacks.size + this.opening >= 8) { throw new Error('Too many OAuth callbacks'); }
			this.opening++;
			try {
				const id = randomUUID();
				const callback = await LoopbackOAuthCallback.listen(`/connector-oauth/${id}`);
				if (this.isDisposed) { callback.close(); throw new Error('Window closed'); }
				this.callbacks.set(id, callback);
				return { id, redirectUri: callback.redirectUri };
			} finally { this.opening--; }
		} }, { channel: 'ash:oauth-callback:wait', validate, invoke: async value => {
			const callback = this.callbacks.get(value as string);
			if (!callback) { throw new Error('OAuth callback is unavailable'); }
			try { return await callback.wait(); } finally { callback.close(); this.callbacks.delete(value as string); }
		} }, { channel: 'ash:oauth-callback:close', validate, invoke: value => {
			this.callbacks.get(value as string)?.close();
			this.callbacks.delete(value as string);
		} }];
	}
}
