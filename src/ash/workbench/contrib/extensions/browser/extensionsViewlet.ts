import {
	defaultButtonStyles,
	defaultInputBoxStyles,
	defaultListStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import type { IAction } from '../../../../base/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { appendLabelIcon } from '../../../../base/browser/ui/iconlabel/iconLabels.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../browser/parts/views/paneComposite.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, type ExtensionsInstalledPackage, type ExtensionsOpenOptions, type ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ExtensionsInput, ExtensionsInputSource } from '../common/extensionsInput.js';
import { changeExtensionPackage } from './extensionsEditor.js';
import { IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IExtensionApi, type ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import { changeExtensionEnablement, extensionEnablementLabel } from './extensionsActions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, type WorkbenchViewRegistry } from '../../../common/views.js';
import { SkillsViewPane, McpServersViewPane, RecommendedExtensionsView } from './extensionsViews.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import './extensions.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.extensions', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Extensions accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize({ bundle: 'ash.extensions', key: 'verbosityTitle' }, 'Extensions accessibility help'), description: localize({ bundle: 'ash.extensions', key: 'verbosityDescription' }, 'Announce keyboard help when Extensions receives focus.') },
});

interface ExtensionListItem {
	readonly summary: ExtensionsPackageSummary;
	readonly installation?: ExtensionsInstalledPackage;
	readonly source?: ExtensionsInputSource;
	readonly enabled?: boolean;
	readonly canChangeEnablement?: boolean;
}

