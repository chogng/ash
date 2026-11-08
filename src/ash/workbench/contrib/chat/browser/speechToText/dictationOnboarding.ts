import { defaultButtonStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ILocalTranscriptionModelService } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/dictation/common/dictation.js';
import { getDictationMicrophoneChoices, readDictationPreparation, readDictationOptions } from './dictationInput.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import './media/dictationOnboarding.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../../base/browser/ui/selectbox/selectbox.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration } from '../../common/constants.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from './chatSpeechToTextService.js';
import { localize } from '../../../../../nls.js';
import { isModelPreparing } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ChatInputOnboarding, type IChatInputOnboardingHostOptions, type IChatInputOnboardingContext } from '../widget/input/chatInputOnboarding.js';
import { ChatInputNoticeWidget, ChatInputNoticeVariant } from '../widget/input/chatInputNoticeWidget.js';

export const SHOW_DICTATION_ONBOARDING_COMMAND = 'workbench.action.chat.showSpeechToTextIntroduction';
export const RESET_DICTATION_ONBOARDING_COMMAND = 'workbench.action.chat.resetSpeechToTextIntroduction';
type SwitchMicrophone = (deviceId: string) => Promise<AnalyserNode | undefined>;

export const IDictationOnboardingService = createDecorator<IDictationOnboardingService>('dictationOnboardingService');
const introductionSeen = 'dictation.introductionSeen';

export interface IDictationOnboardingService {
	readonly _serviceBrand: undefined;
	readonly isVisible: boolean;
	registerHost(options: IChatInputOnboardingHostOptions): IDisposable;
	showIfNeeded(): boolean;
	show(): boolean;
	refreshMicrophones(analyserNode?: AnalyserNode, switchMicrophone?: SwitchMicrophone): void;
	reset(): void;
}

/** Introduction state belongs to the profile; the focused visible surface owns its card. */
export class DictationOnboardingService extends Disposable implements IDictationOnboardingService {
	readonly _serviceBrand = undefined;
	private readonly onboarding: ChatInputOnboarding;
	private banner: DictationOnboardingBanner | undefined;
	public get isVisible(): boolean { return this.onboarding.isVisible; }
	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.onboarding = this._register(instantiation.createInstance(ChatInputOnboarding, { storageKey: introductionSeen }));
	}
	public registerHost(host: IChatInputOnboardingHostOptions): IDisposable {
		return this.onboarding.registerHost(host);
	}
	public showIfNeeded(): boolean {
		return this.onboarding.showIfNeeded(context => this.createBanner(context));
	}
	public show(): boolean {
		return this.onboarding.show(context => this.createBanner(context));
	}
	public refreshMicrophones(analyserNode?: AnalyserNode, switchMicrophone?: SwitchMicrophone): void {
		this.banner?.refreshMicrophones(analyserNode, switchMicrophone);
	}
	public reset(): void { this.onboarding.reset(); }
	private createBanner(context: IChatInputOnboardingContext): DictationOnboardingBanner {
		const banner = this.instantiation.createInstance(DictationOnboardingBanner, context, () => this.refreshMicrophones(), () => {
			if (this.banner === banner) this.banner = undefined;
		});
		this.banner = banner;
		void banner.initialize();
		return banner;
	}
}

