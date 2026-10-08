import { AgentCapabilitiesSettings } from '../../../../workbench/contrib/preferences/browser/agentCapabilitiesSettings.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IDirPermissionsService } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ILocalizationService } from '../../../../workbench/services/localization/common/localizationService.js';
import { GitHubSettingsModel } from '../../../../workbench/contrib/github/browser/githubSettingsModel.js';
import { TraceSettingsModel } from '../../../../workbench/contrib/trace/browser/traceSettingsModel.js';
import { SettingsSectionRenderer } from '../../../../workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import './media/sessionsPreferences.css';
import '../../../../workbench/contrib/preferences/browser/media/settingsCard.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { ContextView, type ContextViewOptions, type ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type { MarketplaceOpenOptions } from '../../../../platform/marketplace/common/marketplaceService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ActivityBarPosition } from '../../../../workbench/common/configuration.js';
import '../../../../workbench/contrib/preferences/common/settingsEditorColorRegistry.js';
import { SettingsRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { AdvisorSettingsContent } from '../../../../workbench/contrib/chat/browser/advisorSettingsContent.js';
import { ModelSettingsContent } from '../../../../workbench/contrib/chat/browser/modelSettingsContent.js';
import { DictationSettingsContent } from '../../../../workbench/contrib/chat/browser/speechToText/dictationSettingsContent.js';
import { SettingsTree } from '../../../../workbench/contrib/preferences/browser/settingsTree.js';
import { SettingsTreeModel, type SettingsContent, type SettingsContentItem, type SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import { SettingsSearchMenu } from '../../../../workbench/contrib/preferences/browser/settingsSearchMenu.js';
import type { SettingWidgetOptions } from '../../../../workbench/contrib/preferences/browser/settingsWidgets.js';
import type { ISetting } from '../../../../workbench/services/preferences/common/preferences.js';
import { SessionsConfiguration } from '../../../common/configuration.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { SessionsCustomizeContent } from './sessionsCustomizeContent.js';
import { DesignConfiguration } from '../../creator/common/config/editorConfiguration.js';

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
	readonly id?: string;
	readonly title: string;
	readonly icon: Icon;
	readonly settings: readonly ISetting[];
	readonly content?: SettingsContent;
}

interface SettingsSection {
	readonly title: string;
	readonly categories: readonly SettingsCategory[];
}

/** Sessions owns its settings page while reusing the Workbench setting widgets. */
export class SessionsPreferences extends Disposable {
	private readonly activeDialog = this._register(new MutableDisposable<DisposableStore>());
	private dialog: Dialog | undefined;
	private navigate: ((categoryId: string, marketplaceOptions?: MarketplaceOpenOptions) => void) | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly showEditor: () => void,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentCapabilitiesService private readonly capabilities: IAgentCapabilitiesService,
		@IDirPermissionsService private readonly permissions: IDirPermissionsService,
		@IRemoteAgentService private readonly remote: IRemoteAgentService,
		@ILocalizationService private readonly localization: ILocalizationService,
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
					() => localize('sessions.settings.help', 'Sessions Settings has categories on the left and settings on the right. General contains dictation settings; Models contains chat models and API connections. Tools shows the current tool catalog and execution requirements. Git & PRs contains Codex review account status, repository access checks, and official review management links. Agents contains the Advisor model and enable switch. Execution trace shows the running recorder, detailed recording switch and save directory. Save trace settings explicitly, then restart the owning App Server to apply them. Other changes are saved immediately. Design contains canvas cursor and accessibility settings. Customize has Settings, Plugins, Skills, and Hooks tabs. Use Left and Right to move between tabs, then Enter or Space to open one. Use search to filter settings. Open More actions for a configuration setting and choose Copy Setting as JSON to copy its key and current value; copying does not save settings. The local dictation table lists available and installed models. Use arrow keys to move between rows and cells, and Tab to reach Install, Use model, Cancel, or Uninstall. Preparation continues after Settings closes. Cloud dictation uses the API connections in Models. Press Escape to close Settings.') + ' ' + localize({ bundle: 'ash.settings', key: 'search.modifiedHelp' }, 'Type @modified or choose Modified in Filter Settings to show settings saved in local user settings, including explicit default values. Combine it with text or @id: filters. Language-only overrides and service status are excluded. Reset removes a saved override; failed saves keep the previous results. Clear Filters keeps your search text.'),
					() => focused.focus(),
					AccessibilityVerbositySettingId.SessionsSettings,
				);
			},
		}));
	}

	public async open(categoryId?: string, marketplaceOptions?: MarketplaceOpenOptions): Promise<void> {
		if (this.dialog?.element.open) {
			if (categoryId) { this.navigate?.(categoryId, marketplaceOptions); }
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
			type: 'search',
			presentation: 'field',
			placeholder: localize('sessions.settings.search', 'Search settings'),
			ariaLabel: localize('sessions.settings.search', 'Search settings'),
		}));
		const dialog = resources.add(new Dialog(this.container, {
			title: localize('sessions.settings.title', 'Sessions Settings'),
			content,
		}));
		resources.add(addDisposableListener(dialog.element, 'click', event => {
			if (event.target === dialog.element) dialog.close();
		}));
		const contextView = resources.add(new ContextView(dialog.element));
		// Modal menus and dropdowns must live in the dialog's top layer and end with it.
		const contentServices = resources.add(this.instantiationService.createChild(new ServiceCollection([IContextViewService, {
			container: dialog.element,
			show: (options: ContextViewOptions) => contextView.show(options),
			hide: (reason?: ContextViewHideReason) => contextView.hide(reason),
			layout: () => contextView.layout(),
		}])));
		const contextMenus = resources.add(contentServices.createInstance(BrowserContextMenuService));
		resources.add(new SettingsSearchMenu(search, {
			getValue: () => searchInput.value,
			setValue: value => { searchInput.value = value; },
			focus: () => searchInput.focus(),
			contextMenuProvider: contextMenus,
		}));
		const settingOptions: SettingWidgetOptions = {
			clipboardService: this.clipboardService,
			configurationService: this.configurationService,
			contextMenuProvider: contextMenus,
			contextViewProvider: contextView,
			onStatus: (message, isError) => {
				status.textContent = message;
				status.classList.toggle('is-error', isError);
				status.setAttribute('role', isError ? 'alert' : 'status');
				status.hidden = !message;
			},
		};
		const toolCatalog = resources.add(new AgentCapabilitiesSettings(pageContent, this.capabilities, this.remote, this.permissions, this.localization));
		const renderer = resources.add(new SettingsRenderer(list, settingOptions));
		const modelContent = resources.add(this.instantiationService.createInstance(ModelSettingsContent, list));
		const dictationContent = resources.add(this.instantiationService.createInstance(DictationSettingsContent, list));
		const customizeContent = resources.add(contentServices.createInstance(SessionsCustomizeContent, list, async () => { dialog.close(); }, this.showEditor));
		const advisorContent = resources.add(contentServices.createInstance(AdvisorSettingsContent, list));
		const githubSettings = resources.add(contentServices.createInstance(GitHubSettingsModel, async () => { dialog.close(); }));
		const githubContent = resources.add(contentServices.createInstance(SettingsSectionRenderer, list, githubSettings, AccessibleViewProviderId.GitHubSettings, AccessibilityVerbositySettingId.GitHubSettings));
		const traceSettings = resources.add(contentServices.createInstance(TraceSettingsModel));
		const traceContent = resources.add(contentServices.createInstance(SettingsSectionRenderer, list, traceSettings, AccessibleViewProviderId.TraceSettings, AccessibilityVerbositySettingId.TraceSettings));
		const sections = this.sections(modelContent, dictationContent, customizeContent, advisorContent, githubContent, traceContent);
		const categories = sections.flatMap(section => section.categories);
		if (categoryId === 'skills' || categoryId === 'plugins' || categoryId === 'hooks') customizeContent.selectTab(categoryId);
		let activeCategory = categoryId === 'customize' || categoryId === 'skills' || categoryId === 'plugins' || categoryId === 'hooks' ? categories.findIndex(category => category.content === customizeContent)
			: categoryId === 'dictation' ? categories.findIndex(category => category.content === dictationContent)
				: categoryId === 'github' ? categories.findIndex(category => category.content === githubContent)
					: categoryId === 'execution-trace' ? categories.findIndex(category => category.content === traceContent)
						: categoryId === 'agents' ? categories.findIndex(category => category.content === advisorContent)
							: categoryId === 'models' ? categories.findIndex(category => category.content === modelContent)
								: categoryId === 'tools' ? categories.findIndex(category => category.id === 'tools') : 0;
		const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const treeModel = resources.add(new SettingsTreeModel<ISetting | SettingsContentItem>(id =>
			// Keep service-only sections out of the local-user filter without creating configuration copies.
			configurationRegistry.getConfiguration(id) !== undefined && this.configurationService.inspect(id).userLocalValue !== undefined,
		));
		const tree = resources.add(new SettingsTree(list, {
			model: treeModel,
			rootClassName: 'ash-sessions-settings-content-tree',
			groupClassName: 'ash-sessions-settings-content-group',
			groupDescriptionClassName: 'ash-sessions-settings-group-description',
			itemsClassName: 'ash-sessions-settings-list ash-settings-card',
			renderItem: item => 'domNode' in item.value ? item.value.domNode : renderer.render(item.value),
			updateItem: item => { if (!('domNode' in item.value)) renderer.update(item.value); },
			disposeItem: item => { if (!('domNode' in item.value)) renderer.disposeSetting(item.id); },
		}));
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
						pageScrollable.scrollTo(0, 0);
					},
				}));
				button.domNode.classList.add('ash-sessions-settings-navigation-item');
				buttons.push(button);
			}
		}
		const render = (): void => {
			const query = new SettingsSearchQuery(searchInput.value);
			const nodes: readonly SettingsTreeNode<ISetting | SettingsContentItem>[] = categories.map((category, index) => ({
				element: { kind: 'group', id: `sessions.category.${index}`, title: category.title, description: '' },
				children: [
					...category.settings.map(setting => ({ element: { kind: 'item' as const, id: setting.id, title: setting.title, description: setting.description, keywords: [setting.id, ...setting.keywords ?? []], value: setting } })),
					...category.content?.getNodes(query) ?? [],
				],
			}));
			treeModel.setChildren(nodes);
			tree.setNavigationTarget(query.isEmpty ? `sessions.category.${activeCategory}` : undefined);
			treeModel.setQuery(query);
			for (const [index, category] of categories.entries()) {
				category.content?.setVisible(!query.isEmpty || index === activeCategory);
			}
			heading.textContent = query.isEmpty ? categories[activeCategory].title : localize('sessions.settings.results', 'Search results');
			const showTools = query.isEmpty && categories[activeCategory].id === 'tools';
			toolCatalog.setView(showTools ? 'tools' : undefined);
			heading.hidden = treeModel.visibleItems.length === 0 && !showTools;
			empty.hidden = treeModel.visibleItems.length !== 0 || query.isEmpty;
			for (const [index, button] of buttons.entries()) {
				const isCurrent = query.isEmpty && index === activeCategory;
				button.toggleClassName('is-current', isCurrent);
				if (isCurrent) button.domNode.setAttribute('aria-current', 'page');
				else button.domNode.removeAttribute('aria-current');
			}
			pageScrollable.layout();
		};
		for (const category of categories) {
			if (category.content) resources.add(category.content.onDidChange(render));
		}
		resources.add(this.configurationService.onDidChangeConfiguration(() => {
			if (new SettingsSearchQuery(searchInput.value).hasModifiedFilter) render();
		}));
		this.navigate = (categoryId, marketplaceOptions) => {
			if (categoryId === 'skills' || categoryId === 'plugins' || categoryId === 'hooks') customizeContent.selectTab(categoryId);
			activeCategory = categoryId === 'customize' || categoryId === 'skills' || categoryId === 'plugins' || categoryId === 'hooks' ? categories.findIndex(category => category.content === customizeContent)
				: categoryId === 'github' ? categories.findIndex(category => category.content === githubContent)
					: categoryId === 'agents' ? categories.findIndex(category => category.content === advisorContent)
						: categoryId === 'models' ? categories.findIndex(category => category.content === modelContent)
							: categoryId === 'tools' ? categories.findIndex(category => category.id === 'tools') : categories.findIndex(category => category.content === dictationContent);
			searchInput.value = '';
			render();
			if (marketplaceOptions) void customizeContent.openPlugins(marketplaceOptions);
		};
		resources.add(searchInput.onDidChange(() => {
			render();
			pageScrollable.scrollTo(0, 0);
		}));
		render();
		dialog.element.classList.add('ash-sessions-settings-dialog');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsSettings);
		if (hint) dialog.element.setAttribute('aria-description', hint);
		resources.add(AccessibleViewRegistry.register({
			type: AccessibleViewType.View, priority: 100, name: 'sessionsSettingsView',
			when: ContextKeyExpr.has('sessionsSettingsFocused'),
			getProvider: () => {
				const focused = ownerDocument.activeElement as HTMLElement;
				return new AccessibleContentProvider(AccessibleViewProviderId.SessionsSettings, { type: AccessibleViewType.View },
					() => pageContent.innerText, () => focused.focus(), AccessibilityVerbositySettingId.SessionsSettings);
			},
		}));

		const scope = resources.add(this.contextKeys.createScoped(dialog.element));
		scope.createKey('sessionsSettingsFocused', true);
		this.dialog = dialog;
		this.activeDialog.value = resources;
		try {
			const shown = dialog.show();
			if (marketplaceOptions) void customizeContent.openPlugins(marketplaceOptions);
			await shown;
		} finally {
			this.navigate = undefined;
			this.dialog = undefined;
			this.activeDialog.clear();
		}
	}

	private sections(modelContent: SettingsContent, dictationContent: SettingsContent, customizeContent: SettingsContent, advisorContent: SettingsContent, githubContent: SettingsContent, traceContent: SettingsContent): readonly SettingsSection[] {
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
		const designSettings: readonly ISetting[] = [{
			id: DesignConfiguration.usePointerCursor,
			valueType: 'boolean',
			configuration: configuration<boolean>(DesignConfiguration.usePointerCursor),
			title: localize('sessions.design.usePointerCursor.title', 'Use pointer cursor on the canvas'),
			description: localize('sessions.design.usePointerCursor.description', 'Show the cursor icon on the Design canvas. Turn this off to use a hand cursor. Dragging shows a grabbing hand.'),
		}, {
			id: AccessibilityVerbositySettingId.DesignCanvas,
			valueType: 'boolean',
			configuration: configuration<boolean>(AccessibilityVerbositySettingId.DesignCanvas),
			title: localize('sessions.design.verbosityTitle', 'Design canvas accessibility help'),
			description: localize('sessions.design.verbosityDescription', 'Announce how to open accessibility help when the Design canvas receives focus.'),
		}];
		const librarySettings: readonly ISetting[] = [{ id: AccessibilityVerbositySettingId.Library, valueType: 'boolean', configuration: configuration<boolean>(AccessibilityVerbositySettingId.Library), title: localize('library.verbosityTitle', 'Library accessibility help'), description: localize('library.verbosityDescription', 'Announce how to open accessibility help when Library receives focus.') }];
		return [{
			title: localize('sessions.settings.section.basics', 'Basics'),
			categories: [
				{ title: localize('sessions.settings.general', 'General'), icon: Lxicon.settings, settings: generalSettings, content: dictationContent },
				{ title: localize('sessions.settings.account', 'Account'), icon: Lxicon.account, settings: [] },
				{ title: localize('sessions.settings.appearance', 'Appearance'), icon: Lxicon.appearance, settings: appearanceSettings },
				{ title: localize('sessions.settings.customize', 'Customize'), icon: Lxicon.briefcase, settings: [], content: customizeContent },
			],
		}, {
			title: localize('sessions.settings.section.development', 'Development'),
			categories: [
				{ id: 'tools', title: localize('sessions.settings.tools', 'Tools'), icon: Lxicon.settings, settings: [] },
				{ title: localize('sessions.settings.agents', 'Agents'), icon: Lxicon.agent, settings: [], content: advisorContent },
				{ title: localize('sessions.settings.executionTrace', 'Execution trace'), icon: Lxicon.history, settings: [], content: traceContent },
				{ title: localize('library.title', 'Library'), icon: Lxicon.library, settings: librarySettings },
				{ title: localize('sessions.settings.design', 'Design'), icon: Lxicon.symbolColor, settings: designSettings },
				{ title: localize('sessions.settings.models', 'Models'), icon: Lxicon.model, settings: [], content: modelContent },
				{ title: localize('sessions.settings.gitPrs', 'Git & PRs'), icon: Lxicon.git, settings: [], content: githubContent },
				{ title: localize('sessions.settings.worktree', 'Worktree'), icon: Lxicon.gitBranch, settings: [] },
				{ title: localize('sessions.settings.browser', 'Browser'), icon: Lxicon.browserWeb, settings: [] },
				{ title: localize('sessions.settings.tab', 'Tab'), icon: Lxicon.keyboardTab, settings: [] },
				{ title: localize('sessions.settings.codeIntelligence', 'Code Intelligence'), icon: Lxicon.code, settings: [] },
				{ title: localize('sessions.settings.environment', 'Environment'), icon: Lxicon.terminal, settings: [] },
			],
		}, {
			title: localize('sessions.settings.section.management', 'Management'),
			categories: [
				{ title: localize('sessions.settings.shortcuts', 'Keyboard Shortcuts'), icon: Lxicon.command, settings: [] },
				{ title: localize('sessions.settings.archivedChats', 'Archived Chats'), icon: Lxicon.archive, settings: [] },
			],
		}];
	}
}
