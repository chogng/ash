import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type CallDeployment = { readonly type: 'local' } | { readonly type: 'server'; readonly url: string; readonly administrator: string } | { readonly type: 'invitation'; readonly url: string; readonly credential: string };
export interface CallState {
	readonly connection: 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed';
	readonly muted: boolean;
	readonly deafened: boolean;
	readonly microphoneAllowed: boolean;
	readonly canManage: boolean;
	readonly screenSharing: boolean;
	readonly screenAllowed: boolean;
	readonly participants: readonly { readonly id: string; readonly muted: boolean }[];
	readonly error: string | null;
}
export interface CallInvitation { readonly url: string; readonly credential: string; }
export type ScreenTarget = { readonly type: 'display' | 'window'; readonly id: string };
export interface ScreenSource { readonly target: ScreenTarget; readonly title: string; readonly width: number; readonly height: number; }
export interface ScreenFrame { readonly trackId: string; readonly participantId: string; readonly data: Uint8Array<ArrayBuffer>; }
export interface ICallService {
	readonly onDidChange: Event<void>;
	readonly onDidChangeScreens: Event<void>;
	readonly screens: readonly ScreenFrame[];
	readonly screenError: string | undefined;
	readonly state: CallState | undefined;
	start(deployment: CallDeployment): Promise<void>;
	mute(muted: boolean): Promise<void>;
	deafen(deafened: boolean): Promise<void>;
	selectDevice(): Promise<void>;
	screenSources(): Promise<readonly ScreenSource[]>;
	shareScreen(target: ScreenTarget): Promise<void>;
	stopScreenShare(): Promise<void>;
	invite(): Promise<CallInvitation>;
	leave(): Promise<void>;
	end(): Promise<void>;
}
export const ICallService = createServiceIdentifier<ICallService>('callService');
