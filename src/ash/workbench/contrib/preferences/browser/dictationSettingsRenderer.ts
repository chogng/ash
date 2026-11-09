import { SettingsPageRenderer } from './settingsRenderers.js';
import { defaultButtonStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ILocalTranscriptionModelService } from '../../../../platform/localTranscription/common/localTranscription.js';
import { ISpeechService } from '../../speech/common/speechService.js';
import { IVoiceCodeTranscriptionBackendService, type DictationBackend } from '../../../../platform/dictation/common/dictation.js';
import { readDictationMicrophones } from '../../chat/browser/speechToText/dictationInput.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import './media/dictationSettingsRenderer.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration, dictationBackend } from '../../chat/common/constants.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { DefaultSettings } from '../../../services/preferences/common/settingsModels.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';
import { LocalTranscriptionModelControls } from './localTranscriptionModelControls.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType,
	AccessibilityVerbositySettingId, IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { IAgentVoiceService } from '../../../../platform/agentHost/common/agentService.js';
import { AgentsVoiceSettingId } from '../../agentsVoice/common/agentsVoice.js';
import { IChatSpeechToTextService } from '../../chat/browser/speechToText/chatSpeechToTextService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.DictationModels,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Dictation model accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('dictation.models.verbosityTitle', 'Dictation model accessibility help'),
		description: localize('dictation.models.verbosityDescription', 'Announce how to open accessibility help when the local model settings receive focus.'),
	},
});

/** Shared dictation content; each settings host owns navigation, search and setting widgets. */
export class DictationSettingsRenderer extends SettingsPageRenderer<ISetting | SettingsSectionReference> {
	public readonly categoryId = 'voice-input';
	public override get settingIds(): readonly string[] { return [...Object.values(DictationConfiguration), AgentsVoiceSettingId.Model, AgentsVoiceSettingId.ShowButton]; }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly controls: LocalTranscriptionModelControls;
	private readonly cloud: HTMLElement;
	private readonly cloudModel: HTMLElement;
	private readonly subscription: HTMLElement;
	private readonly subscriptionTitle: string;
	private readonly subscriptionDescription: string;
	private readonly connectionStatus: HTMLElement;
	private readonly subscriptionStatus: HTMLElement;
	private readonly voiceMode: HTMLElement;
	private readonly voiceModeStatus: HTMLElement;
	private readonly window: Window & typeof globalThis;
	private readonly microphone: { readonly row: HTMLElement; readonly select: SelectBox; readonly title: string; };
	private readonly language: { readonly row: HTMLElement; readonly select: SelectBox; readonly title: string; };
	private showLanguage = false;
	private visible = false;
	private requestVersion = 0;

