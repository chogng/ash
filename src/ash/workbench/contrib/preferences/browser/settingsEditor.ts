import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { SearchSettingsContent } from '../../search/browser/searchSettingsContent.js';
import { NetworkSettingsContent } from './networkSettingsContent.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import './media/settingsEditor.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDirPermissionsService } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacksService.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { DESKTOP_UPDATE_POLICY_SETTING, type DesktopUpdatePolicy } from '../../../../platform/update/common/updateService.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { GitConfiguration, type GitAutofetch } from '../../git/common/gitConfiguration.js';
import { IGitService } from '../../git/common/gitService.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { ILocaleService, LocalizationConfiguration } from '../../../services/localization/common/locale.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import type { ISelectSetting, ISetting, ISettingsEditorModel } from '../../../services/preferences/common/preferences.js';
import { isSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { DefaultSettings, SettingsEditorModel } from '../../../services/preferences/common/settingsModels.js';
import { SettingsRenderer } from './settingsRenderers.js';
import { SkillsSettingsContent } from '../../skills/browser/skillsSettingsContent.js';
import { HooksSettingsContent } from '../../hooks/browser/hooksSettingsContent.js';
import { LanguageServerSettingsContent } from '../../language/browser/languageServerSettingsContent.js';
import { AdvisorSettingsContent } from '../../chat/browser/advisorSettingsContent.js';
import { ModelSettingsContent } from '../../chat/browser/modelSettingsContent.js';
import { DictationSettingsContent } from '../../chat/browser/speechToText/dictationSettingsContent.js';
import { AgentCapabilitiesSettings } from './agentCapabilitiesSettings.js';
import { SettingsSearchQuery } from './settingsSearch.js';
import { SettingsSearchWidget } from './settingsWidgets.js';
import { createSettingsLayout, settingsRootNodes, SettingsCategories, type SettingsCategoryDescriptor, type SettingsCategoryGroupDescriptor } from './settingsLayout.js';
import { SettingsTree } from './settingsTree.js';
import { SettingsTreeModel, type SettingsContent, type SettingsContentItem, type SettingsTreeNode } from './settingsTreeModels.js';
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
	private readonly clipboardService: IClipboardService;
	private readonly contextMenuProvider: IContextMenuProvider;
	private readonly contextViewProvider: IContextViewProvider;
	private element!: HTMLDivElement;
	private readonly localizationService: ILocalizationService;
	private navigationEmpty!: HTMLParagraphElement;
	private navigationScrollable!: ScrollableElement;
	private readonly settingsModel: ISettingsEditorModel;
	private agentCapabilitiesSettings!: AgentCapabilitiesSettings;
	private languageServerSettings!: LanguageServerSettingsContent;
	private readonly contents: SettingsContent[] = [];
	private settingsTree!: SettingsTree<ISetting | SettingsContentItem>;
	private tocTree!: TOCTree;
	private treeModel!: SettingsTreeModel<ISetting | SettingsContentItem>;
	private activeCategory!: SettingsCategoryDescriptor;
	private rootDomNode: HTMLDivElement | undefined;
	private searchWidget: SettingsSearchWidget | undefined;
	private visible = false;
	private sectionToReveal: string | undefined;

	constructor(
		@IClipboardService clipboardService: IClipboardService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService contextMenuProvider: IContextMenuProvider,
		@IContextViewService contextViewProvider: IContextViewProvider,
		@ILocalizationService localizationService: ILocalizationService,
		@ILocaleService localeService: ILocaleService,
		@ILanguagePackService private readonly languagePackService: ILanguagePackService,
		@IGitService gitService: IGitService,
		@IAgentCapabilitiesService private readonly agentCapabilitiesService: IAgentCapabilitiesService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IDirPermissionsService private readonly dirPermissionsService: IDirPermissionsService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(SettingsEditorId, themeService, storageService);
		this.configurationService = configurationService;
		this.localizationService = localizationService;
		this.settingsModel = this._register(new SettingsEditorModel([
			...new DefaultSettings().all.map(setting => {
				if (setting.id === DESKTOP_UPDATE_POLICY_SETTING) return localUpdatePolicySetting(setting, configurationService);
				if (setting.id === LocalizationConfiguration.locale) return displayLanguageSetting(setting, localeService, languagePackService, localizationService, configurationService);
				return setting;
			}),
			...gitSettings(gitService),
		]));
		this.clipboardService = clipboardService;
		this.contextMenuProvider = contextMenuProvider;
		this.contextViewProvider = contextViewProvider;
	}

	public override create(container: HTMLElement): void {
		if (this.rootDomNode) throw new Error('Settings editor has already been created');
		const settingsLayout = createSettingsLayout(this.settingsModel.settings);
		this.treeModel = this._register(new SettingsTreeModel<ISetting | SettingsContentItem>());
		this.treeModel.setChildren(settingsRootNodes(settingsLayout));
		const settingsRenderer = this._register(new SettingsRenderer(container, {
			clipboardService: this.clipboardService,
			configurationService: this.configurationService,
			contextMenuProvider: this.contextMenuProvider,
			contextViewProvider: this.contextViewProvider,
			onStatus: this.settingsModel.reportStatus,
			onOpenSettings: key => this.preferencesService.openUserSettings({ target: ConfigurationTarget.USER_LOCAL, revealSetting: { key, edit: true } }),
		}));

		const ownerDocument = container.ownerDocument;
		const rootDomNode = h(ownerDocument, 'div');
		rootDomNode.className = 'ash-settings-editor';
		const bodyId = `ash-settings-editor-body-${nextSettingsEditorId++}`;
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
		navigation.setAttribute('aria-label', 'Settings categories');
		this.navigationScrollable = this._register(new ScrollableElement(navigation, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
			wheel: { consume: 'when-scrolling' },
		}));
		this.navigationScrollable.element.classList.add('ash-settings-sidebar-scrollable');
		this.tocTree = this._register(new TOCTree(this.navigationScrollable.contentElement, new TOCTreeModel(this.treeModel), {
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

		const initialCategory = SettingsCategories[0];
		if (!initialCategory) throw new Error('Settings requires at least one category');
		this.activeCategory = initialCategory;
		this.contents.push(
			this._register(this.instantiationService.createInstance(NetworkSettingsContent, settingsContent)),
			this._register(this.instantiationService.createInstance(SearchSettingsContent, settingsContent)),
			this._register(this.instantiationService.createInstance(AdvisorSettingsContent, settingsContent)),
			this._register(this.instantiationService.createInstance(SkillsSettingsContent, settingsContent)),
			this._register(this.instantiationService.createInstance(ModelSettingsContent, settingsContent)),
			this._register(this.instantiationService.createInstance(DictationSettingsContent, settingsContent)),
			this._register(this.instantiationService.createInstance(HooksSettingsContent, settingsContent, async () => { await this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand(CLOSE_EDITOR_COMMAND_ID)); })),
		);
		this.languageServerSettings = this._register(this.instantiationService.createInstance(LanguageServerSettingsContent, settingsContent));
		this.contents.push(this.languageServerSettings);
		this.rebuildContent();
		for (const content of this.contents) {
			this._register(content.onDidChange(() => this.rebuildContent()));
		}
		this.treeModel.setNavigationTarget(initialCategory.id);
		this.settingsTree = this._register(new SettingsTree(settingsContent, {
			model: this.treeModel,
			rootClassName: 'ash-settings-content-tree',
			groupClassName: 'ash-configuration-settings-group ash-settings-content-group',
			groupDescriptionClassName: 'ash-configuration-settings-group-description',
			itemsClassName: 'ash-configuration-settings-list',
			renderItem: item => 'domNode' in item.value ? item.value.domNode : settingsRenderer.render(item.value),
			updateItem: item => { if (!('domNode' in item.value)) settingsRenderer.update(item.value); },
			disposeItem: item => { if (!('domNode' in item.value)) settingsRenderer.disposeSetting(item.id); },
		}));
		this.agentCapabilitiesSettings = this._register(new AgentCapabilitiesSettings(settingsContent, this.agentCapabilitiesService, this.remoteAgentService, this.dirPermissionsService, this.localizationService));
		this.renderCategory(initialCategory);

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
			this.navigationEmpty.hidden = !pattern || matches.length !== 0;
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
		const targetId = new URLSearchParams(input.resource.toEncodedComponents().query).get('target');
		if (targetId) {
			// The content model owns section identities and their containing page.
			const target = this.treeModel.getNode(targetId);
			if (!target || target.element.kind !== 'group') throw new RangeError(`Settings target is not available: ${targetId}`);
			let root = target;
			while (root.parent?.element) root = root.parent;
			const category = SettingsCategories.find(candidate => candidate.id === root.element.id)!;
			this.searchWidget!.value = '';
			this.search('');
			this.renderCategory(category);
			this.sectionToReveal = targetId !== category.id ? targetId : undefined;
			this.revealSection();
		}
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
		this.searchWidget?.focus();
	}

	private revealSection(): void {
		// New modal editors receive their input before they become visible and get a usable viewport.
		if (!this.sectionToReveal || !this.visible || this.contentScrollable.state.height === 0) return;
		const section = this.settingsTree.getGroupElement(this.sectionToReveal)!;
		const top = section.getBoundingClientRect().top - this.contentScrollable.scrollableElement.getBoundingClientRect().top + this.contentScrollable.state.top;
		this.contentScrollable.scrollTo(0, top);
		this.sectionToReveal = undefined;
	}

	private search(text: string): void {
		const query = new SettingsSearchQuery(text);
		this.treeModel.setQuery(query);
		this.settingsTree.setNavigationTarget(query.isEmpty ? this.activeCategory.id : undefined);
		this.rebuildContent();
		this.updateContentVisibility();
		this.agentCapabilitiesSettings.setView(query.isEmpty && (this.activeCategory.id === 'tools' || this.activeCategory.id === 'sandbox') ? this.activeCategory.id : undefined);
		this.navigationScrollable.scrollTo(0, 0);
		this.navigationScrollable.layout();
	}

	private rebuildContent(): void {
		const query = new SettingsSearchQuery(this.searchWidget?.value ?? '');
		const ownedSettings = new Set(this.contents.flatMap(content => content.settingIds ?? []));
		const nodes: readonly SettingsTreeNode<ISetting | SettingsContentItem>[] = settingsRootNodes(createSettingsLayout(this.settingsModel.settings)).map(root => ({
			...root,
			children: [
				...(root.children ?? []).map(group => ({ ...group, children: group.children?.filter(item => !ownedSettings.has(item.element.id)) })).filter(group => (group.children?.length ?? 0) > 0),
				...this.contents.filter(content => content.categoryId === root.element.id).flatMap(content => content.getNodes(query)),
			],
		}));
		this.treeModel.setChildren(nodes);
		this.contentEmpty.textContent = this.localized('chrome.noResults', 'No settings found.');
		this.contentEmpty.hidden = query.isEmpty || this.treeModel.visibleItems.some(item => !('domNode' in item.value) || !item.value.domNode.hidden);
		this.tocTree.refresh();
		this.tocTree.setFindPattern(query.text);
	}

	private updateContentVisibility(): void {
		const query = new SettingsSearchQuery(this.searchWidget?.value ?? '');
		// A global query loads each catalog so model names and Hook commands can become searchable.
		for (const content of this.contents) {
			content.setVisible(this.visible && (!query.isEmpty || content.categoryId === this.activeCategory.id));
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
		this.agentCapabilitiesSettings.setView(!this.searchWidget?.value && (category.id === 'tools' || category.id === 'sandbox') ? category.id : undefined);
		this.contentHeading.textContent = this.localizedCategoryLabel(category);
		this.contentDescription.textContent = this.localizedCategoryDescription(category);
		this.contentScrollable.scrollTo(0, 0);
		this.contentScrollable.layout();
	}

	private openNavigationEntry(entry: SettingsTOCOpenEntry): void {
		this.renderCategory(entry.category);
	}

	private updateLocalizedChrome(): void {
		this.navigationEmpty.textContent = this.localized('chrome.noResults', 'No settings found.');
		this.tocTree.rerender();
		this.contentHeading.textContent = this.localizedCategoryLabel(this.activeCategory);
		this.contentDescription.textContent = this.localizedCategoryDescription(this.activeCategory);
	}

	private localized(key: string, fallback: string): string {
		return this.localizationService.translate('ash.settings', key, fallback);
	}

	private localizedCategoryLabel(category: SettingsCategoryDescriptor): string {
		return this.localized(`categories.${category.id}.label`, category.label);
	}

	private localizedCategoryDescription(category: SettingsCategoryDescriptor): string {
		return this.localized(`categories.${category.id}.description`, category.description);
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
			const options = languagePacks.availableLocales.map(locale => ({ value: locale.locale, label: locale.localizedLanguageName }));
			const preference = configuration.getValue<string>(LocalizationConfiguration.locale);
			// A selected local resource remains valid after its Marketplace package is removed.
			if (!options.some(option => option.value === preference)) options.push({ value: preference, label: preference });
			return options;
		},
		// The setting shows the next startup's preference while this UI keeps its active language.
		binding: {
			id: setting.id,
			defaultValue: setting.configuration.defaultValue,
			onDidChange: listener => configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(LocalizationConfiguration.locale)) { listener(); } }),
			getValue: () => configuration.getValue(LocalizationConfiguration.locale),
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
			getValue: () => configuration.inspect<DesktopUpdatePolicy>(DESKTOP_UPDATE_POLICY_SETTING).userLocalValue ?? 'latest',
			updateValue: (value: string | boolean) => configuration.updateValue(DESKTOP_UPDATE_POLICY_SETTING, value, ConfigurationTarget.USER_LOCAL),
			resetValue: () => configuration.updateValue(DESKTOP_UPDATE_POLICY_SETTING, undefined, ConfigurationTarget.USER_LOCAL),
		},
	};
}

