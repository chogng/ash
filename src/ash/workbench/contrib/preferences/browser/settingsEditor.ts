import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { BrowserPasswordSettingsRenderer } from './browserPasswordSettingsRenderer.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import type { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ExtensionSettingBinding } from './extensionSettingBinding.js';
import { GitHubSettingsModel } from '../../github/browser/githubSettingsModel.js';
import { TraceSettingsModel } from '../../trace/browser/traceSettingsModel.js';
import { SettingsSectionRenderer } from './settingsSectionRenderer.js';
import { SnapshotSettingsRenderer } from './snapshotSettingsRenderer.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { SearchSettingsModel } from '../../search/browser/searchSettingsModel.js';
import { NetworkSettingsRenderer } from './networkSettingsRenderer.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import './media/settingsEditor.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SegmentedControl } from '../../../../base/browser/ui/segmentedControl/segmentedControl.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceTrustApi } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { ConfigurationTarget, IConfigurationService, type IConfigurationOverrides } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { DESKTOP_UPDATE_POLICY_SETTING, type DesktopUpdatePolicy } from '../../../../platform/update/common/updateService.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { ILocaleService, LocalizationConfiguration } from '../../../services/localization/common/locale.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import type { IOpenSettingsOptions, ISelectSetting, ISetting } from '../../../services/preferences/common/preferences.js';
import { isSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { configurationSettingBinding, DefaultSettings, SettingsEditorModel } from '../../../services/preferences/common/settingsModels.js';
import type { SettingWidgetOptions } from './settingsWidgets.js';
import { SettingsRenderer, SettingsPageRenderer } from './settingsRenderers.js';
import { Event } from '../../../../base/common/event.js';
import { AICustomizationManagementEditorInput } from '../../chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { LanguageServerSettingsRenderer } from './languageServerSettingsRenderer.js';
import { getSettingsSections } from '../../../services/preferences/browser/settingsSections.js';
import { AgentTaskModelSettingsModel } from './agentTaskModelSettingsModel.js';
import { ModelSettingsRenderer } from './modelSettingsRenderer.js';
import { DictationSettingsRenderer } from './dictationSettingsRenderer.js';
import { AgentCapabilitiesSettings } from './agentCapabilitiesSettings.js';
import { SandboxSettingsModel } from './sandboxSettingsModel.js';
import { IAgentExecutionSettingsService } from '../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { SettingsSearchQuery } from './settingsSearch.js';
import { SettingsSearchWidget } from './settingsWidgets.js';
import { createSettingsLayout, settingsRootNodes, SettingsCategories, SettingsNavigation, type SettingsLayoutCategory, type SettingsNavigationDescriptor, type SettingsCategoryDescriptor, type SettingsCategoryGroupDescriptor } from './settingsLayout.js';
import { SettingsTree } from './settingsTree.js';
import { SettingsTreeModel, type SettingsSectionReference, type SettingsTreeNode } from './settingsTreeModels.js';
import { TOCTree, TOCTreeModel, type SettingsTOCOpenEntry } from './tocTree.js';

export const SettingsEditorId = 'workbench.editor.settings';

/** Owns the Settings search, navigation, and Configuration Registry-backed controls. */
export class SettingsEditor extends EditorPane implements IEditorPane {
	public readonly id = SettingsEditorId;
	private content!: HTMLElement;
	private contentDescription!: HTMLParagraphElement;
	private contentHeading!: HTMLHeadingElement;
	private contentScrollable!: ScrollableElement;
	private contentEmpty!: HTMLParagraphElement;
	private contentStatus!: HTMLParagraphElement;
	private readonly configurationService: IConfigurationService;
	private readonly contextMenuProvider: IContextMenuProvider;
	private readonly contextViewProvider: IContextViewProvider;
	private element!: HTMLDivElement;
	private readonly localizationService: ILocalizationService;
	private navigationEmpty!: HTMLParagraphElement;
	private navigationScrollable!: ScrollableElement;
	private readonly settingsModel: SettingsEditorModel;
	private settingsLayout: readonly SettingsLayoutCategory[] = [];
	private readonly extensionBindings = this._register(new DisposableMap<string, ExtensionSettingBinding>());
	private agentCapabilitiesSettings!: AgentCapabilitiesSettings;
	private languageServerSettings!: LanguageServerSettingsRenderer;
	private readonly contents: SettingsPageRenderer[] = [];
	private settingsTree!: SettingsTree<ISetting | SettingsSectionReference>;
	private settingsRenderer!: SettingsRenderer;
	private tocTree!: TOCTree;
	private treeModel!: SettingsTreeModel<ISetting | SettingsSectionReference>;
	private activeCategory!: SettingsCategoryDescriptor;
	private rootDomNode: HTMLDivElement | undefined;
	private searchWidget: SettingsSearchWidget | undefined;
	private visible = false;
	private sectionToReveal: string | undefined;
	private sectionSearch: SettingsPageRenderer['sectionSearch'];
	private target = ConfigurationTarget.USER_LOCAL;
	private folderUri: URI | undefined;
	private targetControls!: HTMLDivElement;
	private readonly targetSegments = this._register(new MutableDisposable<SegmentedControl<'user' | 'workspace'>>());
	private folderTargetButton!: Button;
	private targetLanguage!: HTMLSpanElement;
	private readonly widgetOptions: SettingWidgetOptions & {
		configurationTarget: ConfigurationTarget;
		configurationOverrides: IConfigurationOverrides;
	} = {
			configurationTarget: ConfigurationTarget.USER_LOCAL,
			configurationOverrides: {},
			onStatus: (message, isError) => this.settingsModel.reportStatus(message, isError),
			onOpenSettings: key => this.openSettingsJson(key),
			onRevealSetting: key => this.revealSetting(key),
		};

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService contextMenuProvider: IContextMenuProvider,
		@IContextViewService contextViewProvider: IContextViewProvider,
		@ILocalizationService localizationService: ILocalizationService,
		@ILocaleService private readonly localeService: ILocaleService,
		@ILanguagePackService private readonly languagePackService: ILanguagePackService,
		@IAgentCapabilitiesService private readonly agentCapabilitiesService: IAgentCapabilitiesService,
		@IAppServerRemoteAgentService private readonly remoteAgentService: IAppServerRemoteAgentService,
		@IAgentExecutionSettingsService private readonly executionSettings: IAgentExecutionSettingsService,
		@IWorkspaceTrustApi private readonly workspaceTrust: IWorkspaceTrustApi,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super(SettingsEditorId, themeService, storageService);
		this.configurationService = configurationService;
		this.localizationService = localizationService;
		this.settingsModel = this._register(new SettingsEditorModel(this.registeredSettings()));
		this.contextMenuProvider = contextMenuProvider;
		this.contextViewProvider = contextViewProvider;
	}

	public override create(container: HTMLElement): void {
		if (this.rootDomNode) throw new Error('Settings editor has already been created');
		this.settingsLayout = createSettingsLayout(this.settingsModel.settings);
		const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		this.treeModel = this._register(new SettingsTreeModel<ISetting | SettingsSectionReference>(id => {
			const configuration = configurationRegistry.getConfiguration(id);
			// Service-owned rows have no configuration key; explicit defaults still count as configured.
			if (!configuration) return false;
			return !configurationSettingBinding(this.configurationService, configuration, this.widgetOptions.configurationOverrides, this.target).isDefault!();
		}));
		this.treeModel.setChildren(settingsRootNodes(this.settingsLayout));
		const settingsRenderer = this._register(this.instantiationService.createInstance(SettingsRenderer, container, this.widgetOptions));
		this.settingsRenderer = settingsRenderer;

		const ownerDocument = container.ownerDocument;
		const rootDomNode = h(ownerDocument, 'div');
		rootDomNode.className = 'ash-settings-editor';
		const bodyId = `ash-settings-editor-body-${nextSettingsEditorId++}`;
		this.targetControls = h(ownerDocument, 'div');
		this.targetControls.className = 'ash-settings-target';
		this.createTargetSegments();
		this.folderTargetButton = this._register(new Button(this.targetControls, {
			...defaultButtonStyles,
			label: this.localized('target.folder', 'Folder'),
			ariaLabel: this.localized('target.folder', 'Folder'),
			icon: Lxicon.chevronDown,
			size: 'small',
			onClick: () => this.showFolderTargetMenu(),
		}));
		this.folderTargetButton.domNode.classList.add('ash-settings-target-folder');
		this.folderTargetButton.domNode.setAttribute('aria-haspopup', 'menu');
		this.folderTargetButton.domNode.setAttribute('aria-expanded', 'false');
		this.targetLanguage = h(ownerDocument, 'span');
		this.targetLanguage.className = 'ash-settings-target-language';
		this.targetControls.append(this.targetLanguage);
		this._register(toDisposable(() => this.targetControls.remove()));
		this.searchWidget = this._register(new SettingsSearchWidget(rootDomNode, {
			ariaControls: bodyId,
			contextMenuProvider: this.contextMenuProvider,
			localizationService: this.localizationService,
		}));
		this._register(this.searchWidget.onDidChange(value => this.search(value)));
		this._register(this.searchWidget.onDidRequestFocusResults(() => this.focusResults()));
		this.element = h(ownerDocument, 'div');
		this.element.className = 'ash-settings-layout';
		this.element.id = bodyId;

		const navigation = h(ownerDocument, 'nav');
		navigation.className = 'ash-settings-sidebar';
		navigation.setAttribute('aria-label', this.localized('chrome.categories', 'Settings categories'));
		this.navigationScrollable = this._register(new ScrollableElement(navigation, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
			wheel: { consume: 'when-scrolling' },
		}));
		this.navigationScrollable.element.classList.add('ash-settings-sidebar-scrollable');
		this.tocTree = this._register(new TOCTree(this.navigationScrollable.contentElement, new TOCTreeModel(this.treeModel, () => this.navigation()), {
			ariaLabel: this.localized('chrome.categories', 'Settings categories'),
			categoryLabel: category => this.localizedCategoryLabel(category),
			categoryDescription: category => this.localizedCategoryDescription(category),
			groupLabel: group => this.localizedGroupLabel(group),
			groupDescription: group => this.localizedGroupDescription(group),
		}));
		this.navigationEmpty = h(ownerDocument, 'p');
		this.navigationEmpty.className = 'ash-settings-navigation-empty';
		this.navigationEmpty.textContent = this.localized('chrome.noResults', 'No settings found.');
		this.navigationEmpty.setAttribute('role', 'status');
		this.navigationEmpty.hidden = true;
		this.navigationScrollable.append(this.navigationEmpty);

		this.content = h(ownerDocument, 'main');
		this.content.className = 'ash-settings-page';
		this.content.dataset.settingsContainer = '';
		this.content.tabIndex = -1;
		this.contentScrollable = this._register(new ScrollableElement(this.content, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
			wheel: { consume: 'when-scrolling' },
		}));
		this.contentScrollable.element.classList.add('ash-settings-page-scrollable');
		const contentInner = h(ownerDocument, 'div');
		contentInner.className = 'ash-settings-page-inner';
		this.contentHeading = h(ownerDocument, 'h3');
		this.contentHeading.id = `ash-settings-category-${nextSettingsEditorId++}`;
		this.content.setAttribute('aria-labelledby', this.contentHeading.id);
		this.contentDescription = h(ownerDocument, 'p');
		this.contentDescription.className = 'ash-settings-description';
		const settingsContent = h(ownerDocument, 'div');
		settingsContent.className = 'ash-settings-content';
		settingsContent.dataset.settingsContent = '';
		this.contentEmpty = h(ownerDocument, 'p');
		this.contentEmpty.className = 'ash-settings-content-empty';
		this.contentEmpty.setAttribute('role', 'status');
		this.contentEmpty.hidden = true;
		this.contentStatus = h(ownerDocument, 'p');
		this.contentStatus.className = 'ash-configuration-settings-status';
		this.contentStatus.setAttribute('role', 'status');
		this.contentStatus.setAttribute('aria-live', 'polite');
		this.contentStatus.hidden = true;
		contentInner.append(this.contentHeading, this.contentDescription, settingsContent, this.contentEmpty, this.contentStatus);
		this.contentScrollable.append(contentInner);
		this.content.append(this.contentScrollable.element);
		this.element.append(navigation, this.content);
		rootDomNode.append(this.element);
		container.append(rootDomNode);
		super.create(rootDomNode);
		this.rootDomNode = rootDomNode;
		// Model menus and their submenus share the Settings pane's overlay lifetime and layer.
		const modelViews = this._register(new BrowserContextViewService(rootDomNode));
		const modelServices = this._register(this.instantiationService.createChild(new ServiceCollection([IContextViewService, modelViews])));
		modelServices.registerInstance(IContextMenuService, this._register(modelServices.createInstance(BrowserContextMenuService)));

		const initialCategory = SettingsCategories[0];
		if (!initialCategory) throw new Error('Settings requires at least one category');
		this.activeCategory = initialCategory;
		const githubSettings = this._register(this.instantiationService.createInstance(GitHubSettingsModel, async () => { await this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand(CLOSE_EDITOR_COMMAND_ID)); }));
		const traceSettings = this._register(this.instantiationService.createInstance(TraceSettingsModel));
		const sandboxSettings = this._register(this.instantiationService.createInstance(SandboxSettingsModel));
		this.contents.push(
			this._register(this.instantiationService.createInstance(SnapshotSettingsRenderer, settingsContent)),
			this._register(this.instantiationService.createInstance(BrowserPasswordSettingsRenderer, settingsContent)),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, sandboxSettings, AccessibleViewProviderId.SandboxSettings, AccessibilityVerbositySettingId.SandboxSettings)),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, traceSettings, AccessibleViewProviderId.TraceSettings, AccessibilityVerbositySettingId.TraceSettings)),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, githubSettings, AccessibleViewProviderId.GitHubSettings, AccessibilityVerbositySettingId.GitHubSettings)),
			this._register(this.instantiationService.createInstance(NetworkSettingsRenderer, settingsContent)),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, this._register(this.instantiationService.createInstance(SearchSettingsModel)), AccessibleViewProviderId.ContentSearchSettings, AccessibilityVerbositySettingId.ContentSearchSettings)),
			...getSettingsSections().map(section => this._register(this.instantiationService.createInstance(
				SettingsSectionRenderer, settingsContent,
				this._register(this.instantiationService.createInstance(section.model)),
				section.accessibleViewProviderId, section.accessibilityVerbositySettingId,
			))),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, this._register(this.instantiationService.createInstance(AgentTaskModelSettingsModel, 'codeReviewModel')), AccessibleViewProviderId.ChatModelConfiguration, AccessibilityVerbositySettingId.ChatModelConfiguration)),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, this._register(this.instantiationService.createInstance(AgentTaskModelSettingsModel, 'commitMessageModel')), AccessibleViewProviderId.ChatModelConfiguration, AccessibilityVerbositySettingId.ChatModelConfiguration)),
			this._register(modelServices.createInstance(ModelSettingsRenderer, settingsContent)),
			this._register(this.instantiationService.createInstance(DictationSettingsRenderer, settingsContent)),
			this._register(this.instantiationService.createInstance(SettingsSectionRenderer, settingsContent, {
				categoryId: 'hooks',
				title: localize({ bundle: 'ash.settings', key: 'hooks.aria' }, 'Agent Hooks'),
				description: localize({ bundle: 'ash.settings', key: 'hooks.managementLink' }, 'Manage Hooks in Agent Customizations.'),
				help: localize({ bundle: 'ash.settings', key: 'hooks.managementLinkHelp' }, 'Open Manage Hooks to search events, inspect declarations, edit TOML, or ask Ash to configure a Hook.'),
				onDidChange: Event.None,
				fields: [{
					id: 'manage', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'hooks.manage' }, 'Manage Hooks'), enabled: true, run: () => this.instantiationService.invokeFunction(async accessor => {
						const commands = accessor.get(ICommandService);
						const editors = accessor.get(IEditorService);
						await commands.executeCommand(CLOSE_EDITOR_COMMAND_ID);
						await editors.openEditor(new AICustomizationManagementEditorInput(), { pinned: true });
					})
				}],
				setVisible: () => { },
			}, AccessibleViewProviderId.HooksSettings, AccessibilityVerbositySettingId.HooksSettings)),
		);
		this.languageServerSettings = this._register(this.instantiationService.createInstance(LanguageServerSettingsRenderer, settingsContent));
		this.contents.push(this.languageServerSettings);
		for (const content of this.contents) this._register(settingsRenderer.registerPage(content));
		this.rebuildContent();
		for (const content of this.contents) {
			this._register(content.onDidChange(() => this.rebuildContent()));
			if (content.onDidRequestReveal) {
				this._register(content.onDidRequestReveal(() => {
					this.searchWidget!.value = '';
					this.search('');
					this.treeModel.setNavigationTarget(content.categoryId);
				}));
			}
		}
		this.treeModel.setNavigationTarget(initialCategory.id);
		this.settingsTree = this._register(new SettingsTree(settingsContent, {
			model: this.treeModel,
			rootClassName: 'ash-settings-content-tree',
			groupClassName: 'ash-configuration-settings-group ash-settings-content-group',
			groupDescriptionClassName: 'ash-configuration-settings-group-description',
			itemsClassName: 'ash-configuration-settings-list',
			renderGroupHeader: header => settingsRenderer.render(header),
			renderItem: item => settingsRenderer.render(item.value),
			updateItem: item => { if (!('rendererId' in item.value)) settingsRenderer.update(item.value); },
			disposeItem: item => { if (!('rendererId' in item.value)) settingsRenderer.disposeSetting(item.id); },
		}));
		this._register(this.treeModel.onDidChange(() => this.updateSearchPresentation()));
		this.agentCapabilitiesSettings = this._register(new AgentCapabilitiesSettings(settingsContent, this.agentCapabilitiesService, this.remoteAgentService, this.workspaceTrust, this.localizationService, this.executionSettings));
		this.renderCategory(initialCategory);
		this._register(configurationRegistry.onDidUpdateConfiguration(({ properties }) => {
			// Remove changed schemas first so keyed controls release their old value bindings.
			this.treeModel.setChildren(settingsRootNodes(createSettingsLayout(this.settingsModel.settings.filter(setting => !properties.has(setting.id)))));
			for (const id of properties) this.extensionBindings.deleteAndDispose(id);
			this.settingsModel.setSettings(this.registeredSettings());
			this.rebuildContent();
			const category = this.settingsLayout.find(entry => entry.id === this.activeCategory.id)?.descriptor ?? SettingsCategories[0];
			this.renderCategory(category);
		}));
		this._register(this.configurationService.onDidChangeConfiguration(() => {
			if (new SettingsSearchQuery(this.searchWidget?.value ?? '').hasModifiedFilter) this.rebuildContent();
		}));
		this._register(this.workspace.onDidChangeWorkspace(() => {
			const current = this.workspace.getWorkspace();
			if (this.target !== ConfigurationTarget.USER_LOCAL) this.treeModel.setChildren([]);
			if (this.target === ConfigurationTarget.WORKSPACE_FOLDER && (!this.folderUri || !this.workspace.getWorkspaceFolder(this.folderUri))) {
				this.target = current.configuration || current.folders.length ? ConfigurationTarget.WORKSPACE : ConfigurationTarget.USER_LOCAL;
				this.folderUri = undefined;
			} else if (this.target === ConfigurationTarget.WORKSPACE && !current.configuration && !current.folders.length) {
				this.target = ConfigurationTarget.USER_LOCAL;
			}
			this.createTargetSegments();
			this.search(this.searchWidget?.value ?? '');
		}));
		this._register(this.languageService.onDidChange(() => this.search(this.searchWidget?.value ?? '')));

		const updateLanguageSetting = (): void => {
			// Recompute descriptors while the keyed renderer retains controls and keyboard focus.
			this.rebuildContent();
		};
		this._register(this.languagePackService.onDidChange(updateLanguageSetting));
		this._register(this.settingsModel.onDidChangeStatus(status => {
			this.contentStatus.textContent = status.message;
			this.contentStatus.classList.toggle('is-error', status.isError);
			this.contentStatus.hidden = !status.message;
		}));
		this._register(this.tocTree.onDidOpen(entry => this.openNavigationEntry(entry)));
		this._register(this.tocTree.onDidChangeFind(({ pattern, matches }) => {
			this.navigationEmpty.hidden = this.treeModel.isSearching || !pattern || matches.length !== 0;
		}));
		this._register(this.tocTree.onDidChangeCollapseState(({ element, collapsed }) => {
			if (element.kind !== 'group') return;
			const containsActiveCategory = element.group.categories.some(category => category.id === this.activeCategory.id);
			const activeId = this.activeCategory.id;
			this.tocTree.setSelection([containsActiveCategory && collapsed ? element.id : activeId]);
		}));
		this._register(toDisposable(() => rootDomNode.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isSettingsEditorInput(input)) throw new TypeError(`Settings editor cannot open ${input.resource}`);
		if (signal.aborted) throw signal.reason;
		this.languageServerSettings.setInput(input);
		this.search(this.searchWidget?.value ?? '');
		const parameters = new URLSearchParams(input.resource.query);
		this.setOptions({ section: parameters.get('target') ?? undefined, query: parameters.get('query') ?? undefined });
	}

	private openSettingsJson(key?: string): Promise<void> {
		const language = this.widgetOptions.configurationOverrides.overrideIdentifier;
		return this.preferencesService.openSettings({
			jsonEditor: true,
			groupId: this.group?.id,
			target: this.target,
			folderUri: this.folderUri,
			query: key ? undefined : this.searchWidget?.value,
			// Revealing an absent language block must not insert a base-user override.
			revealSetting: key ? { key: language ? `[${language}]` : key, edit: !language } : undefined,
		});
	}

	public override getTitleControl(): HTMLElement {
		return this.targetControls;
	}

	public override getActions(): readonly IAction[] {
		const label = localize({ bundle: 'ash.settings', key: 'editor.openJSON' }, 'Open Settings (JSON)');
		return [{
			id: 'settings.switchToJSON',
			label,
			tooltip: label + '\n' + localize({ bundle: 'ash.settings', key: 'editor.groupSwitchHelp' }, 'Switch between Settings UI and JSON in this editor group without changing the default settings editor. Unsaved JSON edits remain in the editor.'),
			icon: Lxicon.goToFile,
			enabled: true,
			run: () => this.openSettingsJson().catch(error => this.settingsModel.reportStatus(String(error), true)),
		}];
	}

	private createTargetSegments(): void {
		const workspace = this.workspace.getWorkspace();
		this.targetSegments.clear();
		const segments = new SegmentedControl<'user' | 'workspace'>(this.targetControls, {
			ariaLabel: this.localized('target.choose', 'Settings target'),
			items: [
				{ id: 'user', label: this.localized('target.user', 'User') },
				{ id: 'workspace', label: this.localized('target.workspace', 'Workspace'), disabled: !workspace.configuration && !workspace.folders.length },
			],
			selectedId: this.target === ConfigurationTarget.USER_LOCAL ? 'user' : 'workspace',
			onActivate: id => {
				const target = id === 'user' ? ConfigurationTarget.USER_LOCAL : ConfigurationTarget.WORKSPACE;
				if (this.target !== target) void this.openTarget(target);
			},
		});
		segments.domNode.setAttribute('aria-description', this.localized('target.help', 'Use Left and Right Arrow to focus User or Workspace, then Enter or Space to switch. In a multi-folder workspace, use Folder to choose a folder. Type @lang: followed by a language ID to edit language-specific settings. Modified filters, changes and resets use the selected target and language.'));
		this.targetSegments.value = segments;
		this.targetControls.prepend(segments.domNode);
	}

	private async openTarget(target: ConfigurationTarget, folderUri?: URI): Promise<void> {
		try {
			await this.preferencesService.openSettings({
				target,
				groupId: this.group?.id,
				folderUri,
				jsonEditor: false,
				query: this.searchWidget?.value,
			});
		} catch (error) {
			this.settingsModel.reportStatus(String(error), true);
		}
	}

	private showFolderTargetMenu(): void {
		if (this.folderTargetButton.domNode.getAttribute('aria-expanded') === 'true') return;
		this.folderTargetButton.domNode.setAttribute('aria-expanded', 'true');
		try {
			this.contextMenuProvider.showContextMenu({
				getAnchor: () => this.folderTargetButton.domNode,
				getCheckedActionsRepresentation: () => 'radio',
				onHide: () => this.folderTargetButton.domNode.setAttribute('aria-expanded', 'false'),
				getActions: () => this.workspace.getWorkspace().folders.map((folder, index) => ({
					id: `settings.target.${index}`,
					label: folder.name,
					tooltip: folder.uri.toString(),
					enabled: true,
					checked: this.target === ConfigurationTarget.WORKSPACE_FOLDER && this.folderUri?.toString() === folder.uri.toString(),
					run: () => this.openTarget(ConfigurationTarget.WORKSPACE_FOLDER, folder.uri),
				})),
			});
		} catch (error) {
			this.folderTargetButton.domNode.setAttribute('aria-expanded', 'false');
			throw error;
		}
	}

	public setOptions(options: IOpenSettingsOptions): void {
		this.sectionSearch = undefined;
		const target = options.target === ConfigurationTarget.USER ? ConfigurationTarget.USER_LOCAL : options.target ?? this.target;
		const folderUri = target === ConfigurationTarget.WORKSPACE_FOLDER ? options.folderUri ?? this.folderUri : undefined;
		if (target !== this.target || folderUri?.toString() !== this.folderUri?.toString()) {
			this.target = target;
			this.folderUri = folderUri;
			this.search(this.searchWidget?.value ?? '');
		}
		const targetId = options.section;
		if (targetId) {
			// The content model owns section identities and their containing page.
			const target = this.treeModel.getNode(targetId);
			if (!target || target.element.kind !== 'group') throw new RangeError(`Settings target is not available: ${targetId}`);
			let root = target;
			while (root.parent?.element) root = root.parent;
			const category = this.settingsLayout.find(candidate => candidate.id === root.element.id)!.descriptor;
			if (options.sectionQuery !== undefined) {
				this.sectionSearch = this.contents.find(content => content.categoryId === category.id)?.sectionSearch;
				if (!this.sectionSearch) { throw new RangeError(localize({ bundle: 'ash.settings', key: 'open.unsupportedSectionSearch' }, 'This Settings section does not provide its own search.')); }
			}
			this.searchWidget!.value = '';
			this.search('');
			this.renderCategory(category);
			this.sectionToReveal = targetId !== category.id ? targetId : undefined;
			this.revealSection();
		}
		if (options.query !== undefined) {
			this.searchWidget!.value = options.query;
			if (!options.preserveFocus && options.focusSearch !== false) this.focus();
		}
		if (options.sectionQuery !== undefined) { this.sectionSearch!.search(options.sectionQuery); }
		if (!options.preserveFocus && options.focusSearch === true) this.focus();
	}

	public override clearInput(): void {
		if (this.searchWidget) this.searchWidget.value = '';
	}

	public override layout(_dimension: IDimension): void {
		this.navigationScrollable.layout();
		this.contentScrollable.layout();
		this.revealSection();
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		this.visible = visibility;
		this.updateContentVisibility();
		this.revealSection();
	}

	public override focus(): void {
		if (!this.visible) return;
		if (this.sectionSearch) { this.sectionSearch.focus(); }
		else { this.searchWidget?.focus(); }
	}

	private revealSection(): void {
		// New modal editors receive their input before they become visible and get a usable viewport.
		if (!this.sectionToReveal || !this.visible || this.contentScrollable.state.height === 0) return;
		const section = this.settingsTree.getGroupElement(this.sectionToReveal)!;
		const top = section.getBoundingClientRect().top - this.contentScrollable.scrollableElement.getBoundingClientRect().top + this.contentScrollable.state.top;
		this.contentScrollable.scrollTo(0, top);
		this.sectionToReveal = undefined;
	}

	private revealSetting(key: string): void {
		for (const category of this.settingsLayout) {
			const group = category.groups.find(group => group.settings.some(setting => setting.id === key));
			if (!group) continue;
			this.setOptions({ section: `${category.id}.group.${group.id}`, focusSearch: false });
			this.settingsRenderer.focusSetting(key);
			return;
		}
	}

	private search(text: string): void {
		const query = new SettingsSearchQuery(text);
		if (query.isEmpty) {
			// Keep browsing scoped while replacing target-bound controls; hidden categories need no widgets.
			this.settingsTree.setNavigationTarget(this.treeModel.has(this.activeCategory.id) ? this.activeCategory.id : undefined);
		}
		const overrides = { resource: this.folderUri, overrideIdentifier: query.languageFilter };
		if (this.widgetOptions.configurationTarget !== this.target
			|| this.widgetOptions.configurationOverrides.resource?.toString() !== overrides.resource?.toString()
			|| this.widgetOptions.configurationOverrides.overrideIdentifier !== overrides.overrideIdentifier) {
			// Releasing old controls preserves their write address while new controls use the new context.
			this.treeModel.setChildren([]);
			this.widgetOptions.configurationTarget = this.target;
			this.widgetOptions.configurationOverrides = overrides;
		}
		this.element.dataset.settingsTarget = String(this.target);
		this.element.dataset.settingsLanguage = query.languageFilter ?? '';
		this.targetSegments.value!.setSelection(this.target === ConfigurationTarget.USER_LOCAL ? 'user' : 'workspace');
		const workspace = this.workspace.getWorkspace();
		this.folderTargetButton.hidden = !workspace.configuration || !workspace.folders.length;
		this.folderTargetButton.label = this.target === ConfigurationTarget.WORKSPACE_FOLDER
			? this.workspace.getWorkspaceFolder(this.folderUri!)?.name ?? this.localized('target.folder', 'Folder')
			: this.localized('target.folder', 'Folder');
		this.folderTargetButton.checked = this.target === ConfigurationTarget.WORKSPACE_FOLDER;
		this.folderTargetButton.setTitle(this.folderTargetButton.label);
		this.targetLanguage.textContent = query.languageFilter ? this.languageService.getLanguageName(query.languageFilter) ?? query.languageFilter : '';
		this.targetLanguage.hidden = !query.languageFilter;
		this.treeModel.setQuery(query);
		// Apply the global query before releasing the browsing scope to avoid an unfiltered render.
		if (!query.isEmpty) this.settingsTree.setNavigationTarget(undefined);
		this.rebuildContent();
		this.settingsTree.setNavigationTarget(query.isEmpty && this.treeModel.has(this.activeCategory.id) ? this.activeCategory.id : undefined);
		this.updateSearchPresentation();
		this.updateContentVisibility();
		this.agentCapabilitiesSettings.setView(query.isEmpty && this.activeCategory.id === 'sandbox' ? this.activeCategory.id : undefined);
		this.navigationScrollable.scrollTo(0, 0);
		this.navigationScrollable.layout();
		this.contentScrollable.scrollTo(0, 0);
		this.contentScrollable.layout();
	}

	private registeredSettings(): readonly ISetting[] {
		return new DefaultSettings().all.map(setting => {
			if (setting.id === DESKTOP_UPDATE_POLICY_SETTING) return localUpdatePolicySetting(setting, this.configurationService);
			if (setting.id === LocalizationConfiguration.locale) return displayLanguageSetting(setting, this.localeService, this.languagePackService, this.localizationService, this.configurationService);
			if (setting.configuration.extensionBinding && setting.valueType !== 'complex') {
				let binding = this.extensionBindings.get(setting.id);
				if (!binding) {
					binding = this.instantiationService.createInstance(ExtensionSettingBinding, setting.configuration);
					this.extensionBindings.set(setting.id, binding);
				}
				return { ...setting, binding } as ISetting;
			}
			return setting;
		});
	}

	private navigation(): readonly SettingsNavigationDescriptor[] {
		const categories = this.settingsLayout.filter(entry => entry.id.startsWith('extension.')).map(entry => entry.descriptor);
		if (categories.length === 0) return SettingsNavigation;
		return [...SettingsNavigation, {
			id: 'extensions',
			label: this.localized('groups.extensions.label', 'Extensions'),
			description: this.localized('groups.extensions.description', 'Configure installed extensions.'),
			categories,
		}];
	}

	private rebuildContent(): void {
		const query = new SettingsSearchQuery(this.searchWidget?.value ?? '');
		const ownedSettings = new Set(this.contents.flatMap(content => content.settingIds ?? []));
		const scoped = this.target !== ConfigurationTarget.USER_LOCAL || !!query.languageFilter;
		const settings = this.settingsModel.settings.filter(setting => {
			if (!scoped) return true;
			if (setting.binding || setting.configuration.extensionBinding || setting.configuration.agentsWindow?.readOnly) return false;
			const scope = setting.configuration.scope ?? ConfigurationScope.WINDOW;
			if (query.languageFilter && (!this.languageService.isRegisteredLanguageId(query.languageFilter) || scope !== ConfigurationScope.LANGUAGE_OVERRIDABLE)) return false;
			if (this.target === ConfigurationTarget.USER_LOCAL) return true;
			return scope === ConfigurationScope.RESOURCE || scope === ConfigurationScope.LANGUAGE_OVERRIDABLE
				|| scope === ConfigurationScope.MACHINE_OVERRIDABLE || this.target === ConfigurationTarget.WORKSPACE && scope === ConfigurationScope.WINDOW;
		});
		this.settingsLayout = createSettingsLayout(settings);
		const nodes: readonly SettingsTreeNode<ISetting | SettingsSectionReference>[] = settingsRootNodes(this.settingsLayout).map(root => ({
			...root,
			children: [
				...(root.children ?? []).map(group => ({ ...group, children: group.children?.filter(item => (scoped || !ownedSettings.has(item.element.id))) })).filter(group => (group.children?.length ?? 0) > 0),
				...this.contents.filter(content => !scoped && content.categoryId === root.element.id).flatMap(content => content.getNodes(query)),
			],
		}));
		this.treeModel.setChildren(nodes);
	}

	private updateSearchPresentation(): void {
		const searching = this.treeModel.isSearching;
		this.contentHeading.textContent = searching ? this.localized('chrome.searchResults', 'Search results') : this.localizedCategoryLabel(this.activeCategory);
		this.contentDescription.textContent = searching ? '' : this.localizedCategoryDescription(this.activeCategory);
		this.contentDescription.hidden = !this.contentDescription.textContent;
		this.contentEmpty.textContent = this.localized('chrome.noResults', 'No settings found.');
		this.contentEmpty.hidden = !searching || this.treeModel.visibleItems.some(item => !('rendererId' in item.value) || !item.value.hidden);
		this.tocTree.refresh();
		this.tocTree.setFindPattern(this.treeModel.query);
		if (searching) {
			for (const category of this.settingsLayout) {
				if (this.treeModel.countVisibleItems(category.id)) this.tocTree.expandTo(category.id);
			}
			this.tocTree.setSelection([]);
			this.navigationEmpty.hidden = true;
		} else {
			this.tocTree.expandTo(this.activeCategory.id);
			this.tocTree.setSelection([this.activeCategory.id]);
		}
	}

	private updateContentVisibility(): void {
		const query = new SettingsSearchQuery(this.searchWidget?.value ?? '');
		// A global query loads each catalog so model names and Hook commands can become searchable.
		for (const content of this.contents) {
			content.setVisible(this.visible && this.target === ConfigurationTarget.USER_LOCAL && !query.languageFilter && (!query.isEmpty || content.categoryId === this.activeCategory.id));
		}
	}

	private focusResults(): void {
		this.tocTree.domFocus();
	}

	private renderCategory(category: SettingsCategoryDescriptor): void {
		this.activeCategory = category;
		this.tocTree.expandTo(category.id);
		this.tocTree.setSelection([category.id]);
		this.content.dataset.activeSettingsCategory = category.id;
		this.settingsTree.setNavigationTarget(new SettingsSearchQuery(this.searchWidget?.value ?? '').isEmpty ? category.id : undefined);
		this.updateContentVisibility();
		this.agentCapabilitiesSettings.setView(!this.searchWidget?.value && category.id === 'sandbox' ? category.id : undefined);
		this.updateSearchPresentation();
		this.tocTree.setSelection([category.id]);
		this.contentScrollable.scrollTo(0, 0);
		this.contentScrollable.layout();
		if (this.treeModel.isSearching) {
			this.sectionToReveal = category.id;
			this.revealSection();
		}
	}

	private openNavigationEntry(entry: SettingsTOCOpenEntry): void {
		this.renderCategory(entry.category);
	}

	private updateLocalizedChrome(): void {
		this.navigationEmpty.textContent = this.localized('chrome.noResults', 'No settings found.');
		this.tocTree.rerender();
		this.updateSearchPresentation();
	}

	private localized(key: string, fallback: string): string {
		return this.localizationService.translate('ash.settings', key, fallback);
	}

	private localizedCategoryLabel(category: SettingsCategoryDescriptor): string {
		return category.id.startsWith('extension.') ? category.label : this.localized(`categories.${category.id}.label`, category.label);
	}

	private localizedCategoryDescription(category: SettingsCategoryDescriptor): string {
		return category.id.startsWith('extension.') ? category.description : this.localized(`categories.${category.id}.description`, category.description);
	}

	private localizedGroupLabel(group: SettingsCategoryGroupDescriptor): string {
		return this.localized(`groups.${group.id}.label`, group.label);
	}

	private localizedGroupDescription(group: SettingsCategoryGroupDescriptor): string {
		return this.localized(`groups.${group.id}.description`, group.description);
	}
}

