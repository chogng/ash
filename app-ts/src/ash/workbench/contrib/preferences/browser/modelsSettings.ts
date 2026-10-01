import './media/modelsSettings.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLOUD_DICTATION_MODEL, DEFAULT_LOCAL_DICTATION_MODEL, DictationConfiguration, XAI_DICTATION_MODEL } from '../../../../platform/dictation/common/dictationConfiguration.js';
import { ILocalTranscriptionService, LocalTranscriptionModelState, type ILocalTranscriptionModelStatus, type ILocalTranscriptionModelOperation } from '../../../../platform/localTranscription/common/localTranscription.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IChatService, ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import { DefaultSettings } from '../../../services/preferences/common/settingsModels.js';
import { SettingsRenderer } from './settingsRenderers.js';

interface ModelsSettingsOptions {
	readonly chatService: IChatService;
	readonly clipboardService: IClipboardService;
	readonly configurationService: IConfigurationService;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly contextViewProvider: IContextViewProvider;
}

/** The Workbench models page reads and writes the same Chat and voice settings as Sessions Settings. */
export class ModelsSettings extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly search: InputBox;
	private readonly chatHeading: HTMLElement;
	private readonly chatList: HTMLElement;
	private readonly voiceGroup: HTMLElement;
	private readonly apiGroup: HTMLElement;
	private readonly apiList: HTMLElement;
	private readonly apiEmpty: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly status: HTMLElement;
	private readonly rows = this._register(new MutableDisposable<DisposableStore>());
	private readonly apiRows = this._register(new MutableDisposable<DisposableStore>());
	private readonly voiceSearchText: string;
	private catalog: readonly ModelCatalogEntry[] | undefined;
	private modelElements: readonly { readonly entry: ModelCatalogEntry; readonly row: HTMLElement }[] = [];
	private apiElements: readonly { readonly provider: ModelProviderCredentialStatus; readonly row: HTMLElement }[] = [];
	private modelLoadVersion = 0;
	private apiLoadVersion = 0;
	private visible = false;
	private readonly localModelControls: LocalTranscriptionModelControls;

	constructor(container: HTMLElement, private readonly options: ModelsSettingsOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-models-settings';
		this.domNode.hidden = true;
		const searchContainer = h(document, 'div');
		searchContainer.className = 'ash-models-settings-search';
		searchContainer.setAttribute('role', 'search');
		appendIcon(Lxicon.search, searchContainer);
		this.search = this._register(new InputBox(searchContainer, {
			type: 'search',
			presentation: 'field',
			placeholder: localize('sessions.settings.searchModels', 'Search models and APIs'),
			ariaLabel: localize('sessions.settings.searchModels', 'Search models and APIs'),
		}));
		this.chatHeading = h(document, 'h4');
		this.chatHeading.textContent = localize('sessions.settings.chatModels', 'Chat models');
		this.chatList = h(document, 'div');
		this.chatList.className = 'ash-models-settings-list ash-settings-card';
		this.empty = h(document, 'p');
		this.empty.className = 'ash-models-settings-empty';
		this.empty.setAttribute('role', 'status');
		this.empty.hidden = true;
		this.status = h(document, 'p');
		this.status.className = 'ash-models-settings-status';
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;
		this.voiceGroup = h(document, 'section');
		this.voiceGroup.className = 'ash-models-settings-group';
		const voiceHeading = h(document, 'h4');
		voiceHeading.textContent = localize('sessions.settings.voiceModels', 'Voice input');
		const voiceList = h(document, 'div');
		voiceList.className = 'ash-models-settings-list ash-settings-card';
		const voiceRenderer = this._register(new SettingsRenderer(voiceList, {
			clipboardService: options.clipboardService,
			configurationService: options.configurationService,
			contextMenuProvider: options.contextMenuProvider,
			contextViewProvider: options.contextViewProvider,
			onStatus: (message, isError) => this.reportStatus(message, isError),
		}));
		const settings = new DefaultSettings();
		const voiceSettings = [
			settings.get(DictationConfiguration.backend),
			settings.get(DictationConfiguration.cloudProvider),
			settings.get(DictationConfiguration.localModel),
		];
		voiceList.replaceChildren(...voiceSettings.map(setting => voiceRenderer.render(setting)));
		const cloudModels = h(document, 'p');
		cloudModels.className = 'ash-models-settings-note';
		cloudModels.textContent = localize('sessions.settings.cloudVoiceModels', 'Cloud models: OpenAI {0} · xAI {1}', CLOUD_DICTATION_MODEL, XAI_DICTATION_MODEL);
		this.voiceSearchText = `${voiceHeading.textContent} ${voiceSettings.map(setting => `${setting.title} ${setting.description}`).join(' ')} ${DEFAULT_LOCAL_DICTATION_MODEL} ${CLOUD_DICTATION_MODEL} ${XAI_DICTATION_MODEL} OpenAI xAI`.toLowerCase();
		this.voiceGroup.append(voiceHeading, voiceList, cloudModels);
		this.localModelControls = this._register(instantiationService.createInstance(LocalTranscriptionModelControls, voiceList));
		this.apiGroup = h(document, 'section');
		this.apiGroup.className = 'ash-models-settings-group';
		const apiHeading = h(document, 'h4');
		apiHeading.textContent = localize('sessions.settings.apiConnections', 'API connections');
		this.apiList = h(document, 'div');
		this.apiList.className = 'ash-models-settings-list ash-settings-card';
		this.apiEmpty = h(document, 'p');
		this.apiEmpty.className = 'ash-models-settings-empty';
		this.apiEmpty.setAttribute('role', 'status');
		this.apiGroup.append(apiHeading, this.apiList, this.apiEmpty);
		this.domNode.append(searchContainer, this.chatHeading, this.chatList, this.empty, this.voiceGroup, this.apiGroup, this.status);
		container.append(this.domNode);
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape' && document.activeElement === this.search.inputElement) this.search.value = '';
		}));
		this._register(this.search.onDidChange(() => this.filter()));
		this._register(options.chatService.onDidChangeModels(() => {
			if (!this.visible) return;
			const version = this.modelLoadVersion;
			void options.chatService.listModelCatalog().then(catalog => {
				if (version === this.modelLoadVersion && catalog !== this.catalog) void this.loadModels(++this.modelLoadVersion);
			}).catch(() => {
				if (version === this.modelLoadVersion) this.reportStatus(localize('sessions.settings.modelsLoadFailed', 'Could not load models.'), true);
			});
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.domNode.hidden = !visible;
		this.localModelControls.setVisible(visible);
		if (!visible) {
			this.modelLoadVersion++;
			this.apiLoadVersion++;
			this.rows.clear();
			this.apiRows.clear();
			this.catalog = undefined;
			this.modelElements = [];
			this.apiElements = [];
			this.chatList.replaceChildren();
			this.apiList.replaceChildren();
			return;
		}
		this.empty.textContent = localize('sessions.settings.modelsLoading', 'Loading models…');
		this.empty.hidden = false;
		this.apiEmpty.textContent = localize('sessions.settings.apiLoading', 'Loading API connections…');
		this.apiEmpty.hidden = false;
		void this.loadModels(++this.modelLoadVersion);
		void this.loadApiConnections(++this.apiLoadVersion);
	}

	private async loadModels(version: number): Promise<void> {
		try {
			const catalog = await this.options.chatService.listModelCatalog();
			if (version !== this.modelLoadVersion) return;
			this.catalog = catalog;
			const resources = new DisposableStore();
			this.modelElements = catalog.map(entry => ({ entry, row: this.modelRow(entry, resources) }));
			this.rows.value = resources;
			this.chatList.replaceChildren(...this.modelElements.map(item => item.row));
			this.filter();
		} catch {
			if (version !== this.modelLoadVersion) return;
			this.chatList.hidden = true;
			this.empty.textContent = localize('sessions.settings.modelsLoadFailed', 'Could not load models.');
			this.empty.hidden = false;
		}
	}

	private async loadApiConnections(version: number): Promise<void> {
		try {
			const providers = (await this.options.chatService.listModelProviders()).filter(provider => provider.apiKeyPolicy !== 'unsupported');
			if (version !== this.apiLoadVersion) return;
			const resources = new DisposableStore();
			this.apiElements = providers.map(provider => ({ provider, row: this.apiConnectionRow(provider, resources) }));
			this.apiRows.value = resources;
			this.apiList.replaceChildren(...this.apiElements.map(item => item.row));
			this.apiList.hidden = providers.length === 0;
			this.apiEmpty.textContent = localize('sessions.settings.noApiConnections', 'No API connections available.');
			this.apiEmpty.hidden = providers.length !== 0;
			this.filter();
		} catch {
			if (version !== this.apiLoadVersion) return;
			this.apiList.hidden = true;
			this.apiEmpty.textContent = localize('sessions.settings.apiLoadFailed', 'Could not load API connections.');
			this.apiEmpty.hidden = false;
		}
	}

	private filter(): void {
		const query = this.search.value.trim().toLowerCase();
		let chatMatches = 0;
		for (const { entry, row } of this.modelElements) {
			row.hidden = !`${entry.displayName} ${entry.model.provider}/${entry.model.model}`.toLowerCase().includes(query);
			if (!row.hidden) chatMatches++;
		}
		const voiceMatches = !query || this.voiceSearchText.includes(query);
		let apiMatches = 0;
		for (const { provider, row } of this.apiElements) {
			row.hidden = !`${provider.displayName} ${provider.provider} ${provider.connection}`.toLowerCase().includes(query);
			if (!row.hidden) apiMatches++;
		}
		this.chatHeading.hidden = !!query && chatMatches === 0;
		this.chatList.hidden = chatMatches === 0;
		this.voiceGroup.hidden = !voiceMatches;
		this.apiGroup.hidden = !!query && apiMatches === 0;
		if (!this.catalog) return;
		this.empty.textContent = this.catalog.length === 0 && !query
			? localize('sessions.settings.noModels', 'No models available.')
			: localize('sessions.settings.noMatchingModels', 'No matching models or APIs.');
		this.empty.hidden = query ? chatMatches > 0 || voiceMatches || apiMatches > 0 : chatMatches > 0;
	}

	private modelRow(entry: ModelCatalogEntry, resources: DisposableStore): HTMLElement {
		const row = h(this.domNode.ownerDocument, 'div');
		row.className = 'ash-models-settings-model-row';
		const copy = h(this.domNode.ownerDocument, 'span');
		copy.className = 'ash-models-settings-model-copy';
		const name = h(this.domNode.ownerDocument, 'span');
		name.textContent = entry.displayName;
		const description = h(this.domNode.ownerDocument, 'span');
		description.className = 'ash-models-settings-note';
		description.textContent = `${entry.model.provider}/${entry.model.model}`;
		copy.append(name, description);
		const toggle = resources.add(new Switch(row, {
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.displayName),
			checked: this.options.chatService.isModelVisible(entry.model),
			content: copy,
			contentPlacement: 'before-control',
		}));
		resources.add(this.options.chatService.onDidChangeModels(() => { toggle.checked = this.options.chatService.isModelVisible(entry.model); }));
		resources.add(toggle.onDidChange(visible => {
			toggle.busy = true;
			this.status.hidden = true;
			void this.options.chatService.setModelVisible(entry.model, visible).catch(() => {
				this.reportStatus(localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.'), true);
			}).finally(() => {
				toggle.checked = this.options.chatService.isModelVisible(entry.model);
				toggle.busy = false;
			});
		}));
		return row;
	}

	private apiConnectionRow(provider: ModelProviderCredentialStatus, resources: DisposableStore): HTMLElement {
		const document = this.domNode.ownerDocument;
		const row = h(document, 'div');
		row.className = 'ash-models-settings-api-row';
		const name = h(document, 'h5');
		name.textContent = provider.displayName;
		const details = h(document, 'p');
		details.className = 'ash-models-settings-note';
		details.textContent = provider.connection;
		const keyStatus = h(document, 'p');
		keyStatus.className = 'ash-models-settings-note';
		keyStatus.textContent = provider.apiKeyConfigured
			? localize('chat.providerKeys.configured', 'API key saved')
			: provider.apiKeyPolicy === 'required'
				? localize('chat.providerKeys.missing', 'API key required')
				: localize('chat.providerKeys.optional', 'No API key saved');
		const controls = h(document, 'div');
		controls.className = 'ash-models-settings-api-controls';
		const input = resources.add(new InputBox(controls, {
			type: 'password',
			presentation: 'field',
			placeholder: localize('chat.providerKeys.inputPlaceholder', 'Paste an API key'),
			ariaLabel: localize('chat.providerKeys.inputTitle', 'API key for {0}', provider.displayName),
		}));
		const save = resources.add(new Button(controls, {
			label: localize('sessions.settings.saveApiKey', 'Save API key'),
			presentation: 'secondary',
			enabled: false,
		}));
		const feedback = h(document, 'p');
		feedback.className = 'ash-models-settings-note';
		feedback.setAttribute('role', 'status');
		feedback.hidden = true;
		row.append(name, details, keyStatus, controls, feedback);
		const saveKey = async (): Promise<void> => {
			const key = input.value.trim();
			if (!key || !save.enabled) return;
			input.enabled = false;
			save.enabled = false;
			feedback.hidden = true;
			try {
				await this.options.chatService.setModelProviderApiKey(provider.connection, key);
				input.value = '';
				keyStatus.textContent = localize('chat.providerKeys.configured', 'API key saved');
				try {
					await this.options.chatService.refreshModels();
					feedback.textContent = localize('chat.providerKeys.saved', 'API key saved for {0}', provider.displayName);
					feedback.setAttribute('role', 'status');
				} catch {
					feedback.textContent = localize('chat.providerKeys.refreshFailed', 'API key saved, but models could not be refreshed');
					feedback.setAttribute('role', 'alert');
				}
			} catch {
				feedback.textContent = localize('chat.providerKeys.saveFailed', 'Could not save the API key');
				feedback.setAttribute('role', 'alert');
			} finally {
				feedback.hidden = false;
				input.enabled = true;
				save.enabled = input.value.trim().length > 0;
			}
		};
		resources.add(input.onDidChange(value => { save.enabled = input.enabled && value.trim().length > 0; }));
		resources.add(input.onKeyDown(event => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			void saveKey();
		}));
		resources.add(save.onDidClick(() => void saveKey()));
		return row;
	}

	private reportStatus(message: string, isError: boolean): void {
		this.status.textContent = message;
		this.status.classList.toggle('is-error', isError);
		this.status.setAttribute('role', isError ? 'alert' : 'status');
		this.status.hidden = !message;
	}
}

