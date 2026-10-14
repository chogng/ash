import { ILanguageModelsService } from '../common/languageModels.js';
import './media/modelSettingsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { ChatModelsWidget, ProviderApiKeyInput } from './chatManagement/chatModelsWidget.js';
import { SettingsSearchQuery } from '../../preferences/browser/settingsSearch.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { type ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';
import { ISecretStorageStatusService, SecretStorageError, secretStorageMessage, type SecretStorageStatus, type SecretStorageMode } from '../../../../platform/secrets/common/secrets.js';

/** Model and credential rows shared by Workbench and Sessions; the host owns navigation and search. */
export class ModelSettingsContent extends Disposable implements SettingsContent {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly document: Document;
	private readonly status: HTMLElement;
	private readonly modelsStatus: HTMLElement;
	private readonly modelTitle: HTMLElement;
	private readonly modelSearch: InputBox;
	private readonly modelSearchEmpty: HTMLElement;
	private readonly providersStatus: HTMLElement;
	private readonly storageStatus: HTMLElement;
	private readonly storageMessage: HTMLElement;
	private readonly storageRetry: Button;
	private readonly storageAuthorize: Button;
	private readonly storageModeButton: Button;
	private storageMode: SecretStorageMode | undefined;
	private storageAvailable = false;
	private storageBusy = false;
	private readonly rows = this._register(new DisposableMap<string, DisposableStore>());
	private readonly apiRows = this._register(new DisposableMap<string, DisposableStore>());
	private modelElements: readonly { readonly entry: ModelCatalogEntry; readonly row: HTMLElement; }[] = [];
	private apiElements: readonly { readonly provider: ModelProviderCredentialStatus; readonly row: HTMLElement; readonly key: ProviderApiKeyInput; }[] = [];
	private readonly providerTitle: HTMLElement;
	private readonly expandRow: HTMLElement;
	private readonly expandButton: Button;
	private readonly customProviders = this._register(new DisposableMap<string, ChatModelsWidget>());
	private expanded = false;
	private visible = false;
	private modelLoadVersion = 0;
	private apiLoadVersion = 0;
	public readonly categoryId = 'models';

