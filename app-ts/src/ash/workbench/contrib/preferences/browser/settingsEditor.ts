import './media/settingsEditor.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ConfigurationTarget, type IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { DESKTOP_UPDATE_POLICY_SETTING, type DesktopUpdatePolicy } from '../../../../platform/update/common/updateService.js';
import { localize } from '../../../../nls.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IChatService } from '../../../services/chat/common/chatService.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { GitConfiguration, type GitAutofetch } from '../../../contrib/git/common/gitConfiguration.js';
import type { IGitService } from '../../../contrib/git/common/gitService.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { ISetting, ISettingsEditorModel } from '../../../services/preferences/common/preferences.js';
import { isSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { DefaultSettings, SettingsEditorModel } from '../../../services/preferences/common/settingsModels.js';
import { SettingsRenderer } from './settingsRenderers.js';
import { ModelsSettings } from './modelsSettings.js';
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
	private settingsTree!: SettingsTree<ISetting>;
	private tocTree!: TOCTree;
	private treeModel!: SettingsTreeModel<ISetting>;
	private activeCategory!: SettingsCategoryDescriptor;
	private activeNavigationTarget: Extract<SettingsTOCEntry, { readonly kind: 'target' }> | undefined;
	private rootDomNode: HTMLDivElement | undefined;
	private searchWidget: SettingsSearchWidget | undefined;
	private visible = false;

	constructor(
		clipboardService: IClipboardService,
		configurationService: IConfigurationService,
		contextMenuProvider: IContextMenuProvider,
		contextViewProvider: IContextViewProvider,
		localizationService: ILocalizationService,
		gitService: IGitService,
		private readonly chatService: IChatService,
	) {
		super();
		this.configurationService = configurationService;
		this.localizationService = localizationService;
		this.settingsModel = this._register(new SettingsEditorModel([
			...new DefaultSettings().all.map(setting => setting.id === DESKTOP_UPDATE_POLICY_SETTING ? localUpdatePolicySetting(setting, configurationService) : setting),
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
		this.renderCategory(initialCategory);

		this._register(this.localizationService.onDidChange(() => this.updateLocalizedChrome()));
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
		const categoryId = new URLSearchParams(input.resource.query).get('category');
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
			this.contentHeading.textContent = this.activeNavigationTarget.target.label;
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
