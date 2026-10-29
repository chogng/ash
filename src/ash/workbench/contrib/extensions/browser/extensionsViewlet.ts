import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import type { IAction } from '../../../../base/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import {
	IInstantiationService,
	type ServicesAccessor,
} from '../../../../platform/instantiation/common/instantiation.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { type PaneCompositeOptions } from '../../../browser/panecomposite.js';
import { FilterViewPaneContainer } from '../../../browser/parts/views/viewsViewlet.js';
import { Emitter } from '../../../../base/common/event.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type ExtensionsOpenOptions } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, type IViewDescriptor, type WorkbenchViewRegistry } from '../../../common/views.js';
import {
	ExtensionsListView,
	SkillsViewPane,
	McpServersViewPane,
	RecommendedExtensionsView,
} from './extensionsViews.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import './media/extensionsViewlet.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.extensions',
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('Extensions accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.extensions', key: 'verbosityTitle' }, 'Extensions accessibility help'),
		description: localize(
			{ bundle: 'ash.extensions', key: 'verbosityDescription' },
			'Announce keyboard help when Extensions receives focus.',
		),
	},
});

/** Owns the single search input and refresh action; panes retain their domain projections. */
export class ExtensionsViewPaneContainer extends FilterViewPaneContainer {
	private readonly filterChanged: Emitter<string[]>;
	private readonly searchRegion: HTMLElement;
	private readonly search: InputBox;
	private readonly searchActions: ActionBar;
	private readonly searchScheduler = this._register(
		new RunOnceScheduler(() => {
			void this.applySearch();
		}, 250),
	);
	private searchOptions: ExtensionsOpenOptions = {};
	private updatingSearch = false;
	private refreshing = false;