function modelProgressText(status: ILocalTranscriptionModelStatus): string {
	switch (status.state) {
		case LocalTranscriptionModelState.Checking: return localize('dictation.model.checking', 'Checking model files…');
		case LocalTranscriptionModelState.Downloading: return localize('dictation.model.downloading', 'Downloading {0}: {1} MiB', status.file, (status.downloadedBytes / (1024 * 1024)).toFixed(1));
		case LocalTranscriptionModelState.Loading: return localize('dictation.model.loading', 'Loading model…');
		case LocalTranscriptionModelState.Ready: return localize('dictation.model.ready', 'Model verified and ready to use.');
		case LocalTranscriptionModelState.Cancelled: return localize('dictation.model.cancelled', 'Model preparation cancelled.');
		case LocalTranscriptionModelState.Error: return localize('dictation.model.failed', 'Model preparation failed: {0}', status.error);
	}
}

/** Shared model controls for Workbench and Sessions; closing the view cancels its borrowed operation. */
export class LocalTranscriptionModelControls extends Disposable {
	public readonly domNode: HTMLElement;
	private visible = false;
	private readonly localModelStatusDomNode: HTMLElement;
	private readonly modelSource: InputBox;
	private readonly prepareModelButton: Button;
	private readonly importModelButton: Button;
	private readonly cancelModelButton: Button;
	private modelOperation: ILocalTranscriptionModelOperation | undefined;
	private modelStatusVersion = 0;

