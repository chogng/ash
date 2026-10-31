import { SettingsPageRenderer } from './settingsRenderers.js';
import {
	defaultButtonStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import './media/modelSettingsRenderer.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { ModelProviderSettingsRenderer, ProviderApiKeyInput } from './modelProviderSettingsRenderer.js';
import { SettingsSearchQuery } from './settingsSearch.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { type ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import { ChatModelsWidget } from '../../chat/browser/chatManagement/chatModelsWidget.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';
import { ISecretStorageStatusService, SecretStorageError, secretStorageStateMessage, type SecretStorageState, type SecretStorageMode } from '../../../../platform/secrets/common/secrets.js';

/** Model and credential rows shared by Workbench and Sessions; the host owns navigation and search. */
export class ModelSettingsRenderer extends SettingsPageRenderer<SettingsSectionReference> {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly reveal = this._register(new Emitter<void>());
	public override readonly onDidRequestReveal = this.reveal.event;
	private readonly document: Document;
	private readonly providersStatus: HTMLElement;
	private readonly storageStatus: HTMLElement;
	private readonly storageMessage: HTMLElement;
	private readonly storageRetry: Button;
	private readonly storageAuthorize: Button;
	private readonly storageModeButton: Button;
	private storageMode: SecretStorageMode | undefined;
	private storageAvailable = false;
	private storageBusy = false;
	private readonly apiRows = this._register(new DisposableMap<string, DisposableStore>());
	private apiElements: readonly { readonly provider: ModelProviderCredentialStatus; readonly row: HTMLElement; readonly key: ProviderApiKeyInput; }[] = [];
	private readonly providerTitle: HTMLElement;
	private readonly subscriptionTitle: HTMLElement;
	private readonly subscriptionStatus: HTMLElement;
	private readonly subscriptionRows = this._register(new DisposableMap<string, DisposableStore>());
	private subscriptionElements: readonly HTMLElement[] = [];
	private readonly modelsWidget: ChatModelsWidget;
	private catalogQuery = new SettingsSearchQuery('');
	private readonly customProviderSubscriptions = this._register(new DisposableMap<string, IDisposable>());
	private readonly addProvider: Button;
	private readonly customProviders = this._register(new DisposableMap<string, ModelProviderSettingsRenderer>());
	private visible = false;
	private apiLoadVersion = 0;
	public readonly categoryId = 'models';
	public override readonly sectionSearch = {
		search: (query: string): void => this.modelsWidget.search(query, { focus: false }),
		focus: (): void => this.modelsWidget.focusSearch(),
	};

	constructor(container: HTMLElement, @ILanguageModelsService private readonly languageModels: ILanguageModelsService, @ISecretStorageStatusService private readonly secretStorage: ISecretStorageStatusService, @IAccessibleViewService accessibleView: IAccessibleViewService, @IConfigurationService configuration: IConfigurationService, @IInstantiationService private readonly instantiation: IInstantiationService, @INotificationService private readonly notifications: INotificationService, @IDialogService private readonly dialogs: IDialogService, @ICommandService private readonly commands: ICommandService) {
		super();
		this.document = container.ownerDocument;
		this.modelsWidget = this._register(instantiation.createInstance(ChatModelsWidget, this.document, {
			matches: (entry: ModelCatalogEntry) => this.catalogQuery.matches({ title: entry.displayName, description: '', keywords: [`${entry.model.provider}/${entry.model.model}`] }),
			onStorageError: (error: SecretStorageError) => this.updateStorageStatus({ status: error.status }),
			onConfigure: (connection: string, model?: string) => this.configure(connection, model),
		}));
		this.modelsWidget.element.hidden = true;
		this._register(this.modelsWidget.onDidChangeItemCount(() => this.changed.fire()));
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
			...defaultButtonStyles,
			label: localize('credentials.storage.retry', 'Retry credential storage'),
			presentation: 'secondary',
		}));
		this._register(this.storageRetry.onDidClick(() => {
			void this.loadApiConnections(++this.apiLoadVersion);
			this.modelsWidget.render();
		}));
		this.storageAuthorize = this._register(new Button(this.storageStatus, {
			...defaultButtonStyles,
			label: localize('credentials.storage.authorize', 'Authorize system keyring'),
			presentation: 'secondary',
		}));
		this._register(this.storageAuthorize.onDidClick(() => void this.changeStorage('authorize')));
		this.storageModeButton = this._register(new Button(this.storageStatus, {
			...defaultButtonStyles,
			label: localize('credentials.storage.useFile', 'Use file storage'),
			presentation: 'secondary',
		}));
		this._register(this.storageModeButton.onDidClick(() => void this.changeStorage('mode')));
		this.providerTitle = h(this.document, 'span');
		this.providerTitle.className = 'ash-models-settings-provider-title';
		const title = h(this.document, 'span');
		title.textContent = localize('models.connections.api', 'API access');
		this.providerTitle.append(title);
		this.subscriptionTitle = h(this.document, 'span');
		this.subscriptionTitle.className = 'ash-models-settings-provider-title';
		const subscriptionsLabel = h(this.document, 'span');
		subscriptionsLabel.textContent = localize('models.connections.subscriptions', 'Subscription accounts');
		this.subscriptionTitle.append(subscriptionsLabel);
		this._register(new Button(this.subscriptionTitle, {
			...defaultButtonStyles,
			label: localize('models.connections.manageAccounts', 'Manage accounts'),
			presentation: 'secondary',
			onClick: () => { void this.manageAccounts(); },
		}));
		this.subscriptionStatus = h(this.document, 'p');
		this.subscriptionStatus.className = 'ash-models-settings-empty ash-models-settings-subscription-empty';
		this.subscriptionStatus.setAttribute('role', 'status');
		this.subscriptionStatus.textContent = localize('models.connections.loading', 'Loading subscription accounts…');
		this.addProvider = this._register(new Button(this.providerTitle, {
			...defaultButtonStyles,
			label: localize('models.provider.new', 'New provider'),
			presentation: 'secondary',
		}));
		this._register(this.addProvider.onDidClick(() => {
			const id = `custom-${createUuid()}`;
			const card = this.instantiation.createInstance(ModelProviderSettingsRenderer, this.document, { id, name: '', baseUrl: '', apiFormat: 'responses', order: Date.now(), models: [] }, false, true);
			this.trackProvider(id, card);
			card.setCredentialStorageAvailable(this.storageAvailable);
			void card.initialize();
			this.changed.fire();
			card.focus();
		}));
		this._register(this.languageModels.onDidChangeModels(() => {
			if (!this.visible) { return; }
			void this.loadApiConnections(++this.apiLoadVersion);
		}));
		const hint = (): void => {
			const message = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
			for (const node of [this.providerTitle, this.subscriptionTitle]) {
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
					const nodes = [this.providerTitle, this.subscriptionTitle, ...this.subscriptionElements, this.subscriptionStatus, this.storageStatus, ...this.apiElements.map(provider => provider.row), ...[...this.customProviders].map(([, card]) => card.domNode)];
					if (!nodes.some(node => node.contains(focused))) return undefined;
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatModelConfiguration, { type },
						() => type === AccessibleViewType.View ? [this.storageMessage.textContent, [...this.customProviders].map(([, card]) => card.getAccessibleContent()).join('\n\n')].filter(Boolean).join('\n\n') : localize('models.settings.help', 'The Model list card contains all models and their supported settings. Enabled models appear first; enabled and disabled models each keep the catalog order. The Subscription accounts card opens account management for sign-in and sign-out. The API access card manages keys and custom endpoints. Turning a model off restores its place among disabled models. Search models filters the full list by model name or ID. Clear the search to restore the list. API keys save when the field loses focus; clear the field to remove a key. Credential storage checks and retries are silent. If the system keyring is unavailable, credentials are stored only in memory until Ash exits. Authorizing the keyring saves the credentials entered during this run and restores persistent storage. Use Authorize system keyring to explicitly request system access. Use file storage migrates credentials to unencrypted private files after confirmation. Use encrypted storage migrates them back and may request system authorization. Missing original encryption keys block migration and preserve existing credentials. New provider adds a card with provider name, Base URL, API key and API format. Delete provider removes its configuration and saved API key after confirmation. Test models tests the current table, fetching the endpoint list first when empty. Refresh models fetches the list again. Use Add model for a missing ID or to declare its context window. Edit context and delete manual declarations from the row actions. Each Enabled switch controls picker availability independently of test results. Test status: orange means it has not passed and green means it passed. Use Tab and Shift+Tab to move between fields and buttons.'),
						() => focused.focus(), AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
		this._register(toDisposable(() => { this.apiLoadVersion++; }));
	}

	protected override buildNodes(query?: SettingsSearchQuery): readonly SettingsTreeNode<SettingsSectionReference>[] {
		const item = (id: string, title: string, description: string, domNode: HTMLElement, keywords?: readonly string[]): SettingsTreeNode<SettingsSectionReference> => ({
			element: { kind: 'item', id, title, description, keywords, value: this.retainElement(id, domNode) },
		});
		if (query && query.key !== this.catalogQuery.key) {
			this.catalogQuery = query;
			this.modelsWidget.render();
		}
		const customNodes = [...this.customProviders].reverse().map(([id, card]) => item(`models.providers.${id}`, card.title, card.domNode.textContent ?? '', card.domNode));
		const providerNodes = this.apiElements.map(({ provider, row }) => item(`models.providers.${provider.connection}`, provider.displayName, provider.provider, row, ['API key']));
		return [
			{
				element: { kind: 'group', id: 'models.catalog', title: localize('models.catalog.listTitle', 'Model list'), description: '' },
				// The widget has already matched names and IDs; retain those matches in the outer Settings search.
				children: [item('models.catalog.widget', localize('sessions.settings.chatModels', 'Chat models'), this.modelsWidget.element.textContent ?? '', this.modelsWidget.element, this.modelsWidget.hasResults ? [this.catalogQuery.text] : undefined)],
			},
			{
				element: { kind: 'group', id: 'models.subscriptions', title: localize('models.connections.subscriptions', 'Subscription accounts'), header: this.retainElement('models.subscriptions.heading', this.subscriptionTitle), description: '' },
				children: this.subscriptionElements.length
					? this.subscriptionElements.map(row => item(`models.subscriptions.${row.dataset.connection}`, row.textContent ?? '', '', row))
					: [item('models.subscriptions.status', localize('models.connections.subscriptions', 'Subscription accounts'), this.subscriptionStatus.textContent ?? '', this.subscriptionStatus)],
			},
			{
				element: { kind: 'group', id: `${this.categoryId}.providers`, title: localize('models.connections.api', 'API access'), header: this.retainElement(`${this.categoryId}.providers` + '.heading', this.providerTitle), description: '' },
				children: [
					...(this.storageStatus.hidden ? [] : [item('models.credentials.storage', localize('models.keys.title', 'API key'), this.storageMessage.textContent ?? '', this.storageStatus)]),
					...customNodes,
					...(this.apiElements.length ? providerNodes : [item(`${this.categoryId}.providers.status`, localize('models.keys.title', 'API key'), this.providersStatus.textContent ?? '', this.providersStatus)]),
				],
			},
		];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.modelsWidget.element.hidden = !visible;
		if (!visible) {
			this.apiLoadVersion++;
			return;
		}
		this.providersStatus.textContent = localize('sessions.settings.apiLoading', 'Loading API keys…');
		this.changed.fire();
		this.modelsWidget.render();
		void this.loadApiConnections(++this.apiLoadVersion);
	}

	private trackProvider(id: string, card: ModelProviderSettingsRenderer): void {
		this.customProviders.set(id, card);
		this.customProviderSubscriptions.set(id, card.onDidDelete(() => this.forgetProvider(id)));
	}

	private async configure(connection: string, model?: string): Promise<void> {
		this.reveal.fire();
		await this.loadApiConnections(++this.apiLoadVersion);
		if (this.isDisposed || !this.visible) { return; }
		const card = this.customProviders.get(connection);
		if (card) {
			await card.initialize();
			if (this.isDisposed || !this.visible) { return; }
			card.domNode.scrollIntoView({ block: 'nearest' });
			if (model) { card.focusModel(model); }
			else { card.focus(); }
			return;
		}
		const key = this.apiElements.find(entry => entry.provider.connection === connection)?.key;
		if (key) { key.input.focus(); return; }
		await this.commands.executeCommand('workbench.action.manageAccounts');
	}

	private async manageAccounts(): Promise<void> {
		try { await this.commands.executeCommand('workbench.action.manageAccounts'); }
		catch { if (!this.isDisposed) { this.notifications.error(localize('models.connections.manageFailed', 'Could not open account management.')); } }
	}

	private updateSubscriptions(providers: readonly ModelProviderCredentialStatus[]): void {
		const subscriptions = providers.filter(provider => provider.access === 'subscription' && provider.configured);
		const previous = new Map(this.subscriptionElements.map(row => [row.dataset.connection!, row]));
		const ids = new Set(subscriptions.map(provider => provider.connection));
		for (const [id] of this.subscriptionRows) { if (!ids.has(id)) { this.subscriptionRows.deleteAndDispose(id); } }
		this.subscriptionElements = subscriptions.map(provider => {
			let row = previous.get(provider.connection);
			if (!row) {
				const lifetime = new DisposableStore();
				this.subscriptionRows.set(provider.connection, lifetime);
				row = h(this.document, 'div');
				row.className = 'ash-models-settings-subscription-row';
				row.dataset.connection = provider.connection;
				row.append(h(this.document, 'span'), h(this.document, 'span'));
				lifetime.add(toDisposable(() => row!.remove()));
			}
			row.children[0].textContent = provider.displayName;
			row.children[1].textContent = provider.configured
				? localize('models.connections.connected', 'Account connected')
				: localize('models.connections.signInRequired', 'Sign in required');
			return row;
		});
		this.subscriptionStatus.textContent = localize('models.connections.none', 'No subscription accounts connected.');
	}

	private forgetProvider(id: string): void {
		const card = this.customProviders.get(id);
		const focused = card?.isDeleting || card?.domNode.contains(this.document.activeElement);
		this.customProviderSubscriptions.deleteAndDispose(id);
		this.customProviders.deleteAndDispose(id);
		this.changed.fire();
		if (focused && this.visible) { this.addProvider.focus(); }
	}

	private async loadApiConnections(version: number): Promise<void> {
		const storageFocused = this.document.activeElement;
		const restoreStorageFocus = this.storageStatus.contains(storageFocused);
		this.storageRetry.enabled = false;
		try {
			const catalog = await this.languageModels.listModelProviders();
			if (version !== this.apiLoadVersion || this.isDisposed) { return; }
			this.updateSubscriptions(catalog);
			const storage = await this.secretStorage.readState();
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			this.storageMode = storage.mode;
			this.updateStorageStatus(storage);
			if (!this.storageAvailable) {
				this.providersStatus.textContent = '';
				this.changed.fire();
				return;
			}
			const custom = await this.languageModels.listCustomModelProviders();
			const providers = catalog.filter(provider => provider.access !== 'subscription' && provider.apiKeyPolicy !== 'unsupported' && provider.connection !== 'openai-compatible' && !provider.connection.startsWith('custom-'));
			if (version !== this.apiLoadVersion || this.isDisposed) return;
			const customIds = new Set(custom.map(provider => provider.id));
			for (const [id, card] of this.customProviders) {
				if (!customIds.has(id) && !card.isDraft) { this.forgetProvider(id); }
			}
			for (const provider of [...custom].sort((left, right) => left.order - right.order)) {
				const configured = catalog.some(entry => entry.connection === provider.id && entry.apiKeyConfigured);
				const existing = this.customProviders.get(provider.id);
				if (existing) {
					existing.updateKeyConfigured(configured);
				} else {
					const card = this.instantiation.createInstance(ModelProviderSettingsRenderer, this.document, provider, configured, false);
					this.trackProvider(provider.id, card);
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
				this.updateStorageStatus({ status: error.status });
				this.providersStatus.textContent = '';
				this.changed.fire();
				return;
			}
			this.apiElements = [];
			for (const [id] of this.apiRows) this.apiRows.deleteAndDispose(id);
			this.subscriptionStatus.textContent = localize('models.connections.loadFailed', 'Could not load subscription accounts.');
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
			else this.modelsWidget.focusSearch();
		}
	}

	private updateStorageStatus(state: SecretStorageState): void {
		const available = state.status === 'available' || state.storageType === 'in-memory';
		const persisted = state.status === 'available' && state.storageType !== 'in-memory';
		this.storageAvailable = available;
		this.storageMessage.textContent = persisted ? this.storageMode === 'file'
			? localize('credentials.storage.file', 'Credentials are stored without encryption in private files protected by your account permissions.')
			: this.storageMode === 'encrypted' ? localize('credentials.storage.encrypted', 'Credentials are encrypted using a key in your system keyring.') : ''
			: secretStorageStateMessage(state);
		this.storageStatus.hidden = persisted && !this.storageMode;
		this.storageRetry.domNode.hidden = persisted;
		this.storageAuthorize.domNode.hidden = this.storageMode !== 'encrypted' || persisted;
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
			this.updateStorageStatus(state);
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
					this.modelsWidget.render();
				}
			}
		}
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

}