	constructor(
		container: HTMLElement,
		options: PaneCompositeOptions,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const filterChanged = new Emitter<string[]>();
		super(
			container,
			{ ...options, mergeViewWithContainerWhenSingleView: false },
			filterChanged.event,
			storage,
			theme,
			menus,
			configuration,
			instantiationService,
			contextKeys,
		);
		this.filterChanged = this._register(filterChanged);
		filterChanged.fire(['skills', 'plugins', 'mcp', 'recommended']);
		this.element.classList.add('ash-extensions-view-container');
		this.searchRegion = h(container.ownerDocument, 'div');
		this.searchRegion.className = 'extensions-global-search';
		this.element.prepend(this.searchRegion);
		this.search = this._register(
			new InputBox(this.searchRegion, {
				inputBoxStyles: defaultInputBoxStyles,
				type: 'search',
				presentation: 'compact',
				placeholder: localize({ bundle: 'ash.extensions', key: 'searchPackages' }, 'Search extensions'),
				ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchPackages' }, 'Search extensions'),
			}),
		);
		this.search.element.classList.add('extensions-search-input');
		this.searchActions = this._register(
			new ActionBar(this.search.element, {
				ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchActions' }, 'Extension search actions'),
				actionViewItemOptions: { buttonStyles: defaultButtonStyles },
				actions: this.createSearchActions(),
				actionViewItemProvider: (action, options) =>
					action.id === 'ash.extensions.filterSearch'
						? new DropdownMenuActionViewItem(
								action,
								() =>
									this.searchFilters().map(filter => ({
										id: `ash.extensions.filter.${filter.token}`,
										label: filter.label,
										tooltip: '',
										enabled: true,
										checked: filter.token
											? this.readSearch().token === filter.token
											: !this.readSearch().token &&
												this.contextKeys.contextMatchesRules(
													ContextKeyExpr.has('extensionsMarketplaceVisible'),
												),
										run: () =>
											this.open({
												mode: 'browse',
												query: `${filter.token} ${this.readSearch().query}`.trim(),
											}),
									})),
								contextMenus,
								options,
							)
						: undefined,
			}),
		);
		this.searchActions.element.classList.add('ash-toolbar', 'extensions-search-actions');
		const help = localize(
			{ bundle: 'ash.extensions', key: 'globalSearchHelp' },
			'Type to search the Marketplace and installed Plugins, including built-in language servers. Use @installed to filter installed Skills, Plugins and Connections. Use the Filter extensions menu for installed categories, built-in plugins and recommendations. Clear Search removes the query and filters. Clear the search to return to installed categories. Enter searches immediately; Down moves to results; Escape clears the search. Refresh reloads all categories and preserves the search and pane expansion. The title bar More Actions menu provides marketplace, installed, source management and installation commands. Pane actions appear on hover or keyboard focus.',
		);
		this.search.inputElement.setAttribute('aria-description', help);

		this._register(
			this.search.onDidChange(() => {
				this.searchActions.updateActions(this.createSearchActions());
				// Clearing disables the previous toolbar entry point; keep Filter reachable by Tab.
				if (!this.search.value) {
					this.searchActions.setTabStop('ash.extensions.filterSearch');
				}
				if (this.updatingSearch) {
					return;
				}
				this.searchOptions = this.search.value.trim()
					? { ...this.searchOptions, mode: this.searchOptions.mode === 'builtIn' ? 'builtIn' : undefined }
					: {};
				this.searchScheduler.schedule();
			}),
		);
		this._register(
			this.search.onKeyDown(event => {
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
					const pane =
						(this.searchOptions.view
							? this.getView(`ash.extensions.${this.searchOptions.view}`)
							: undefined) ??
						this.panes.find(pane => pane.isExpanded()) ??
						this.panes[0];
					pane?.setExpanded(true);
					pane?.focus();
				}
			}),
		);
		this.scopedContextKeyService.createKey('extensionsSearchFocused', true);
		this._register(
			AccessibleViewRegistry.register({
				type: AccessibleViewType.Help,
				priority: 110,
				name: `extensions-search-${generateUuid()}`,
				when: ContextKeyExpr.has('extensionsSearchFocused'),
				getProvider: () => {
					const focused = this.element.ownerDocument.activeElement;
					if (
						!this.isVisible() ||
						!(focused instanceof HTMLElement) ||
						!this.searchRegion.contains(focused)
					) {
						return undefined;
					}
					return new AccessibleContentProvider(
						AccessibleViewProviderId.Extensions,
						{ type: AccessibleViewType.Help },
						() => help,
						() => focused.focus(),
						AccessibilityVerbositySettingId.Extensions,
					);
				},
			}),
		);
		this._register(
			this.search.onDidFocus(() => {
				if (configuration.getValue<boolean>(AccessibilityVerbositySettingId.Extensions)) {
					this.search.inputElement.setAttribute('aria-description', help);
				} else {
					this.search.inputElement.removeAttribute('aria-description');
				}
			}),
		);
	}

	private searchFilters(): readonly { readonly token: string; readonly label: string }[] {
		return [
			{ token: '', label: localize({ bundle: 'ash.extensions', key: 'marketplacePane' }, 'Marketplace') },
			{ token: '@installed', label: localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed') },
			{ token: '@skills', label: localize({ bundle: 'ash.extensions', key: 'filterSkills' }, 'Skills') },
			{ token: '@plugins', label: localize({ bundle: 'ash.extensions', key: 'installedPlugins' }, 'Plugins') },
			{
				token: '@connections',
				label: localize({ bundle: 'ash.extensions', key: 'installedConnectors' }, 'Connections'),
			},
			{ token: '@builtin', label: localize({ bundle: 'ash.extensions', key: 'builtInFilter' }, 'Built-in') },
			{
				token: '@recommended',
				label: localize({ bundle: 'ash.extensions', key: 'recommendedPane' }, 'Recommended'),
			},
		];
	}

	private readSearch(): { readonly token: string; readonly query: string } {
		const raw = this.search.value.trim();
		const match = /^(@installed|@skills|@plugins|@connections|@connectors|@builtin|@recommended)(?:\s+|$)/iu.exec(
			raw,
		);
		const token = match?.[1].toLowerCase() ?? '';
		return {
			token: token === '@connectors' ? '@connections' : token,
			query: match ? raw.slice(match[0].length) : raw,
		};
	}

	private createSearchActions(): readonly IAction[] {
		return [
			{
				id: 'ash.extensions.clearSearch',
				label: localize({ bundle: 'ash.extensions', key: 'clearSearch' }, 'Clear Search'),
				tooltip: localize({ bundle: 'ash.extensions', key: 'clearSearch' }, 'Clear Search'),
				icon: Lxicon.clearAll,
				enabled: !!this.search.value,
				checked: undefined,
				run: () => this.open(),
			},
			{
				id: 'ash.extensions.filterSearch',
				label: localize({ bundle: 'ash.extensions', key: 'filterSearch' }, 'Filter extensions'),
				tooltip: localize({ bundle: 'ash.extensions', key: 'filterSearch' }, 'Filter extensions'),
				icon: Lxicon.filter,
				enabled: true,
				checked: undefined,
				run: () => undefined,
			},
		];
	}

	public override layout(dimension: IDimension): void {
		// Pane changes can reuse the previous content allocation; measure the host to subtract the search row once.
		super.layout({
			...dimension,
			height: Math.max(
				0,
				(this.element.clientHeight || dimension.height) - (this.searchRegion?.offsetHeight ?? 0),
			),
		});
	}

	public override focus(): void {
		this.search.focus();
	}

	public async open(options: ExtensionsOpenOptions = {}): Promise<void> {
		this.searchOptions = options;
		const installed =
			options.mode === 'installed' ||
			options.mode === 'builtIn' ||
			(!!options.view && options.view !== 'extensions' && options.mode !== 'browse');
		this.updatingSearch = true;
		this.search.value =
			options.mode === 'builtIn'
				? `@builtin ${options.query ?? ''}`.trimEnd()
				: installed && options.query
					? `@installed ${options.query}`
					: (options.query ?? '');
		this.updatingSearch = false;
		this.searchScheduler.cancel();
		this.search.focus();
		await this.applySearch();
	}

	public async refresh(): Promise<void> {
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;
		this.contextKeys.setContext('extensionsRefreshing', true);
		this.element.setAttribute('aria-busy', 'true');
		try {
			await Promise.all(
				this.panes.map(pane => {
					if (pane instanceof RecommendedExtensionsView) {
						return pane.refreshRecommendations();
					}
					if (
						pane instanceof ExtensionsListView ||
						pane instanceof SkillsViewPane ||
						pane instanceof McpServersViewPane
					) {
						return pane.refresh();
					}
					return Promise.resolve();
				}),
			);
		} finally {
			this.refreshing = false;
			this.contextKeys.setContext('extensionsRefreshing', false);
			if (!this.isDisposed) {
				this.element.setAttribute('aria-busy', 'false');
			}
		}
	}

	private async applySearch(): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		const raw = this.search.value.trim();
		const { token, query } = this.readSearch();
		const installed = !!token;
		const builtIn = token === '@builtin' || this.searchOptions.mode === 'builtIn';
		const installedCategory =
			(
				{
					'@skills': 'skills',
					'@plugins': 'plugins',
					'@connections': 'mcp',
					'@builtin': 'plugins',
					'@recommended': 'recommended',
				} as Record<string, string>
			)[token] ?? 'all';
		const marketplace =
			!installed &&
			!builtIn &&
			(raw.length > 0 ||
				this.searchOptions.mode === 'browse' ||
				!!this.searchOptions.capabilityKind ||
				!!this.searchOptions.languageId);
		const category =
			marketplace && (this.searchOptions.view === 'skills' || this.searchOptions.view === 'mcp')
				? this.searchOptions.view
				: 'view';
		const searchPlugins =
			marketplace &&
			this.searchOptions.mode !== 'browse' &&
			category === 'view' &&
			!!query &&
			!this.searchOptions.capabilityKind &&
			!this.searchOptions.languageId;
		const marketplaceCategories = searchPlugins ? [category, 'plugins'] : [category];
		this.contextKeys.bufferChangeEvents(() => {
			this.contextKeys.setContext('extensionsMarketplaceVisible', marketplace);
		});
		this.filterChanged.fire(
			marketplace
				? marketplaceCategories
				: installedCategory === 'all'
					? ['skills', 'plugins', 'mcp', 'recommended']
					: [installedCategory],
		);
		if (marketplace) {
			// Installed providers must remain manageable even when the registry has no match.
			if (searchPlugins) {
				const plugins = this.getView('ash.extensions.plugins');
				if (plugins instanceof ExtensionsListView) {
					plugins.setSearch(query);
					plugins.setExpanded(true);
				}
			}
			const pane = this.getView(`ash.extensions.${category}`);
			if (
				pane instanceof ExtensionsListView ||
				pane instanceof SkillsViewPane ||
				pane instanceof McpServersViewPane
			) {
				await pane.open({ ...this.searchOptions, mode: 'browse', query });
			}
		} else {
			for (const pane of this.panes) {
				if (
					pane instanceof ExtensionsListView ||
					pane instanceof SkillsViewPane ||
					pane instanceof McpServersViewPane ||
					pane instanceof RecommendedExtensionsView
				) {
					pane.setSearch(query);
				}
			}
			const target = this.getView(
				`ash.extensions.${installedCategory === 'all' ? (this.searchOptions.view ?? 'plugins') : installedCategory}`,
			);
			if (builtIn && target instanceof ExtensionsListView) {
				await target.open({ mode: 'builtIn', query });
			} else if (
				target &&
				(this.searchOptions.view ||
					this.searchOptions.mode === 'installed' ||
					installedCategory !== 'all' ||
					!raw)
			) {
				target.setExpanded(true);
			}
		}
	}

	protected override getFilterOn(viewDescriptor: IViewDescriptor): string | undefined {
		return viewDescriptor.id.startsWith('ash.extensions.')
			? viewDescriptor.id.slice('ash.extensions.'.length)
			: undefined;
	}

	protected override setFilter(viewDescriptor: IViewDescriptor): void {
		const category = this.getFilterOn(viewDescriptor);
		if (category === 'view') {
			void this.open({ mode: 'browse' });
		} else if (category) {
			void this.open({ mode: 'installed', view: category as ExtensionsOpenOptions['view'] });
		}
	}
}

