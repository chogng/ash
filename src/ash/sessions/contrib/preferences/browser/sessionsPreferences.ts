import { BrowserDownloadDirectorySetting, BrowserDownloadAskSetting } from '../../../../platform/browserView/common/browserDownloads.js';
import { BrowserOpenLinksSettingId, BrowserOpenLocalhostLinksSettingId } from '../../../../platform/browserView/common/browserView.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import { ExecutionSettingsModel } from './executionSettingsModel.js';
import { LspSettingsModel } from './lspSettingsModel.js';
import { GitHubSettingsModel } from '../../../../workbench/contrib/github/browser/githubSettingsModel.js';
import { TraceSettingsModel } from '../../../../workbench/contrib/trace/browser/traceSettingsModel.js';
import { SettingsSectionRenderer } from '../../../../workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import { trustedDomainsSetting } from '../../../../workbench/contrib/url/browser/trustedDomains.js';
import { ITrustedDomainService } from '../../../../workbench/contrib/url/common/trustedDomainService.js';
import { MEMORY_SETTINGS_CATEGORY, memorySettingsTitle } from '../../../../workbench/contrib/memories/browser/memorySettings.js';
import { MemorySettingsRenderer } from '../../../../workbench/contrib/preferences/browser/memorySettingsRenderer.js';
import { CodeConversationDefaultsEntry } from './codeConversationDefaultsEntry.js';
import { ChatConfiguration, ChatEditorConfiguration, ChatInputConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { PROMPT_TIMELINE_DISPLAY_SETTING } from '../../../../workbench/contrib/chat/common/promptTimeline.js';
import './media/sessionsPreferences.css';
import '../../../../workbench/services/extensions/browser/resourceEditorAccessibility.js';
import '../../../../workbench/contrib/preferences/browser/media/settingsCard.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { ContextView, type ContextViewOptions, type ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isNative } from '../../../../base/common/platform.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { ILocaleService, LocalizationConfiguration } from '../../../../workbench/services/localization/common/locale.js';
import { ILocalizationService } from '../../../../workbench/services/localization/common/localizationService.js';
import { displayLanguageSetting } from '../../../../workbench/contrib/preferences/browser/displayLanguageSetting.js';
import { STARTUP_WINDOW_SETTING } from '../../../../platform/window/common/window.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING } from '../../../../workbench/contrib/comments/common/commentsConfiguration.js';
import { TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { createSettingsEditorInput } from '../../../../workbench/services/preferences/common/settingsEditorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import '../../../../workbench/contrib/preferences/common/settingsEditorColorRegistry.js';
import { DefaultSettings } from '../../../../workbench/services/preferences/common/settingsModels.js';
import { SettingsRenderer, SettingsPageRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import type { SettingsSectionField } from '../../../../workbench/services/preferences/common/preferences.js';
import { getSettingsSections } from '../../../../workbench/services/preferences/browser/settingsSections.js';
import { ModelSettingsRenderer } from '../../../../workbench/contrib/preferences/browser/modelSettingsRenderer.js';
import { DictationSettingsRenderer } from '../../../../workbench/contrib/preferences/browser/dictationSettingsRenderer.js';
import { SettingsTree } from '../../../../workbench/contrib/preferences/browser/settingsTree.js';
import { SettingsLayout } from '../../../../workbench/contrib/preferences/browser/settingsLayout.js';
import { SettingsTreeModel, type SettingsSectionReference, type SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import type { SettingWidgetOptions } from '../../../../workbench/contrib/preferences/browser/settingsWidgets.js';
import { IPreferencesService, validateSettingsEditorOptions, type IOpenSettingsOptions, type ISetting, type ISelectSetting, type ISettingsGroup } from '../../../../workbench/services/preferences/common/preferences.js';
import { SESSIONS_DIFF_VIEW_MODE, SESSIONS_DIFF_WORD_WRAP, SESSIONS_EDITOR_WORD_WRAP } from '../../../services/configuration/common/editorConfiguration.js';
import { SESSIONS_GENERAL_SETTINGS_TAG, SessionsConfiguration } from '../../../common/configuration.js';
import { SESSIONS_LAYOUT_SCOPE_SETTING } from '../../../common/chatLayout.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { BROWSER_FOLLOWS_SESSION_SETTING } from '../../layout/common/sessionsLayoutConfiguration.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { SessionsAccountContent } from './sessionsAccountContent.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { SessionsAgentsContent } from './sessionsAgentsContent.js';
import { SessionsStorageContent, storageSettingsTitle } from './sessionsStorageContent.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { TeamRun } from '../../../services/teams/common/team.js';
import { ArtifactCanvasConfiguration } from '../../artifact/common/config/artifactCanvasEditorConfiguration.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Sessions Settings accessibility verbosity must be boolean');
		return value;
	},
	setting: {
		included: false,
		valueType: 'boolean',
		get title() { return localize('sessions.settings.verbosityTitle', 'Settings accessibility help'); },
		get description() { return localize('sessions.settings.verbosityDescription', 'Announce how to open accessibility help when this page has focus.'); }
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ExecutionSettings, defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError('Execution Settings accessibility verbosity must be boolean'); return value; },
	setting: {
		included: false,
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.settings', key: 'execution.verbosityTitle' }, 'Execution and permissions accessibility help'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'execution.verbosityDescription' }, 'Announce how to open accessibility help for execution and permissions controls.'); }
	},
});


interface SettingsCategory {
	readonly id: string;
	readonly title: string;
	readonly icon: Icon;
	readonly settings: readonly ISetting[];
	readonly settingGroups?: readonly ISettingsGroup[];
	readonly content?: SettingsPageRenderer<ISetting | SettingsSectionReference>;
}

interface SettingsSection {
	readonly title: string;
	readonly categories: readonly SettingsCategory[];
}

const desktopAppSettingsTitle = () => localize('sessions.settings.desktopApp', 'Desktop App');

