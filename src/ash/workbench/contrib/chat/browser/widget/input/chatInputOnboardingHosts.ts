import { DisposableStore, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IDictationOnboardingService } from '../../speechToText/dictationOnboarding.js';
import type { IVoiceModeOnboardingService } from '../../../../agentsVoice/browser/voiceModeOnboarding.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from './chatInputNoticeHost.js';

/** Register voice and dictation against the same onboarding lane for the composer's visible lifetime. */
export function registerChatInputOnboardingHosts(
	host: ChatInputNoticeHost,
	containers: { readonly voice: HTMLElement; readonly dictation: HTMLElement; },
	focusRoot: HTMLElement,
	focusInput: () => void,
	voiceModeOnboardingService: IVoiceModeOnboardingService,
	dictationOnboardingService: IDictationOnboardingService,
): IDisposable {
	const registrations = new DisposableStore();
	const claimNotice = (options: Parameters<ChatInputNoticeHost['occupy']>[1]) => host.occupy(ChatInputNoticeLane.Onboarding, options);
	registrations.add(voiceModeOnboardingService.registerHost({
		container: containers.voice, focusRoot, focus: focusInput, claimNotice,
	}));
	registrations.add(dictationOnboardingService.registerHost({
		container: containers.dictation,
		focusRoot,
		focus: focusInput,
		claimNotice,
	}));
	return registrations;
}