/** A trial owns the shared recording only while its own start is accepted. */
class DictationOnboardingBanner extends Disposable {
	private readonly notice: ChatInputNoticeWidget;
	private readonly domNode: HTMLElement;
	private readonly transcript: HTMLElement;
	private readonly description: HTMLElement;
	private readonly microphone: SelectBox;
	private readonly language: SelectBox;
	private readonly test: Button;
	private recording = false;
	private readonly recordingToken = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly recordingEvents = this._register(new MutableDisposable());
	private preparing = false;
	private trialRevision = 0;
	private optionsRequest = 0;
	private switchMicrophone: SwitchMicrophone | undefined;
	public get isVisible(): boolean { return !this.domNode.hidden; }
	public hasFocus(): boolean { return this.domNode.contains(this.domNode.ownerDocument.activeElement); }
	public focus(): void { this.notice.focus(); }
	public announce(): void { this.notice.announce(); }
	public setVisible(visible: boolean): void {
		this.notice.setVisible(visible);
		if (!visible) {
			this.trialRevision++;
			if (this.recording) {
				this.recording = false;
				this.recordingToken.value?.cancel();
				this.transcript.textContent = '';
			}
		}
	}
	public refreshMicrophones(_analyserNode?: AnalyserNode, switchMicrophone?: SwitchMicrophone): void {
		if (switchMicrophone) this.switchMicrophone = switchMicrophone;
		void this.initialize();
	}
	constructor(
		context: IChatInputOnboardingContext,
		refreshMicrophones: () => void,
		private readonly onDispose: () => void,
		@IChatSpeechToTextService private readonly speech: IChatSpeechToTextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IPreferencesService preferences: IPreferencesService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@ILocalTranscriptionModelService private readonly localTranscription: ILocalTranscriptionModelService,
		@ISpeechService private readonly speechProviders: ISpeechService,
		@IVoiceCodeTranscriptionBackendService private readonly backend: IVoiceCodeTranscriptionBackendService | undefined,
	) {
		super();
		const document = context.container.ownerDocument;
		const close = () => context.dismiss();
		this.notice = this._register(new ChatInputNoticeWidget({
			container: context.container,
			variant: ChatInputNoticeVariant.Onboarding,
			className: 'ash-dictation-onboarding',
			ariaLabel: localize({ bundle: 'ash', key: 'dictation.introduction' }, 'Dictation introduction'),
			onEscape: close,
		}));
		this.domNode = this.notice.domNode;
		const title = h(document, 'h3');
		title.textContent = localize({ bundle: 'ash', key: 'dictation.introduction' }, 'Dictation introduction');
		const description = this.description = h(document, 'p');
		description.textContent = localize({ bundle: 'ash', key: 'dictation.introductionDescription' }, 'Choose a microphone and try speaking. Test text stays here. Your system may ask for microphone permission. Local models run on this device; cloud dictation sends audio to your API provider.');
		this.domNode.append(title, description);
		this.microphone = this._register(new SelectBox(this.domNode, {
			options: [], ariaLabel: localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone')
		}, defaultSelectBoxStyles));
		this.language = this._register(new SelectBox(this.domNode, {
			options: [], ariaLabel: localize({ bundle: 'ash', key: 'dictation.language' }, 'Transcription language')
		}, defaultSelectBoxStyles));
		this.transcript = h(document, 'p');
		this.transcript.setAttribute('role', 'status');
		this.domNode.append(this.transcript);
		const actions = h(document, 'div');
		actions.className = 'ash-dictation-onboarding-actions';
		this.domNode.append(actions);
		this.test = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash', key: 'dictation.test' }, 'Test microphone'),
		}));
		const settings = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash', key: 'dictation.prepareSettings' }, 'Model and API settings'),
			presentation: 'secondary',
		}));
		const done = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash', key: 'dictation.done' }, 'Done'),
			presentation: 'quiet',
		}));
		this._register(done.onDidClick(close));
		this._register(settings.onDidClick(() => { void preferences.openSettings({ section: 'dictation' }); }));
		this._register(this.test.onDidClick(() => { void this.toggleTrial(); }));
		this._register(this.microphone.onDidSelect(({ value }) => { void this.configure(DictationConfiguration.inputDevice, value); }));
		this._register(this.language.onDidSelect(({ value }) => { void this.configure(DictationConfiguration.language, value); }));
		if (document.defaultView?.navigator.mediaDevices) this._register(addDisposableListener(document.defaultView.navigator.mediaDevices, 'devicechange', () => { void this.initialize(); }));
		this._register(speech.onDidChangeState(() => { this.updateTest(); refreshMicrophones(); }));
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
							? localize({ bundle: 'ash', key: 'dictation.introductionHelp' }, 'Use Tab to reach microphone, language, test, settings and Done. Test starts or stops recording. Changing the microphone keeps recording; changing the language stops it. Escape closes the introduction and releases its recording. Test text is never inserted into your draft or terminal. In Chat, use {0} to switch between the visible notice and the message. A notification hides this introduction and stops its recording until the introduction returns.', '<keybinding:workbench.action.chat.focusTip>')
							: this.transcript.textContent || description.textContent!,
						() => focus.focus(),
						AccessibilityVerbositySettingId.DictationOnboarding,
					);
				},
			}));
		}
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.DictationOnboarding);
		if (hint) { this.domNode.setAttribute('aria-description', hint); }
		this.updateTest();
		done.domNode.focus();
	}
	public async initialize(): Promise<void> {
		const request = ++this.optionsRequest;
		this.microphone.enabled = this.language.enabled = false;
		if (!this.speech.isConfigured) { this.transcript.textContent = localize('chat.input.dictationUnavailable', 'Dictation is unavailable'); return; }
		try {
			const options = await readDictationOptions(this.domNode.ownerDocument.defaultView as Window & typeof globalThis, this.configuration, this.backend, this.speechProviders);
			if (this.isDisposed || request !== this.optionsRequest) { return; }
			this.microphone.element.hidden = this.language.element.hidden = !options;
			this.description.textContent = options
				? localize({ bundle: 'ash', key: 'dictation.introductionDescription' }, 'Choose a microphone and try speaking. Test text stays here. Your system may ask for microphone permission. Local models run on this device; cloud dictation sends audio to your API provider.')
				: localize('speech.extensionIntroduction', 'Try speaking with your speech extension. It controls recognition and microphone access. Test text stays here.');
			if (!options) return;
			const selected = this.configuration.getValue<string>(DictationConfiguration.inputDevice);
			this.microphone.setOptions(getDictationMicrophoneChoices(options.inputDevices, selected).map(({ id, label }) => ({ value: id, label })));
			this.microphone.value = selected;
			this.microphone.enabled = true;
			const configuredLanguage = this.configuration.getValue<string>(DictationConfiguration.language);
			const unavailableLanguage = options.languages.length && configuredLanguage !== 'auto' && !options.languages.includes(configuredLanguage) ? [{ value: configuredLanguage, label: localize('dictation.unavailableLanguage', 'Language {0} is unavailable with this service', configuredLanguage), disabled: true }] : [];
			this.language.setOptions([...unavailableLanguage, { value: 'auto', label: localize({ bundle: 'ash', key: 'dictation.autoLanguage' }, 'Automatic language detection') }, ...options.languages.map(value => ({ value, label: new Intl.DisplayNames([this.domNode.ownerDocument.documentElement.lang || 'en'], { type: 'language' }).of(value)! }))]);
			this.language.value = options.languages.length ? this.configuration.getValue<string>(DictationConfiguration.language) : 'auto';
			this.language.enabled = options.languages.length > 0;
		} catch (error) { if (!this.isDisposed && request === this.optionsRequest) { this.transcript.textContent = String(error); } }
	}
	private async configure(key: string, value: string): Promise<void> {
		if (key === DictationConfiguration.inputDevice && value === this.configuration.getValue<string>(key)) return;
		try {
			if (this.speech.isBusy) {
				if (key === DictationConfiguration.inputDevice && this.speech.analyserNode) await (this.switchMicrophone ? this.switchMicrophone(value) : this.speech.switchMicrophone(this.domNode.ownerDocument.defaultView as Window & typeof globalThis, value));
				else { this.recording = false; this.recordingToken.value?.cancel(); await this.speech.stopAndTranscribe(); }
			}
			await this.configuration.updateValue(key, value);
		} catch (error) { if (!this.isDisposed && !isCancellationError(error)) { this.transcript.textContent = String(error); } }
	}
	private async toggleTrial(): Promise<void> {
		try {
			if (this.recording) { await this.speech.stopAndTranscribe(); this.recording = false; this.updateTest(); return; }
			if (this.speech.isBusy || this.preparing) { return; }
			this.preparing = true;
			const revision = ++this.trialRevision;
			this.updateTest();
			const preparation = await readDictationPreparation(this.configuration, this.localTranscription, this.speechProviders);
			if (this.isDisposed || !this.isVisible || revision !== this.trialRevision || this.speech.isBusy) { return; }
			if (preparation && (!preparation.available || isModelPreparing(preparation.status))) {
				this.transcript.textContent = localize({ bundle: 'ash', key: 'dictation.prepare' }, 'Install or select a local model in Dictation settings before testing.');
				return;
			}
			this.recording = true;
			this.transcript.textContent = localize({ bundle: 'ash', key: 'dictation.listening' }, 'Listening…');
			const owner = new CancellationTokenSource();
			this.recordingToken.value = owner;
			const events = new DisposableStore();
			this.recordingEvents.value = events;
			events.add(owner.token.onCancellationRequested(() => {
				if (this.recordingToken.value === owner) void this.speech.cancel().catch(() => undefined);
			}));
			events.add(this.speech.onDidUpdateTranscript(event => {
				if (this.recordingToken.value === owner && this.recording && this.isVisible && !this.isDisposed) this.transcript.textContent = event.text;
			}));
			await this.speech.start(this.domNode.ownerDocument.defaultView as Window & typeof globalThis);
		} catch (error) { this.recording = false; if (!this.isDisposed && !isCancellationError(error)) { this.transcript.textContent = String(error); } }
		finally {
			this.preparing = false;
			if (!this.isDisposed) { this.updateTest(); }
		}
	}
	private updateTest(): void {
		this.test.label = this.recording && this.speech.isBusy ? localize({ bundle: 'ash', key: 'dictation.stopTest' }, 'Stop test') : localize({ bundle: 'ash', key: 'dictation.test' }, 'Test microphone');
		this.test.enabled = (this.speech.isConfigured) && !this.preparing && (!this.speech.isBusy || this.recording) && this.speech.state !== ChatSpeechToTextState.Transcribing;
	}
	protected override disposeCore(): void {
		if (this.recording) { this.recording = false; this.recordingToken.value?.cancel(); void this.speech.stopAndTranscribe().catch(() => undefined); }
		this.domNode.remove();
		this.onDispose();
		super.disposeCore();
	}
}
