import { Emitter } from '../../../base/common/event.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS, type CallStatus, type CallControl } from '../../app-server/common/generated/index.js';
import type { CallDeployment, CallInvitation, CallState, ICallService, ScreenFrame, ScreenSource, ScreenTarget } from '../common/callService.js';

export class AppServerCallService extends Disposable implements ICallService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly screensChanged = this._register(new Emitter<void>());
	public readonly onDidChangeScreens = this.screensChanged.event;
	private readonly screenPoll = this._register(new RunOnceScheduler(() => { void this.readScreens(); }, 67));
	private readonly frames = new Map<string, ScreenFrame>();
	private readingScreens = false;
	private mediaEpoch = 0;
	private screenGeneration = 0;
	public screenError: string | undefined;
	public get screens(): readonly ScreenFrame[] { return [...this.frames.values()]; }
	private resource: string | undefined;
	private sequence = -1;
	private revision = 0;
	private current: CallState | undefined;
	private readonly device = generateUuid();
	public get state(): CallState | undefined { return this.current; }

	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onNotification(notification => {
			if (notification.method === 'call/changed') { this.accept(notification.params); }
		}));
		this._register(client.onStateChange(state => {
			if (state === 'crashed' && this.current) {
				this.current = { ...this.current, connection: 'failed', muted: true, screenSharing: false, error: 'Connection lost. Join the call again.' };
				this.resource = undefined;
				this.clearScreens();
				this.changed.fire();
			}
		}));
	}

	public async start(deployment: CallDeployment): Promise<void> {
		if (this.resource && this.current && !['ended', 'failed'].includes(this.current.connection)) { throw new Error('Leave the current call first.'); }
		this.resource = generateUuid();
		this.sequence = -1;
		try {
			this.accept(await this.client.request(APP_SERVER_METHODS['call/start'], { resourceId: this.resource, operationId: generateUuid(), deviceId: this.device, deployment }));
		} catch (error) {
			this.resource = undefined;
			throw error;
		}
	}

	public mute(muted: boolean): Promise<void> { return this.control({ type: muted ? 'mute' : 'unmute' }); }
	public deafen(deafened: boolean): Promise<void> { return this.control({ type: deafened ? 'deafen' : 'undeafen' }); }
	public selectDevice(): Promise<void> { return this.control({ type: 'selectDevice', operationId: generateUuid(), revision: this.revision }); }
	public async screenSources(): Promise<readonly ScreenSource[]> {
		const result = await this.client.request(APP_SERVER_METHODS['call/screenSources'], { resourceId: this.requireResource() });
		return result.sources.map(source => ({ target: { type: source.target.type, id: source.target.id }, title: source.title, width: source.width, height: source.height }));
	}
	public shareScreen(target: ScreenTarget): Promise<void> { return this.control({ type: 'shareScreen', target }); }
	public stopScreenShare(): Promise<void> { return this.control({ type: 'stopScreenShare' }); }
	public async invite(): Promise<CallInvitation> {
		return this.client.request(APP_SERVER_METHODS['call/invite'], { resourceId: this.requireResource(), operationId: generateUuid(), revision: this.revision, role: 'speaker' });
	}
	public async leave(): Promise<void> {
		this.accept(await this.client.request(APP_SERVER_METHODS['call/leave'], { resourceId: this.requireResource() }));
	}
	public async end(): Promise<void> {
		this.accept(await this.client.request(APP_SERVER_METHODS['call/end'], { resourceId: this.requireResource(), operationId: generateUuid(), revision: this.revision }));
	}
	private async control(control: CallControl): Promise<void> {
		this.accept(await this.client.request(APP_SERVER_METHODS['call/control'], { resourceId: this.requireResource(), control }));
	}
	private requireResource(): string {
		if (!this.resource) { throw new Error('Join a call first.'); }
		return this.resource;
	}
	private accept(status: CallStatus): void {
		if (status.resourceId !== this.resource || status.sequence < this.sequence) { return; }
		this.sequence = status.sequence;
		this.revision = status.call.revision;
		if (this.mediaEpoch !== status.call.mediaEpoch || status.connection !== 'connected') { this.clearScreens(); }
		this.mediaEpoch = status.call.mediaEpoch;
		const role = status.call.members.find(member => member.id === status.memberId)?.role;
		this.current = {
			connection: status.connection, muted: status.muted, deafened: status.deafened,
			microphoneAllowed: status.microphoneAllowed, canManage: role === 'owner',
			screenSharing: status.screenSharing, screenAllowed: role === 'owner' || role === 'speaker',
			participants: status.participants.map(({ id, muted }) => ({ id, muted })), error: status.error,
		};
		this.changed.fire();
		if (status.connection === 'connected' && !this.readingScreens && !this.screenPoll.isScheduled()) { this.screenPoll.schedule(); }
	}

	public override dispose(): void {
		this.clearScreens();
		super.dispose();
	}

	private clearScreens(): void {
		this.screenGeneration++;
		this.screenPoll.cancel();
		this.frames.clear();
		this.screenError = undefined;
		this.screensChanged.fire();
	}

	private async readScreens(): Promise<void> {
		if (this.isDisposed || this.readingScreens || !this.resource || this.current?.connection !== 'connected') { return; }
		const resource = this.resource;
		const epoch = this.mediaEpoch;
		const generation = this.screenGeneration;
		this.readingScreens = true;
		try {
			const result = await this.client.request(APP_SERVER_METHODS['call/screenFrames'], { resourceId: resource });
			if (this.isDisposed || resource !== this.resource || epoch !== this.mediaEpoch || generation !== this.screenGeneration || result.mediaEpoch !== epoch || this.current?.connection !== 'connected') { return; }
			if (result.tracks.length > 8 || result.frames.length > 8) { throw new Error('Too many shared screens.'); }
			for (const id of this.frames.keys()) { if (!result.tracks.includes(id)) { this.frames.delete(id); } }
			for (const frame of result.frames) {
				if (!result.tracks.includes(frame.trackId) || frame.jpeg.length > 2_796_204) { throw new Error('Invalid shared screen frame.'); }
				const bytes = atob(frame.jpeg);
				const data = Uint8Array.from(bytes, character => character.charCodeAt(0));
				this.frames.set(frame.trackId, { trackId: frame.trackId, participantId: frame.participantId, data });
			}
			this.screenError = undefined;
			this.screensChanged.fire();
		} catch (error) {
			if (!this.isDisposed && resource === this.resource && epoch === this.mediaEpoch && generation === this.screenGeneration && this.current?.connection === 'connected') {
				this.frames.clear();
				this.screenError = error instanceof Error ? error.message : 'Could not receive shared screens.';
				this.screensChanged.fire();
			}
		} finally {
			this.readingScreens = false;
			if (!this.isDisposed && this.current?.connection === 'connected') { this.screenPoll.schedule(this.screenError ? 1000 : 67); }
		}
	}
}
