import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AgentsVoiceStorageKeys } from '../common/agentsVoice.js';

/** Profile-owned dismissal; showing this introduction never opens the microphone. */
export class VoiceModeOnboardingBanner extends Disposable {
	readonly element: HTMLElement;

	constructor(container: HTMLElement, onDismiss: () => void, @IStorageService storage: IStorageService) {
		super();
		this.element = h(container.ownerDocument, 'section');
		this.element.className = 'ash-agents-voice-introduction';
		this.element.hidden = storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false);
		const heading = h(container.ownerDocument, 'h2');
		heading.textContent = localize('agentsVoice.introduction.title', 'Talk with your agent');
		const description = h(container.ownerDocument, 'p');
		description.textContent = localize(
			'agentsVoice.introduction.description',
			'Start a voice conversation from Chat and choose a provider, model and voice. Audio goes to that provider. Spoken requests use the same Chat mode and approval controls. Your unsent message stays in the composer.',
		);
		this.element.append(heading, description);
		this._register(
			new Button(this.element, {
				...defaultButtonStyles,
				label: localize('agentsVoice.introduction.dismiss', 'Got it'),
				onClick: () => {
					storage.store(AgentsVoiceStorageKeys.IntroBannerShown, true, StorageScope.PROFILE, StorageTarget.USER);
					this.element.hidden = true;
					onDismiss();
				},
			}),
		);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}
}
