import './media/sessionsPreferences.css';
import '../../../../workbench/contrib/preferences/browser/media/settingsCard.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ContextView } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { CLOUD_DICTATION_MODEL, DEFAULT_LOCAL_DICTATION_MODEL, DictationConfiguration, XAI_DICTATION_MODEL } from '../../../../platform/dictation/common/dictationConfiguration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import type { IChatService, ModelProviderCredentialStatus } from '../../../../workbench/services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import '../../../../workbench/contrib/preferences/common/settingsEditorColorRegistry.js';
import { SettingsRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import type { SettingWidgetOptions } from '../../../../workbench/contrib/preferences/browser/settingsWidgets.js';
import type { ISetting } from '../../../../workbench/services/preferences/common/preferences.js';
import { DefaultSettings } from '../../../../workbench/services/preferences/common/settingsModels.js';
import { SessionsConfiguration } from '../../../common/configuration.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Sessions Settings accessibility verbosity must be boolean');
		return value;
	},
});

function configuration<T>(key: string): IRegisteredConfiguration<T> {
	const registered = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key);
	if (!registered) throw new Error(`Sessions setting '${key}' is not registered`);
	return registered as IRegisteredConfiguration<T>;
}

interface SettingsCategory {
	readonly title: string;
	readonly icon: Icon;
	readonly settings: readonly ISetting[];
	readonly models?: boolean;
}

interface SettingsSection {
	readonly title: string;
	readonly categories: readonly SettingsCategory[];
}