/** The Workbench and Sessions share catalog rendering; package authority stays in the backend. */
class ExtensionsContent extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private query = '';
	private readonly list: List<ExtensionListItem>;
	private readonly status: HTMLElement;
	private readonly rowResources = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private options: ExtensionsOpenOptions;
	private readonly isPluginsPane: boolean;
	private installed: readonly ExtensionsInstalledPackage[] = [];
	private visible = false;
	private generation = 0;
	private working = false;
	private loaded = false;

	constructor(container: HTMLElement, options: ExtensionsOpenOptions & { readonly beforeOpenEditor?: () => Promise<void>; },
		@IExtensionManagementService private readonly extensionManagement: IExtensionManagementService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IEditorService private readonly editors: IEditorService,
		@IGlobalExtensionEnablementService private readonly enablement: IGlobalExtensionEnablementService,
		@IPluginManagementService private readonly plugins: IPluginManagementService,
		@IExtensionApi private readonly extensionCatalog: IExtensionApi,
	) {
		super();
		this.options = options;
		this.isPluginsPane = options.view === 'plugins';
		this.domNode = h(mainWindow.document, 'section'); this.domNode.className = 'ash-extensions';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));

		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); this.domNode.append(this.status);
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; this.domNode.append(listContainer);
		this.list = this._register(new List(listContainer, {
			styles: defaultListStyles,
			ariaLabel: this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'installedPlugins' }, 'Plugins') : localize({ bundle: 'ash.extensions', key: 'marketplacePane' }, 'Marketplace'),
			domFocusable: true,
			keyboardNavigation: true,
			focusOnMouseMove: false,
			getId: item => `${item.source ?? ExtensionsInputSource.Registry}/${item.installation?.installationId ?? item.summary.id}/${item.summary.version}`,
			accessibilityProvider: { getAriaLabel: item => `${item.summary.displayName}, ${item.summary.version}, ${item.summary.description}, ${item.source === ExtensionsInputSource.BuiltIn ? localize({ bundle: 'ash.extensions', key: 'builtInFilter' }, 'Built-in') + ', ' : ''}${item.enabled === undefined ? '' : item.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled')}` },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.summary.displayName },
			renderItem: (item, _index, row) => this.renderItem(item, row),
			onDidRemoveRow: row => this.rowResources.deleteAndDispose(row),
		}));
		this._register(this.list.onDidAccept(({ item }) => {
			void this.run(async () => {
				const editors = this.editors;
				const input = new ExtensionsInput(item.summary, item.installation?.installationId, item.source);
				await options.beforeOpenEditor?.();
				await editors.openEditor(input);
			});
		}));
		this._register(addDisposableListener(this.list.element, 'keydown', event => { if (event.key === 'Enter' && event.target === this.list.element) { event.preventDefault(); this.list.acceptActive(event); } }));
		this._register(extensionManagement.onDidChangeInstalled(() => { this.loaded = false; if (this.visible && !this.working) { void this.run(() => this.load()); } }));
		const refreshInstalled = () => { this.loaded = false; if (this.visible && !this.working) { void this.run(() => this.load()); } };
		this._register(this.enablement.onDidChangeEnablement(refreshInstalled));
		this._register(this.plugins.onDidChange(refreshInstalled));
		const scopedContext = this._register(contextKeys.createScoped(this.domNode)); scopedContext.createKey('extensionsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 100, name: `extensions-help-${generateUuid()}`, when: ContextKeyExpr.has('extensionsFocused'), getProvider: () => {
				const focused = mainWindow.document.activeElement;
				if (!this.visible || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type: AccessibleViewType.Help }, () => localize({ bundle: 'ash.extensions', key: 'accessibilityHelp' }, 'Extensions opens your installed Skills, Plugins and Connectors, followed by Recommended. Skills contain Agent working methods, Plugins add features, and Connectors manage external services and tool servers. The search box above all panes searches the Marketplace. Use Filter extensions to choose installed categories, built-in plugins or recommendations. Clear Search removes the query and filters. Use @installed to filter installed items, or clear the search to return to these categories. One Refresh extensions action reloads all categories. The title bar More Actions menu provides marketplace, installed, source management and installation commands. Pane actions appear on hover or keyboard focus. Use Left and Right on pane headers to collapse or expand them. Use Tab to move between controls, arrow keys to select an item, and Enter to open details. Enable or Disable in Plugins controls the feature package. Skill enablement and connection actions are managed separately in their details. Execution authorization and permissions are reviewed in package details. Language packs are managed through the display language setting. Run Install extension from Git repository in the Command Palette to install a repository package. Press Escape during installation to cancel. Escape closes this help.'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
			}
		}));
	}

	public async open(options: ExtensionsOpenOptions = {}): Promise<void> {
		if (this.working) { this.focus(); return; }
		this.options = options; this.query = options.query ?? '';
		await this.run(() => this.load());
	}
	public setVisible(visible: boolean): void { this.visible = visible; if (!visible) { ++this.generation; } else if (!this.loaded) { void this.run(() => this.load()); } }
	public focus(): void { this.list.domFocus(); if (this.configuration.getValue<boolean>('accessibility.verbosity.extensions')) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.'); } }

	private renderItem(item: ExtensionListItem, row: HTMLDivElement): HTMLElement {
		const resources = new DisposableStore(); this.rowResources.set(row, resources);
		row.dataset.packageId = item.summary.id;
		if (item.installation) { row.dataset.installationId = item.installation.installationId; } else { delete row.dataset.installationId; }
		const content = h(mainWindow.document, 'div'); content.className = 'extension-row';
		const icon = h(mainWindow.document, 'div'); icon.className = 'extension-icon'; appendLabelIcon(icon, Lxicon.extensions); icon.setAttribute('aria-hidden', 'true');
		const body = h(mainWindow.document, 'div'); body.className = 'extension-body';
		for (const [className, value] of [['extension-name', item.summary.displayName], ['extension-description', item.summary.description], ['extension-metadata', `${item.summary.id} · ${item.summary.version}`]]) {
			const label = h(mainWindow.document, 'div'); label.className = className; label.textContent = value;
			resources.add(getHoverDelegate().setupHover({ target: label, content: value })); body.append(label);
		}
		const actions = h(mainWindow.document, 'div'); actions.className = 'extension-row-actions';
		if (!item.source && !item.installation && !this.installed.some(entry => entry.package.id === item.summary.id)) {
			const install = resources.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'),
				presentation: 'primary',
				size: 'small',
				enabled: !this.working,
			}));
			resources.add(install.onDidClick(event => {
				event.stopPropagation(); void this.run(async () => {
					if (this.working) { return; }
					this.working = true; install.enabled = false;
					try { const details = await this.extensionManagement.get(item.summary.id, item.summary.version); await changeExtensionPackage(this.extensionManagement, this.dialogs, 'install', details); }
					finally { this.working = false; if (!this.isDisposed) { await this.load(); } }
				});
			}));
		} else {
			const state = h(mainWindow.document, 'span'); state.className = 'extension-state'; state.textContent = item.source === ExtensionsInputSource.BuiltIn ? localize({ bundle: 'ash.extensions', key: 'builtInFilter' }, 'Built-in') : item.installation?.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'); actions.append(state);
		}
		if (item.enabled !== undefined) {
			const state = h(mainWindow.document, 'span'); state.className = 'extension-state';
			state.textContent = item.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
			body.append(state);
			if (item.canChangeEnablement) {
				const toggle = resources.add(new Button(actions, {
					...defaultButtonStyles,
					label: extensionEnablementLabel(item.enabled),
					size: 'small',
					enabled: !this.working && item.installation?.state !== 'pendingRemoval',
				}));
				resources.add(toggle.onDidClick(event => {
					event.stopPropagation();
					void this.run(async () => {
						if (this.working) { return; }
						this.working = true; toggle.enabled = false;
						using input = new ExtensionsInput(item.summary, item.installation?.installationId, item.source);
						try { await changeExtensionEnablement(input, this.enablement, this.extensionManagement, this.plugins, this.extensionCatalog); }
						finally { this.working = false; if (!this.isDisposed) { await this.load(); this.list.domFocus(); } }
					});
				}));
			}
		}
		content.append(icon, body, actions); return content;
	}

	private async load(force = false): Promise<void> {
		const generation = ++this.generation;
		const query = this.query.trim();
		const isInstalled = this.options.mode === 'installed' || this.options.mode === undefined && !query && !this.options.capabilityKind && !this.options.languageId;
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		this.domNode.setAttribute('aria-busy', 'true');
		try {
			const installed = this.options.mode === 'builtIn' ? [] : await this.extensionManagement.listInstalled();
			// Package execution policy applies to marketplace installations. Local
			// plugins have their own owner and remain manageable from a Web client.
			const policies = installed.length ? await this.extensionManagement.listEditorExtensions() : { extensions: [] };
			let items: ExtensionListItem[];
			let editorMetadata: readonly ExtensionDescriptor[] = [];
			const builtInItems: ExtensionListItem[] = [];
			if (this.options.mode === 'builtIn' || isInstalled) {
				const catalog = await this.extensionCatalog.list('cached', { includeDisabled: true });
				editorMetadata = catalog.extensions;
				const providers = await this.extensionManagement.listBuiltInProviders().catch(() => undefined);
				const disabled = new Set(this.enablement.getDisabledExtensions().map(value => value.id));
				builtInItems.push(...catalog.extensions.filter(extension => extension.sourceKind === 'builtIn' && (!this.options.capabilityKind || this.options.capabilityKind === 'editorExtension' || this.options.capabilityKind === 'localization' && JSON.parse(extension.manifestJson).contributes?.localizations?.length)).map(extension => {
					const manifest = JSON.parse(extension.manifestJson);
					const provider = providers?.providers.find(value => value.id === extension.id);
					const isProvider = (manifest.ashRuntime?.kind === 'rust' && !manifest.browser) || !!manifest.ashLanguageServers;
					return {
						source: ExtensionsInputSource.BuiltIn, enabled: isProvider ? provider?.enabled : !disabled.has(extension.id.toLowerCase()), canChangeEnablement: isProvider ? !!provider && providers?.canChangeEnablement === true : !manifest.contributes?.localizations?.length,
						summary: { id: extension.id, version: extension.version, packageType: 'editorExtension', displayName: manifest.displayName?.startsWith('%') ? extension.id : manifest.displayName ?? extension.displayName, description: typeof manifest.description === 'string' && !manifest.description.startsWith('%') ? manifest.description : '' }
					};
				}));
			}
			if (this.options.mode === 'builtIn') {
				items = builtInItems;
			} else if (isInstalled) {
				items = installed.filter(entry => (!this.options.capabilityKind || entry.capabilities.some(capability => capability.kind === this.options.capabilityKind))).map(installation => {
					const policy = policies.extensions.find(value => value.installationId === installation.installationId);
					const editor = editorMetadata.find(value => value.id === installation.package.id.split('@')[0] && value.version === installation.package.version);
					return { installation, enabled: policy?.enabled, canChangeEnablement: !!policy, summary: { id: installation.package.id, version: installation.package.version, displayName: editor?.displayName ?? installation.package.id.split('@')[0], packageType: 'installed', description: installation.capabilities.map(capability => capability.kind === 'editorExtension' ? localize({ bundle: 'ash.extensions', key: 'pluginEditorTag' }, 'Editor') : capability.kind).join(' · ') } };
				});
				items.push(...builtInItems);
				if (this.isPluginsPane || !this.options.capabilityKind || this.options.capabilityKind === 'editorExtension') {
					const catalog = await this.plugins.list();
					items.push(...catalog.packages.filter(plugin => this.isPluginsPane || !this.options.capabilityKind || plugin.hasEditorExtensions).map(plugin => ({ source: ExtensionsInputSource.Local, enabled: plugin.enabled, canChangeEnablement: plugin.enabled || !plugin.revoked, summary: { id: plugin.id, version: plugin.version, packageType: 'editorExtension', displayName: plugin.displayName, description: localize({ bundle: 'ash.extensions', key: 'localExtension' }, 'Local extension') } })));
				}
			} else {
				const options = { limit: 200, packageType: this.isPluginsPane ? 'plugin' : undefined, capabilityKind: this.options.capabilityKind, languageId: this.options.languageId };
				const snapshot = await (force ? this.extensionManagement.refreshBrowse(query, options) : this.extensionManagement.browse(query, options));
				items = snapshot.packages.map(entry => {
					const installation = installed.find(value => value.package.id === entry.summary.id && value.package.version === entry.summary.version);
					const policy = policies.extensions.find(value => value.installationId === installation?.installationId);
					return { summary: entry.summary, installation, enabled: policy?.enabled, canChangeEnablement: !!policy };
				});
			}
			if (this.isDisposed || generation !== this.generation) { return; }
			this.installed = installed;
			this.list.items = this.options.mode === 'browse' || this.options.mode === undefined ? items : items.filter(item => [item.summary.id, item.summary.displayName, item.summary.description].some(value => value.toLowerCase().includes(query.toLowerCase())));
			this.loaded = true;
			if (this.list.items.length) {
				this.status.textContent = this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'pluginResults' }, '{0} plugins', this.list.items.length) : localize({ bundle: 'ash.extensions', key: 'results' }, '{0} extensions', this.list.items.length);
			} else {
				this.status.textContent = '';
			}
			this.changed.fire();
		} catch (error) { if (!this.isDisposed && generation === this.generation) { throw error; } }
		finally { if (!this.isDisposed && generation === this.generation) { this.domNode.setAttribute('aria-busy', 'false'); } }
	}

	public refresh(): Promise<void> { return this.run(() => this.load(true)); }
	public setSearch(query: string): void { this.query = query; this.options = { mode: 'installed', view: this.options.view }; this.loaded = false; if (this.visible) { void this.run(() => this.load()); } }

	private async run(operation: () => Promise<void>): Promise<void> { try { await operation(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } } }
}

