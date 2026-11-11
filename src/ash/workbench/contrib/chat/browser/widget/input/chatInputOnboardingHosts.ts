import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import type { IVoiceModeOnboardingService } from '../../../../agentsVoice/browser/voiceModeOnboarding.js';
import { ChatInputNoticeLane, type ChatInputNoticeHost } from './chatInputNoticeHost.js';
import type { IChatInputNoticeHubService } from './chatInputNoticeHub.js';

/** Releases the composer's notice and onboarding registrations together when its surface hides. */
export function registerChatInputOnboardingHosts(
	host: ChatInputNoticeHost,
	focusRoot: HTMLElement,
	voiceContainer: HTMLElement,
	focusInput: () => void,
	noticeHub: IChatInputNoticeHubService,
	voiceOnboarding: IVoiceModeOnboardingService,
): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(noticeHub.registerHost(host, focusRoot));
	registrations.add(voiceOnboarding.registerHost({
		container: voiceContainer,
		focusRoot,
		focus: focusInput,
		claimNotice: options => host.occupy(ChatInputNoticeLane.Onboarding, options),
	}));
	return registrations;
}