	constructor(container: HTMLElement,
		private readonly options: { readonly showGroupHeader: boolean; },
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILanguageModelsService private readonly chat: ILanguageModelsService,
		@IPreferencesService preferences: IPreferencesService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextViewService contextViewProvider: IContextViewService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@ILocalTranscriptionModelService private readonly localTranscription: ILocalTranscriptionModelService,
		@ISpeechService private readonly speechProviders: ISpeechService,
		@IVoiceCodeTranscriptionBackendService private readonly backend: IVoiceCodeTranscriptionBackendService | undefined,
		@IChatSpeechToTextService private readonly speech: IChatSpeechToTextService,
		@INotificationService private readonly notifications: INotificationService,
		@IAgentVoiceService private readonly voice: IAgentVoiceService | undefined,
	) {
		super();
		const document = container.ownerDocument;
		this.window = document.defaultView as Window & typeof globalThis;
		this.controls = this._register(instantiation.createInstance(LocalTranscriptionModelControls, h(document, 'div')));
		const createSelectRow = (key: string, title: string) => {
			const row = h(document, 'div');
			row.className = 'ash-configuration-setting ash-general-setting';
			const label = h(document, 'span', title);
			label.className = 'ash-configuration-setting-title ash-general-setting-title';
			row.append(label);
			const select = this._register(new SelectBox(row, { options: [], ariaLabel: title, presentation: 'field', contextViewProvider }, defaultSelectBoxStyles));
			select.element.classList.add('ash-general-setting-control');
			this._register(select.onDidSelect(({ value }) => { void this.configure(key, value); }));
			return { row, select, title };
		};
		this.microphone = createSelectRow(DictationConfiguration.inputDevice, localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone'));
		this.language = createSelectRow(DictationConfiguration.language, localize({ bundle: 'ash', key: 'dictation.language' }, 'Transcription language'));
		const mediaDevices = this.window.navigator.mediaDevices;
		if (mediaDevices) this._register(addDisposableListener(mediaDevices, 'devicechange', () => this.updateVisibility()));
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.DictationModels);
			this.controls.setAriaDescription(hint);
		};
		this.cloud = h(document, 'div');
		this.cloud.className = 'ash-dictation-cloud-connection';
		this.cloudModel = h(document, 'span');
		this.connectionStatus = h(document, 'p');
		this.connectionStatus.setAttribute('role', 'status');
		this.cloud.append(this.connectionStatus);
		const connections = this._register(new Button(this.cloud, {
			...defaultButtonStyles,
			label: localize('dictation.connections.manage', 'Manage API connections'),
			presentation: 'secondary',
		}));
		this._register(connections.onDidClick(() => { void preferences.openSettings({ section: 'models' }); }));
		this.subscriptionTitle = localize('dictation.subscription.title', 'ChatGPT dictation');
		this.subscriptionDescription = localize('dictation.subscription.description', 'Uses your Codex login from Models to transcribe while you speak. Stop to review the final text.');
		this.subscription = h(document, 'div');
		this.subscription.className = 'ash-dictation-subscription';
		this.subscription.setAttribute('role', 'group');
		const title = h(document, 'h5', this.subscriptionTitle);
		title.id = `dictation-subscription-${generateUuid()}`;
		const description = h(document, 'p', this.subscriptionDescription);
		description.id = `${title.id}-description`;
		this.subscription.setAttribute('aria-labelledby', title.id);
		this.subscription.setAttribute('aria-describedby', description.id);
		this.subscriptionStatus = h(document, 'p');
		this.subscriptionStatus.setAttribute('role', 'status');
		this.subscription.append(title, description, this.subscriptionStatus);
		this.voiceMode = h(document, 'div');
		this.voiceMode.className = 'ash-dictation-cloud-connection';
		this.voiceModeStatus = h(document, 'p');
		this.voiceModeStatus.setAttribute('role', 'status');
		this.voiceMode.append(this.voiceModeStatus);
		if (voice) {
			this._register(voice.onDidChange(() => this.updateVisibility()));
		}
		if (backend) {
			this._register(backend.onDidChangeConnection(() => this.updateVisibility()));
		}
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.DictationModels)) { updateHint(); }
			if (event.affectsConfiguration(DictationConfiguration.backend) || event.affectsConfiguration(DictationConfiguration.cloudProvider)) {
				this.updateVisibility();
				this.changed.fire();
			}
			if (event.affectsConfiguration(DictationConfiguration.inputDevice) || event.affectsConfiguration(DictationConfiguration.language) || event.affectsConfiguration(AgentsVoiceSettingId.Model)) { this.updateVisibility(); }
		}));
		this._register(speech.onDidChangeState(() => this.updateVisibility()));
		this._register(speechProviders.onDidChangeHasSpeechProvider(() => {
			this.updateVisibility();
			this.changed.fire();
		}));
		this._register(chat.onDidChangeModels(() => this.updateVisibility()));
		const scoped = this._register(contextKeys.createScoped(this.controls.domNode));
		scoped.createKey('dictationModelsFocused', true);
		updateHint();
		const instanceId = generateUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type,
				priority: 110,
				name: `dictation-models-${instanceId}-${type}`,
				when: ContextKeyExpr.has('dictationModelsFocused'),
				getProvider: () => {
					const focused = document.activeElement as HTMLElement;
					if (!this.visible || !this.controls.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.DictationModels, { type },
						() => type === AccessibleViewType.Help ? localize('dictation.models.help', 'Local dictation models\nUse the Dictation models selector to switch between installed models. Use Tab to reach model actions. The Install button shows progress during preparation. Hover over it or focus it with the keyboard to reveal Cancel. Activate Cancel to stop preparation. Uninstall requires confirmation and shows when removal is in progress. Preparation continues after Settings closes.') : this.controls.getAccessibleContent(),
						() => focused.focus(), AccessibilityVerbositySettingId.DictationModels);
				},
			}));
		}
	}

	protected override buildNodes(): readonly SettingsTreeNode<ISetting | SettingsSectionReference>[] {
		const settings = new DefaultSettings();
		const settingNode = (id: string): SettingsTreeNode<ISetting> => {
			const setting = { ...settings.get(id), presentation: 'general' as const };
			return {
				element: {
					kind: 'item', id, title: setting.title, description: setting.description,
					keywords: [id, ...setting.keywords ?? []], value: setting,
				},
			};
		};
		const inputNode = (id: string, input: typeof this.microphone): SettingsTreeNode<SettingsSectionReference> => ({
			element: {
				kind: 'item', id, title: input.title, description: '',
				value: this.retainElement(id, input.row),
			},
		});
		const children: SettingsTreeNode<ISetting | SettingsSectionReference>[] = [settingNode(DictationConfiguration.backend)];
		if (!this.speechProviders.hasSpeechProvider) {
			children.push(inputNode(DictationConfiguration.inputDevice, this.microphone));
			if (this.showLanguage) children.push(inputNode(DictationConfiguration.language, this.language));
		}
		const backend = dictationBackend(this.configuration);
		if (backend.type === 'cloud') {
			children.push(settingNode(DictationConfiguration.cloudProvider), {
				element: {
					kind: 'item', id: 'dictation.cloudModel',
					title: localize('dictation.cloudModel.title', 'Transcription model'),
					description: localize('dictation.cloudModel.description', 'The transcription model follows the selected service. Voice input is independent of the chat model.'),
					keywords: [backend.modelId, 'model', 'transcription'],
					value: this.retainElement('dictation.cloudModel', this.cloudModel),
				},
			}, {
				element: {
					kind: 'item', id: 'dictation.connection',
					title: localize('dictation.connections.title', 'Cloud connection'),
					description: localize('dictation.connections.description', 'Cloud dictation uses an API connection that supports transcription.'),
					value: this.retainElement('dictation.connection', this.cloud),
				},
			});
		} else if (backend.type === 'local') {
			if (this.localTranscription.isSupported && !this.speechProviders.hasSpeechProvider) {
				children.push(settingNode(DictationConfiguration.modelLoadTiming));
			}
			children.push({
				element: {
					kind: 'item', id: DictationConfiguration.model,
					title: localize('dictation.model.table', 'Local dictation models'),
					description: localize('dictation.model.tableDescription', 'Install a model, select it for dictation, or uninstall it.'),
					keywords: ['model', 'install', 'uninstall'],
					value: this.retainElement(DictationConfiguration.model, this.controls.domNode),
				},
			});
		} else {
			children.push({
				element: {
					kind: 'item', id: 'dictation.subscription',
					title: this.subscriptionTitle,
					description: this.subscriptionDescription,
					keywords: ['Codex', 'ChatGPT', 'subscription'],
					value: this.retainElement('dictation.subscription', this.subscription),
				},
			});
		}
		const items = children.map(node => ({ ...node, element: { ...node.element, keywords: [...node.element.keywords ?? [], 'dictation', 'speech', localize('sessions.settings.dictation', 'Dictation'), localize('settings.dictation.group', 'Voice input')] } }));
		const voiceMode: SettingsTreeNode<ISetting | SettingsSectionReference> = {
			element: {
				kind: 'group', id: 'voice-mode', title: localize('dictation.voiceMode.title', 'Voice Mode'),
				description: localize('dictation.voiceMode.description', 'Talk with Ash in a two-way voice conversation.'),
			},
			children: [
				...([AgentsVoiceSettingId.Model, AgentsVoiceSettingId.ShowButton]
					.filter(id => settings.all.some(setting => setting.id === id))
					.map(settingNode)),
				{
					element: {
						kind: 'item', id: 'dictation.voiceMode.status',
						title: localize('dictation.voiceMode.status', 'Voice model availability'),
						description: '',
						value: this.retainElement('dictation.voiceMode.status', this.voiceMode),
					},
				},
			],
		};
		const dictation: SettingsTreeNode<ISetting | SettingsSectionReference> = {
			element: { kind: 'group', id: 'dictation', title: localize('settings.dictation.group', 'Voice input'), description: localize('dictation.settings.description', 'Choose local or cloud transcription and manage local dictation models.') },
			children: items,
		};
		return [...(this.options.showGroupHeader ? [dictation] : items), voiceMode];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.updateVisibility();
	}

	private updateVisibility(): void {
		const version = ++this.requestVersion;
		const backend = dictationBackend(this.configuration);
		const cloud = backend.type === 'cloud';
		this.cloudModel.textContent = backend.type === 'cloud' ? backend.modelId : '';
		this.controls.setVisible(this.visible && backend.type === 'local');
		if (this.visible && (cloud || backend.type === 'codex')) {
			void this.readConnection(backend, version);
		}
		if (this.visible) {
			void this.readVoiceMode(version);
		}
		if (this.visible && !this.speechProviders.hasSpeechProvider) { void this.readMicrophones(version); }
		if (this.visible) { void this.readLanguages(backend, version); }
	}

	private async configure(key: string, value: string): Promise<void> {
		if (value === this.configuration.getValue<string>(key)) return;
		const microphone = key === DictationConfiguration.inputDevice;
		try {
			if (this.speech.isBusy) {
				if (microphone && this.speech.analyserNode) await this.speech.switchMicrophone(this.window, value);
				else await this.speech.stopAndTranscribe();
			}
			await this.configuration.updateValue(key, value);
		} catch (error) {
			const select = microphone ? this.microphone.select : this.language.select;
			const saved = this.configuration.getValue<string>(key);
			if (select.value === value && select.options.some(option => option.value === saved)) select.value = saved;
			this.notifications.error(String(error));
		}
	}

	private async readMicrophones(version: number): Promise<void> {
		try {
			const { choices, selectedDeviceId } = await readDictationMicrophones(this.window, this.configuration);
			if (this.isDisposed || version !== this.requestVersion) return;
			this.microphone.select.setOptions(choices.map(({ id, label }) => ({ value: id, label })));
			this.microphone.select.value = selectedDeviceId;
		} catch (error) {
			if (!this.isDisposed && version === this.requestVersion) this.notifications.error(String(error));
		}
	}

	private async readLanguages(backend: DictationBackend, version: number): Promise<void> {
		this.language.select.enabled = false;
		try {
			const options = backend.type !== 'local' && !this.speechProviders.hasSpeechProvider && this.backend?.isConnected
				? await this.backend.getOptions(backend)
				: undefined;
			if (this.isDisposed || version !== this.requestVersion) return;
			const languages = options?.languages ?? [];
			const configuredLanguage = this.configuration.getValue<string>(DictationConfiguration.language);
			const unavailableLanguage = configuredLanguage !== 'auto' && !languages.includes(configuredLanguage) ? [{ value: configuredLanguage, label: localize('dictation.unavailableLanguage', 'Language {0} is unavailable with this service', configuredLanguage) }] : [];
			const displayNames = new Intl.DisplayNames([this.window.document.documentElement.lang || 'en'], { type: 'language' });
			this.language.select.setOptions([...unavailableLanguage, { value: 'auto', label: localize({ bundle: 'ash', key: 'dictation.autoLanguage' }, 'Automatic language detection') }, ...languages.map(value => ({ value, label: displayNames.of(value)! }))]);
			this.language.select.value = configuredLanguage;
			this.language.select.enabled = languages.length > 0;
			if (this.showLanguage !== (languages.length > 0)) {
				this.showLanguage = languages.length > 0;
				this.changed.fire();
			}
		} catch (error) { if (!this.isDisposed && version === this.requestVersion) { this.notifications.error(String(error)); } }
	}

	private async readConnection(backend: DictationBackend, version: number): Promise<void> {
		const status = backend.type === 'codex' ? this.subscriptionStatus : this.connectionStatus;
		try {
			const providers = await this.chat.listModelProviders();
			if (version !== this.requestVersion || this.isDisposed) { return; }
			if (backend.type === 'codex') {
				status.textContent = this.backend?.isConnected && providers.some(provider => provider.connection === 'chatgpt-subscription' && provider.ready)
					? localize('dictation.subscription.available', 'Available with your Codex login.')
					: localize('dictation.subscription.unavailable', 'Unavailable. Check your Codex login in Models.');
				return;
			}
			const connection = backend.type === 'cloud' && backend.provider === 'xai' ? 'xai' : 'openai';
			const provider = providers.find(provider => provider.connection === connection);
			status.textContent = provider?.apiKeyConfigured
				? localize('dictation.connections.configured', 'API key configured. This connection is shared with chat.')
				: localize('dictation.connections.missing', 'This cloud API service requires an API key. Configure it in Models.');
		} catch {
			if (version === this.requestVersion && !this.isDisposed) { status.textContent = localize('dictation.connections.failed', 'Could not read the dictation connection.'); }
		}
	}

	private async readVoiceMode(version: number): Promise<void> {
		let available = false;
		try {
			if (this.voice?.isAvailable) {
				const model = this.configuration.getValue<string>(AgentsVoiceSettingId.Model);
				const connections = await this.voice.getOptions();
				available = connections.some(connection => connection.models.some(choice => choice.modelId === model));
			}
		} catch {
			// Provider failures leave the connection unavailable until Models refreshes.
		}
		if (version === this.requestVersion && !this.isDisposed) {
			this.voiceModeStatus.textContent = available
				? localize('dictation.voiceMode.available', 'Voice model available.')
				: localize('dictation.voiceMode.unavailable', 'Voice model unavailable. Check API connections in Models.');
		}
	}

}
