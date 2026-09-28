import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import { validateConfigurationSnapshot, type IConfigurationApi } from '../../configuration/common/configurationIpc.js';
import { dictationBackend } from '../common/dictationConfiguration.js';
import type { IDictationService, IDictationSession } from '../common/dictationService.js';

interface ActiveDictation {
	readonly resourceId: string;
	readonly onTranscript: (text: string, isFinal: boolean) => void;
	readonly onEnded: (error?: string) => void;
	stopping: boolean;
	finalDelivered: boolean;
	endedError?: string;
}

export class AppServerDictationService extends Disposable implements IDictationService {
	private active: ActiveDictation | undefined;

	constructor(private readonly client: AppServerProtocolClient, private readonly configuration: IConfigurationApi) {
		super();
		this._register(client.onNotification(notification => {
			const active = this.active;
			if (!active) { return; }
			if (notification.method === 'dictation/transcript' && notification.params.resourceId === active.resourceId) {
				if (notification.params.isFinal) { active.finalDelivered = true; }
				active.onTranscript(notification.params.text, notification.params.isFinal);
			} else if (notification.method === 'dictation/ended' && notification.params.resourceId === active.resourceId) {
				if (active.stopping) {
					active.endedError = notification.params.error ?? undefined;
					return;
				}
				this.active = undefined;
				active.onEnded(notification.params.error ?? undefined);
				if (!active.stopping) { void this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId }).catch(() => undefined); }
			}
		}));
		this._register(client.onStateChange(state => {
			if (state === 'ready' || !this.active) { return; }
			const active = this.active;
			this.active = undefined;
			active.onEnded('Dictation connection lost');
		}));
	}

	async start(onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<IDictationSession> {
		if (this.client.state !== 'ready') { throw new Error('Dictation connection is unavailable'); }
		if (this.active) { throw new Error('Dictation is already active'); }
		const backend = dictationBackend(validateConfigurationSnapshot(await this.configuration.read()).document);
		const active: ActiveDictation = { resourceId: generateUuid(), onTranscript, onEnded, stopping: false, finalDelivered: false };
		this.active = active;
		try {
			await this.client.request(APP_SERVER_METHODS['dictation/start'], { resourceId: active.resourceId, backend });
		} catch (error) {
			if (this.active === active) { this.active = undefined; }
			throw error;
		}
		return { stop: () => this.stop(active) };
	}

	private async stop(active: ActiveDictation): Promise<void> {
		if (this.active !== active) { return; }
		active.stopping = true;
		try {
			const result = await this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId });
			if (!active.finalDelivered && result.text !== null) {
				active.finalDelivered = true;
				active.onTranscript(result.text, true);
			}
			if (this.active === active) {
				this.active = undefined;
				active.onEnded(active.endedError);
			}
		} catch (error) {
			if (this.active === active) { this.active = undefined; }
			throw error;
		}
	}

	public override dispose(): void {
		const active = this.active;
		if (active) { void this.stop(active).catch(() => undefined); }
		super.dispose();
	}
}