	constructor(container: HTMLElement,
		@ILocalTranscriptionService private readonly localTranscription: ILocalTranscriptionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const document = container.ownerDocument;
		const localModelRow = h(document, 'div');
		localModelRow.className = 'ash-local-transcription-model-controls';
		this.domNode = localModelRow;
		const sourceLabel = h(document, 'label');
		sourceLabel.textContent = localize('dictation.model.source', 'Prepared Paraformer model directory');
		const sourceContainer = h(document, 'div');
		sourceContainer.className = 'ash-local-transcription-model-source';
		this.modelSource = this._register(new InputBox(sourceContainer, {
			presentation: 'field',
			ariaLabel: localize('dictation.model.source', 'Prepared Paraformer model directory'),
			placeholder: localize('dictation.model.sourcePlaceholder', 'Absolute directory containing dictation-model.json'),
		}));
		this.modelSource.inputElement.id = generateUuid();
		sourceLabel.htmlFor = this.modelSource.inputElement.id;
		const actions = h(document, 'div');
		actions.className = 'ash-local-transcription-model-actions';
		this.prepareModelButton = this._register(new Button(actions, { label: localize('dictation.model.prepare', 'Prepare model'), presentation: 'secondary' }));
		this.importModelButton = this._register(new Button(actions, { label: localize('dictation.model.import', 'Import model'), presentation: 'secondary' }));
		this.cancelModelButton = this._register(new Button(actions, { label: localize('dictation.model.cancel', 'Cancel'), presentation: 'secondary', enabled: false }));
		this.localModelStatusDomNode = h(document, 'p');
		this.localModelStatusDomNode.className = 'ash-local-transcription-model-status';
		this.localModelStatusDomNode.setAttribute('role', 'status');
		this.localModelStatusDomNode.setAttribute('aria-atomic', 'true');
		localModelRow.append(sourceLabel, sourceContainer, actions, this.localModelStatusDomNode);
		container.append(localModelRow);
		this.updateModelControls();
		this._register(this.modelSource.onDidChange(() => this.updateModelControls()));
		this._register(this.prepareModelButton.onDidClick(() => { void this.runModelOperation('prepare'); }));
		this._register(this.importModelButton.onDidClick(() => { void this.runModelOperation('import'); }));
		this._register(this.cancelModelButton.onDidClick(() => { void this.modelOperation?.cancel(); }));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DictationConfiguration.localModel) && this.visible && !this.modelOperation) { void this.readLocalModelStatus(); }
		}));
		this._register(toDisposable(() => { void this.modelOperation?.cancel(); }));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public setVisible(visible: boolean): void {
		if (visible === this.visible) { return; }
		this.visible = visible;
		this.modelStatusVersion++;
		if (visible && !this.modelOperation) { void this.readLocalModelStatus(); }
		if (!visible) { void this.modelOperation?.cancel(); }
	}

	private updateModelControls(): void {
		const enabled = this.localTranscription.isSupported && !this.modelOperation;
		this.prepareModelButton.enabled = enabled;
		this.importModelButton.enabled = enabled && !!this.modelSource.value.trim();
		this.modelSource.inputElement.disabled = !enabled;
		this.cancelModelButton.enabled = !!this.modelOperation;
	}

	private async readLocalModelStatus(): Promise<void> {
		const version = ++this.modelStatusVersion;
		if (!this.localTranscription.isSupported) {
			this.localModelStatusDomNode.textContent = localize('dictation.connectionUnavailable', 'Dictation connection is unavailable');
			return;
		}
		try {
			const model = this.configurationService.getValue<string>(DictationConfiguration.localModel);
			const status = await this.localTranscription.getModelStatus(model);
			if (version !== this.modelStatusVersion || this.isDisposed) { return; }
			this.localModelStatusDomNode.textContent = status.available
				? localize('dictation.model.installed', 'Model package installed: {0}', status.model)
				: localize('dictation.model.missing', 'Model package not installed: {0}', status.model);
		} catch (error) {
			if (version === this.modelStatusVersion && !this.isDisposed) { this.localModelStatusDomNode.textContent = localize('dictation.model.failed', 'Model preparation failed: {0}', String(error)); }
		}
	}

	private async runModelOperation(kind: 'prepare' | 'import'): Promise<void> {
		if (this.modelOperation) { return; }
		this.modelStatusVersion++;
		try {
			const model = this.configurationService.getValue<string>(DictationConfiguration.localModel);
			const onProgress = (status: ILocalTranscriptionModelStatus): void => {
				if (!this.isDisposed && this.visible) { this.localModelStatusDomNode.textContent = modelProgressText(status); }
			};
			// The transcription service owns the handle; this page borrows it and cancels on close.
			const operation = kind === 'prepare'
				? this.localTranscription.prepareModel(model, onProgress)
				: this.localTranscription.importModel({ model, sourcePath: this.modelSource.value.trim() }, onProgress);
			this.modelOperation = operation;
			this.updateModelControls();
			await operation.completed;
		} catch (error) {
			if (!this.isDisposed && this.visible) { this.localModelStatusDomNode.textContent = localize('dictation.model.failed', 'Model preparation failed: {0}', String(error)); }
		} finally {
			this.modelOperation = undefined;
			if (!this.isDisposed) { this.updateModelControls(); }
		}
	}

}
