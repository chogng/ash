import { CancellationError } from '../../../base/common/errors.js';
import { localize } from '../../../nls.js';
import { RunOnceScheduler, TaskQueue } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { ChannelConnection } from '../../../../../.build/protocol/typescript/index.js';
import type { ChannelReference, ChannelResourceAccess, ChannelChange, ChannelConnect, ChannelFailure, ChannelInvitation, ChannelRole, ChannelSpace, IChannelService } from '../common/channelService.js';

export class AppServerChannelService extends Disposable implements IChannelService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public space: ChannelSpace | undefined;
	public error: ChannelFailure | undefined;
	public busy = false;
	private watchers = 0;
	private readonly requests = new TaskQueue();
	private readonly poll = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 2000));
	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onStateChange(state => {
			if (state === 'crashed') { this.space = undefined; this.error = 'transport'; this.changed.fire(); }
		}));
	}
	public watch(): IDisposable {
		if (++this.watchers === 1) void this.refresh();
		return toDisposable(() => { if (--this.watchers === 0) this.poll.cancel(); });
	}
	public refresh(): Promise<void> {
		return this.run(async () => this.accept(await appServerRequest(this.client, 'channels/read', {})), false);
	}
	public connect(params: ChannelConnect): Promise<void> {
		return this.run(async () => this.accept(await appServerRequest(this.client, 'channels/connect', params)));
	}
	public edit(change: ChannelChange): Promise<void> {
		const space = this.space;
		if (!space) return Promise.resolve();
		return this.run(async () => this.accept(await appServerRequest(this.client, 'channels/edit', {
			spaceId: space.id, revision: space.revision, change: change.type === 'create' ? { ...change, parentId: change.parentId ?? null } : change,
		})));
	}
	public async invite(name: string, role: ChannelRole): Promise<ChannelInvitation | undefined> {
		const space = this.space;
		if (!space) return undefined;
		let invitation: ChannelInvitation | undefined;
		await this.run(async () => {
			const result = await appServerRequest(this.client, 'channels/invite', { spaceId: space.id, revision: space.revision, name, role });
			invitation = { serverUrl: result.serverUrl, credential: result.credential };
			// Keep a successful invitation even if the following snapshot refresh fails.
			this.accept(await appServerRequest(this.client, 'channels/read', {}));
		});
		return invitation;
	}
	public async signInKey(): Promise<ChannelInvitation | undefined> {
		let key: ChannelInvitation | undefined;
		await this.run(async () => { const result = await appServerRequest(this.client, 'channels/signInKey', {}); key = { serverUrl: result.serverUrl, credential: result.credential }; });
		return key;
	}
	public disconnect(): Promise<void> {
		return this.run(async () => { await appServerRequest(this.client, 'channels/disconnect', {}); this.accept(null); });
	}
	public notes(channel: ChannelReference): Promise<ChannelResourceAccess> { return this.resource('channels/notes', channel); }
	public call(channel: ChannelReference): Promise<ChannelResourceAccess> { return this.resource('channels/call', channel); }
	private async resource(method: 'channels/notes' | 'channels/call', channel: ChannelReference): Promise<ChannelResourceAccess> {
		const space = this.space;
		if (!space || space.id !== channel.spaceId || space.serverUrl !== channel.serverUrl) throw new CancellationError();
		try {
			const result = await appServerRequest(this.client, method, { spaceId: channel.spaceId, channelId: channel.channelId });
			if (this.isDisposed || this.space?.id !== space.id || this.space.memberId !== space.memberId || this.space.serverUrl !== space.serverUrl) throw new CancellationError();
			return { serverUrl: result.serverUrl, resourceId: result.resourceId, credential: result.credential };
		} catch (error) {
			if (error instanceof CancellationError) throw error;
			throw new Error(failure(error) === 'denied'
				? localize('collaboration.resourceDenied', 'Channel access was denied. Read-only members can join an existing call; an editor or administrator must start it.')
				: localize('collaboration.resourceFailed', 'Could not open the channel resource. Check the collaboration server and its call hosting configuration.'));
		}
	}
	private accept(result: ChannelConnection | null): void {
		if (this.isDisposed) return;
		// An unchanged revision preserves the view's objects and keyboard focus during polling.
		if (result && this.space?.id === result.snapshot.id && this.space.revision === result.snapshot.revision
			&& this.space.memberId === result.snapshot.memberId && this.space.serverUrl === result.serverUrl) { this.error = undefined; return; }
		this.space = result ? {
			id: result.snapshot.id, name: result.snapshot.name, serverUrl: result.serverUrl,
			revision: result.snapshot.revision, memberId: result.snapshot.memberId,
			channels: result.snapshot.channels.map(channel => ({ id: channel.id, name: channel.name, parentId: channel.parentId ?? undefined })),
			members: result.snapshot.members.map(member => ({ id: member.id, name: member.name, role: member.role })),
		} : undefined;
		this.error = undefined;
	}
	private run(operation: () => Promise<void>, mutation = true): Promise<void> {
		return this.requests.schedule(async () => {
			if (this.isDisposed) return;
			const previousSpace = this.space, previousError = this.error;
			this.poll.cancel();
			if (mutation) { this.busy = true; this.changed.fire(); }
			try { await operation(); if (!this.isDisposed) this.error = undefined; }
			catch (error) {
				if (this.isDisposed) return;
				this.error = failure(error);
				// Revocation must clear cached names and membership; refresh failures disable mutations.
				if (this.error === 'denied') this.space = undefined;
			}
			finally {
				this.busy = false;
				if (!this.isDisposed) {
					if (mutation || this.space !== previousSpace || this.error !== previousError) this.changed.fire();
					if (this.watchers) this.poll.schedule(this.error ? 5000 : 2000);
				}
			}
		});
	}
}
function failure(error: unknown): ChannelFailure {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'ChannelInvalid': return 'invalid';
			case 'ChannelDenied': case 'PermissionRequired': return 'denied';
			case 'ChannelConflict': return 'conflict';
			case 'ChannelStorage': return 'storage';
		}
	}
	return 'transport';
}
