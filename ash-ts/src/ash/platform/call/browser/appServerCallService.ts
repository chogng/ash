import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS, type CallStatus, type CallControl } from '../../app-server/common/generated/index.js';
import type { CallDeployment, CallInvitation, CallState, ICallService } from '../common/callService.js';

export class AppServerCallService extends Disposable implements ICallService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
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
				this.current = { ...this.current, connection: 'failed', muted: true, error: 'Connection lost. Join the call again.' };
				this.resource = undefined;
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
		const role = status.call.members.find(member => member.id === status.memberId)?.role;
		this.current = {
			connection: status.connection, muted: status.muted, deafened: status.deafened,
			microphoneAllowed: status.microphoneAllowed, canManage: role === 'owner',
			participants: status.participants.map(({ id, muted }) => ({ id, muted })), error: status.error,
		};
		this.changed.fire();
	}
}
