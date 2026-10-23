import { Emitter } from '../../../src/ash/base/common/event.js';
import { Disposable, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { generateUuid } from '../../../src/ash/base/common/uuid.js';
import type { ChannelReference, ChannelChange, ChannelRole, ChannelSpace, IChannelService, ChannelFailure } from '../../../src/ash/platform/collab/common/channelService.js';

/** UI-only authority fixture. Persistence and cross-host authorization are tested against Rust/HTTP. */
export class ChannelServiceFixture extends Disposable implements IChannelService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	busy = false;
	error: ChannelFailure | undefined;
	space: ChannelSpace | undefined = {
		id: 'space', name: 'Ash', serverUrl: 'https://fixture.invalid', revision: 0, memberId: 'owner',
		members: [{ id: 'owner', name: 'Lance', role: 'owner' }, { id: 'guest', name: 'Alice', role: 'viewer' }],
		channels: [{ id: 'general', name: 'general' }, { id: 'rooms', name: 'rooms' }, { id: 'design', parentId: 'rooms', name: 'design' },
		{ id: 'engineering', parentId: 'rooms', name: 'engineering' }, { id: 'projects', name: 'projects' },
		{ id: 'ash', parentId: 'projects', name: 'ash' }, { id: 'desktop', parentId: 'ash', name: 'desktop' }, { id: 'collaboration', parentId: 'ash', name: 'collaboration' }],
	};
	constructor() { super(); const saved = sessionStorage.getItem('channels-fixture'); if (saved) this.space = JSON.parse(saved) as ChannelSpace; }
	watch() { return toDisposable(() => { }); }
	async refresh() { this.error = undefined; this.changed.fire(); }
	async notes(channel: ChannelReference) { return { serverUrl: channel.serverUrl, resourceId: `channel-notes-${channel.channelId}`, credential: 'c'.repeat(64) }; }
	async call(channel: ChannelReference) { return { serverUrl: channel.serverUrl, resourceId: `channel-call-${channel.channelId}`, credential: 'd'.repeat(64) }; }
	async connect() { await this.refresh(); }
	async signInKey() { return { serverUrl: 'https://fixture.invalid', credential: 'b'.repeat(64) }; }
	async disconnect() { this.space = undefined; sessionStorage.removeItem('channels-fixture'); this.changed.fire(); }
	async edit(change: ChannelChange) {
		const space = this.space; if (!space) return;
		switch (change.type) {
			case 'create': this.space = { ...space, channels: [...space.channels, { id: generateUuid(), name: change.name, parentId: change.parentId }] }; break;
			case 'rename': this.space = { ...space, channels: space.channels.map(c => c.id === change.channelId ? { ...c, name: change.name } : c) }; break;
			case 'remove': {
				const removed = new Set([change.channelId]);
				let length = -1;
				while (length !== removed.size) { length = removed.size; for (const c of space.channels) if (c.parentId && removed.has(c.parentId)) removed.add(c.id); }
				this.space = { ...space, channels: space.channels.filter(c => !removed.has(c.id)) }; break;
			}
			case 'setRole': this.space = { ...space, members: space.members.map(m => m.id === change.memberId ? { ...m, role: change.role } : m) }; break;
			case 'removeMember': this.space = { ...space, members: space.members.filter(m => m.id !== change.memberId) }; break;
		}
		this.space = { ...this.space!, revision: space.revision + 1 }; this.publish();
	}
	async invite(name: string, role: ChannelRole) {
		if (!this.space) return undefined;
		this.space = { ...this.space, revision: this.space.revision + 1, members: [...this.space.members, { id: generateUuid(), name, role }] }; this.publish();
		return { serverUrl: this.space.serverUrl, credential: 'a'.repeat(64) };
	}
	setRole(role: ChannelRole) { if (this.space) { this.space = { ...this.space, members: this.space.members.map(m => m.id === this.space!.memberId ? { ...m, role } : m) }; this.publish(); } }
	revoke() { this.space = undefined; this.error = 'denied'; this.changed.fire(); }
	private publish() { sessionStorage.setItem('channels-fixture', JSON.stringify(this.space)); this.changed.fire(); }
}