	constructor(container: HTMLElement, @ILanguageModelsService private readonly languageModels: ILanguageModelsService, @ISecretStorageStatusService private readonly secretStorage: ISecretStorageStatusService, @IAccessibleViewService accessibleView: IAccessibleViewService, @IConfigurationService configuration: IConfigurationService, @IInstantiationService private readonly instantiation: IInstantiationService, @INotificationService private readonly notifications: INotificationService, @IDialogService private readonly dialogs: IDialogService) {
		super();
		this.document = container.ownerDocument;
		this.status = h(this.document, 'p');
		this.status.className = 'ash-models-settings-status';
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;
		this.modelsStatus = h(this.document, 'p');
		this.modelsStatus.className = 'ash-models-settings-empty';
		this.modelsStatus.setAttribute('role', 'status');
		this.modelTitle = h(this.document, 'div');
		this.modelTitle.className = 'ash-models-settings-model-title';
		const modelTitle = h(this.document, 'span');
		modelTitle.textContent = localize('sessions.settings.chatModels', 'Chat models');
		this.modelTitle.append(modelTitle);
		this.modelSearch = this._register(new InputBox(this.modelTitle, {
			type: 'search', presentation: 'field',
			ariaLabel: localize('models.catalog.search', 'Search models'),
			placeholder: localize('models.catalog.searchPlaceholder', 'Search model name or ID'),
		}));
		this._register(this.modelSearch.onDidChange(() => this.changed.fire()));
		this.modelSearchEmpty = h(this.document, 'p');
		this.modelSearchEmpty.className = 'ash-models-settings-empty';
		this.modelSearchEmpty.setAttribute('role', 'status');
		this.modelSearchEmpty.textContent = localize('models.catalog.noMatches', 'No models found.');
		this.providersStatus = h(this.document, 'p');
		this.providersStatus.className = 'ash-models-settings-empty';
		this.providersStatus.setAttribute('role', 'status');
		this.storageStatus = h(this.document, 'div');
		this.storageStatus.hidden = true;
		this.storageMessage = h(this.document, 'p');
		this.storageMessage.className = 'ash-models-settings-empty';
		this.storageMessage.setAttribute('role', 'status');
		this.storageStatus.append(this.storageMessage);
		this.storageRetry = this._register(new Button(this.storageStatus, {
			label: localize('credentials.storage.retry', 'Retry credential storage'), presentation: 'secondary',
		}));
		this._register(this.storageRetry.onDidClick(() => {
			void this.loadApiConnections(++this.apiLoadVersion);
			void this.loadModels(++this.modelLoadVersion);
		}));
		this.storageAuthorize = this._register(new Button(this.storageStatus, {
			label: localize('credentials.storage.authorize', 'Authorize system keyring'), presentation: 'secondary',
		}));
		this._register(this.storageAuthorize.onDidClick(() => void this.changeStorage('authorize')));
		this.storageModeButton = this._register(new Button(this.storageStatus, {
			label: localize('credentials.storage.useFile', 'Use file storage'), presentation: 'secondary',
		}));
		this._register(this.storageModeButton.onDidClick(() => void this.changeStorage('mode')));
		this.providerTitle = h(this.document, 'span');
		this.providerTitle.className = 'ash-models-settings-provider-title';
		const title = h(this.document, 'span');
		title.textContent = localize('models.keys.title', 'API key');
		this.providerTitle.append(title);
		const add = this._register(new Button(this.providerTitle, { label: localize('models.provider.new', 'New provider'), presentation: 'secondary' }));
		this._register(add.onDidClick(() => {
			const id = `custom-${createUuid()}`;
			const card = this.instantiation.createInstance(ChatModelsWidget, this.document, { id, name: '', baseUrl: '', apiFormat: 'responses', order: Date.now(), models: [] }, false, true);
			this.customProviders.set(id, card);
			card.setCredentialStorageAvailable(this.storageAvailable);
			void card.initialize();
			this.changed.fire();
			card.focus();
		}));
		this.expandRow = h(this.document, 'div');
		this.expandRow.className = 'ash-models-settings-expand';
		this.expandButton = this._register(new Button(this.expandRow, { label: localize('models.catalog.viewAll', 'viewall models'), icon: Lxicon.chevronDown, presentation: 'secondary' }));
		this.expandButton.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.expandButton.onDidClick(() => {
			this.expanded = !this.expanded;
			this.expandButton.domNode.setAttribute('aria-expanded', String(this.expanded));
			this.expandButton.icon = this.expanded ? Lxicon.chevronUp : Lxicon.chevronDown;
			this.changed.fire();
		}));
		this._register(this.languageModels.onDidChangeModels(() => {
			if (!this.visible) { return; }
			void this.loadModels(++this.modelLoadVersion);
			void this.loadApiConnections(++this.apiLoadVersion);
		}));
		const hint = (): void => {
			const message = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
			for (const node of [this.providerTitle, this.modelSearch.inputElement]) {
				if (message) node.setAttribute('aria-description', message);
				else node.removeAttribute('aria-description');
			}
		};
		hint();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ChatModelConfiguration)) hint();
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `models-settings-${type}-${createUuid()}`,
				getProvider: () => {
					const focused = this.document.activeElement;
					if (!this.visible || !isHTMLElement(focused)) return undefined;
					const nodes = [this.modelTitle, this.providerTitle, this.expandRow, this.storageStatus, ...this.modelElements.map(model => model.row), ...this.apiElements.map(provider => provider.row), ...[...this.customProviders].map(([, card]) => card.domNode)];
					if (!nodes.some(node => node.contains(focused))) return undefined;
					const modelNames = (): string => this.getNodes()[0].children!
						.filter(node => node.element.id !== 'models.catalog.expand')
						.map(node => node.element.title).join('\n');
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatModelConfiguration, { type },
						() => type === AccessibleViewType.View ? [this.storageMessage.textContent, [...this.customProviders].map(([, card]) => card.getAccessibleContent()).join('\n\n') || modelNames()].filter(Boolean).join('\n\n') : localize('models.settings.help', 'Models shows the newest model from each provider. Enabled models appear first; each group keeps the catalog order. Turning a model off restores its place among disabled models. Search models filters the full list by model name or ID. Clear the search to restore the list. Use viewall models to expand or collapse the full list. API keys save when the field loses focus; clear the field to remove a key. Credential storage checks and retries are silent. Use Authorize system keyring to explicitly request system access. Use file storage migrates credentials to unencrypted private files after confirmation. Use encrypted storage migrates them back and may request system authorization. Missing original encryption keys block migration and preserve existing credentials. New provider adds a card with provider name, Base URL, API key and API format. Test models tests the current table, fetching the endpoint list first when empty. Refresh models fetches the list again. Use Add model for a missing ID or to declare its context window. Edit context and delete manual declarations from the row actions. Each Enabled switch controls picker availability independently of test results. Test status: orange means it has not passed and green means it passed. Use Tab and Shift+Tab to move between fields and buttons.'),
						() => focused.focus(), AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
		this._register(toDisposable(() => { this.modelLoadVersion++; this.apiLoadVersion++; }));
	}

	public getNodes(query?: SettingsSearchQuery): readonly SettingsTreeNode<SettingsContentItem>[] {
		const item = (id: string, title: string, description: string, domNode: HTMLElement, keywords?: readonly string[]): SettingsTreeNode<SettingsContentItem> => ({
			element: { kind: 'item', id, title, description, keywords, value: { domNode } },
		});
		const seenProviders = new Set<string>();
		const modelQuery = new SettingsSearchQuery(this.modelSearch.value);
		const models = this.modelElements.filter(({ entry }) => {
			const first = !seenProviders.has(entry.model.provider);
			seenProviders.add(entry.model.provider);
			return modelQuery.matches({ title: entry.displayName, description: '', keywords: [`${entry.model.provider}/${entry.model.model}`] })
				&& (this.expanded || !modelQuery.isEmpty || (query && !query.isEmpty) || first);
		});
		// Keep the catalog order as the baseline so disabling restores the model's place.
		models.sort((left, right) => Number(this.languageModels.isModelVisible(right.entry.model)) - Number(this.languageModels.isModelVisible(left.entry.model)));
		const modelNodes = models.map(({ entry, row }) => item(`models.catalog.${entry.model.provider}/${entry.model.model}`, entry.displayName, '', row, [`${entry.model.provider}/${entry.model.model}`]));
		if (models.length && this.modelElements.length > seenProviders.size && modelQuery.isEmpty && (!query || query.isEmpty)) modelNodes.push(item('models.catalog.expand', localize('models.catalog.viewAll', 'viewall models'), '', this.expandRow));
		if (this.modelElements.length && !models.length) modelNodes.push(item('models.catalog.noMatches', this.modelSearchEmpty.textContent!, '', this.modelSearchEmpty));
		const customNodes = [...this.customProviders].reverse().map(([id, card]) => item(`models.providers.${id}`, card.title, card.domNode.textContent ?? '', card.domNode));
		const providerNodes = this.apiElements.map(({ provider, row }) => item(`models.providers.${provider.connection}`, provider.displayName, provider.provider, row, ['API key']));
		return [
			{
				element: { kind: 'group', id: 'models.catalog', title: localize('sessions.settings.chatModels', 'Chat models'), titleDomNode: this.modelTitle, description: '' },
				children: this.modelElements.length ? modelNodes : [item('models.catalog.status', localize('sessions.settings.chatModels', 'Chat models'), this.modelsStatus.textContent ?? '', this.modelsStatus)],
			},
			{
				element: { kind: 'group', id: `${this.categoryId}.providers`, title: localize('models.keys.title', 'API key'), titleDomNode: this.providerTitle, description: '' },
				children: [
					...(this.storageStatus.hidden ? [] : [item('models.credentials.storage', localize('models.keys.title', 'API key'), this.storageMessage.textContent ?? '', this.storageStatus)]),
					...customNodes,
					...(this.apiElements.length ? providerNodes : [item(`${this.categoryId}.providers.status`, localize('models.keys.title', 'API key'), this.providersStatus.textContent ?? '', this.providersStatus)]),
				],
			},
			item(`${this.categoryId}.status`, localize('sessions.settings.models', 'Models'), this.status.textContent ?? '', this.status),
		];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (!visible) {
			this.modelLoadVersion++;
			this.apiLoadVersion++;
			return;
		}
		this.modelsStatus.textContent = localize('sessions.settings.modelsLoading', 'Loading models…');
		this.providersStatus.textContent = localize('sessions.settings.apiLoading', 'Loading API keys…');
		this.changed.fire();
		void this.loadModels(++this.modelLoadVersion);
		void this.loadApiConnections(++this.apiLoadVersion);
	}

	private async loadModels(version: number): Promise<void> {
		try {
			const catalog = await this.languageModels.listModelCatalog();
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
		} catch (error) {
			if (version !== this.modelLoadVersion || this.isDisposed) return;
			if (error instanceof SecretStorageError) {
				this.updateStorageStatus(error.status);
				this.modelsStatus.textContent = '';
				this.changed.fire();
				return;
			}
			this.modelElements = [];
			for (const [id] of this.rows) this.rows.deleteAndDispose(id);
			this.modelsStatus.textContent = localize('sessions.settings.modelsLoadFailed', 'Could not load models.');
			this.notifications.error(this.modelsStatus.textContent);
		}
		this.changed.fire();
	}

	private async loadApiConnections(version: number): Promise<void> {
		const storageFocused = this.document.activeElement;
		const restoreStorageFocus = this.storageStatus.contains(storageFocused);
		this.storageRetry.enabled = false;
		try {
			const storage = await this.secretStorage.readState();
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			this.storageMode = storage.mode;
			this.updateStorageStatus(storage.status);
			if (storage.status !== 'available') {
				this.providersStatus.textContent = '';
				this.changed.fire();
				return;
			}
			const [catalog, custom] = await Promise.all([this.languageModels.listModelProviders(), this.languageModels.listCustomModelProviders()]);
			const providers = catalog.filter(provider => provider.apiKeyPolicy !== 'unsupported' && provider.connection !== 'openai-compatible' && !provider.connection.startsWith('custom-'));
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			for (const provider of [...custom].sort((left, right) => left.order - right.order)) {
				const configured = catalog.some(entry => entry.connection === provider.id && entry.apiKeyConfigured);
				const existing = this.customProviders.get(provider.id);
				if (existing) {
					existing.updateKeyConfigured(configured);
				} else {
					const card = this.instantiation.createInstance(ChatModelsWidget, this.document, provider, configured, false);
					this.customProviders.set(provider.id, card);
					void card.initialize();
				}
			}
			const previous = new Map(this.apiElements.map(item => [item.provider.connection, item]));
			const ids = new Set(providers.map(provider => provider.connection));
			for (const [id] of this.apiRows) {
				if (!ids.has(id)) this.apiRows.deleteAndDispose(id);
			}
			this.apiElements = providers.map(provider => {
				const existing = previous.get(provider.connection);
				if (existing) {
					existing.row.querySelector('h5')!.textContent = provider.displayName;
					existing.key.updateConfigured(provider.apiKeyConfigured);
					return { provider, row: existing.row, key: existing.key };
				}
				const resources = new DisposableStore();
				this.apiRows.set(provider.connection, resources);
				return { provider, ...this.apiConnectionRow(provider, resources) };
			});
			this.providersStatus.textContent = localize('sessions.settings.noApiConnections', 'No API key providers available.');
		} catch (error) {
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			if (error instanceof SecretStorageError) {
				this.updateStorageStatus(error.status);
				this.providersStatus.textContent = '';
				this.changed.fire();
				return;
			}
			this.apiElements = [];
			for (const [id] of this.apiRows) this.apiRows.deleteAndDispose(id);
			this.providersStatus.textContent = localize('sessions.settings.apiLoadFailed', 'Could not load API keys.');
			this.notifications.error(this.providersStatus.textContent);
		} finally {
			if (version === this.apiLoadVersion && !this.isDisposed) {
				this.storageRetry.enabled = true;
				this.changed.fire();
				if (restoreStorageFocus && !this.storageStatus.hidden) {
					if (isHTMLElement(storageFocused) && !storageFocused.hidden) storageFocused.focus();
					else if (!this.storageModeButton.domNode.hidden) this.storageModeButton.focus();
					else this.storageRetry.focus();
				}
			}
		}
		if (restoreStorageFocus && this.storageStatus.hidden) {
			if (this.apiElements.length) this.apiElements[0].key.input.focus();
			else if (this.customProviders.size) [...this.customProviders][0][1].focus();
			else this.modelSearch.focus();
		}
	}

	private updateStorageStatus(status: SecretStorageStatus): void {
		const available = status === 'available';
		this.storageAvailable = available;
		this.storageMessage.textContent = available ? this.storageMode === 'file'
			? localize('credentials.storage.file', 'Credentials are stored without encryption in private files protected by your account permissions.')
			: this.storageMode === 'encrypted' ? localize('credentials.storage.encrypted', 'Credentials are encrypted using a key in your system keyring.') : ''
			: secretStorageMessage(status);
		this.storageStatus.hidden = available && !this.storageMode;
		this.storageRetry.domNode.hidden = available;
		this.storageAuthorize.domNode.hidden = this.storageMode !== 'encrypted' || available;
		this.storageModeButton.domNode.hidden = !this.storageMode;
		this.storageModeButton.label = this.storageMode === 'file' ? localize('credentials.storage.useEncrypted', 'Use encrypted storage') : localize('credentials.storage.useFile', 'Use file storage');
		this.storageAuthorize.enabled = !this.storageBusy;
		this.storageModeButton.enabled = !this.storageBusy;
		for (const { key } of this.apiElements) key.setEnabled(available);
		for (const [, card] of this.customProviders) card.setCredentialStorageAvailable(available);
	}

	private async changeStorage(action: 'authorize' | 'mode'): Promise<void> {
		if (this.storageBusy || !this.storageMode) return;
		const focused = this.document.activeElement;
		const restoreFocus = this.storageStatus.contains(focused);
		this.storageBusy = true;
		this.storageAuthorize.enabled = this.storageModeButton.enabled = this.storageRetry.enabled = false;
		try {
			const mode = this.storageMode === 'file' ? 'encrypted' : 'file';
			if (action === 'mode' && mode === 'file') {
				const confirmation = await this.dialogs.confirm({
					message: localize('credentials.storage.fileConfirm', 'Store credentials without encryption?'),
					detail: localize('credentials.storage.fileDetail', 'Existing credentials will be migrated to private files. File permissions protect them from other accounts, but applications running as your account can read them. Encrypted credentials require their original key before they can be migrated.'),
					primaryButton: localize('credentials.storage.useFile', 'Use file storage'),
				});
				if (!confirmation.confirmed || this.isDisposed || !this.visible) return;
			}
			// Invalidate background observations before the explicit request. Only these actions
			// may request OS authorization; refreshes and ordinary credential operations stay silent.
			this.apiLoadVersion++;
			const state = action === 'authorize' ? await this.secretStorage.authorizeAccess() : await this.secretStorage.setStorageMode(mode);
			if (this.isDisposed) return;
			this.storageMode = state.mode;
			this.updateStorageStatus(state.status);
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.storageBusy = false;
			if (!this.isDisposed) {
				this.storageAuthorize.enabled = this.storageModeButton.enabled = this.storageRetry.enabled = true;
				this.changed.fire();
				if (this.visible) {
					// Disabling the focused button or hiding it after authorization moves focus to
					// the document. Restore a surviving control before the background refresh.
					if (restoreFocus && (this.document.activeElement === this.document.body || this.storageStatus.contains(this.document.activeElement))) {
						if (isHTMLElement(focused) && !focused.hidden) focused.focus();
						else this.storageModeButton.focus();
					}
					void this.loadApiConnections(++this.apiLoadVersion);
					void this.loadModels(++this.modelLoadVersion);
				}
			}
		}
	}

	private modelRow(entry: ModelCatalogEntry, resources: DisposableStore): HTMLElement {
		const row = h(this.document, 'div');
		row.className = 'ash-models-settings-model-row';
		const copy = h(this.document, 'span');
		copy.className = 'ash-models-settings-model-copy';
		const name = h(this.document, 'span');
		name.textContent = entry.displayName;
		copy.append(name);
		const toggle = resources.add(new Switch(row, {
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.displayName),
			checked: this.languageModels.isModelVisible(entry.model),
			content: copy,
			contentPlacement: 'before-control',
		}));
		resources.add(this.languageModels.onDidChangeModels(() => { toggle.checked = this.languageModels.isModelVisible(entry.model); }));
		resources.add(toggle.onDidChange(visible => {
			const hadFocus = row.contains(this.document.activeElement);
			toggle.busy = true;
			this.status.hidden = true;
			void this.languageModels.setModelVisible(entry.model, visible).catch(() => {
				this.reportStatus(localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.'), true);
			}).finally(() => {
				toggle.checked = this.languageModels.isModelVisible(entry.model);
				toggle.busy = false;
				// Saving disables the input and sorting can move its row. Restore keyboard
				// focus only if the user has not focused another control while saving.
				if (hadFocus && this.visible && row.isConnected && this.document.activeElement === this.document.body) {
					toggle.focus();
				}
			});
		}));
		return row;
	}

	private apiConnectionRow(provider: ModelProviderCredentialStatus, resources: DisposableStore): { readonly row: HTMLElement; readonly key: ProviderApiKeyInput; } {
		const row = h(this.document, 'div');
		row.className = 'ash-models-settings-api-row';
		const name = h(this.document, 'h5');
		name.textContent = provider.displayName;
		name.title = provider.displayName;
		const controls = h(this.document, 'div');
		controls.className = 'ash-models-settings-api-controls';
		const key = resources.add(this.instantiation.createInstance(ProviderApiKeyInput, controls, provider.connection, provider.displayName, provider.apiKeyConfigured, async () => { }));
		row.append(name, controls);
		return { row, key };
	}

	private reportStatus(message: string, isError: boolean): void {
		this.status.textContent = message;
		this.status.classList.toggle('is-error', isError);
		this.status.setAttribute('role', isError ? 'alert' : 'status');
		this.status.hidden = !message;
		if (isError) { this.notifications.error(message); }
	}
}