export class ExtensionsViewPane extends ViewPane {
	private readonly content: ExtensionsContent;
	constructor(container: HTMLElement, options: IViewPaneOptions, @IInstantiationService instantiation: IInstantiationService) { super(container, { ...options, minimumBodySize: 160 }); this.element.classList.add('ash-extensions-view'); this.content = this._register(instantiation.createInstance(ExtensionsContent, this.contentElement, options.id === 'ash.extensions.plugins' ? { view: 'plugins', mode: 'installed' } : { mode: 'browse' })); this._register(this.onDidChangeBodyVisibility(visible => this.content.setVisible(visible))); }
	public async open(options?: ExtensionsOpenOptions): Promise<void> { this.setExpanded(true); await this.content.open(this.id === 'ash.extensions.plugins' ? { ...options, view: 'plugins', mode: options?.mode ?? 'installed' } : { mode: 'browse', ...options }); }
	public override focus(): void { this.content.focus(); }
	public refresh(): Promise<void> { return this.content.refresh(); }
	public setSearch(query: string): void { this.content.setSearch(query); }
}

/** Owns the single search input and refresh action; panes retain their domain projections. */
export class ExtensionsViewPaneContainer extends PaneComposite {
	private readonly searchRegion: HTMLElement;
	private readonly search: InputBox;
	private readonly searchActions: ActionBar;
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => { void this.applySearch(); }, 250));
	private searchOptions: ExtensionsOpenOptions = {};
	private updatingSearch = false;
	private refreshing = false;

	constructor(container: HTMLElement, options: PaneCompositeOptions,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super(container, { ...options, mergeViewWithContainerWhenSingleView: false }, storage, theme, menus, configuration);
		this.element.classList.add('ash-extensions-view-container');
		this.searchRegion = h(container.ownerDocument, 'div');
		this.searchRegion.className = 'extensions-global-search';
		this.element.prepend(this.searchRegion);
		this.search = this._register(new InputBox(this.searchRegion, {
			inputBoxStyles: defaultInputBoxStyles, type: 'search', presentation: 'compact',
			placeholder: localize({ bundle: 'ash.extensions', key: 'searchPackages' }, 'Search extensions'),
			ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchPackages' }, 'Search extensions'),
		}));
		this.search.element.classList.add('extensions-search-input');
		this.searchActions = this._register(new ActionBar(this.search.element, {
			ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchActions' }, 'Extension search actions'),
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			actions: this.createSearchActions(),
			actionViewItemProvider: (action, options) => action.id === 'ash.extensions.filterSearch'
				? new DropdownMenuActionViewItem(action, () => this.searchFilters().map(filter => ({
					id: `ash.extensions.filter.${filter.token}`, label: filter.label, tooltip: '', enabled: true,
					checked: filter.token ? this.readSearch().token === filter.token : !this.readSearch().token && this.contextKeys.contextMatchesRules(ContextKeyExpr.has('extensionsMarketplaceVisible')),
					run: () => this.open({ mode: 'browse', query: `${filter.token} ${this.readSearch().query}`.trim() }),
				})), contextMenus, options)
				: undefined,
		}));
		this.searchActions.element.classList.add('ash-toolbar', 'extensions-search-actions');
		const help = localize({ bundle: 'ash.extensions', key: 'globalSearchHelp' }, 'Type to search the Marketplace. Use @installed to filter installed Skills, Plugins and Connectors. Use the Filter extensions menu for installed categories, built-in plugins and recommendations. Clear Search removes the query and filters. Clear the search to return to installed categories. Enter searches immediately; Down moves to results; Escape clears the search. Refresh reloads all categories and preserves the search and pane expansion. The title bar More Actions menu provides marketplace, installed, source management and installation commands. Pane actions appear on hover or keyboard focus.');
		this.search.inputElement.setAttribute('aria-description', help);

		this._register(this.search.onDidChange(() => {
			this.searchActions.updateActions(this.createSearchActions());
			// Clearing disables the previous toolbar entry point; keep Filter reachable by Tab.
			if (!this.search.value) { this.searchActions.setTabStop('ash.extensions.filterSearch'); }
			if (this.updatingSearch) { return; }
			this.searchOptions = this.search.value.trim() ? { ...this.searchOptions, mode: this.searchOptions.mode === 'builtIn' ? 'builtIn' : undefined } : {};
			this.searchScheduler.schedule();
		}));
		this._register(this.search.onKeyDown(event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.searchScheduler.cancel();
				void this.applySearch();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.search.value = '';
				this.searchOptions = {};
				this.searchScheduler.cancel();
				void this.applySearch();
			} else if (event.key === 'ArrowDown') {
				event.preventDefault();
				const pane = (this.searchOptions.view ? this.getView(`ash.extensions.${this.searchOptions.view}`) : undefined)
					?? this.panes.find(pane => pane.isExpanded()) ?? this.panes[0];
				pane?.setExpanded(true);
				pane?.focus();
			}
		}));
		this.scopedContextKeyService.createKey('extensionsSearchFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 110, name: `extensions-search-${generateUuid()}`, when: ContextKeyExpr.has('extensionsSearchFocused'),
			getProvider: () => {
				const focused = this.element.ownerDocument.activeElement;
				if (!this.isVisible() || !(focused instanceof HTMLElement) || !this.searchRegion.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type: AccessibleViewType.Help }, () => help, () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
			},
		}));
		this._register(this.search.onDidFocus(() => {
			if (configuration.getValue<boolean>(AccessibilityVerbositySettingId.Extensions)) { this.search.inputElement.setAttribute('aria-description', help); }
			else { this.search.inputElement.removeAttribute('aria-description'); }
		}));
	}

	private searchFilters(): readonly { readonly token: string; readonly label: string; }[] {
		return [
			{ token: '', label: localize({ bundle: 'ash.extensions', key: 'marketplacePane' }, 'Marketplace') },
			{ token: '@installed', label: localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed') },
			{ token: '@skills', label: localize({ bundle: 'ash.extensions', key: 'filterSkills' }, 'Skills') },
			{ token: '@plugins', label: localize({ bundle: 'ash.extensions', key: 'installedPlugins' }, 'Plugins') },
			{ token: '@connectors', label: localize({ bundle: 'ash.extensions', key: 'installedConnectors' }, 'Connectors') },
			{ token: '@builtin', label: localize({ bundle: 'ash.extensions', key: 'builtInFilter' }, 'Built-in') },
			{ token: '@recommended', label: localize({ bundle: 'ash.extensions', key: 'recommendedPane' }, 'Recommended') },
		];
	}

	private readSearch(): { readonly token: string; readonly query: string; } {
		const raw = this.search.value.trim();
		const match = /^(@installed|@skills|@plugins|@connectors|@builtin|@recommended)(?:\s+|$)/iu.exec(raw);
		return { token: match?.[1].toLowerCase() ?? '', query: match ? raw.slice(match[0].length) : raw };
	}

	private createSearchActions(): readonly IAction[] {
		return [
			{
				id: 'ash.extensions.clearSearch', label: localize({ bundle: 'ash.extensions', key: 'clearSearch' }, 'Clear Search'),
				tooltip: localize({ bundle: 'ash.extensions', key: 'clearSearch' }, 'Clear Search'),
				icon: Lxicon.clearAll, enabled: !!this.search.value, checked: undefined,
				run: () => this.open(),
			},
			{
				id: 'ash.extensions.filterSearch', label: localize({ bundle: 'ash.extensions', key: 'filterSearch' }, 'Filter extensions'),
				tooltip: localize({ bundle: 'ash.extensions', key: 'filterSearch' }, 'Filter extensions'),
				icon: Lxicon.filter, enabled: true, checked: undefined, run: () => undefined,
			},
		];
	}

	public override layout(dimension: IDimension): void {
		// Pane changes can reuse the previous content allocation; measure the host to subtract the search row once.
		super.layout({ ...dimension, height: Math.max(0, (this.element.clientHeight || dimension.height) - (this.searchRegion?.offsetHeight ?? 0)) });
	}

	public override focus(): void { this.search.focus(); }

	public async open(options: ExtensionsOpenOptions = {}): Promise<void> {
		this.searchOptions = options;
		const installed = options.mode === 'installed' || options.mode === 'builtIn' || !!options.view && options.view !== 'extensions' && options.mode !== 'browse';
		this.updatingSearch = true;
		this.search.value = options.mode === 'builtIn' ? `@builtin ${options.query ?? ''}`.trimEnd() : installed && options.query ? `@installed ${options.query}` : options.query ?? '';
		this.updatingSearch = false;
		this.searchScheduler.cancel();
		this.search.focus();
		await this.applySearch();
	}

	public async refresh(): Promise<void> {
		if (this.refreshing) { return; }
		this.refreshing = true;
		this.contextKeys.setContext('extensionsRefreshing', true);
		this.element.setAttribute('aria-busy', 'true');
		try {
			await Promise.all(this.panes.map(pane => {
				if (pane instanceof RecommendedExtensionsView) { return pane.refreshRecommendations(); }
				if (pane instanceof ExtensionsViewPane || pane instanceof SkillsViewPane || pane instanceof McpServersViewPane) { return pane.refresh(); }
				return Promise.resolve();
			}));
		} finally {
			this.refreshing = false;
			this.contextKeys.setContext('extensionsRefreshing', false);
			if (!this.isDisposed) { this.element.setAttribute('aria-busy', 'false'); }
		}
	}

	private async applySearch(): Promise<void> {
		if (this.isDisposed) { return; }
		const raw = this.search.value.trim();
		const { token, query } = this.readSearch();
		const installed = !!token;
		const builtIn = token === '@builtin' || this.searchOptions.mode === 'builtIn';
		const installedCategory = ({ '@skills': 'skills', '@plugins': 'plugins', '@connectors': 'mcp', '@builtin': 'plugins', '@recommended': 'recommended' } as Record<string, string>)[token] ?? 'all';
		const marketplace = !installed && !builtIn && (raw.length > 0 || this.searchOptions.mode === 'browse' || !!this.searchOptions.capabilityKind || !!this.searchOptions.languageId);
		const category = marketplace && (this.searchOptions.view === 'skills' || this.searchOptions.view === 'mcp') ? this.searchOptions.view : 'view';
		this.contextKeys.bufferChangeEvents(() => {
			this.contextKeys.setContext('extensionsSearchCategory', category);
			this.contextKeys.setContext('extensionsInstalledCategory', installedCategory);
			this.contextKeys.setContext('extensionsMarketplaceVisible', marketplace);
		});
		if (marketplace) {
			const pane = this.getView(`ash.extensions.${category}`);
			if (pane instanceof ExtensionsViewPane || pane instanceof SkillsViewPane || pane instanceof McpServersViewPane) { await pane.open({ ...this.searchOptions, mode: 'browse', query }); }
		} else {
			for (const pane of this.panes) {
				if (pane instanceof ExtensionsViewPane || pane instanceof SkillsViewPane || pane instanceof McpServersViewPane || pane instanceof RecommendedExtensionsView) { pane.setSearch(query); }
			}
			const target = this.getView(`ash.extensions.${installedCategory === 'all' ? this.searchOptions.view ?? 'plugins' : installedCategory}`);
			if (builtIn && target instanceof ExtensionsViewPane) { await target.open({ mode: 'builtIn', query }); }
			else if (target && (this.searchOptions.view || this.searchOptions.mode === 'installed' || installedCategory !== 'all' || !raw)) { target.setExpanded(true); }
		}
	}
}

