import { raceCancellationError, ResourceQueue } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import { chatGPTHistoryCooldownMs, readChatGPTRetryAfter } from '../common/chatGPTTransport.js';

const storageScope = { scope: StorageScope.APPLICATION, id: 'application' };

/** Owns recent-list cooldowns across windows and desktop launches. */
export class ChatGPTRecentHistoryGate extends Disposable {
	private readonly requests = this._register(new ResourceQueue());
	private readonly unsaved = new Map<string, number>();

	constructor(
		@IApplicationStorageMainService private readonly storage: IApplicationStorageMainService,
		@ILogService private readonly log: ILogService,
	) { super(); }

	request(scope: string, native: boolean, signal: AbortSignal, fetch: () => Promise<Response>): Promise<Response> {
		const key = `sessions.chatgpt.${native ? 'native' : 'web'}RecentCooldown:${scope}`;
		const request = this.requests.queueFor(URI.from({ scheme: 'ash-chatgpt', path: `/${key}` }), async () => {
			signal.throwIfAborted();
			const snapshot = await this.storage.getItems(storageScope).catch(() => undefined);
			const stored = Number(snapshot?.entries[key]?.value ?? 0);
			const deadline = Math.max(Number.isSafeInteger(stored) ? stored : 0, this.unsaved.get(key) ?? 0);
			signal.throwIfAborted();
			const now = Date.now();
			if (deadline > now) {
				return new Response(null, { status: 429, headers: { 'Retry-After': String(Math.ceil((deadline - now) / 1000)) } });
			}
			this.unsaved.delete(key);
			const response = await fetch();
			if (response.status === 429) {
				const received = Date.now();
				const retryAfter = readChatGPTRetryAfter(response.headers.get('Retry-After'), received);
				const retryAt = native ? Math.max(received + chatGPTHistoryCooldownMs, retryAfter ?? 0) : retryAfter ?? received + chatGPTHistoryCooldownMs;
				try {
					if (!snapshot) { await this.storage.getItems(storageScope); }
					await this.storage.updateItems(storageScope, key, { value: String(retryAt), target: StorageTarget.MACHINE });
				} catch {
					this.unsaved.set(key, retryAt);
					this.log.warn('chatgpt', 'Could not persist the recent history cooldown');
				}
			}
			return response;
		});
		return raceCancellationError(request, signal);
	}
}
