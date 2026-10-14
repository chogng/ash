import type { Event } from '../../../../base/common/event.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const AGENTS_VOICE_CONNECTED = new RawContextKey<boolean>('agentsVoiceConnected', false);
export const AGENTS_VOICE_CONNECTING = new RawContextKey<boolean>('agentsVoiceConnecting', false);
export const AGENTS_VOICE_PUSH_TO_TALK = new RawContextKey<boolean>('agentsVoicePushToTalk', false);

export const enum AgentsVoiceStorageKeys {
	IntroBannerShown = 'agentsVoice.introBannerShown',
}

export const IAgentsVoiceWindowService = createDecorator<IAgentsVoiceWindowService>('agentsVoiceWindowService');

/** Owns only the floating controls. Closing the window does not end its Chat's media session. */
export interface IAgentsVoiceWindowService {
	readonly isOpen: boolean;
	readonly onDidChangeOpen: Event<boolean>;
	openWindow(): Promise<void>;
	closeWindow(): void;
	toggleWindow(): Promise<void>;
}