function gitSettings(gitService: IGitService): readonly ISetting[] {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const mode = registry.getConfiguration(GitConfiguration.autofetch) as IRegisteredConfiguration<GitAutofetch> | undefined;
	const period = registry.getConfiguration(GitConfiguration.autofetchPeriod) as IRegisteredConfiguration<number> | undefined;
	if (!mode || !period) throw new Error('Git settings require their migration definitions');
	return [
		{
			id: mode.key,
			valueType: 'select',
			configuration: mode as IRegisteredConfiguration<string | boolean>,
			get title() { return localize('git.autofetch.title', 'Auto Fetch'); },
			get description() { return localize('git.autofetch.description', 'Periodically fetch updates without changing local branches or files.'); },
			get options() {
				return [
					{ value: false, label: localize('git.autofetch.off', 'Off') },
					{ value: true, label: localize('git.autofetch.default', 'Default remote') },
					{ value: 'all', label: localize('git.autofetch.all', 'All remotes') },
				] as const;
			},
			binding: {
				id: mode.key,
				defaultValue: false,
				onDidChange: gitService.onDidChangeAutoFetch,
				getValue: () => gitService.autoFetch,
				updateValue: value => gitService.setAutoFetch(value as GitAutofetch),
				resetValue: () => gitService.setAutoFetch(false),
			},
		},
		{
			id: period.key,
			valueType: 'number',
			configuration: period,
			get title() { return localize('git.autofetchPeriod.title', 'Auto Fetch Period'); },
			get description() { return localize('git.autofetchPeriod.description', 'Seconds between automatic fetches for each repository.'); },
			minimum: 1,
			maximum: 86_400,
			binding: {
				id: period.key,
				defaultValue: 180,
				onDidChange: gitService.onDidChangeAutoFetch,
				getValue: () => gitService.autoFetchPeriod,
				updateValue: value => gitService.setAutoFetchPeriod(value),
				resetValue: () => gitService.setAutoFetchPeriod(180),
			},
		},
	];
}

let nextSettingsEditorId = 1;