/** Product commands resolve the retained container so search and refresh have one owner. */
export async function openExtensionsView(views: IViewsService, options: ExtensionsOpenOptions = {}): Promise<void> {
	const composite = await views.openViewContainer('ash.extensions', true);
	if (composite instanceof ExtensionsViewPaneContainer) {
		void composite.open(options);
	}
}

/** Both product hosts use the same capability panes with their own view registry and location. */
export function registerExtensionsViewContainer(
	registry: WorkbenchViewRegistry,
	location = ViewContainerLocation.Sidebar,
): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(
		registerAction2(
			class RefreshExtensions extends Action2 {
				constructor() {
					super({
						id: 'ash.extensions.refresh',
						title: localize2({ bundle: 'ash.extensions', key: 'refreshAll' }, 'Refresh extensions'),
						icon: Lxicon.refresh,
						f1: true,
						precondition: ContextKeyExpr.not('extensionsRefreshing'),
						menu: {
							id: MenuId.ViewContainerTitle,
							when: ContextKeyExpr.equals('viewContainer', 'ash.extensions'),
							group: 'navigation',
							order: 2,
						},
					});
				}
				public override async run(accessor: ServicesAccessor): Promise<void> {
					const container = accessor.get(IViewsService).getActiveViewPaneContainerWithId('ash.extensions');
					if (container instanceof ExtensionsViewPaneContainer) {
						await container.refresh();
					}
				}
			},
		),
	);
	registrations.add(
		registry.registerViewContainer({
			id: 'ash.extensions',
			title: localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'),
			location,
			icon: Lxicon.extensions,
			order: 8,
			ctorDescriptor: new SyncDescriptor(ExtensionsViewPaneContainer),
		}),
	);
	registrations.add(
		registry.registerViews('ash.extensions', [
			{
				id: 'ash.extensions.view',
				title: localize({ bundle: 'ash.extensions', key: 'marketplacePane' }, 'Marketplace'),
				canToggleVisibility: false,
				order: 0,
				ctorDescriptor: new SyncDescriptor(ExtensionsListView),
			},
			{
				id: 'ash.extensions.skills',
				title: localize({ bundle: 'ash.extensions', key: 'filterSkills' }, 'Skills'),
				collapsed: true,
				canToggleVisibility: false,
				order: 1,
				ctorDescriptor: new SyncDescriptor(SkillsViewPane),
			},
			{
				id: 'ash.extensions.plugins',
				title: localize({ bundle: 'ash.extensions', key: 'installedPlugins' }, 'Plugins'),
				canToggleVisibility: false,
				order: 2,
				ctorDescriptor: new SyncDescriptor(ExtensionsListView),
			},
			{
				id: 'ash.extensions.mcp',
				title: localize({ bundle: 'ash.extensions', key: 'installedConnectors' }, 'Connections'),
				collapsed: true,
				canToggleVisibility: false,
				order: 3,
				ctorDescriptor: new SyncDescriptor(McpServersViewPane),
			},
			{
				id: 'ash.extensions.recommended',
				title: localize({ bundle: 'ash.extensions', key: 'recommendedPane' }, 'Recommended'),
				canToggleVisibility: false,
				order: 4,
				collapsed: true,
				ctorDescriptor: new SyncDescriptor(RecommendedExtensionsView),
			},
		]),
	);
	return registrations;
}
