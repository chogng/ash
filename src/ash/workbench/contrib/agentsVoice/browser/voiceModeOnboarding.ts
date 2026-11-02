import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentsVoiceStorageKeys } from '../common/agentsVoice.js';
import { ChatInputOnboarding, type IChatInputOnboardingBanner, type IChatInputOnboardingContext, type IChatInputOnboardingHostOptions } from '../../chat/browser/widget/input/notices/chatInputOnboarding.js';
import { ChatInputNoticeVariant, ChatInputNoticeWidget, getChatInputNoticeHelp } from '../../chat/browser/widget/input/notices/chatInputNoticeWidget.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import './media/voiceModeOnboarding.css';

export const IVoiceModeOnboardingService = createDecorator<IVoiceModeOnboardingService>('voiceModeOnboardingService');

export interface IVoiceModeOnboardingService {
	readonly _serviceBrand: undefined;
	registerHost(options: IChatInputOnboardingHostOptions): IDisposable;
	showIfNeeded(): void;
	show(): boolean;
}

/** Shares one introduction and the existing acknowledgement preference across voice surfaces. */
export class VoiceModeOnboardingService extends Disposable implements IVoiceModeOnboardingService {
	readonly _serviceBrand = undefined;
	private readonly onboarding: ChatInputOnboarding;

	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.onboarding = this._register(instantiation.createInstance(ChatInputOnboarding, {
			storageKey: AgentsVoiceStorageKeys.IntroBannerShown,
			markSeenOn: 'acknowledge',
		}));
	}

	registerHost(options: IChatInputOnboardingHostOptions): IDisposable {
		return this.onboarding.registerHost(options);
	}

	showIfNeeded(): void {
		this.onboarding.showIfNeeded(context => this.instantiation.createInstance(VoiceModeOnboardingBanner, context, false));
	}

	show(): boolean {
		return this.onboarding.show(context => this.instantiation.createInstance(VoiceModeOnboardingBanner, context, true));
	}
}

/** Profile-owned dismissal; showing this introduction never opens the microphone. */
class VoiceModeOnboardingBanner extends Disposable implements IChatInputOnboardingBanner {
	private readonly notice: ChatInputNoticeWidget;

	constructor(context: IChatInputOnboardingContext, focus: boolean, @IAccessibleViewService accessibleView: IAccessibleViewService) {
		super();
		this.notice = this._register(new ChatInputNoticeWidget({
			container: context.container,
			variant: ChatInputNoticeVariant.Onboarding,
			className: 'ash-agents-voice-introduction',
			ariaLabel: localize('agentsVoice.introduction.title', 'Talk with your agent'),
			onEscape: () => context.dismiss(),
			focusInput: context.focusInput,
			accessibility: {
				priority: 120,
				verbositySettingKey: AccessibilityVerbositySettingId.AgentsVoice,
				getHelp: () => getChatInputNoticeHelp() + '\n' + localize('agentsVoice.introduction.help', 'Use Tab to reach Got it. Got it acknowledges this introduction so it no longer opens automatically. Escape closes it without acknowledgement. Showing the introduction does not open a microphone or start a voice conversation.'),
			},
		}));
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.AgentsVoice);
		if (hint) this.notice.domNode.setAttribute('aria-description', hint);
		const document = context.container.ownerDocument;
		const heading = h(document, 'h2');
		heading.textContent = localize('agentsVoice.introduction.title', 'Talk with your agent');
		const description = h(document, 'p');
		description.textContent = localize('agentsVoice.introduction.description', 'Start a voice conversation from Chat and choose a provider, model and voice. Audio goes to that provider. Spoken requests use the same Chat mode and approval controls. Your unsent message stays in the composer.');
		this.notice.domNode.append(heading, description);
		this._register(new Button(this.notice.domNode, {
			...defaultButtonStyles,
			label: localize('agentsVoice.introduction.dismiss', 'Got it'),
			onClick: context.acknowledge,
		}));
		if (focus) this.notice.focus();
	}

	hasFocus(): boolean { return this.notice.hasFocus(); }
	focus(): void { this.notice.focus(); }
	announce(): void { this.notice.announce(); }
	setVisible(visible: boolean): void { this.notice.setVisible(visible); }
}