/** Sessions owns its settings page while reusing the Workbench setting widgets. */
export class SessionsPreferences extends Disposable {
	private readonly activeDialog = this._register(new MutableDisposable<DisposableStore>());
	private dialog: Dialog | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly configurationService: IConfigurationService,
		private readonly clipboardService: IClipboardService,
		private readonly contextMenuProvider: IContextMenuProvider,
		private readonly contextKeys: IContextKeyService,
		private readonly accessibleView: IAccessibleViewService,
		private readonly chatService: IChatService,
	) {
		super();
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 100,
			name: 'sessionsSettingsHelp',
			when: ContextKeyExpr.has('sessionsSettingsFocused'),
			getProvider: () => {
				const focused = this.container.ownerDocument.activeElement as HTMLElement;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsSettings,
					{ type: AccessibleViewType.Help },
					() => localize('sessions.settings.help', 'Sessions Settings has categories on the left and settings on the right. Models contains chat models, voice input settings, and API connections. Search models and APIs filters these sections. Use Tab and Shift+Tab to move between controls, arrow keys to choose menu values, and Space to toggle switches. Press Escape to close Settings.'),
					() => focused.focus(),
					AccessibilityVerbositySettingId.SessionsSettings,
				);
			},
		}));
	}

	public async open(): Promise<void> {
		if (this.dialog?.element.open) {
			this.dialog.element.focus();
			return;
		}
		const ownerDocument = this.container.ownerDocument;
		const content = h(ownerDocument, 'div');
		content.className = 'ash-sessions-settings';
		const sidebar = h(ownerDocument, 'aside');
		sidebar.className = 'ash-sessions-settings-sidebar';
		const search = h(ownerDocument, 'div');
		search.className = 'ash-sessions-settings-search';
		search.setAttribute('role', 'search');
		appendIcon(Lxicon.search, search);
		const navigation = h(ownerDocument, 'nav');
		navigation.className = 'ash-sessions-settings-navigation';
		navigation.setAttribute('aria-label', localize('sessions.settings.categories', 'Settings categories'));
		const navigationContent = h(ownerDocument, 'div');
		navigationContent.className = 'ash-sessions-settings-navigation-content';
		sidebar.append(search, navigation);
		const page = h(ownerDocument, 'section');
		page.className = 'ash-sessions-settings-page';
		const pageContent = h(ownerDocument, 'div');
		pageContent.className = 'ash-sessions-settings-page-content';
		const heading = h(ownerDocument, 'h3');
		heading.className = 'ash-sessions-settings-page-title';
		heading.id = 'ash-sessions-settings-page-title';
		page.setAttribute('aria-labelledby', heading.id);
		const modelSearch = h(ownerDocument, 'div');
		modelSearch.className = 'ash-sessions-settings-model-search';
		modelSearch.setAttribute('role', 'search');
		modelSearch.hidden = true;
		appendIcon(Lxicon.search, modelSearch);
		const list = h(ownerDocument, 'div');
		list.className = 'ash-sessions-settings-list ash-settings-card';
		const chatModelsHeading = h(ownerDocument, 'h4');
		chatModelsHeading.className = 'ash-sessions-settings-section-title';
		chatModelsHeading.textContent = localize('sessions.settings.chatModels', 'Chat models');
		chatModelsHeading.hidden = true;
		const voiceGroup = h(ownerDocument, 'section');
		voiceGroup.className = 'ash-sessions-settings-model-group';
		voiceGroup.hidden = true;
		const voiceHeading = h(ownerDocument, 'h4');
		voiceHeading.className = 'ash-sessions-settings-section-title';
		voiceHeading.textContent = localize('sessions.settings.voiceModels', 'Voice input');
		const voiceList = h(ownerDocument, 'div');
		voiceList.className = 'ash-sessions-settings-voice-list ash-settings-card';
		const cloudModels = h(ownerDocument, 'p');
		cloudModels.className = 'ash-sessions-settings-cloud-models';
		cloudModels.textContent = localize('sessions.settings.cloudVoiceModels', 'Cloud models: OpenAI {0} · xAI {1}', CLOUD_DICTATION_MODEL, XAI_DICTATION_MODEL);
		voiceGroup.append(voiceHeading, voiceList, cloudModels);
		const apiGroup = h(ownerDocument, 'section');
		apiGroup.className = 'ash-sessions-settings-model-group';
		apiGroup.hidden = true;
		const apiHeading = h(ownerDocument, 'h4');
		apiHeading.className = 'ash-sessions-settings-section-title';
		apiHeading.textContent = localize('sessions.settings.apiConnections', 'API connections');
		const apiList = h(ownerDocument, 'div');
		apiList.className = 'ash-sessions-settings-api-list ash-settings-card';
		const apiEmpty = h(ownerDocument, 'p');
		apiEmpty.className = 'ash-sessions-settings-empty';
		apiEmpty.setAttribute('role', 'status');
		apiGroup.append(apiHeading, apiList, apiEmpty);
		const empty = h(ownerDocument, 'p');
		empty.className = 'ash-sessions-settings-empty';
		empty.setAttribute('role', 'status');
		empty.textContent = localize('sessions.settings.noResults', 'No settings found.');
		const status = h(ownerDocument, 'p');
		status.className = 'ash-sessions-settings-status';
		status.setAttribute('role', 'status');
		status.hidden = true;
		pageContent.append(heading, modelSearch, chatModelsHeading, list, empty, voiceGroup, apiGroup, status);
		content.append(sidebar, page);
		const resources = new DisposableStore();
		const navigationScrollable = resources.add(new ScrollableElement(navigation, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
			wheel: { consume: 'when-scrolling' },
		}));
		navigationScrollable.element.classList.add('ash-sessions-settings-navigation-scrollable');
		navigationScrollable.append(navigationContent);
		const pageScrollable = resources.add(new ScrollableElement(page, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
			wheel: { consume: 'when-scrolling' },
		}));
		pageScrollable.element.classList.add('ash-sessions-settings-page-scrollable');
		pageScrollable.append(pageContent);
		const searchInput = resources.add(new InputBox(search, {
			type: 'search',
			presentation: 'field',
			placeholder: localize('sessions.settings.search', 'Search settings'),
			ariaLabel: localize('sessions.settings.search', 'Search settings'),
		}));
		const modelSearchInput = resources.add(new InputBox(modelSearch, {
			type: 'search',
			presentation: 'field',
			placeholder: localize('sessions.settings.searchModels', 'Search models and APIs'),
			ariaLabel: localize('sessions.settings.searchModels', 'Search models and APIs'),
		}));
		const dialog = resources.add(new Dialog(this.container, {
			title: localize('sessions.settings.title', 'Sessions Settings'),
			content,
		}));
		resources.add(addDisposableListener(dialog.element, 'click', event => {
			if (event.target === dialog.element) dialog.close();
		}));
		const contextView = resources.add(new ContextView(dialog.element));
		const settingOptions: SettingWidgetOptions = {
			clipboardService: this.clipboardService,
			configurationService: this.configurationService,
			contextMenuProvider: this.contextMenuProvider,
			contextViewProvider: contextView,
			onStatus: (message, isError) => {
				status.textContent = message;
				status.classList.toggle('is-error', isError);
				status.setAttribute('role', isError ? 'alert' : 'status');
				status.hidden = !message;
			},
		};
		const renderer = resources.add(new SettingsRenderer(list, settingOptions));
		const voiceRenderer = resources.add(new SettingsRenderer(voiceList, settingOptions));
		const modelRows = resources.add(new MutableDisposable<DisposableStore>());
		const apiRows = resources.add(new MutableDisposable<DisposableStore>());
		const { sections, voiceSettings } = this.sections();
		const categories = sections.flatMap(section => section.categories);
		let activeCategory = 0;
		let renderVersion = 0;
		let renderedCatalog: readonly ModelCatalogEntry[] | undefined;
		let renderedRows: readonly { readonly entry: ModelCatalogEntry; readonly row: HTMLElement }[] = [];
		let renderedApiRows: readonly { readonly provider: ModelProviderCredentialStatus; readonly row: HTMLElement }[] = [];
		const voiceSearchText = `${voiceHeading.textContent} ${voiceSettings.map(setting => `${setting.title} ${setting.description}`).join(' ')} ${DEFAULT_LOCAL_DICTATION_MODEL} ${CLOUD_DICTATION_MODEL} ${XAI_DICTATION_MODEL} OpenAI xAI`.toLowerCase();
		const filterModels = (): void => {
			if (searchInput.value || !categories[activeCategory].models) return;
			const query = modelSearchInput.value.trim().toLowerCase();
			let chatMatches = 0;
			for (const { entry, row } of renderedRows) {
				const searchText = `${entry.displayName} ${entry.model.provider}/${entry.model.model}`.toLowerCase();
				row.hidden = !searchText.includes(query);
				if (!row.hidden) chatMatches++;
			}
			const voiceMatches = !query || voiceSearchText.includes(query);
			let apiMatches = 0;
			for (const { provider, row } of renderedApiRows) {
				row.hidden = !`${apiHeading.textContent} ${provider.displayName} ${provider.provider} ${provider.connection}`.toLowerCase().includes(query);
				if (!row.hidden) apiMatches++;
			}
			chatModelsHeading.hidden = !!query && chatMatches === 0;
			list.hidden = chatMatches === 0;
			voiceGroup.hidden = !voiceMatches;
			apiGroup.hidden = !!query && apiMatches === 0;
			if (!renderedCatalog) return;
			empty.textContent = renderedCatalog.length === 0 && !query
				? localize('sessions.settings.noModels', 'No models available.')
				: localize('sessions.settings.noMatchingModels', 'No matching models or APIs.');
			empty.hidden = query ? chatMatches > 0 || voiceMatches || apiMatches > 0 : chatMatches > 0;
		};
		const renderModels = async (version: number): Promise<void> => {
			try {
				const catalog = await this.chatService.listModelCatalog();
				if (version !== renderVersion) return;
				renderedCatalog = catalog;
				const rowResources = new DisposableStore();
				const rows = catalog.map(entry => ({ entry, row: this.modelRow(list, entry, rowResources, status) }));
				modelRows.value = rowResources;
				renderedRows = rows;
				list.replaceChildren(...rows.map(({ row }) => row));
				filterModels();
			} catch {
				if (version !== renderVersion) return;
				list.hidden = true;
				empty.textContent = localize('sessions.settings.modelsLoadFailed', 'Could not load models.');
				empty.hidden = false;
			}
		};
		const renderApiConnections = async (version: number): Promise<void> => {
			try {
				const providers = (await this.chatService.listModelProviders()).filter(provider => provider.apiKeyPolicy !== 'unsupported');
				if (version !== renderVersion) return;
				const rowResources = new DisposableStore();
				const rows = providers.map(provider => ({ provider, row: this.apiConnectionRow(apiList, provider, rowResources) }));
				apiRows.value = rowResources;
				renderedApiRows = rows;
				apiList.replaceChildren(...rows.map(({ row }) => row));
				apiList.hidden = rows.length === 0;
				apiEmpty.textContent = localize('sessions.settings.noApiConnections', 'No API connections available.');
				apiEmpty.hidden = rows.length !== 0;
				filterModels();
			} catch {
				if (version !== renderVersion) return;
				apiList.hidden = true;
				apiEmpty.textContent = localize('sessions.settings.apiLoadFailed', 'Could not load API connections.');
				apiEmpty.hidden = false;
			}
		};
		const buttons: Button[] = [];
		for (const section of sections) {
			const group = h(ownerDocument, 'div');
			group.className = 'ash-sessions-settings-navigation-group';
			group.setAttribute('role', 'group');
			group.setAttribute('aria-label', section.title);
			const label = h(ownerDocument, 'p');
			label.className = 'ash-sessions-settings-navigation-label';
			label.textContent = section.title;
			group.append(label);
			navigationContent.append(group);
			for (const category of section.categories) {
				const index = buttons.length;
				const button = resources.add(new Button(group, {
					label: category.title,
					icon: category.icon,
					presentation: 'quiet',
					onClick: () => {
						activeCategory = index;
						if (searchInput.value) searchInput.value = '';
						else render();
					},
				}));
				button.domNode.classList.add('ash-sessions-settings-navigation-item');
				buttons.push(button);
			}
		}
		const render = (): void => {
			const version = ++renderVersion;
			const query = new SettingsSearchQuery(searchInput.value);
			const isModels = query.isEmpty && categories[activeCategory].models;
			const visible = query.isEmpty ? categories[activeCategory].settings : categories.flatMap(category => category.settings).filter(setting => query.matches(setting));
			heading.textContent = query.isEmpty ? categories[activeCategory].title : localize('sessions.settings.results', 'Search results');
			heading.hidden = query.isEmpty && visible.length === 0 && !isModels;
			modelSearch.hidden = !isModels;
			chatModelsHeading.hidden = !isModels;
			voiceGroup.hidden = !isModels;
			apiGroup.hidden = !isModels;
			modelRows.clear();
			apiRows.clear();
			if (!isModels) {
				renderedCatalog = undefined;
				renderedRows = [];
				renderedApiRows = [];
			}
			list.replaceChildren(...visible.map(setting => renderer.render(setting)));
			pageScrollable.scrollTo(0, 0);
			list.hidden = visible.length === 0 && !isModels;
			empty.textContent = localize('sessions.settings.noResults', 'No settings found.');
			empty.hidden = query.isEmpty || visible.length !== 0;
			if (isModels) {
				empty.textContent = localize('sessions.settings.modelsLoading', 'Loading models…');
				empty.hidden = false;
				voiceList.replaceChildren(...voiceSettings.map(setting => voiceRenderer.render(setting)));
				apiList.replaceChildren();
				apiList.hidden = true;
				apiEmpty.textContent = localize('sessions.settings.apiLoading', 'Loading API connections…');
				apiEmpty.hidden = false;
				filterModels();
				void renderModels(version);
				void renderApiConnections(version);
			}
			for (const [index, button] of buttons.entries()) {
				const isCurrent = query.isEmpty && index === activeCategory;
				button.toggleClassName('is-current', isCurrent);
				if (isCurrent) button.domNode.setAttribute('aria-current', 'page');
				else button.domNode.removeAttribute('aria-current');
			}
		};
		resources.add(this.chatService.onDidChangeModels(() => {
			if (searchInput.value || !categories[activeCategory].models) return;
			void this.chatService.listModelCatalog().then(catalog => {
				if (catalog !== renderedCatalog) void renderModels(++renderVersion);
			});
		}));
		resources.add(searchInput.onDidChange(render));
		resources.add(modelSearchInput.onDidChange(filterModels));
		render();
		dialog.element.classList.add('ash-sessions-settings-dialog');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsSettings);
		if (hint) dialog.element.setAttribute('aria-description', hint);
		const scope = resources.add(this.contextKeys.createScoped(dialog.element));
		scope.createKey('sessionsSettingsFocused', true);
		this.dialog = dialog;
		this.activeDialog.value = resources;
		try {
			await dialog.show();
		} finally {
			renderVersion++;
			this.dialog = undefined;
			this.activeDialog.clear();
		}
	}

	private modelRow(container: HTMLElement, entry: ModelCatalogEntry, resources: DisposableStore, status: HTMLElement): HTMLElement {
		const row = h(container.ownerDocument, 'div');
		row.className = 'ash-sessions-settings-model-row';
		const copy = h(container.ownerDocument, 'span');
		copy.className = 'ash-sessions-settings-model-copy';
		const title = h(container.ownerDocument, 'span');
		title.className = 'ash-sessions-settings-model-name';
		title.textContent = entry.displayName;
		const description = h(container.ownerDocument, 'span');
		description.className = 'ash-sessions-settings-model-description';
		description.textContent = `${entry.model.provider}/${entry.model.model}`;
		copy.append(title, description);
		const toggle = resources.add(new Switch(row, {
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.displayName),
			checked: this.chatService.isModelVisible(entry.model),
			content: copy,
			contentPlacement: 'before-control',
		}));
		resources.add(this.chatService.onDidChangeModels(() => { toggle.checked = this.chatService.isModelVisible(entry.model); }));
		resources.add(toggle.onDidChange(visible => {
			toggle.busy = true;
			status.hidden = true;
			void this.chatService.setModelVisible(entry.model, visible).catch(() => {
				status.textContent = localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.');
				status.setAttribute('role', 'alert');
				status.hidden = false;
			}).finally(() => {
				toggle.checked = this.chatService.isModelVisible(entry.model);
				toggle.busy = false;
			});
		}));
		return row;
	}

	private apiConnectionRow(container: HTMLElement, provider: ModelProviderCredentialStatus, resources: DisposableStore): HTMLElement {
		const row = h(container.ownerDocument, 'div');
		row.className = 'ash-sessions-settings-api-row';
		const name = h(container.ownerDocument, 'h5');
		name.className = 'ash-sessions-settings-api-name';
		name.textContent = provider.displayName;
		const details = h(container.ownerDocument, 'p');
		details.className = 'ash-sessions-settings-api-details';
		details.textContent = provider.connection;
		const keyStatus = h(container.ownerDocument, 'p');
		keyStatus.className = 'ash-sessions-settings-api-status';
		keyStatus.textContent = provider.apiKeyConfigured
			? localize('chat.providerKeys.configured', 'API key saved')
			: provider.apiKeyPolicy === 'required'
				? localize('chat.providerKeys.missing', 'API key required')
				: localize('chat.providerKeys.optional', 'No API key saved');
		const controls = h(container.ownerDocument, 'div');
		controls.className = 'ash-sessions-settings-api-controls';
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
		const feedback = h(container.ownerDocument, 'p');
		feedback.className = 'ash-sessions-settings-api-feedback';
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

	private sections(): { readonly sections: readonly SettingsSection[]; readonly voiceSettings: readonly ISetting[] } {
		const appearanceSettings: readonly ISetting[] = [{
			id: SessionsConfiguration.layoutStyle,
			valueType: 'select',
			configuration: configuration<string | boolean>(SessionsConfiguration.layoutStyle),
			title: localize('sessions.layoutStyle.title', 'Layout style'),
			description: localize('sessions.layoutStyle.description', 'Choose an inset frame (Modern) or edge-to-edge regions (Flat).'),
			options: [
				{ value: 'modern', label: localize('sessions.layoutStyle.modern', 'Modern') },
				{ value: 'flat', label: localize('sessions.layoutStyle.flat', 'Flat') },
			],
		}, {
			id: SessionsConfiguration.activityBarLocation,
			valueType: 'select',
			configuration: configuration<string | boolean>(SessionsConfiguration.activityBarLocation),
			title: localize('sessions.activityBar.location.title', 'Activity Bar position'),
			description: localize('sessions.activityBar.location.description', 'Place the Activity Bar on the side, top, or bottom, or hide it.'),
			options: [
				{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
				{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
				{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
				{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
			],
		}, {
			id: SessionsConfiguration.activityBarCompact,
			valueType: 'boolean',
			configuration: configuration<boolean>(SessionsConfiguration.activityBarCompact),
			title: localize('sessions.activityBar.compact.title', 'Compact Activity Bar'),
				description: localize('sessions.activityBar.compact.description', 'Use smaller buttons when the Activity Bar is on the side.'),
		}];
		// Existing accessibility preferences live under General without changing their stored keys.
		const generalSettings: readonly ISetting[] = [{
			id: AccessibilityVerbositySettingId.SessionsActivityBar,
			valueType: 'boolean',
			configuration: configuration<boolean>(AccessibilityVerbositySettingId.SessionsActivityBar),
			title: localize('sessions.activity.verbosityTitle', 'Activity Bar accessibility help'),
			description: localize('sessions.activity.verbosityDescription', 'Announce how to open accessibility help when the Activity Bar receives focus.'),
		}, {
			id: AccessibilityVerbositySettingId.SessionsSettings,
			valueType: 'boolean',
			configuration: configuration<boolean>(AccessibilityVerbositySettingId.SessionsSettings),
			title: localize('sessions.settings.verbosityTitle', 'Settings accessibility help'),
			description: localize('sessions.settings.verbosityDescription', 'Announce how to open accessibility help when this page has focus.'),
		}];
		const registeredSettings = new DefaultSettings();
		const voiceSettings = [
			registeredSettings.get(DictationConfiguration.backend),
			registeredSettings.get(DictationConfiguration.cloudProvider),
			registeredSettings.get(DictationConfiguration.localModel),
		];
		return { voiceSettings, sections: [{
			title: localize('sessions.settings.section.basics', 'Basics'),
			categories: [
				{ title: localize('sessions.settings.general', 'General'), icon: Lxicon.settings, settings: generalSettings },
				{ title: localize('sessions.settings.account', 'Account'), icon: Lxicon.account, settings: [] },
				{ title: localize('sessions.settings.appearance', 'Appearance'), icon: Lxicon.appearance, settings: appearanceSettings },
				{ title: localize('sessions.settings.voice', 'Voice'), icon: Lxicon.mic, settings: voiceSettings },
				{ title: localize('sessions.settings.personalization', 'Personalization'), icon: Lxicon.briefcase, settings: [] },
			],
		}, {
			title: localize('sessions.settings.section.development', 'Development'),
			categories: [
				{ title: localize('sessions.settings.agents', 'Agents'), icon: Lxicon.agent, settings: [] },
				{ title: localize('sessions.settings.models', 'Models'), icon: Lxicon.model, settings: [], models: true },
				{ title: localize('sessions.settings.gitPrs', 'Git & PRs'), icon: Lxicon.git, settings: [] },
				{ title: localize('sessions.settings.worktree', 'Worktree'), icon: Lxicon.gitBranch, settings: [] },
				{ title: localize('sessions.settings.browser', 'Browser'), icon: Lxicon.browserWeb, settings: [] },
				{ title: localize('sessions.settings.tab', 'Tab'), icon: Lxicon.keyboardTab, settings: [] },
				{ title: localize('sessions.settings.codeIntelligence', 'Code Intelligence'), icon: Lxicon.code, settings: [] },
				{ title: localize('sessions.settings.environment', 'Environment'), icon: Lxicon.terminal, settings: [] },
			],
		}, {
			title: localize('sessions.settings.section.management', 'Management'),
			categories: [
				{ title: localize('sessions.settings.plugins', 'Plugins'), icon: Lxicon.extensions, settings: [] },
				{ title: localize('sessions.settings.shortcuts', 'Keyboard Shortcuts'), icon: Lxicon.command, settings: [] },
				{ title: localize('sessions.settings.archivedChats', 'Archived Chats'), icon: Lxicon.archive, settings: [] },
			],
		}] };
	}
}
