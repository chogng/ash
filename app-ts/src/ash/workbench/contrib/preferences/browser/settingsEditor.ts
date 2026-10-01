import './media/settingsEditor.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDirPermissionsService } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacksService.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { DESKTOP_UPDATE_POLICY_SETTING, type DesktopUpdatePolicy } from '../../../../platform/update/common/updateService.js';
import { localize } from '../../../../nls.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { GitConfiguration, type GitAutofetch } from '../../../contrib/git/common/gitConfiguration.js';
import { IGitService } from '../../../contrib/git/common/gitService.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { ILocaleService, LocalizationConfiguration } from '../../../services/localization/common/locale.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import type { ISelectSetting, ISetting, ISettingsEditorModel } from '../../../services/preferences/common/preferences.js';
import { isSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { DefaultSettings, SettingsEditorModel } from '../../../services/preferences/common/settingsModels.js';
import { SettingsRenderer } from './settingsRenderers.js';
import { ModelsSettings } from './modelsSettings.js';
import { AgentCapabilitiesSettings } from './agentCapabilitiesSettings.js';
import { SettingsSearchQuery } from './settingsSearch.js';
import { SettingsSearchWidget } from './settingsWidgets.js';
import { createSettingsLayout, settingsRootNodes, SettingsCategories, type SettingsCategoryDescriptor, type SettingsCategoryGroupDescriptor, type SettingsLayoutCategory } from './settingsLayout.js';
import { SettingsTree } from './settingsTree.js';
import { SettingsTreeModel } from './settingsTreeModels.js';
import { TOCTree, TOCTreeModel, type SettingsTOCEntry, type SettingsTOCOpenEntry } from './tocTree.js';

export const SettingsEditorId = 'workbench.editor.settings';

/** Owns the Settings search, navigation, and Configuration Registry-backed controls. */
export class SettingsEditor extends Disposable implements IEditorPane {
	public readonly id = SettingsEditorId;
	private content!: HTMLElement;
	private contentDescription!: HTMLParagraphElement;
	private contentHeading!: HTMLHeadingElement;
	private contentScrollable!: ScrollableElement;
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
	private modelsSettings!: ModelsSettings;
	private agentCapabilitiesSettings!: AgentCapabilitiesSettings;
	private settingsTree!: SettingsTree<ISetting>;
	private tocTree!: TOCTree;
	private treeModel!: SettingsTreeModel<ISetting>;
	private activeCategory!: SettingsCategoryDescriptor;
	private activeNavigationTarget: Extract<SettingsTOCEntry, { readonly kind: 'target' }> | undefined;
	private rootDomNode: HTMLDivElement | undefined;
	private searchWidget: SettingsSearchWidget | undefined;
	private visible = false;

	constructor(
		@IClipboardService clipboardService: IClipboardService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService contextMenuProvider: IContextMenuProvider,
		@IContextViewService contextViewProvider: IContextViewProvider,
		@ILocalizationService localizationService: ILocalizationService,
		@ILocaleService localeService: ILocaleService,
		@ILanguagePackService private readonly languagePackService: ILanguagePackService,
		@IGitService gitService: IGitService,
		@IChatService private readonly chatService: IChatService,
		@IAgentCapabilitiesService private readonly agentCapabilitiesService: IAgentCapabilitiesService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IDirPermissionsService private readonly dirPermissionsService: IDirPermissionsService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
	) {
		super();
		this.configurationService = configurationService;
		this.localizationService = localizationService;
		this.settingsModel = this._register(new SettingsEditorModel([
			...new DefaultSettings().all.map(setting => {
				if (setting.id === DESKTOP_UPDATE_POLICY_SETTING) return localUpdatePolicySetting(setting, configurationService);
				if (setting.id === LocalizationConfiguration.locale) return displayLanguageSetting(setting, localeService, languagePackService, localizationService);
				return setting;
			}),
			...gitSettings(gitService),
		]));
		this.clipboardService = clipboardService;
		this.contextMenuProvider = contextMenuProvider;
		this.contextViewProvider = contextViewProvider;
	}

	public create(container: HTMLElement): void {
		if (this.rootDomNode) throw new Error('Settings editor has already been created');
		const settingsLayout = createSettingsLayout(this.settingsModel.settings);
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
		this.tocTree = this._register(new TOCTree(this.navigationScrollable.contentElement, new TOCTreeModel(settingsLayout), {
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
		this.contentStatus = h(ownerDocument, 'p');
		this.contentStatus.className = 'ash-configuration-settings-status';
		this.contentStatus.setAttribute('role', 'status');
		this.contentStatus.setAttribute('aria-live', 'polite');
		this.contentStatus.hidden = true;
		contentInner.append(this.contentHeading, this.contentDescription, settingsContent, this.contentStatus);
		this.contentScrollable.append(contentInner);
		this.content.append(this.contentScrollable.element);
		this.element.append(navigation, this.content);
		rootDomNode.append(this.element);
		container.append(rootDomNode);
		this.rootDomNode = rootDomNode;

		const initialCategory = SettingsCategories[0];
		if (!initialCategory) throw new Error('Settings requires at least one category');
		this.activeCategory = initialCategory;
		this.treeModel = this._register(new SettingsTreeModel<ISetting>());
		this.treeModel.setChildren(settingsRootNodes(settingsLayout));
		this.treeModel.setNavigationTarget(initialCategory.id);
		this.settingsTree = this._register(new SettingsTree(settingsContent, {
			model: this.treeModel,
			rootClassName: 'ash-settings-content-tree',
			groupClassName: 'ash-configuration-settings-group ash-settings-content-group',
			groupDescriptionClassName: 'ash-configuration-settings-group-description',
			itemsClassName: 'ash-configuration-settings-list',
			renderItem: item => settingsRenderer.render(item.value),
			updateItem: item => settingsRenderer.update(item.value),
			disposeItem: item => settingsRenderer.disposeSetting(item.id),
		}));
		this.modelsSettings = this._register(new ModelsSettings(settingsContent, {
			chatService: this.chatService,
			clipboardService: this.clipboardService,
			configurationService: this.configurationService,
			contextMenuProvider: this.contextMenuProvider,
			contextViewProvider: this.contextViewProvider,
		}));
		this.agentCapabilitiesSettings = this._register(new AgentCapabilitiesSettings(settingsContent, this.agentCapabilitiesService, this.remoteAgentService, this.dirPermissionsService, this.localizationService));
		this.renderCategory(initialCategory);

		const updateLanguageSetting = (): void => {
			// Recompute descriptors while the keyed renderer retains controls and keyboard focus.
			this.treeModel.setChildren(settingsRootNodes(createSettingsLayout(this.settingsModel.settings)));
		};
		this._register(this.languagePackService.onDidChange(updateLanguageSetting));
		this._register(this.localizationService.onDidChange(() => {
			updateLanguageSetting();
			this.updateLocalizedChrome();
		}));
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
			const activeId = this.activeNavigationTarget?.id ?? this.activeCategory.id;
			this.tocTree.setSelection([containsActiveCategory && collapsed ? element.id : activeId]);
		}));
		this._register(toDisposable(() => rootDomNode.remove()));
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isSettingsEditorInput(input)) throw new TypeError(`Settings editor cannot open ${input.resource}`);
		if (signal.aborted) throw signal.reason;
		this.search(this.searchWidget?.value ?? '');
		const categoryId = new URLSearchParams(input.resource.toEncodedComponents().query).get('category');
		if (categoryId) {
			const category = SettingsCategories.find(candidate => candidate.id === categoryId);
			if (!category) throw new RangeError(`Settings category is not available: ${categoryId}`);
			this.renderCategory(category);
		}
	}

	public clearInput(): void {
		if (this.searchWidget) this.searchWidget.value = '';
	}

	public layout(_dimension: IDimension): void {
		this.navigationScrollable.layout();
		this.contentScrollable.layout();
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		this.visible = visibility === EditorPaneVisibility.Visible;
	}

	public focus(): void {
		if (!this.visible) return;
		this.searchWidget?.focus();
	}

	private search(text: string): void {
		const query = new SettingsSearchQuery(text);
		this.tocTree.setFindPattern(query.text);
		this.treeModel.setQuery(query);
		this.modelsSettings.setVisible(query.isEmpty && this.activeCategory.id === 'models');
		this.agentCapabilitiesSettings.setView(query.isEmpty && (this.activeCategory.id === 'tools' || this.activeCategory.id === 'sandbox') ? this.activeCategory.id : undefined);
		this.navigationScrollable.scrollTo(0, 0);
		this.navigationScrollable.layout();
	}

	private focusResults(): void {
		this.tocTree.domFocus();
	}

	private renderCategory(category: SettingsCategoryDescriptor, entry?: Extract<SettingsTOCEntry, { readonly kind: 'target' }>): void {
		this.activeCategory = category;
		const navigationId = entry?.id ?? category.id;
		this.tocTree.expandTo(navigationId);
		this.tocTree.setSelection([navigationId]);
		this.content.dataset.activeSettingsCategory = category.id;
		this.showNavigationTarget(category, entry);
	}

	private openNavigationEntry(entry: SettingsTOCOpenEntry): void {
		if (entry.kind === 'category') {
			this.renderCategory(entry.category);
			return;
		}
		this.renderCategory(entry.category, entry);
	}

	private showNavigationTarget(
		category: SettingsCategoryDescriptor,
		entry: Extract<SettingsTOCEntry, { readonly kind: 'target' }> | undefined,
	): void {
		const targetId = entry?.target.targetId ?? category.id;
		const target = this.treeModel.getGroup(targetId);
		if (!target) throw new RangeError(`Settings layout does not expose navigation target '${targetId}'`);
		this.settingsTree.setNavigationTarget(targetId);
		this.modelsSettings.setVisible(category.id === 'models' && !this.searchWidget?.value);
		this.agentCapabilitiesSettings.setView(!this.searchWidget?.value && (category.id === 'tools' || category.id === 'sandbox') ? category.id : undefined);
		this.activeNavigationTarget = entry;
		this.content.classList.toggle('has-navigation-target', entry !== undefined);
		if (entry) this.content.dataset.activeSettingsTarget = entry.target.targetId;
		else delete this.content.dataset.activeSettingsTarget;
		this.contentHeading.textContent = entry ? target.title : this.localizedCategoryLabel(category);
		this.contentDescription.textContent = entry ? target.description : this.localizedCategoryDescription(category);
		this.contentScrollable.scrollTo(0, 0);
		this.contentScrollable.layout();
	}

	private updateLocalizedChrome(): void {
		this.navigationEmpty.textContent = this.localized('chrome.noResults', 'No settings found.');
		this.tocTree.rerender();
		if (this.activeNavigationTarget) {
			const target = this.treeModel.getGroup(this.activeNavigationTarget.target.targetId)!;
			this.contentHeading.textContent = target.title;
			this.contentDescription.textContent = target.description;
			return;
		}
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

function displayLanguageSetting(setting: ISetting, locale: ILocaleService, languagePacks: ILanguagePackService, localization: ILocalizationService): ISelectSetting {
	if (setting.valueType !== 'select') throw new TypeError('Display language requires a select setting');
	return {
		...setting,
		get title() { return localization.translate('ash.settings', 'displayLanguage.select', 'Interface language'); },
		get description() { return localization.translate('ash.settings', 'displayLanguage.description', 'Choose the language used by the Ash interface.'); },
		get options() { return languagePacks.availableLocales.map(locale => ({ value: locale.locale, label: locale.localizedLanguageName })); },
		// The control shows the resolved installed language, including changes made through commands or JSON.
		binding: {
			id: setting.id,
			defaultValue: setting.configuration.defaultValue,
			onDidChange: listener => locale.onDidChangeLocale(() => listener()),
			getValue: () => locale.locale,
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
			get options() { return [
				{ value: false, label: localize('git.autofetch.off', 'Off') },
				{ value: true, label: localize('git.autofetch.default', 'Default remote') },
				{ value: 'all', label: localize('git.autofetch.all', 'All remotes') },
			] as const; },
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
