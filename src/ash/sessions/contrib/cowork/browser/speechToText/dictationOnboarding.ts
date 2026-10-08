import './media/dictationOnboarding.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../../base/browser/ui/selectbox/selectbox.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration } from '../../../../../platform/dictation/common/dictationConfiguration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from './chatSpeechToTextService.js';
import { localize } from '../../../../../nls.js';
import { isModelPreparing } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

export const IDictationOnboardingService = createDecorator<IDictationOnboardingService>('coworkDictationOnboardingService');
const introductionSeen = 'dictation.introductionSeen';
interface OnboardingHost { readonly container: HTMLElement; readonly focusTarget: HTMLElement; readonly isVisible: () => boolean; }

export interface IDictationOnboardingService {
	registerHost(host: OnboardingHost): IDisposable;
	showIfNeeded(): boolean;
	show(): boolean;
	hide(container: HTMLElement): void;
}

/** Introduction state belongs to the profile; the focused visible surface owns its card. */
export class DictationOnboardingService extends Disposable implements IDictationOnboardingService {
	private readonly hosts = new Set<OnboardingHost>();
	private focused: OnboardingHost | undefined;
	private readonly banner = this._register(new MutableDisposable<DictationOnboardingBanner>());
	constructor(@IStorageService private readonly storage: IStorageService, @IInstantiationService private readonly instantiation: IInstantiationService) { super(); }
	public registerHost(host: OnboardingHost): IDisposable {
		this.hosts.add(host);
		const focus = addDisposableListener(host.focusTarget, 'focusin', () => { this.focused = host; });
		return toDisposable(() => {
			focus.dispose();
			this.hosts.delete(host);
			if (this.focused === host) { this.focused = undefined; }
			if (this.banner.value?.host === host) { this.banner.clear(); }
		});
	}
	public showIfNeeded(): boolean {
		if (this.banner.value) { return true; }
		return this.storage.getBoolean(introductionSeen, StorageScope.PROFILE, false) ? false : this.show();
	}
	public show(): boolean {
		const host = this.focused?.isVisible() ? this.focused : [...this.hosts].find(candidate => candidate.isVisible());
		if (!host) { return false; }
		this.banner.value = this.instantiation.createInstance(DictationOnboardingBanner, host, () => this.banner.clear());
		this.storage.store(introductionSeen, true, StorageScope.PROFILE, StorageTarget.USER);
		void this.banner.value.initialize();
		return true;
	}
	public hide(container: HTMLElement): void { if (this.banner.value?.host.container === container) { this.banner.clear(); } }
}

