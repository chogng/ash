import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import type { IDictationService, IDictationSession } from '../common/dictationService.js';

interface ActiveDictation {
	readonly resourceId: string;
	readonly onTranscript: (text: string) => void;
	readonly onEnded: (error?: string) => void;
}

export class AppServerDictationService extends Disposable implements IDictationService {
	private active: ActiveDictation | undefined;

	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onNotification(notification => {
			const active = this.active;
			if (!active) { return; }
			if (notification.method === 'dictation/transcript' && notification.params.resourceId === active.resourceId) {
				active.onTranscript(notification.params.text);
			} else if (notification.method === 'dictation/ended' && notification.params.resourceId === active.resourceId) {
				this.active = undefined;
				active.onEnded(notification.params.error ?? undefined);
				void this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId }).catch(() => undefined);
			}
		}));
		this._register(client.onStateChange(state => {
			if (state === 'ready' || !this.active) { return; }
			const active = this.active;
			this.active = undefined;
			active.onEnded('Dictation connection lost');
		}));
	}

	async start(onTranscript: (text: string) => void, onEnded: (error?: string) => void): Promise<IDictationSession> {
		if (this.client.state !== 'ready') { throw new Error('Dictation connection is unavailable'); }
		if (this.active) { throw new Error('Dictation is already active'); }
		const active = { resourceId: generateUuid(), onTranscript, onEnded };
		this.active = active;
		try {
			await this.client.request(APP_SERVER_METHODS['dictation/start'], { resourceId: active.resourceId });
		} catch (error) {
			if (this.active === active) { this.active = undefined; }
			throw error;
		}
		return { stop: () => this.stop(active) };
	}

	private async stop(active: ActiveDictation): Promise<void> {
		if (this.active !== active) { return; }
		this.active = undefined;
		await this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId });
	}

	public override dispose(): void {
		const active = this.active;
		if (active) { void this.stop(active).catch(() => undefined); }
		super.dispose();
	}
}