/** Product commands resolve the retained container so search and refresh have one owner. */
export async function openExtensionsView(views: IViewsService, options: ExtensionsOpenOptions = {}): Promise<void> {
	const composite = await views.openViewContainer('ash.extensions', true);
	if (composite instanceof ExtensionsViewPaneContainer) { void composite.open(options); }
}

/** Both product hosts use the same capability panes with their own view registry and location. */
export function registerExtensionsViewContainer(registry: WorkbenchViewRegistry, location = ViewContainerLocation.Sidebar): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registerAction2(class RefreshExtensions extends Action2 {
		constructor() {
			super({
				id: 'ash.extensions.refresh', title: localize2({ bundle: 'ash.extensions', key: 'refreshAll' }, 'Refresh extensions'),
				icon: Lxicon.refresh, f1: true, precondition: ContextKeyExpr.not('extensionsRefreshing'),
				menu: { id: MenuId.ViewContainerTitle, when: ContextKeyExpr.equals('viewContainer', 'ash.extensions'), group: 'navigation', order: 2 },
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const container = accessor.get(IViewsService).getActiveViewPaneContainerWithId('ash.extensions');
			if (container instanceof ExtensionsViewPaneContainer) { await container.refresh(); }
		}
	}));
	registrations.add(registry.registerViewContainer({ id: 'ash.extensions', title: localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'), location, icon: Lxicon.extensions, order: 8, ctorDescriptor: new SyncDescriptor(ExtensionsViewPaneContainer) }));
	const installedCategory = (category: string) => ContextKeyExpr.and(
		ContextKeyExpr.not('extensionsMarketplaceVisible'),
		ContextKeyExpr.or(ContextKeyExpr.not('extensionsInstalledCategory'), ContextKeyExpr.equals('extensionsInstalledCategory', 'all'), ContextKeyExpr.equals('extensionsInstalledCategory', category)),
	);
	registrations.add(registry.registerViews('ash.extensions', [
		{ id: 'ash.extensions.view', title: localize({ bundle: 'ash.extensions', key: 'marketplacePane' }, 'Marketplace'), when: ContextKeyExpr.and(ContextKeyExpr.has('extensionsMarketplaceVisible'), ContextKeyExpr.notEquals('extensionsSearchCategory', 'skills'), ContextKeyExpr.notEquals('extensionsSearchCategory', 'mcp')), canToggleVisibility: false, order: 0, ctorDescriptor: new SyncDescriptor(ExtensionsViewPane) },
		{ id: 'ash.extensions.skills', title: localize({ bundle: 'ash.extensions', key: 'filterSkills' }, 'Skills'), collapsed: true, when: ContextKeyExpr.or(installedCategory('skills'), ContextKeyExpr.equals('extensionsSearchCategory', 'skills')), canToggleVisibility: false, order: 1, ctorDescriptor: new SyncDescriptor(SkillsViewPane) },
		{ id: 'ash.extensions.plugins', title: localize({ bundle: 'ash.extensions', key: 'installedPlugins' }, 'Plugins'), when: installedCategory('plugins'), canToggleVisibility: false, order: 2, ctorDescriptor: new SyncDescriptor(ExtensionsViewPane) },
		{ id: 'ash.extensions.mcp', title: localize({ bundle: 'ash.extensions', key: 'installedConnectors' }, 'Connectors'), collapsed: true, when: ContextKeyExpr.or(installedCategory('mcp'), ContextKeyExpr.equals('extensionsSearchCategory', 'mcp')), canToggleVisibility: false, order: 3, ctorDescriptor: new SyncDescriptor(McpServersViewPane) },
		{ id: 'ash.extensions.recommended', title: localize({ bundle: 'ash.extensions', key: 'recommendedPane' }, 'Recommended'), when: installedCategory('recommended'), canToggleVisibility: false, order: 4, collapsed: true, ctorDescriptor: new SyncDescriptor(RecommendedExtensionsView) },
	]));
	return registrations;
}