/** A trial owns the shared recording only while its own start is accepted. */
class DictationOnboardingBanner extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly transcript: HTMLElement;
	private readonly microphone: SelectBox;
	private readonly language: SelectBox;
	private readonly test: Button;
	private readonly previousFocus: HTMLElement | null;
	private recording = false;
	private preparing = false;
	private optionsRequest = 0;
	constructor(
		public readonly host: OnboardingHost,
		close: () => void,
		@IChatSpeechToTextService private readonly speech: IChatSpeechToTextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IPreferencesService preferences: IPreferencesService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = host.container.ownerDocument;
		this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-cowork-dictation-onboarding';
		this.domNode.setAttribute('aria-label', localize({ bundle: 'ash', key: 'dictation.introduction' }, 'Dictation introduction'));
		this.domNode.setAttribute('role', 'region');
		const title = h(document, 'h3');
		title.textContent = localize({ bundle: 'ash', key: 'dictation.introduction' }, 'Dictation introduction');
		const description = h(document, 'p');
		description.textContent = localize({ bundle: 'ash', key: 'dictation.introductionDescription' }, 'Choose a microphone and try speaking. Test text stays here. Your system may ask for microphone permission. Local models run on this device; cloud dictation sends audio to your API provider.');
		this.domNode.append(title, description);
		this.microphone = this._register(new SelectBox(this.domNode, { options: [], ariaLabel: localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone') }));
		this.language = this._register(new SelectBox(this.domNode, { options: [], ariaLabel: localize({ bundle: 'ash', key: 'dictation.language' }, 'Transcription language') }));
		this.transcript = h(document, 'p');
		this.transcript.setAttribute('role', 'status');
		this.domNode.append(this.transcript);
		const actions = h(document, 'div');
		actions.className = 'ash-cowork-dictation-onboarding-actions';
		this.domNode.append(actions);
		this.test = this._register(new Button(actions, { label: localize({ bundle: 'ash', key: 'dictation.test' }, 'Test microphone') }));
		const settings = this._register(new Button(actions, { label: localize({ bundle: 'ash', key: 'dictation.prepareSettings' }, 'Model and API settings'), presentation: 'secondary' }));
		const done = this._register(new Button(actions, { label: localize({ bundle: 'ash', key: 'dictation.done' }, 'Done'), presentation: 'quiet' }));
		this._register(done.onDidClick(close));
		this._register(settings.onDidClick(() => { void preferences.openSettings({ section: 'dictation' }); }));
		this._register(this.test.onDidClick(() => { void this.toggleTrial(); }));
		this._register(addDisposableListener(this.domNode, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }));
		this._register(this.microphone.onDidSelect(({ value }) => { void this.configure(DictationConfiguration.inputDevice, value); }));
		this._register(this.language.onDidSelect(({ value }) => { void this.configure(DictationConfiguration.language, value); }));
		this._register(speech.onDidChangePreparation(() => { void this.initialize(); }));
		this._register(speech.onDidUpdateTranscript(({ text }) => { if (this.recording) { this.transcript.textContent = text; } }));
		this._register(speech.onDidEnd(error => { if (this.recording && error) { this.transcript.textContent = error; } }));
		this._register(speech.onDidChangeState(() => { if (!speech.isBusy) { this.recording = false; } this.updateTest(); }));
		const keys = this._register(contextKeys.createScoped(this.domNode));
		keys.createKey('dictationIntroductionFocused', true);
		const id = generateUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type,
				priority: 120,
				name: `dictation-introduction-${id}-${type}`,
				when: ContextKeyExpr.has('dictationIntroductionFocused'),
				getProvider: () => {
					const focus = document.activeElement as HTMLElement;
					if (!this.domNode.contains(focus)) { return undefined; }
					return new AccessibleContentProvider(
						AccessibleViewProviderId.DictationOnboarding,
						{ type },
						() => type === AccessibleViewType.Help
							? localize({ bundle: 'ash', key: 'dictation.introductionHelp' }, 'Use Tab to reach microphone, language, test, settings and Done. Test starts or stops recording. Escape closes the introduction and releases its recording. Test text is never inserted into your draft or terminal.')
							: this.transcript.textContent || description.textContent!,
						() => focus.focus(),
						AccessibilityVerbositySettingId.DictationOnboarding,
					);
				},
			}));
		}
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.DictationOnboarding);
		if (hint) { this.domNode.setAttribute('aria-description', hint); }
		host.container.append(this.domNode);
		this.updateTest();
		done.domNode.focus();
	}
	public async initialize(): Promise<void> {
		const request = ++this.optionsRequest;
		this.microphone.enabled = this.language.enabled = false;
		if (!this.speech.isConfigured) { this.transcript.textContent = localize('chat.input.dictationUnavailable', 'Dictation is unavailable'); return; }
		try {
			const options = await this.speech.getOptions();
			if (this.isDisposed || request !== this.optionsRequest) { return; }
			const selected = this.configuration.getValue<string>(DictationConfiguration.inputDevice);
			const missing = selected && !options.inputDevices.some(device => device.id === selected) ? [{ value: selected, label: localize({ bundle: 'ash', key: 'dictation.missingMicrophone' }, 'Selected microphone is disconnected'), disabled: true }] : [];
			this.microphone.setOptions([...missing, { value: '', label: localize({ bundle: 'ash', key: 'dictation.systemMicrophone' }, 'System default microphone') }, ...options.inputDevices.map(device => ({ value: device.id, label: device.label }))]);
			this.microphone.value = this.configuration.getValue<string>(DictationConfiguration.inputDevice);
			this.microphone.enabled = true;
			const configuredLanguage = this.configuration.getValue<string>(DictationConfiguration.language);
			const unavailableLanguage = options.languages.length && configuredLanguage !== 'auto' && !options.languages.includes(configuredLanguage) ? [{ value: configuredLanguage, label: localize('dictation.unavailableLanguage', 'Language {0} is unavailable with this service', configuredLanguage), disabled: true }] : [];
			this.language.setOptions([...unavailableLanguage, { value: 'auto', label: localize({ bundle: 'ash', key: 'dictation.autoLanguage' }, 'Automatic language detection') }, ...options.languages.map(value => ({ value, label: new Intl.DisplayNames([this.domNode.ownerDocument.documentElement.lang || 'en'], { type: 'language' }).of(value)! }))]);
			this.language.value = options.languages.length ? this.configuration.getValue<string>(DictationConfiguration.language) : 'auto';
			this.language.enabled = options.languages.length > 0;
		} catch (error) { if (!this.isDisposed && request === this.optionsRequest) { this.transcript.textContent = String(error); } }
	}
	private async configure(key: string, value: string): Promise<void> {
		try {
			if (this.recording) { this.recording = false; await this.speech.cancel(); }
			await this.configuration.updateValue(key, value);
		} catch (error) { if (!this.isDisposed) { this.transcript.textContent = String(error); } }
	}
	private async toggleTrial(): Promise<void> {
		try {
			if (this.recording) { await this.speech.stopAndTranscribe(); this.recording = false; this.updateTest(); return; }
			if (this.speech.isBusy || this.preparing) { return; }
			this.preparing = true;
			this.updateTest();
			const preparation = await this.speech.getPreparation();
			if (this.isDisposed || !this.host.isVisible() || this.speech.isBusy) { return; }
			if (preparation && (!preparation.available || isModelPreparing(preparation.status))) {
				this.transcript.textContent = localize({ bundle: 'ash', key: 'dictation.prepare' }, 'Install or select a local model in Dictation settings before testing.');
				return;
			}
			this.recording = true;
			this.transcript.textContent = localize({ bundle: 'ash', key: 'dictation.listening' }, 'Listening…');
			await this.speech.start();
		} catch (error) { this.recording = false; if (!this.isDisposed) { this.transcript.textContent = String(error); } }
		finally {
			this.preparing = false;
			if (!this.isDisposed) { this.updateTest(); }
		}
	}
	private updateTest(): void {
		this.test.label = this.recording && this.speech.isBusy ? localize({ bundle: 'ash', key: 'dictation.stopTest' }, 'Stop test') : localize({ bundle: 'ash', key: 'dictation.test' }, 'Test microphone');
		this.test.enabled = this.speech.isConfigured && !this.preparing && (!this.speech.isBusy || this.recording) && !this.speech.isStarting && this.speech.state !== ChatSpeechToTextState.Transcribing;
	}
	protected override disposeCore(): void {
		if (this.recording) { this.recording = false; void this.speech.cancel().catch(() => undefined); }
		this.domNode.remove();
		this.previousFocus?.focus();
		super.disposeCore();
	}
}
