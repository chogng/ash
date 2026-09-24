import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { GitConfiguration, type GitAutofetch } from '../../../services/git/common/gitConfiguration.js';
import type { IGitService } from '../../../services/git/common/gitService.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { ISetting, ISettingsEditorModel } from '../../../services/preferences/common/preferences.js';
import { DefaultSettings, SettingsEditorModel } from '../../../services/preferences/common/preferencesModels.js';
import type { IPreferencesEditorPane } from './preferencesEditorRegistry.js';
import { PreferencesRenderer } from './preferencesRenderers.js';
import { PreferencesSearchQuery } from './preferencesSearch.js';
import { createSettingsLayout, settingsRootNodes, SettingsCategories, type SettingsCategoryDescriptor, type SettingsCategoryGroupDescriptor, type SettingsLayoutCategory } from './settingsLayout.js';
import { SettingsTree } from './settingsTree.js';
import { SettingsTreeModel } from './settingsTreeModels.js';
import { TOCTree, TOCTreeModel, type SettingsTOCEntry, type SettingsTOCOpenEntry } from './tocTree.js';

export const SettingsEditorPaneId = 'workbench.preferences.settings';

/** Owns the Configuration Registry-backed Settings navigation and setting widgets. */
export class SettingsEditorPane extends Disposable implements IPreferencesEditorPane {
	private readonly content: HTMLElement;
	private readonly contentDescription: HTMLParagraphElement;
	private readonly contentHeading: HTMLHeadingElement;
	private readonly contentScrollable: ScrollableElement;
	private readonly contentStatus: HTMLParagraphElement;
	private readonly configurationService: IConfigurationService;
	private readonly element: HTMLDivElement;
	private readonly localizationService: ILocalizationService;
	private readonly navigationEmpty: HTMLParagraphElement;
	private readonly navigationScrollable: ScrollableElement;
	private readonly settingsModel: ISettingsEditorModel;
	private readonly settingsTree: SettingsTree<ISetting>;
	private readonly tocTree: TOCTree;
	private readonly treeModel: SettingsTreeModel<ISetting>;
	private activeCategory: SettingsCategoryDescriptor;
	private activeNavigationTarget: Extract<SettingsTOCEntry, { readonly kind: 'target' }> | undefined;

	constructor(
		container: HTMLElement,
		clipboardService: IClipboardService,
		configurationService: IConfigurationService,
		contextMenuProvider: IContextMenuProvider,
		contextViewProvider: IContextViewProvider,
		localizationService: ILocalizationService,
		gitService: IGitService,
	) {
		super();
		this.configurationService = configurationService;
		this.localizationService = localizationService;
		this.settingsModel = this._register(new SettingsEditorModel([...new DefaultSettings().all, ...gitSettings(gitService)]));
		const settingsLayout = createSettingsLayout(this.settingsModel.settings);
		const preferencesRenderer = this._register(new PreferencesRenderer(container, {
			clipboardService,
			configurationService,
			contextMenuProvider,
			contextViewProvider,
			onStatus: this.settingsModel.reportStatus,
		}));

		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'ash-settings-layout';

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
			renderItem: item => preferencesRenderer.render(item.value),
			updateItem: item => preferencesRenderer.update(item.value),
			disposeItem: item => preferencesRenderer.disposeSetting(item.id),
		}));
		this.renderCategory(initialCategory);

		this._register(this.localizationService.onDidChange(() => this.updateLocalizedChrome()));
		this._register(configurationService.onDidChangeConfiguration(() => this.treeModel.refreshQuery()));
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
		this._register(toDisposable(() => this.element.remove()));
	}

	getDomNode(): HTMLElement {
		return this.element;
	}

	layout(_dimension: IDimension): void {
		this.navigationScrollable.layout();
		this.contentScrollable.layout();
	}

	search(text: string): void {
		const query = new PreferencesSearchQuery(text, { isModified: id => this.isModified(id) });
		this.tocTree.setFindPattern(query.text);
		this.treeModel.setQuery(query);
		this.navigationScrollable.scrollTo(0, 0);
		this.navigationScrollable.layout();
	}

	private isModified(id: string): boolean {
		const setting = this.settingsModel.settings.find(candidate => candidate.id === id);
		if (!setting) return false;
		if (setting.binding) return !Object.is(setting.binding.getValue(), setting.binding.defaultValue);
		const configuration = setting.configuration as IRegisteredConfiguration<unknown>;
		return JSON.stringify(configuration.serialize(this.configurationService.getValue(configuration.key))) !== JSON.stringify(configuration.serialize(configuration.defaultValue));
	}

	focus(): void {
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
