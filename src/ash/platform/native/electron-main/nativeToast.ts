import type { Notification } from 'electron/main';
import type { Event } from '../../../base/common/event.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { CANCEL_TOAST_CHANNEL, SHOW_TOAST_CHANNEL, type IToastOptions, type IToastResult } from '../common/native.js';

const liveKeys = new Set<string>();
const maxToastsPerWindow = 64;
const maxToastLifetime = 60 * 60 * 1000;

export interface INativeToast {
	readonly notification: Pick<Notification, 'once' | 'on' | 'removeAllListeners' | 'show' | 'close'>;
	readonly onDidActivate?: Event<void>;
}

function validateId(id: unknown): string {
	if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new TypeError('Invalid toast request ID');
	return id;
}

function validateOptions(value: unknown): IToastOptions {
	if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 256
		|| (value.body !== undefined && (typeof value.body !== 'string' || value.body.length > 1024))
		|| (value.onlyWhenUnfocused !== undefined && typeof value.onlyWhenUnfocused !== 'boolean')
		|| (value.dedupeKey !== undefined && (typeof value.dedupeKey !== 'string' || !value.dedupeKey || value.dedupeKey.length > 4096))) {
		throw new TypeError('Invalid toast options');
	}
	return { id: validateId(value.id), title: value.title, body: value.body, dedupeKey: value.dedupeKey, onlyWhenUnfocused: value.onlyWhenUnfocused };
}

/** Requests and cancellation belong to the sender. Only the live deduplication keys cross window boundaries. */
export function nativeToastRoutes(
	create: (options: IToastOptions) => INativeToast | undefined,
	onRendererReset: (listener: () => void) => void,
	isWindowFocused: () => boolean,
): readonly IpcRoute<unknown, unknown>[] {
	const pending = new Map<string, () => void>();
	onRendererReset(() => { for (const cancel of pending.values()) cancel(); });

	const show = (options: IToastOptions): Promise<IToastResult> => {
		const { id, dedupeKey } = options;
		if (pending.has(id)) throw new Error('Duplicate toast request ID');
		if (options.onlyWhenUnfocused && isWindowFocused()) return Promise.resolve({ supported: true, clicked: false });
		if (pending.size >= maxToastsPerWindow || dedupeKey && liveKeys.has(dedupeKey)) {
			return Promise.resolve({ supported: true, clicked: false, suppressed: true });
		}
		const created = create(options);
		if (!created) return Promise.resolve({ supported: false, clicked: false });
		const { notification: toast, onDidActivate } = created;
		if (dedupeKey) liveKeys.add(dedupeKey);
		return new Promise(resolve => {
			const finish = (result: IToastResult, close = false): void => {
				if (pending.get(id) !== cancel) return;
				clearTimeout(expiry);
				pending.delete(id);
				if (dedupeKey) liveKeys.delete(dedupeKey);
				activation?.dispose();
				toast.removeAllListeners();
				try { if (close) toast.close(); }
				finally { resolve(result); }
			};
			const cancel = () => finish({ supported: true, clicked: false }, true);
			const expiry = setTimeout(cancel, maxToastLifetime);
			expiry.unref();
			pending.set(id, cancel);
			const clicked = () => finish({ supported: true, clicked: true });
			const activation = onDidActivate?.(clicked);
			toast.once('click', clicked);
			toast.on('close', event => {
				// A timed-out Windows banner can still be opened from Action Center.
				if (event?.reason !== 'timedOut') finish({ supported: true, clicked: false });
			});
			toast.once('failed', () => finish({ supported: false, clicked: false }));
			try { toast.show(); }
			catch { finish({ supported: false, clicked: false }); }
		});
	};

	return [
		{ channel: SHOW_TOAST_CHANNEL, validate: validateOptions, invoke: options => show(options as IToastOptions) },
		{ channel: CANCEL_TOAST_CHANNEL, validate: validateId, invoke: id => pending.get(id as string)?.() },
	];
}
