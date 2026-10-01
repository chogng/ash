import './media/modelSettingsContent.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CLOUD_DICTATION_MODEL, XAI_DICTATION_MODEL } from '../../../../platform/dictation/common/dictationConfiguration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatService, type ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import { LocalTranscriptionModelControls } from '../../localTranscription/browser/localTranscriptionModelControls.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';

/** Model and credential rows shared by Workbench and Sessions; the host owns navigation and search. */
export class ModelSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'models';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly document: Document;
	private readonly cloudModelsNote: HTMLElement;
	private readonly status: HTMLElement;
	private readonly modelsStatus: HTMLElement;
	private readonly providersStatus: HTMLElement;
	private readonly rows = this._register(new DisposableMap<string, DisposableStore>());
	private readonly apiRows = this._register(new DisposableMap<string, DisposableStore>());
	private modelElements: readonly { readonly entry: ModelCatalogEntry; readonly row: HTMLElement }[] = [];
	private apiElements: readonly { readonly provider: ModelProviderCredentialStatus; readonly row: HTMLElement }[] = [];
	private visible = false;
	private modelLoadVersion = 0;
	private apiLoadVersion = 0;
	private readonly localModelControls: LocalTranscriptionModelControls;

	constructor(container: HTMLElement, @IChatService private readonly chatService: IChatService, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.document = container.ownerDocument;
		this.cloudModelsNote = h(this.document, 'p');
		this.cloudModelsNote.className = 'ash-models-settings-note';
		this.cloudModelsNote.textContent = localize('sessions.settings.cloudVoiceModels', 'Cloud models: OpenAI {0} · xAI {1}', CLOUD_DICTATION_MODEL, XAI_DICTATION_MODEL);
		this.status = h(this.document, 'p');
		this.status.className = 'ash-models-settings-status';
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;
		this.modelsStatus = h(this.document, 'p');
		this.modelsStatus.className = 'ash-models-settings-empty';
		this.modelsStatus.setAttribute('role', 'status');
		this.providersStatus = h(this.document, 'p');
		this.providersStatus.className = 'ash-models-settings-empty';
		this.providersStatus.setAttribute('role', 'status');
		this.localModelControls = this._register(instantiationService.createInstance(LocalTranscriptionModelControls, h(this.document, 'div')));
		this._register(this.chatService.onDidChangeModels(() => {
			if (this.visible) void this.loadModels(++this.modelLoadVersion);
		}));
		this._register(toDisposable(() => { this.modelLoadVersion++; this.apiLoadVersion++; }));
	}

	public getNodes(): readonly SettingsTreeNode<SettingsContentItem>[] {
		const item = (id: string, title: string, description: string, domNode: HTMLElement, keywords?: readonly string[]): SettingsTreeNode<SettingsContentItem> => ({
			element: { kind: 'item', id, title, description, keywords, value: { domNode } },
		});
		return [
			{
				element: { kind: 'group', id: 'models.catalog', title: localize('sessions.settings.chatModels', 'Chat models'), description: '' },
				children: this.modelElements.length ? this.modelElements.map(({ entry, row }) => item(`models.catalog.${entry.model.provider}/${entry.model.model}`, entry.displayName, `${entry.model.provider}/${entry.model.model}`, row)) : [item('models.catalog.status', localize('sessions.settings.chatModels', 'Chat models'), this.modelsStatus.textContent ?? '', this.modelsStatus)],
			},
			{
				element: { kind: 'group', id: 'models.providers', title: localize('sessions.settings.apiConnections', 'API connections'), description: '' },
				children: this.apiElements.length ? this.apiElements.map(({ provider, row }) => item(`models.providers.${provider.connection}`, provider.displayName, `${provider.provider} ${provider.connection}`, row, ['API connections'])) : [item('models.providers.status', localize('sessions.settings.apiConnections', 'API connections'), this.providersStatus.textContent ?? '', this.providersStatus)],
			},
			item('models.voice-models', localize('sessions.settings.voiceModels', 'Voice input'), this.cloudModelsNote.textContent ?? '', this.cloudModelsNote),
			item('models.local-transcription', localize('sessions.settings.voiceModels', 'Voice input'), localize('dictation.model.source', 'Prepared Paraformer model directory'), this.localModelControls.domNode),
			item('models.status', localize('sessions.settings.models', 'Models'), this.status.textContent ?? '', this.status),
		];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.localModelControls.setVisible(visible);
		if (!visible) {
			this.modelLoadVersion++;
			this.apiLoadVersion++;
			return;
		}
		this.modelsStatus.textContent = localize('sessions.settings.modelsLoading', 'Loading models…');
		this.providersStatus.textContent = localize('sessions.settings.apiLoading', 'Loading API connections…');
		this.changed.fire();
		void this.loadModels(++this.modelLoadVersion);
		void this.loadApiConnections(++this.apiLoadVersion);
	}

	private async loadModels(version: number): Promise<void> {
		try {
			const catalog = await this.chatService.listModelCatalog();
			if (version !== this.modelLoadVersion || this.isDisposed) return;
			const previous = new Map(this.modelElements.map(item => [`${item.entry.model.provider}/${item.entry.model.model}`, item]));
			const ids = new Set(catalog.map(entry => `${entry.model.provider}/${entry.model.model}`));
			for (const [id] of this.rows) {
				if (!ids.has(id)) this.rows.deleteAndDispose(id);
			}
			this.modelElements = catalog.map(entry => {
				const id = `${entry.model.provider}/${entry.model.model}`;
				const existing = previous.get(id);
				if (existing) {
					existing.row.querySelector('.ash-models-settings-model-copy > span')!.textContent = entry.displayName;
					existing.row.querySelector('input')!.setAttribute('aria-label', localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.displayName));
					return { entry, row: existing.row };
				}
				const resources = new DisposableStore();
				this.rows.set(id, resources);
				return { entry, row: this.modelRow(entry, resources) };
			});
			this.modelsStatus.textContent = localize('sessions.settings.noModels', 'No models available.');
		} catch {
			if (version !== this.modelLoadVersion || this.isDisposed) return;
			this.modelElements = [];
			for (const [id] of this.rows) this.rows.deleteAndDispose(id);
			this.modelsStatus.textContent = localize('sessions.settings.modelsLoadFailed', 'Could not load models.');
		}
		this.changed.fire();
	}

	private async loadApiConnections(version: number): Promise<void> {
		try {
			const providers = (await this.chatService.listModelProviders()).filter(provider => provider.apiKeyPolicy !== 'unsupported');
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			const previous = new Map(this.apiElements.map(item => [item.provider.connection, item]));
			const ids = new Set(providers.map(provider => provider.connection));
			for (const [id] of this.apiRows) {
				if (!ids.has(id)) this.apiRows.deleteAndDispose(id);
			}
			this.apiElements = providers.map(provider => {
				const existing = previous.get(provider.connection);
				if (existing) {
					existing.row.querySelector('h5')!.textContent = provider.displayName;
					return { provider, row: existing.row };
				}
				const resources = new DisposableStore();
				this.apiRows.set(provider.connection, resources);
				return { provider, row: this.apiConnectionRow(provider, resources) };
			});
			this.providersStatus.textContent = localize('sessions.settings.noApiConnections', 'No API connections available.');
		} catch {
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			this.apiElements = [];
			for (const [id] of this.apiRows) this.apiRows.deleteAndDispose(id);
			this.providersStatus.textContent = localize('sessions.settings.apiLoadFailed', 'Could not load API connections.');
		}
		this.changed.fire();
	}

	private modelRow(entry: ModelCatalogEntry, resources: DisposableStore): HTMLElement {
		const row = h(this.document, 'div');
		row.className = 'ash-models-settings-model-row';
		const copy = h(this.document, 'span');
		copy.className = 'ash-models-settings-model-copy';
		const name = h(this.document, 'span');
		name.textContent = entry.displayName;
		const description = h(this.document, 'span');
		description.className = 'ash-models-settings-note';
		description.textContent = `${entry.model.provider}/${entry.model.model}`;
		copy.append(name, description);
		const toggle = resources.add(new Switch(row, {
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.displayName),
			checked: this.chatService.isModelVisible(entry.model),
			content: copy,
			contentPlacement: 'before-control',
		}));
		resources.add(this.chatService.onDidChangeModels(() => { toggle.checked = this.chatService.isModelVisible(entry.model); }));
		resources.add(toggle.onDidChange(visible => {
			toggle.busy = true;
			this.status.hidden = true;
			void this.chatService.setModelVisible(entry.model, visible).catch(() => {
				this.reportStatus(localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.'), true);
			}).finally(() => {
				toggle.checked = this.chatService.isModelVisible(entry.model);
				toggle.busy = false;
			});
		}));
		return row;
	}

	private apiConnectionRow(provider: ModelProviderCredentialStatus, resources: DisposableStore): HTMLElement {
		const document = this.document;
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
				await this.chatService.setModelProviderApiKey(provider.connection, key);
				input.value = '';
				keyStatus.textContent = localize('chat.providerKeys.configured', 'API key saved');
				try {
					await this.chatService.refreshModels();
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