function displayLanguageSetting(setting: ISetting, locale: ILocaleService, languagePacks: ILanguagePackService, localization: ILocalizationService, configuration: IConfigurationService): ISelectSetting {
	if (setting.valueType !== 'select') throw new TypeError('Display language requires a select setting');
	return {
		...setting,
		get title() { return localization.translate('ash.settings', 'displayLanguage.select', 'Interface language'); },
		get description() { return localization.translate('ash.settings', 'displayLanguage.description', 'Choose the language used by the Ash interface.'); },
		get options() {
			const options = languagePacks.catalogs
				.map(catalog => ({ value: catalog.locale, label: catalog.localizedLanguageName }))
				.sort((left, right) => left.value.localeCompare(right.value));
			const preference = configuration.getValue<string>(LocalizationConfiguration.locale);
			// A selected local resource remains valid after its Extensions package is removed.
			if (!options.some(option => option.value === preference)) options.push({ value: preference, label: preference });
			return options;
		},
		// The setting shows the next startup's preference while this UI keeps its active language.
		binding: {
			id: setting.id,
			defaultValue: setting.configuration.defaultValue,
			onDidChange: listener => configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(LocalizationConfiguration.locale)) { listener(); } }),
			getValue: () => configuration.getValue(LocalizationConfiguration.locale),
			isDefault: () => configuration.inspect(LocalizationConfiguration.locale).userLocalValue === undefined,
			updateValue: value => locale.setLocale({ id: String(value), label: String(value) }),
			resetValue: () => locale.clearLocalePreference(),
		},
	};
}

function localUpdatePolicySetting(setting: ISetting, configuration: IConfigurationService): ISetting {
	if (setting.valueType !== 'select') throw new TypeError('Desktop update policy requires a select setting');
	return {
		...setting,
		binding: {
			id: setting.id,
			defaultValue: 'latest',
			onDidChange: listener => configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(DESKTOP_UPDATE_POLICY_SETTING)) listener();
			}),
			getValue: () => {
				const value = configuration.inspect<DesktopUpdatePolicy>(DESKTOP_UPDATE_POLICY_SETTING);
				// This Desktop setting excludes workspace values but still honors OS policy.
				return value.policyValue ?? value.userLocalValue ?? 'latest';
			},
			isDefault: () => {
				const value = configuration.inspect(DESKTOP_UPDATE_POLICY_SETTING);
				return value.policyValue === undefined && value.userLocalValue === undefined;
			},
			updateValue: (value: string | boolean) => configuration.updateValue(DESKTOP_UPDATE_POLICY_SETTING, value, ConfigurationTarget.USER_LOCAL),
			resetValue: () => configuration.updateValue(DESKTOP_UPDATE_POLICY_SETTING, undefined, ConfigurationTarget.USER_LOCAL),
		},
	};
}

let nextSettingsEditorId = 1;