/** Sessions owns its settings page while reusing the Workbench setting widgets. */
export class SessionsPreferences extends Disposable {
	private readonly activeDialog = this._register(new MutableDisposable<DisposableStore>());
	private readonly standaloneStorage = this._register(new MutableDisposable<SessionsStorageContent>());
	private dialog: Dialog | undefined;
	private dialogVisible = false;
	private closeDialog: (() => Promise<boolean>) | undefined;
	private focusDialog: (() => void) | undefined;
	private navigate: ((categoryId: string) => void) | undefined;
	private applyQuery: ((query: string, focus: boolean) => void) | undefined;
	private applySectionQuery: ((options: IOpenSettingsOptions) => void) | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly showEditor: () => void | Promise<void>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILocaleService private readonly localeService: ILocaleService,
		@ILanguagePackService private readonly languagePackService: ILanguagePackService,
		@ILocalizationService private readonly localizationService: ILocalizationService,
		@ITrustedDomainService private readonly trustedDomains: ITrustedDomainService,
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
					() => localize('sessions.settings.help', 'Settings has categories on the left and settings on the right. In Appearance, use Interface font, Message body font, and Code block font to choose typography for each part of the window. Use the arrow keys to browse font choices and Enter to select one. In Appearance, Automatically follow new replies controls whether chat follows replies at the bottom. In General, Terminal default location chooses where new terminals open. Interface language takes effect after restarting Ash or refreshing the page. Voice contains settings for dictation and two-way voice conversations. Account contains connected subscription accounts, their usage and reset times. Use Connect or Disconnect beside an account name to sign in or out. External client accounts are read-only. Models contains chat models and API connections. In Your Ash, use Manage under Code conversation defaults to edit and save your personal or workspace defaults. Run Developer: Show Agent Tool Catalog to inspect a grouped read-only tool snapshot. Git & PRs contains GitHub account selection, repository access checks, and official Codex PR cloud review management links. Agents contains the Advisor model, conversation title and recap settings, Agent definitions, and Teams. Teams manages fixed members, roles, tasks and discussion. Select a model to enable Advisor or Disable to turn it off. Execution trace shows the running recorder, detailed recording switch and save directory. Save trace settings explicitly, then restart the owning App Server to apply them. Other changes are saved immediately. Design contains canvas cursor and accessibility settings. The sidebar Customize entry manages plugins, skills and connections. Agents contains Manage Hooks, which opens Agent Customizations in the editor. Use Up and Down, Home or End to navigate categories. Browser has the Browser follows session switch, separate opening locations for web links and local development sites, trusted domains and Clear data. Clear data asks for confirmation before removing history, saved passwords, cookies and other built-in browser data. Browser settings are grouped into Browser, Downloads and Trusted domains. Browsing history and Download history have separate Manage buttons. In Downloads, Change chooses the save folder and the switch asks where to save each file. Tab opens its Workbench settings. In Code Intelligence, edit Codebase settings and control language servers with Enable LSPs and Enable LSPs for Worktrees. Environment contains execution and permissions settings. Use search to filter settings and Down to focus the first result. Right-click a configuration setting, or focus its control and press Shift+F10 to open the setting menu. Choose Copy Setting as JSON to copy the key and current value without saving settings. Local dictation settings list available and installed models. Use the Dictation models selector to switch between installed models. Use Tab to reach Install, Cancel, or Uninstall. Preparation continues after Settings closes. Cloud dictation and Voice Mode use API connections in Models. ChatGPT dictation uses the Codex login in Account. Press Escape to close Settings.') + ' ' + localize({ bundle: 'ash.settings', key: 'search.modifiedHelp' }, 'Type @modified or choose Modified in Filter Settings to show settings saved in local user settings, including explicit default values. Combine it with text or @id: filters. Language-only overrides and service status are excluded. Reset removes a saved override; failed saves keep the previous results. Clear Filters keeps your search text.') + ' ' + localize({ bundle: 'ash.settings', key: 'search.maturityHelp' }, 'Settings can be marked Experimental or Preview; these labels describe maturity and do not change enablement. Use @tag:experimental or @tag:preview to filter them, or @stable to exclude both. Combine these filters with text, @id: and @modified.') + ' ' + localize({ bundle: 'ash.settings', key: 'search.openQueryHelp' }, 'Search accepts setting IDs or words. Opening Settings with a query focuses the search field and updates the existing page. An empty query clears the filter. Press Escape in a non-empty search field to clear it.') + ' ' + localize({ bundle: 'ash.settings', key: 'search.languageHelp' }, 'Language queries such as @lang:plaintext open language-specific settings in the shared Workbench editor. Workspace and folder settings use that editor too.') + ' ' + localize({ bundle: 'ash.settings', key: 'number.automaticHelp' }, 'Enter a number, or clear the field to use Automatic.') + ' ' + localize({ bundle: 'ash.settings', key: 'number.modeHelp' }, 'Enter a number directly, or use the value mode list for other choices.') + ' ' + localize({ bundle: 'ash.settings', key: 'editor.switchHelp' }, 'Switch between Settings UI and JSON without changing the default settings editor. Unsaved JSON edits remain in the editor.') + ' ' + localize('sessions.settings.chatGPTBackendHelp', 'In the desktop General category, Default ChatGPT entry selects which entry opens when you start a new chat.') + (isNative ? ' ' + localize('sessions.settings.desktopAppHelp', 'In Desktop App, Open on startup chooses which window opens when Ash starts. Project files shows the local save folder. Activate Change to choose a different folder.') : '') + ' ' + localize('sessions.settings.layoutScopeHelp', 'Appearance has Layout scope. Session keeps documents per session. Chat with shared visibility keeps documents per chat and shares Editor and Details visibility. Chat keeps documents and visibility per chat.') + (isNative ? ' ' + localize({ bundle: 'ash.sessions', key: 'sessions.storage.help' }, 'In Desktop App, choose Manage next to Storage to see local disk usage. Press Escape to return to Settings. Use Tab to refresh, manage worktrees, restore an archived session, or review sessions for permanent deletion. Expand Manage worktrees and use Space to select worktrees to clean up. Expand Details to see local storage paths.') : '') + '\n\n'
						+ localize('sessions.backgroundColor.help', 'In Appearance, Background color switches the light conversation and editor area between Warm and Cool. Cool uses pure white.'),
					() => focused.focus(),
					AccessibilityVerbositySettingId.SessionsSettings,
				);
			},
		}));
	}

	public async openStorage(): Promise<'restore' | 'delete' | undefined> {
		if (this.dialogVisible) {
			await this.open({ section: 'desktop-app', query: storageSettingsTitle() });
			return undefined;
		}
		return this.showStorage(this.container, this.standaloneStorage);
	}

	private async showStorage(container: HTMLElement, slot: MutableDisposable<SessionsStorageContent>): Promise<'restore' | 'delete' | undefined> {
		if (slot.value || this.isDisposed) return undefined;
		const panel = slot.value = this.instantiationService.createInstance(SessionsStorageContent, container);
		try {
			return await panel.show();
		} finally {
			slot.clear();
		}
	}

	public async open(options: IOpenSettingsOptions = {}): Promise<void> {
		const validated = validateSettingsEditorOptions(options);
		if (validated.openToSide || validated.groupId !== undefined || validated.folderUri || validated.target === ConfigurationTarget.WORKSPACE || validated.target === ConfigurationTarget.WORKSPACE_FOLDER || new SettingsSearchQuery(validated.query ?? '').languageFilter) {
			// Sessions owns product preferences; resource and language editing belongs to the shared Workbench pane.
			const preferences = this.instantiationService.invokeFunction(accessor => accessor.get(IPreferencesService));
			const jsonEditor = validated.jsonEditor ?? false;
			if (this.closeDialog && !await this.closeDialog()) { return; }
			const inGroup = validated.openToSide || validated.groupId !== undefined;
			// Revealing Code selects its document group. Settle that layout before opening and focusing the requested pane.
			if (inGroup) await this.showEditor();
			await preferences.openUserSettings({ ...validated, jsonEditor });
			if (jsonEditor && !inGroup) await this.showEditor();
			return;
		}
		// Agent settings always open the UI unless JSON is explicitly requested.
		if (validated.jsonEditor) {
			if (this.closeDialog && !await this.closeDialog()) { return; }
			const preferences = this.instantiationService.invokeFunction(accessor => accessor.get(IPreferencesService));
			await preferences.openUserSettings({ ...validated, jsonEditor: true });
			await this.showEditor();
			return;
		}
		const categoryId = validated.section === 'chat-appearance' ? 'appearance' : validated.section;
		const query = validated.query ?? (validated.revealSetting ? `@id:${validated.revealSetting.key}` : undefined);
		if (this.dialogVisible) {
			if (validated.sectionQuery !== undefined) { this.applySectionQuery?.(validated); return; }
			if (categoryId) { this.navigate?.(categoryId); }
			if (query !== undefined) this.applyQuery?.(query, !validated.preserveFocus && validated.focusSearch !== false);
			else if (!validated.preserveFocus && validated.focusSearch !== false) this.focusDialog?.();
			return;
		}
		// Release the closed modal's menus and accessibility registrations before
		// a replacement is constructed, even if its open promise is still settling.
		this.activeDialog.clear();
		const ownerDocument = this.container.ownerDocument;
		const content = h(ownerDocument, 'div');
		content.className = 'ash-sessions-settings';
		const sidebar = h(ownerDocument, 'aside');
		sidebar.className = 'ash-sessions-settings-sidebar';
		const search = h(ownerDocument, 'div');
		search.className = 'ash-sessions-settings-search';
		search.setAttribute('role', 'search');
		const navigation = h(ownerDocument, 'nav');
		navigation.className = 'ash-sessions-settings-navigation';
		navigation.setAttribute('aria-label', localize('sessions.settings.categories', 'Settings categories'));
		const navigationContent = h(ownerDocument, 'div');
		navigationContent.className = 'ash-sessions-settings-navigation-content';
		sidebar.append(search, navigation);
		const page = h(ownerDocument, 'section');
		page.id = 'ash-sessions-settings-content';
		page.className = 'ash-sessions-settings-page';
		const pageContent = h(ownerDocument, 'div');
		pageContent.className = 'ash-sessions-settings-page-content';
		const heading = h(ownerDocument, 'h3');
		heading.className = 'ash-sessions-settings-page-title';
		heading.id = 'ash-sessions-settings-page-title';
		page.setAttribute('aria-labelledby', heading.id);
		const list = h(ownerDocument, 'div');
		list.className = 'ash-sessions-settings-list';
		const empty = h(ownerDocument, 'p');
		empty.className = 'ash-sessions-settings-empty';
		empty.setAttribute('role', 'status');
		empty.textContent = localize('sessions.settings.noResults', 'No settings found.');
		const status = h(ownerDocument, 'p');
		status.className = 'ash-sessions-settings-status';
		status.setAttribute('role', 'status');
		status.hidden = true;
		pageContent.append(heading, list, empty, status);
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
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search',
			leadingIcon: Lxicon.search,
			presentation: 'field',
			placeholder: localize('sessions.settings.searchPlaceholder', 'Search'),
			ariaLabel: localize('sessions.settings.search', 'Search settings'),
			ariaControls: page.id,
		}));
		if (query !== undefined) searchInput.value = query;
		let memoryContent: MemorySettingsRenderer | undefined;
		const storageDialog = resources.add(new MutableDisposable<SessionsStorageContent>());
		const dialog = resources.add(new Dialog(this.container, localize('sessions.settings.title', 'Settings'), [], createWorkbenchDialogOptions({
			layout: 'form',
			extraClasses: ['ash-sessions-settings-dialog'],
			closeOnBackdropClick: true,
			canClose: async () => !storageDialog.value && await (memoryContent?.canClose() ?? true),
			disableDefaultAction: true,
			renderBody: body => body.append(content),
			onVisibilityChange: (_window, visible) => { if (this.dialog === dialog) this.dialogVisible = visible; },
		})));
		const closeDialog = async (): Promise<boolean> => {
			await dialog.requestClose();
			return this.dialog !== dialog || !this.dialogVisible;
		};
		const contextView = resources.add(new ContextView(content));
		// Modal menus and dropdowns must live in the dialog's top layer and end with it.
		const contentServices = resources.add(this.instantiationService.createChild(new ServiceCollection([IContextViewService, {
			container: content,
			show: (options: ContextViewOptions) => contextView.show(options),
			hide: (reason?: ContextViewHideReason) => contextView.hide(reason),
			layout: () => contextView.layout(),
		}])));
		const contextMenus = resources.add(contentServices.createInstance(BrowserContextMenuService));
		contentServices.registerInstance(IContextMenuService, contextMenus);
		// The window owns preferences, editors and notifications. Resolve them before closing
		// the modal, whose child service scope is released by open()'s finally block.
		const notifications = this.instantiationService.invokeFunction(accessor => accessor.get(INotificationService));
		const handoff = async (operation: () => Promise<void>, showEditor = true): Promise<void> => {
			if (!await closeDialog()) { return; }
			try {
				await operation();
				if (showEditor && !this.isDisposed) await this.showEditor();
			} catch (error) {
				if (!this.isDisposed) notifications.error(localize('sessions.settings.openFailed', 'Could not open preferences: {0}', String(error)));
			}
		};
		const openSettingsEditor = (section?: string): Promise<void> => {
			const editors = this.instantiationService.invokeFunction(accessor => accessor.get(IEditorService));
			return handoff(async () => { await editors.openEditor(createSettingsEditorInput(section), { pinned: true }, 'modalGroup'); }, false);
		};
		const openUserSettings = (key?: string): Promise<void> => {
			const preferences = this.instantiationService.invokeFunction(accessor => accessor.get(IPreferencesService));
			return handoff(() => preferences.openUserSettings({ jsonEditor: true, ...(key ? { revealSetting: { key, edit: true } } : {}) }));
		};
		const managementContent = (id: string, title: string, description: string, fields: readonly SettingsSectionField[], help = description): SettingsPageRenderer =>
			resources.add(contentServices.createInstance(SettingsSectionRenderer, list, {
				categoryId: id, title, description, help, fields, hideInnerTitle: true,
			}, AccessibleViewProviderId.SessionsSettings, AccessibilityVerbositySettingId.SessionsSettings));
		const settingOptions: SettingWidgetOptions = {
			actionsOnContextMenuOnly: true,
			onOpenSettings: key => openUserSettings(key),
			onStatus: (message, isError) => {
				status.textContent = message;
				status.classList.toggle('is-error', isError);
				status.setAttribute('role', isError ? 'alert' : 'status');
				status.hidden = !message;
			},
		};
		const renderer = resources.add(contentServices.createInstance(SettingsRenderer, list, settingOptions));
		const modelContent = resources.add(contentServices.createInstance(ModelSettingsRenderer, { container: list, showSubscriptions: false }));
		const dictationContent = resources.add(contentServices.createInstance(DictationSettingsRenderer, list, { showGroupHeader: false }));
		const githubSettings = resources.add(contentServices.createInstance(GitHubSettingsModel, closeDialog));
		const githubContent = resources.add(contentServices.createInstance(SettingsSectionRenderer, list, githubSettings, AccessibleViewProviderId.GitHubSettings, AccessibilityVerbositySettingId.GitHubSettings));
		const traceSettings = resources.add(contentServices.createInstance(TraceSettingsModel));
		const traceContent = resources.add(contentServices.createInstance(SettingsSectionRenderer, { container: list, hideInnerTitle: true }, traceSettings, AccessibleViewProviderId.TraceSettings, AccessibilityVerbositySettingId.TraceSettings));
		const executionSettings = resources.add(contentServices.createInstance(ExecutionSettingsModel));
		const executionContent = resources.add(contentServices.createInstance(SettingsSectionRenderer, list, executionSettings, AccessibleViewProviderId.ExecutionSettings, AccessibilityVerbositySettingId.ExecutionSettings));
		const management = new Map<string, SettingsPageRenderer>();
		management.set('account', resources.add(contentServices.createInstance(SessionsAccountContent, list)));
		const hooksContent = managementContent('agents', localize({ bundle: 'ash.settings', key: 'hooks.aria' }, 'Agent Hooks'),
			localize({ bundle: 'ash.settings', key: 'hooks.managementLink' }, 'Manage Hooks in Agent Customizations.'), [{
				id: 'manage', kind: 'action', enabled: true,
				label: localize({ bundle: 'ash.settings', key: 'hooks.manage' }, 'Manage Hooks'),
				run: () => {
					const editors = this.instantiationService.invokeFunction(accessor => accessor.get(IEditorService));
					return handoff(async () => { await editors.openEditor(new AICustomizationManagementEditorInput(), { pinned: true }); });
				},
			}], localize({ bundle: 'ash.settings', key: 'hooks.managementLinkHelp' }, 'Open Manage Hooks to search events, inspect declarations, edit TOML, or ask Ash to configure a Hook.'));
		const tabTitle = localize('sessions.settings.tab', 'Tab');
		management.set('tab', managementContent('tab', tabTitle,
			localize('sessions.settings.sharedDescription', 'These preferences are shared with the Workbench. Open the settings editor to view, change, search, or reset them.'),
			[{
				id: 'settings', kind: 'action', enabled: true,
				label: localize('sessions.settings.openSection', 'Open {0} settings', tabTitle),
				run: () => openSettingsEditor('editor-opening'),
			}]));
		management.set('code-intelligence', resources.add(contentServices.createInstance(SettingsSectionRenderer,
			{ container: list, rowPresentation: 'general' }, resources.add(contentServices.createInstance(LspSettingsModel)),
			AccessibleViewProviderId.LanguageServers, AccessibilityVerbositySettingId.LanguageServers)));
		const contributed = getSettingsSections().filter(section => section.categoryId !== 'chat-usage').map(section => {
			const categoryId = section.categoryId === 'editor-suggestions' ? 'code-intelligence' : section.categoryId;
			const useGeneralRows = categoryId === 'agents' || categoryId === 'code-intelligence';
			return {
				categoryId,
				content: resources.add(contentServices.createInstance(SettingsSectionRenderer,
					useGeneralRows ? { container: list, rowPresentation: 'general' } : list,
					resources.add(contentServices.createInstance(section.model)),
					section.accessibleViewProviderId, section.accessibilityVerbositySettingId)),
			};
		});
		const runCommand = (id: string) => this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand(id));
		if (isNative) {
			const clearData = localize({ bundle: 'ash', key: 'sessions.browser.clearData' }, 'Clear data');
			const description = localize({ bundle: 'ash', key: 'sessions.browser.clearData.description' }, 'Clear history, passwords, cookies and other data in the built-in browser.');
			const manage = localize({ bundle: 'ash', key: 'sessions.browser.manage' }, 'Manage');
			const configuration = this.configurationService;
			management.set('downloads', resources.add(contentServices.createInstance(SettingsSectionRenderer,
				{ container: list, rowPresentation: 'general' }, {
				categoryId: 'browser-downloads', groupId: null,
				title: localize({ bundle: 'ash', key: 'downloads.title' }, 'Downloads'), description: '',
				help: localize({ bundle: 'ash', key: 'downloads.settingsHelp' }, 'Use Change to choose the download folder. The switch asks where to save each file. Manage opens searchable download history. Escape closes the list and returns focus to Manage.'),
				onDidChange: (listener: () => void) => configuration.onDidChangeConfiguration(event => {
					if (event.affectsConfiguration(BrowserDownloadDirectorySetting) || event.affectsConfiguration(BrowserDownloadAskSetting)) listener();
				}),
				get fields(): readonly SettingsSectionField[] {
					return [{
						id: 'download-folder', kind: 'action', presentation: 'setting', enabled: true,
						label: localize({ bundle: 'ash', key: 'downloads.location' }, 'Download location'),
						description: configuration.getValue<string>(BrowserDownloadDirectorySetting) || localize({ bundle: 'ash', key: 'downloads.defaultLocation' }, 'System Downloads folder'),
						actionLabel: localize({ bundle: 'ash', key: 'sessions.browser.change' }, 'Change'),
						run: async () => { await runCommand('workbench.action.browser.chooseDownloadDirectory'); },
					}, {
						id: 'download-ask', kind: 'boolean', enabled: true,
						label: localize({ bundle: 'ash', key: 'downloads.ask' }, 'Ask where to save each file before downloading'),
						description: localize({ bundle: 'ash', key: 'downloads.ask.description' }, 'Choose a save location for each download.'),
						value: configuration.getValue<boolean>(BrowserDownloadAskSetting),
						setValue: value => { void configuration.updateValue(BrowserDownloadAskSetting, value, ConfigurationTarget.USER).catch(error => notifications.error(error)); },
					}, {
						id: 'download-history', kind: 'action', presentation: 'setting', enabled: true,
						label: localize({ bundle: 'ash', key: 'downloads.history' }, 'Download history'), actionLabel: manage,
						run: async () => { await runCommand('workbench.action.browser.showDownloads'); },
					}];
				},
			}, AccessibleViewProviderId.SessionsSettings, AccessibilityVerbositySettingId.SessionsSettings)));
			management.set('browser', managementContent('browser-data', localize('sessions.settings.browser', 'Browser'), '', [{
				id: 'browsing-history', kind: 'action', label: localize({ bundle: 'ash', key: 'sessions.browser.history' }, 'Browsing history'),
				actionLabel: manage, enabled: true, presentation: 'setting',
				run: () => handoff(async () => { await runCommand('workbench.action.browser.manageHistory'); }, false),
			}, {
				id: 'clear-browser-data', kind: 'action', label: clearData, description, enabled: true, presentation: 'setting',
				run: async () => { await runCommand('workbench.action.browser.clearAllData'); },
			}], localize({ bundle: 'ash', key: 'sessions.browser.historyHelp' }, 'Use Manage beside Browsing history to search and clear visits in the current browser storage session. Clear data asks for confirmation before removing built-in browser data. Download history is managed separately in Downloads.')));
		}
		if (isNative) {
			const title = storageSettingsTitle();
			const description = localize({ bundle: 'ash.sessions', key: 'sessions.storage.search' }, 'Disk usage, worktrees and archived sessions');
			management.set('storage', resources.add(contentServices.createInstance(SettingsSectionRenderer, { container: list, hideInnerTitle: true }, {
				categoryId: 'desktop-app', itemId: 'sessions.storage', groupTitle: desktopAppSettingsTitle(), title,
				description: '', keywords: [description],
				help: localize({ bundle: 'ash.sessions', key: 'sessions.storage.manageHelp' }, 'Choose Manage to open Storage. Press Escape to return to Settings.'),
				fields: [{
					id: 'manage', kind: 'action', presentation: 'setting', enabled: true, label: title, description,
					actionLabel: localize({ bundle: 'ash.sessions', key: 'sessions.storage.manage' }, 'Manage'),
					run: async () => {
						const action = await this.showStorage(content, storageDialog);
						if (action && !resources.isDisposed) {
							await handoff(async () => { await runCommand(action === 'restore' ? 'agentSession.restore' : 'agentSession.delete'); }, false);
						}
					},
				}],
			}, AccessibleViewProviderId.SessionsSettings, AccessibilityVerbositySettingId.SessionsSettings)));
		}
		memoryContent = resources.add(contentServices.createInstance(MemorySettingsRenderer, list,
			() => this.contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'chat' ? 'chat' : 'code', closeDialog, this.showEditor));
		management.set(MEMORY_SETTINGS_CATEGORY, memoryContent);
		const codeDefaults = resources.add(contentServices.createInstance(CodeConversationDefaultsEntry, content));
		const sessions = this.instantiationService.invokeFunction(accessor => accessor.get(ISessionsService));
		management.set('agents', resources.add(contentServices.createInstance(SessionsAgentsContent, list,
			async () => { if (await closeDialog()) await this.showEditor(); },
			(run: TeamRun) => handoff(async () => {
				await runCommand('sessions.open.code');
				await sessions.openThread(run.sessionId, run.coordinatorThreadId);
			}, false),
			(error: unknown) => notifications.error(localize({ bundle: 'ash.settings', key: 'roles.openFailed' }, 'Could not open Agent definition: {0}', String(error))),
		)));
		const sections = this.sections(modelContent, dictationContent, githubContent, traceContent, management);
		const categories = sections.flatMap(section => section.categories);
		const storageEntry = management.get('storage');
		const categoryContents = (category: SettingsCategory): readonly SettingsPageRenderer[] => {
			const pages = contributed.filter(section => section.categoryId === category.id).map(section => section.content);
			const downloadActions = category.id === 'browser' ? management.get('downloads') : undefined;
			const content = [...category.content ? [category.content] : [], ...downloadActions ? [downloadActions] : []];
			return [
				...category.id === 'environment' ? [executionContent] : [],
				...category.id === 'agents' || category.id === 'code-intelligence' ? [...pages, ...content] : [...content, ...pages],
				...category.id === 'agents' ? [hooksContent] : [],
				...category.id === MEMORY_SETTINGS_CATEGORY ? [codeDefaults] : [],
				...category.id === 'desktop-app' && storageEntry ? [storageEntry] : [],
			];
		};
		for (const category of categories) {
			for (const content of categoryContents(category)) resources.add(renderer.registerPage(content));
		}
		const categoryIndex = (id: string | undefined): number => {
			const target = id === 'chat-usage' ? 'account' : id === 'hooks' ? 'agents' : id === 'execution-permissions' ? 'environment' : id;
			const index = categories.findIndex(category => category.id === target);
			return index >= 0 ? index : 0;
		};
		let activeCategory = categoryIndex(categoryId);
		const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const treeModel = resources.add(new SettingsTreeModel<ISetting | SettingsSectionReference>(id =>
			// Keep service-only sections out of the local-user filter without creating configuration copies.
			configurationRegistry.getConfiguration(id) !== undefined && this.configurationService.inspect(id).userLocalValue !== undefined,
		));
		const tree = resources.add(new SettingsTree(list, {
			model: treeModel,
			rootClassName: 'ash-sessions-settings-content-tree',
			groupClassName: 'ash-sessions-settings-content-group',
			groupDescriptionClassName: 'ash-sessions-settings-group-description',
			itemsClassName: 'ash-sessions-settings-list ash-settings-card',
			renderGroupHeader: header => renderer.render(header),
			renderItem: item => renderer.render(item.value),
			updateItem: item => { if (!('rendererId' in item.value)) renderer.update(item.value); },
			disposeItem: item => { if (!('rendererId' in item.value)) renderer.disposeSetting(item.id); },
		}));
		const buttons: Button[] = [];
		for (const section of sections) {
			const group = h(ownerDocument, 'div');
			group.className = 'ash-sessions-settings-navigation-group';
			group.setAttribute('role', 'group');
			group.setAttribute('aria-label', section.title);
			navigationContent.append(group);
			for (const category of section.categories) {
				const index = buttons.length;
				const button = resources.add(new Button(group, {
					...defaultButtonStyles,
					label: category.title,
					title: category.title,
					icon: category.icon,
					presentation: 'quiet',
					onClick: () => {
						activeCategory = index;
						if (searchInput.value) searchInput.value = '';
						else render();
						pageScrollable.scrollTo(0, 0);
					},
				}));
				button.domNode.classList.add('ash-sessions-settings-navigation-item');
				button.domNode.dataset.settingsCategoryId = category.id;
				button.domNode.setAttribute('aria-controls', page.id);
				buttons.push(button);
			}
		}
		const render = (): void => {
			const query = new SettingsSearchQuery(searchInput.value);
			const nodes: readonly SettingsTreeNode<ISetting | SettingsSectionReference>[] = categories.map((category, index) => ({
				element: { kind: 'group', id: `sessions.category.${category.id}`, title: category.title, description: '' },
				children: [
					...category.settings.map(setting => ({ element: { kind: 'item' as const, id: setting.id, title: setting.title, description: setting.description, keywords: [setting.id, ...setting.keywords ?? []], tags: setting.tags, value: setting } })),
					...categoryContents(category).flatMap(content => content.getNodes(query).flatMap(node => {
						const group = node.element;
						// The category heading already labels these rows, including in search results.
						return group.kind === 'group' && group.title === category.title && !group.header && !group.description
							? node.children ?? []
							: [node];
					})),
					...category.settingGroups ? new SettingsLayout(`sessions.category.${category.id}`, category.settingGroups).nodes : [],
				],
			}));
			treeModel.setChildren(nodes);
			tree.setNavigationTarget(query.isEmpty ? `sessions.category.${categories[activeCategory].id}` : undefined);
			treeModel.setQuery(query);
			for (const [index, category] of categories.entries()) {
				for (const content of categoryContents(category)) content.setVisible(!query.isEmpty || index === activeCategory);
			}
			heading.textContent = query.isEmpty ? categories[activeCategory].title : localize('sessions.settings.results', 'Search results');
			heading.hidden = treeModel.visibleItems.length === 0;
			empty.hidden = treeModel.visibleItems.length !== 0 || query.isEmpty;
			for (const [index, button] of buttons.entries()) {
				const isCurrent = query.isEmpty && index === activeCategory;
				button.toggleClassName('is-current', isCurrent);
				if (isCurrent) button.domNode.setAttribute('aria-current', 'page');
				else button.domNode.removeAttribute('aria-current');
			}
			pageScrollable.layout();
		};
		for (const [index, category] of categories.entries()) {
			for (const content of categoryContents(category)) {
				resources.add(content.onDidChange(render));
				if (content.onDidRequestReveal) resources.add(content.onDidRequestReveal(() => {
					activeCategory = index;
					searchInput.value = '';
					render();
				}));
			}
		}
		resources.add(this.languagePackService.onDidChange(render));
		resources.add(this.configurationService.onDidChangeConfiguration(() => {
			if (new SettingsSearchQuery(searchInput.value).hasModifiedFilter) render();
		}));
		this.navigate = categoryId => {
			activeCategory = categoryIndex(categoryId);
			searchInput.value = '';
			render();
			pageScrollable.scrollTo(0, 0);
		};
		resources.add(addDisposableListener(navigation, 'keydown', event => {
			const current = buttons.findIndex(button => button.domNode === ownerDocument.activeElement);
			if (current < 0) return;
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
				: event.key === 'ArrowDown' ? (current + 1) % buttons.length
					: event.key === 'ArrowUp' ? (current + buttons.length - 1) % buttons.length : undefined;
			if (next === undefined) return;
			event.preventDefault();
			event.stopPropagation();
			buttons[next].focus();
			buttons[next].domNode.click();
		}));
		resources.add(searchInput.onKeyDown(event => {
			if (event.key === 'Escape' && searchInput.value) {
				event.preventDefault();
				event.stopPropagation();
				searchInput.value = '';
			} else if (event.key === 'ArrowDown') {
				const target = [...pageContent.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')]
					.find(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
				if (!target) return;
				event.preventDefault();
				event.stopPropagation();
				target.focus();
			}
		}));
		resources.add(searchInput.onDidChange(() => {
			if (new SettingsSearchQuery(searchInput.value).languageFilter) {
				const preferences = this.instantiationService.invokeFunction(accessor => accessor.get(IPreferencesService));
				void handoff(() => preferences.openUserSettings({ query: searchInput.value, jsonEditor: false }), false);
				return;
			}
			render();
			pageScrollable.scrollTo(0, 0);
		}));
		this.applyQuery = (query, focus) => {
			searchInput.value = query;
			if (focus) searchInput.focus();
		};
		this.applySectionQuery = options => {
			const sectionSearch = categoryContents(categories[categoryIndex(options.section)]).find(content => content.sectionSearch)?.sectionSearch;
			if (!sectionSearch) { throw new RangeError(localize({ bundle: 'ash.settings', key: 'open.unsupportedSectionSearch' }, 'This Settings section does not provide its own search.')); }
			this.navigate?.(options.section!);
			if (options.query !== undefined) { this.applyQuery?.(options.query, false); }
			sectionSearch.search(options.sectionQuery!);
			if (!options.preserveFocus && options.focusSearch !== false) { sectionSearch.focus(); }
		};
		render();
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsSettings);
		if (hint) {
			searchInput.inputElement.setAttribute('aria-description', hint);
		}
		resources.add(AccessibleViewRegistry.register({
			type: AccessibleViewType.View, priority: 100, name: 'sessionsSettingsView',
			when: ContextKeyExpr.has('sessionsSettingsFocused'),
			getProvider: () => {
				const focused = ownerDocument.activeElement as HTMLElement;
				return new AccessibleContentProvider(AccessibleViewProviderId.SessionsSettings, { type: AccessibleViewType.View },
					() => storageDialog.value?.accessibleContent ?? pageContent.innerText, () => focused.focus(), AccessibilityVerbositySettingId.SessionsSettings);
			},
		}));

		const scope = resources.add(this.contextKeys.createScoped(content));
		scope.createKey('sessionsSettingsFocused', true);
		this.focusDialog = () => searchInput.focus();
		this.dialog = dialog;
		this.closeDialog = closeDialog;
		this.activeDialog.value = resources;
		try {
			const shown = dialog.show();
			if (validated.sectionQuery !== undefined) this.applySectionQuery(validated);
			else if (query !== undefined) searchInput.focus();
			await shown;
		} finally {
			// Closing can be followed by another open before this promise settles.
			// A retired opening must not release the replacement's modal scope.
			if (this.dialog === dialog) {
				this.navigate = undefined;
				this.applyQuery = undefined;
				this.applySectionQuery = undefined;
				this.dialog = undefined;
				this.closeDialog = undefined;
				this.focusDialog = undefined;
				this.dialogVisible = false;
				this.activeDialog.clear();
			}
		}
	}

	private sections(modelContent: SettingsPageRenderer<ISetting | SettingsSectionReference>, dictationContent: SettingsPageRenderer<ISetting | SettingsSectionReference>, githubContent: SettingsPageRenderer<ISetting | SettingsSectionReference>, traceContent: SettingsPageRenderer<ISetting | SettingsSectionReference>, management: ReadonlyMap<string, SettingsPageRenderer<ISetting | SettingsSectionReference>>): readonly SettingsSection[] {
		const defaults = new DefaultSettings();
		const appearanceSettings: readonly ISetting[] = [
			...[SESSIONS_LAYOUT_SCOPE_SETTING, SessionsConfiguration.layoutStyle, SessionsConfiguration.activityBarLocation].map(id => defaults.get(id)),
			defaults.get(SessionsConfiguration.showSessionActivityBar),
			defaults.get(SessionsConfiguration.interfaceFontFamily),
			{
				...defaults.get(ChatConfiguration.FontFamily),
				title: localize('sessions.settings.messageFontFamily', 'Message body font'),
			},
			{
				...defaults.get(ChatEditorConfiguration.fontFamily),
				title: localize('sessions.settings.codeBlockFontFamily', 'Code block font'),
			},
			defaults.get(SessionsConfiguration.backgroundColor),
			{
				...defaults.get(ChatInputConfiguration.fontSize),
				title: localize('sessions.settings.messageInputFontSize', 'User message font size'),
				description: localize('sessions.settings.messageInputFontSize.description', 'Set the font size in pixels for the message input, sent user messages, and inline editing. The IDE shares this user setting for its message input.'),
			},
			defaults.get(SessionsConfiguration.chatInputLayout),
			defaults.get(ChatConfiguration.AutoFollowReplies),
			defaults.get(ChatConfiguration.ShowAgentReplyTimestamps),
			defaults.get(PROMPT_TIMELINE_DISPLAY_SETTING),
			...[SESSIONS_DIFF_VIEW_MODE, SESSIONS_DIFF_WORD_WRAP, SESSIONS_EDITOR_WORD_WRAP].map(id => defaults.get(id)),
		];
		const generalSettings: readonly ISetting[] = [
			...defaults.all.filter(setting => setting.id === ChatConfiguration.TipsEnabled || setting.tags?.includes(SESSIONS_GENERAL_SETTINGS_TAG)),
			defaults.get(TerminalSettingId.DefaultLocation),
			displayLanguageSetting(defaults.get(LocalizationConfiguration.locale), this.localeService, this.languagePackService, this.localizationService, this.configurationService),
		];
		const designSettings: readonly ISetting[] = [
			ArtifactCanvasConfiguration.usePointerCursor,
			AccessibilityVerbositySettingId.DesignCanvas
		].map(id => defaults.get(id));
		const trustedDomains = trustedDomainsSetting(this.trustedDomains);
		const localLinks = defaults.all.find(setting => setting.id === BrowserOpenLocalhostLinksSettingId);
		if (localLinks && localLinks.valueType !== 'boolean') throw new TypeError('Local link configuration must be boolean');
		// Keep the existing routing preference; only the Agent Window presents it as a destination selector.
		const localDestination: ISelectSetting | undefined = localLinks && {
			id: localLinks.id,
			configuration: localLinks.configuration as ISelectSetting['configuration'],
			valueType: 'select',
			title: localize({ bundle: 'ash', key: 'sessions.browser.localDestination' }, 'Local URL opening location'),
			description: localize({ bundle: 'ash', key: 'sessions.browser.localDestination.description' }, 'Choose where local development sites open, including localhost, loopback addresses and all-interfaces addresses.'),
			options: [
				{ value: true, label: 'Ash' },
				{ value: false, label: localize({ bundle: 'ash', key: 'sessions.browser.systemDestination' }, 'Default browser') },
			],
		};

		return [{
			title: localize('sessions.settings.section.basics', 'Basics'),
			categories: [
				{ id: 'general', title: localize('sessions.settings.general', 'General'), icon: Lxicon.settings, settings: generalSettings },
				{ id: 'account', title: localize('sessions.settings.account', 'Account'), icon: Lxicon.account, settings: [], content: management.get('account') },
				{ id: 'appearance', title: localize('sessions.settings.appearance', 'Appearance'), icon: Lxicon.appearance, settings: appearanceSettings },
				{ id: 'dictation', title: localize('sessions.settings.voice', 'Voice'), icon: Lxicon.voiceMode, settings: [], content: dictationContent },
				...isNative ? [{
					id: 'desktop-app',
					title: desktopAppSettingsTitle(),
					icon: Lxicon.layout,
					settings: defaults.all.filter(setting => setting.id === STARTUP_WINDOW_SETTING),
				}] : [],
			],
		}, {
			title: localize('sessions.settings.section.development', 'Development'),
			categories: [
				{ id: 'agents', title: localize('sessions.settings.agents', 'Agents'), icon: Lxicon.bot, settings: [], content: management.get('agents') },
				{ id: MEMORY_SETTINGS_CATEGORY, title: memorySettingsTitle(), icon: Lxicon.personalization, settings: [], content: management.get(MEMORY_SETTINGS_CATEGORY) },
				{ id: 'execution-trace', title: localize('sessions.settings.executionTrace', 'Execution trace'), icon: Lxicon.history, settings: [], content: traceContent },
				{ id: 'design', title: localize('sessions.settings.design', 'Design'), icon: Lxicon.symbolColor, settings: designSettings },
				{ id: 'models', title: localize('sessions.settings.models', 'Models'), icon: Lxicon.model, settings: [], content: modelContent },
				{
					id: 'github', title: localize('sessions.settings.gitPrs', 'Git & PRs'), icon: Lxicon.git,
					settings: defaults.all.filter(setting => setting.id === COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING), content: githubContent,
				},
				{
					id: 'browser', title: localize('sessions.settings.browser', 'Browser'), icon: Lxicon.global,
					settings: [
						defaults.get(BROWSER_FOLLOWS_SESSION_SETTING),
						...defaults.all.filter(setting => setting.id === BrowserOpenLinksSettingId),
						...localDestination ? [localDestination] : [],
						...defaults.all.filter(setting => setting.id === 'workbench.browser.autoReloadOnFileChange'
							|| setting.id === 'workbench.browser.autoReloadLocalhostOnFileChange')],
					content: management.get('browser'),
					settingGroups: [{ id: 'trusted-domains', title: trustedDomains.title, description: '', settings: [trustedDomains] }],
				},
				{ id: 'tab', title: localize('sessions.settings.tab', 'Tab'), icon: Lxicon.keyboardTab, settings: [], content: management.get('tab') },
				{ id: 'code-intelligence', title: localize('sessions.settings.codeIntelligence', 'Code Intelligence'), icon: Lxicon.code, settings: [], content: management.get('code-intelligence') },
				{ id: 'environment', title: localize('sessions.settings.environment', 'Environment'), icon: Lxicon.terminal, settings: [] },
			],
		}];
	}
}
