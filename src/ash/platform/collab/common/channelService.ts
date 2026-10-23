import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type ChannelRole = 'owner' | 'editor' | 'viewer';
export interface Channel { readonly id: string; readonly name: string; readonly parentId?: string; }
export interface ChannelMember { readonly id: string; readonly name: string; readonly role: ChannelRole; }
export interface ChannelSpace {
	readonly id: string; readonly name: string; readonly serverUrl: string; readonly revision: number;
	readonly memberId: string; readonly channels: readonly Channel[]; readonly members: readonly ChannelMember[];
}
export type ChannelConnect = { readonly type: 'join'; readonly serverUrl: string; readonly credential: string; }
	| { readonly type: 'create'; readonly serverUrl: string; readonly administrator: string; readonly name: string; readonly memberName: string; };
export type ChannelChange = { readonly type: 'create'; readonly name: string; readonly parentId?: string; }
	| { readonly type: 'rename'; readonly channelId: string; readonly name: string; }
	| { readonly type: 'remove'; readonly channelId: string; }
	| { readonly type: 'setRole'; readonly memberId: string; readonly role: ChannelRole; }
	| { readonly type: 'removeMember'; readonly memberId: string; };
export type ChannelFailure = 'invalid' | 'denied' | 'conflict' | 'storage' | 'transport';
export interface ChannelInvitation { readonly serverUrl: string; readonly credential: string; }
export interface ChannelReference { readonly spaceId: string; readonly channelId: string; readonly serverUrl: string; }
/** Scoped credentials live only in a resource connection, never in editor URIs or settings. */
export interface ChannelResourceAccess { readonly serverUrl: string; readonly resourceId: string; readonly credential: string; }
/** Shared backend account facade. Watchers receive authoritative snapshots, never optimistic writes. */
export interface IChannelService {
	readonly space: ChannelSpace | undefined;
	readonly error: ChannelFailure | undefined;
	readonly busy: boolean;
	readonly onDidChange: Event<void>;
	watch(): IDisposable;
	refresh(): Promise<void>;
	connect(params: ChannelConnect): Promise<void>;
	edit(change: ChannelChange): Promise<void>;
	invite(name: string, role: ChannelRole): Promise<ChannelInvitation | undefined>;
	signInKey(): Promise<ChannelInvitation | undefined>;
	disconnect(): Promise<void>;
	notes(channel: ChannelReference): Promise<ChannelResourceAccess>;
	call(channel: ChannelReference): Promise<ChannelResourceAccess>;
}
export const IChannelService = createServiceIdentifier<IChannelService>('channelService');
