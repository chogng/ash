import { AgentPluginEditorInput } from '../../../../workbench/contrib/extensions/common/agentPluginEditorInput.js';
import { ACADEMY_PACKAGE_ID, isAcademyExtension } from '../../../../workbench/contrib/extensions/common/academyExtension.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { SegmentedControl } from '../../../../base/browser/ui/segmentedControl/segmentedControl.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { raceCancellationError, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { derived, observableValue } from '../../../../base/common/observable.js';
import type { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConnectorService } from '../../../../platform/connectors/common/connectorService.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import {
	CustomizationMarketplaceMediaType,
	ICustomizationMarketplaceService,
	type ICustomizationMarketplaceCursor,
	type ICustomizationMarketplaceResource,
} from '../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpServerManagementService } from '../../../../platform/mcp/common/mcpServerManagementService.js';
import { IMcpServerStatusService } from '../../../../platform/mcp/common/mcpServerStatusService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import {
	addConnection,
	describeConnectorState,
	describeMcpServerState,
	getMarketplaceMcpServerId,
	getSkillSummary,
} from '../../../../workbench/contrib/extensions/browser/extensionsActions.js';
import {
	changeExtensionPackage,
	ExtensionEditor,
} from '../../../../workbench/contrib/extensions/browser/extensionEditor.js';
import {
	ExtensionsCapabilityInput,
	ExtensionsInput,
} from '../../../../workbench/contrib/extensions/common/extensionsInput.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { CustomizeSkillActions } from './customizeSkillActions.js';
import './customizeEditor.css';
import { ToolbarSearchActionViewItem } from '../../../browser/ui/toolbarSearchActionViewItem.js';

type Category = 'skills' | 'connectors' | 'plugins';
type Collection = 'yours' | 'discover';
type InstalledCategory = Exclude<Category, 'connectors'>;
type CatalogLocation = { readonly category: Category; readonly collection: Collection; };
type InstalledSelection = { readonly category: InstalledCategory; readonly id: string; };
export const CUSTOMIZE_NAVIGATION_CONTAINER = 'sessions.customize.navigation';
export const CUSTOMIZE_NAVIGATION_VIEW = CUSTOMIZE_NAVIGATION_CONTAINER + '.view';
interface Card {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly metadata?: string;
	readonly installed?: boolean;
	readonly install?: () => Promise<unknown>;
	readonly open: () => Promise<void>;
}
interface Catalog {
	readonly cards: readonly Card[];
	readonly note?: string;
	readonly cursor?: ICustomizationMarketplaceCursor;
}
interface CatalogMenuAction extends IAction {
	readonly getActions: () => readonly IAction[];
}

/** A Sessions catalog projection. The existing domain services and detail editors own all mutations. */
export class CustomizeEditorPane extends EditorPane {
	public readonly id = 'sessions.editor.customize';
	private root!: HTMLElement;
	private catalog!: HTMLElement;
	private catalogHeader!: HTMLElement;
	private details!: HTMLElement;
	private detailHost!: HTMLElement;
	private back!: Button;
	private detailEditor: ExtensionEditor | undefined;
	private catalogScrollTop = 0;
	private returnFocus:
		{ readonly element: HTMLElement; readonly resourceId?: string; readonly action: boolean; } | undefined;
	private readonly detailResources = this._register(new DisposableStore());
	private panel!: HTMLElement;
	private grid!: HTMLElement;
	private message!: HTMLElement;
	private heading!: HTMLElement;
	private count!: CountBadge;
	private countContainer!: HTMLElement;
	private hero!: HTMLElement;
	private heroTitle!: HTMLElement;
	private heroDescription!: HTMLElement;
	private search!: HTMLInputElement;
	private searchAction!: IAction;
	private searchActionViewItem!: ToolbarSearchActionViewItem;
	private tabs!: TabList<Category>;
	private collectionControl!: SegmentedControl<Collection>;
	private toolbar!: ActionBar;
	private toolbarActions: readonly CatalogMenuAction[] = [];
	private more!: Button;
	private retry!: Button;
	private readonly location = observableValue<CatalogLocation>(this, { category: 'skills', collection: 'yours' });
	private get category(): Category { return this.location.get().category; }
	private get collection(): Collection { return this.location.get().collection; }
	private readonly installedSelection = observableValue<InstalledSelection | undefined>(this, undefined);
	private readonly installedCatalogs = observableValue<Partial<Record<InstalledCategory, Catalog>>>(this, {});
	private readonly installedReads = new Map<InstalledCategory, { readonly sessionId: string | undefined; readonly result: Promise<Catalog>; }>();
	public readonly navigation = derived(reader => {
		const { category, collection } = this.location.read(reader);
		const catalogs = this.installedCatalogs.read(reader);
		return {
			current: collection === 'discover' ? 'discover' : category,
			selected: this.installedSelection.read(reader),
			plugins: catalogs.plugins?.cards ?? [],
			skills: catalogs.skills?.cards ?? [],
		};
	});
	private sourceId: string | undefined;
	private descending = false;
	private cards: readonly Card[] = [];
	private note = '';
	private loadedQuery: string | undefined;
	private cursor: ICustomizationMarketplaceCursor | undefined;
	private request: CancellationTokenSource | undefined;
	private shown = false;
	private opening = false;
	private readonly cardResources = this._register(new DisposableStore());
	private readonly refresh = this._register(new RunOnceScheduler(() => { void this.load(); }, 200));
	private readonly installedRefresh = this._register(new RunOnceScheduler(() => this.refreshInstalled(), 200));
	private readonly actions = new AbortController();
	private skillActions!: CustomizeSkillActions;

	constructor(
		@IPromptsService private readonly prompts: IPromptsService,
		@ICustomizationMarketplaceService private readonly marketplace: ICustomizationMarketplaceService,
		@IExtensionManagementService private readonly extensions: IExtensionManagementService,
		@IPluginManagementService private readonly plugins: IPluginManagementService,
		@IConnectorService private readonly connectors: IConnectorService,
		@IMcpServerManagementService private readonly mcp: IMcpServerManagementService,
		@IMcpServerStatusService private readonly mcpStatus: IMcpServerStatusService,
		@IChatSessionNavigationService private readonly sessions: IChatSessionNavigationService,
		@ICommandService private readonly commands: ICommandService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@IHoverService private readonly hover: IHoverService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService private readonly accessible: IAccessibleViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly views: IViewsService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super('sessions.editor.customize', theme, storage);
		const refresh = () => { if (this.shown) this.refresh.schedule(); };
		this._register(prompts.onDidChangeSkills(() => {
			this.invalidateInstalled('skills');
			refresh();
		}));
		for (const event of [extensions.onDidChangeInstalled, plugins.onDidChange]) {
			this._register(event(() => {
				this.invalidateInstalled('plugins');
				refresh();
			}));
		}
		for (const event of [marketplace.onDidChangeSources, connectors.onDidChange, mcp.onDidChange]) {
			this._register(event(refresh));
		}
		this._register(this.layoutService.onDidChangePartVisibility(({ partId }) => {
			if (partId === 'sidebar') this.updateNavigationControls();
		}));
		this._register(this.views.onDidChangeViewVisibility(({ id }) => {
			if (id === CUSTOMIZE_NAVIGATION_VIEW) this.updateNavigationControls();
		}));
		this._register(
			toDisposable(() => {
				this.request?.dispose(true);
				this.actions.abort();
				this.root?.remove();
			}),
		);
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.skillActions = this._register(this.instantiationService.createInstance(CustomizeSkillActions, document));
		this.root = h(document, 'section', { className: 'ash-customize' });
		parent.append(this.root);
		super.create(this.root);
		const hint = this.accessible.getOpenAriaHint(AccessibilityVerbositySettingId.Customize);
		this.root.setAttribute('aria-label', `${localize('customize.title', 'Customize')}${hint ? ` ${hint}` : ''}`);
		this._register(this.contexts.createScoped(this.root)).createKey('sessionsCustomizeFocused', true);
		this.catalog = h(document, 'div', { className: 'ash-customize-catalog' });
		this.root.append(this.catalog);
		this.catalogHeader = h(document, 'header', { className: 'ash-customize-header' });
		this.catalogHeader.append(h(document, 'h1', {}, localize('customize.title', 'Customize')));
		this.catalog.append(this.catalogHeader);
		const toolbar = h(document, 'div', { className: 'ash-customize-toolbar' });
		this.catalogHeader.append(toolbar);
		this.tabs = this._register(
			new TabList(toolbar, {
				ariaLabel: localize('customize.categories', 'Customization categories'),
				presentation: 'navigation',
				onActivate: category => {
					if (category === this.category) return;
					this.location.set({ category, collection: this.collection }, undefined);
					this.sourceId = undefined;
					this.search.value = '';
					this.updateControls();
					void this.load();
				},
			}),
		);
		this.collectionControl = this._register(
			new SegmentedControl(toolbar, {
				ariaLabel: localize('customize.collection', 'Resource collection'),
				items: [
					{ id: 'yours', label: localize('customize.yours', 'Yours') },
					{ id: 'discover', label: localize('customize.discover', 'Discover') },
				],
				selectedId: this.collection,
				onActivate: collection => this.selectCollection(collection),
			}),
		);
		const tools = h(document, 'div', { className: 'ash-customize-tools' });
		toolbar.append(tools);
		const searchLabel = localize('customize.search', 'Search');
		this.search = h(document, 'input', {
			className: 'ash-customize-search',
			properties: { type: 'search', placeholder: searchLabel },
			attributes: { 'aria-label': searchLabel },
		});
		const updateSearch = () => {
			if (this.collection === 'discover') {
				this.request?.dispose(true);
				this.cursor = undefined;
				this.more.domNode.hidden = true;
				this.refresh.schedule();
			} else this.renderCards();
		};
		this._register(addDisposableListener(this.search, 'input', updateSearch));
		this._register(
			addDisposableListener(this.search, 'keydown', event => {
				if (event.key === 'ArrowDown' && !event.isComposing) {
					event.preventDefault();
					this.grid.querySelector<HTMLButtonElement>('button')?.focus();
				}
			}),
		);
		this.searchAction = {
			id: 'searchResources',
			label: searchLabel,
			tooltip: searchLabel,
			icon: Lxicon.search,
			enabled: true,
			run: () => {
				this.searchActionViewItem.setExpanded(true);
				this.search.focus();
			},
		};
		this.toolbarActions = [
			{
				id: 'filterSources',
				label: localize('customize.filter', 'Filter sources'),
				icon: Lxicon.listFilter,
				getActions: () => [
					this.menuAction(
						'all',
						localize('customize.allSources', 'All sources'),
						() => this.setSource(undefined),
						!this.sourceId,
					),
					...this.marketplace.sources.map(source =>
						this.menuAction(
							source.id,
							source.displayName,
							() => this.setSource(source.id),
							this.sourceId === source.id,
						),
					),
				],
			},
			{
				id: 'sortResources',
				label: localize('customize.sort', 'Sort resources'),
				icon: Lxicon.sort,
				getActions: () => [
					this.menuAction(
						'ascending',
						localize('customize.ascending', 'Name: A to Z'),
						() => {
							this.descending = false;
							this.renderCards();
						},
						!this.descending,
					),
					this.menuAction(
						'descending',
						localize('customize.descending', 'Name: Z to A'),
						() => {
							this.descending = true;
							this.renderCards();
						},
						this.descending,
					),
				],
			},
			{
				id: 'addResource',
				label: localize('customize.add', 'Add'),
				icon: Lxicon.add,
				getActions: () => this.addActions(),
			},
		].map(action => ({ ...action, tooltip: action.label, enabled: true, run: () => undefined }));
		this.toolbar = this._register(
			new ActionBar(tools, {
				ariaLabel: localize('customize.actions', 'Customization actions'),
				actionViewItemOptions: { buttonStyles: defaultButtonStyles },
				actionViewItemProvider: (action, options) => {
					if (action === this.searchAction) {
						this.searchActionViewItem = new ToolbarSearchActionViewItem(
							action,
							options,
							this.search,
							() => {
								this.search.value = '';
								this.searchActionViewItem.setExpanded(false);
								this.searchActionViewItem.focus();
								updateSearch();
							},
							localize('customize.closeSearch', 'Close search'),
						);
						return this.searchActionViewItem;
					}
					const menuAction = this.toolbarActions.find(item => item.id === action.id);
					if (!menuAction) return undefined;
					const provider =
						action.id === 'addResource'
							? {
								showContextMenu: (
									delegate: Parameters<IContextMenuService['showContextMenu']>[0],
								) =>
									this.menus.showContextMenu({
										...delegate,
										anchorAlignment: AnchorAlignment.Right,
										gap: 8,
										getMenuClassName: () => 'ash-customize-add-menu',
									}),
							}
							: this.menus;
					return new DropdownMenuActionViewItem(action, menuAction.getActions, provider, {
						...options,
						buttonPresentation: action.id === 'addResource' ? 'primary' : 'quiet',
					});
				},
			}),
		);
		this.toolbar.domNode.classList.add('ash-customize-actions');
		this.panel = h(document, 'div', {
			className: 'ash-customize-panel',
			attributes: { id: 'ash-customize-panel', role: 'tabpanel' },
		});
		this.catalog.append(this.panel);
		this.hero = h(document, 'div', { className: 'ash-customize-hero' });
		this.heroTitle = h(document, 'h2');
		this.heroDescription = h(document, 'p');
		this.hero.append(this.heroTitle, this.heroDescription);
		this.panel.append(this.hero);
		const header = h(document, 'div', { className: 'ash-customize-results-heading' });
		const title = h(document, 'h2');
		this.heading = h(document, 'span', { attributes: { id: 'ash-customize-results-title' } });
		title.append(this.heading);
		this.countContainer = h(document, 'span', { className: 'ash-customize-count' });
		title.append(this.countContainer);
		this.count = this._register(new CountBadge(this.countContainer, {
			titleFormat: localize('customize.count', '{0} resources'),
		}));
		this.countContainer.hidden = true;
		header.append(title);
		const refresh = this._register(
			new Button(header, {
				...defaultButtonStyles,
				label: localize('customize.refresh', 'Refresh'),
				icon: Lxicon.refresh,
				iconOnly: true,
				onClick: () => {
					void this.load();
					this.refreshInstalled();
				},
			}),
		);
		refresh.setTitle(refresh.label);
		this.message = h(document, 'p', {
			className: 'ash-customize-message',
			attributes: { role: 'status', 'aria-live': 'polite' },
		});
		this.retry = this._register(
			new Button(this.panel, {
				...defaultButtonStyles,
				label: localize('customize.retry', 'Retry'),
				onClick: () => {
					void this.load();
				},
			}),
		);
		this.retry.domNode.hidden = true;
		this.grid = h(document, 'div', { className: 'ash-customize-grid' });
		this.panel.append(header, this.message, this.retry.domNode, this.grid);
		this.more = this._register(
			new Button(this.panel, {
				...defaultButtonStyles,
				label: localize('customize.more', 'Load more'),
				onClick: () => {
					void this.load(true);
				},
			}),
		);
		this.more.domNode.hidden = true;
		this._register(addDisposableListener(this.grid, 'keydown', event => this.navigateCards(event)));
		this.details = h(document, 'div', { className: 'ash-customize-details' });
		this.details.hidden = true;
		const navigation = h(document, 'div', { className: 'ash-customize-detail-navigation' });
		this.back = this._register(
			new Button(navigation, {
				...defaultButtonStyles,
				label: localize('customize.skills', 'Skills'),
				icon: Lxicon.arrowLeft,
				onClick: () => this.showCatalog(),
			}),
		);
		this.detailHost = h(document, 'div', { className: 'ash-customize-detail-host' });
		this.details.append(navigation, this.detailHost);
		this.root.append(this.details);
		this.registerAccessibility();
		this.updateControls();
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
	}

	public openCatalog(category: Category, collection: Collection, query = '', focus = true): void {
		this.showCatalog(false);
		this.location.set({ category, collection }, undefined);
		this.sourceId = undefined;
		this.search.value = query;
		this.updateControls();
		this.searchActionViewItem.setExpanded(!!query);
		void this.load();
		if (focus) this.focus();
	}

	public openSidebarCatalog(target: 'discover' | Category): void {
		if (target === 'discover') this.openCatalog(this.category, 'discover', '', false);
		else this.openCatalog(target, 'yours', '', false);
	}

	public openSidebarResource(category: InstalledCategory, id: string, trigger: HTMLElement): void {
		const card = this.installedCatalogs.get()[category]?.cards.find(candidate => candidate.id === id);
		if (!card || !this.shown) return;
		if (this.category !== category || this.collection !== 'yours') this.openSidebarCatalog(category);
		this.returnFocus = { element: trigger, action: false };
		void this.showCardDetails(card).catch(error => {
			if (!this.isDisposed && this.shown && !isCancellationError(error)) this.setMessage(String(error));
		});
	}

	public override clearInput(): void {
		this.request?.dispose(true);
		this.refresh.cancel();
		this.installedRefresh.cancel();
		this.showCatalog(false);
	}
	public override focus(): void {
		if (this.detailEditor) this.back.focus();
		else this.searchActionViewItem.focus();
	}
	public override layout(dimension: IDimension): void {
		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
		this.root.classList.toggle('narrow', dimension.width < 760);
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.shown = visible;
		this.detailEditor?.setVisible(visible);
		if (visible) {
			void this.load();
			this.refreshInstalled();
		}
		else {
			this.refresh.cancel();
			this.installedRefresh.cancel();
			this.request?.dispose(true);
		}
	}

	private selectCollection(collection: Collection): void {
		if (collection === this.collection) return;
		this.location.set({ category: this.category, collection }, undefined);
		this.updateControls();
		void this.load();
	}

	private updateControls(): void {
		const categories = [
			{ id: 'skills' as const, label: localize('customize.skills', 'Skills') },
			{ id: 'connectors' as const, label: localize('customize.connectors', 'Connectors') },
			{ id: 'plugins' as const, label: localize('customize.plugins', 'Plugins') },
		];
		this.tabs.setTabs(
			categories.map(item => ({
				...item,
				value: item.id,
				tabId: `ash-customize-${item.id}`,
				panelId: this.panel.id,
			})),
			this.category,
		);
		this.collectionControl.setSelection(this.collection);
		this.updateNavigationControls();
		this.toolbar.setActions([
			this.searchAction,
			...this.toolbarActions.filter(
				action =>
					action.id !== 'filterSources' || (this.collection === 'discover' && this.category !== 'plugins'),
			),
		]);
		this.toolbar.domNode
			.querySelector('[data-action-id="filterSources"] button')
			?.setAttribute('aria-pressed', String(!!this.sourceId));
		this.hero.hidden = this.collection !== 'discover';
		this.heroTitle.textContent =
			this.category === 'skills'
				? localize('customize.skillsTitle', 'Give Ash new ways to work')
				: this.category === 'connectors'
					? localize('customize.connectorsTitle', 'Bring your tools into the conversation')
					: localize('customize.pluginsTitle', 'Make Ash your own');
		this.heroDescription.textContent =
			this.category === 'skills'
				? localize(
					'customize.skillsDescription',
					'Discover reusable instructions for writing, research, coding and everyday work.',
				)
				: this.category === 'connectors'
					? localize(
						'customize.connectorsDescription',
						'Connect your services and MCP servers to work with the context you need.',
					)
					: localize(
						'customize.pluginsDescription',
						'Explore plugins that add tools and capabilities to your workspace.',
					);
		this.heading.textContent =
			this.collection === 'yours' && this.category === 'connectors'
				? localize('customize.connections', 'Connections')
				: this.collection === 'yours'
					? localize(
						'customize.yourResources',
						'Your {0}',
						categories.find(item => item.id === this.category)!.label.toLocaleLowerCase(),
					)
					: localize(
						'customize.discoverResources',
						'Discover {0}',
						categories.find(item => item.id === this.category)!.label.toLocaleLowerCase(),
					);
	}

	private updateNavigationControls(): void {
		if (!this.panel) return;
		const sidebar = this.layoutService.isPartVisible('sidebar') && this.views.isViewVisible(CUSTOMIZE_NAVIGATION_VIEW);
		const showTabs = !sidebar || this.collection === 'discover';
		this.catalogHeader.classList.toggle('compact', !showTabs);
		this.tabs.element.hidden = !showTabs;
		this.collectionControl.domNode.hidden = sidebar;
		this.panel.setAttribute('role', showTabs ? 'tabpanel' : 'region');
		this.panel.setAttribute('aria-labelledby', showTabs ? `ash-customize-${this.category}` : this.heading.id);
	}

	private async load(append = false): Promise<void> {
		if (!this.shown || !this.grid) return;
		this.refresh.cancel();
		this.request?.dispose(true);
		const request = (this.request = new CancellationTokenSource());
		const sessionId = this.sessions.getActiveConversation()?.sessionId;
		const cursor = append ? this.cursor : undefined;
		const queryKey = JSON.stringify([
			this.category,
			this.collection,
			this.sourceId,
			this.collection === 'discover' ? this.search.value : '',
			sessionId,
		]);
		if (!append && queryKey !== this.loadedQuery) {
			this.cards = [];
			this.note = '';
			this.cursor = undefined;
			this.loadedQuery = queryKey;
			this.renderCards();
			this.countContainer.hidden = true;
		}
		this.panel.setAttribute('aria-busy', 'true');
		this.more.enabled = false;
		this.retry.domNode.hidden = true;
		this.setMessage(localize('customize.loading', 'Loading resources…'), !this.cards.length);
		try {
			const result =
				this.collection === 'discover'
					? await this.readDiscover(request, cursor)
					: this.category === 'connectors' ? await this.readConnections() : await this.readInstalled(this.category, sessionId);
			if (request.token.isCancellationRequested || !this.shown) return;
			if (sessionId !== this.sessions.getActiveConversation()?.sessionId) {
				this.refresh.schedule();
				return;
			}
			const unique = new Map(
				(append ? [...this.cards, ...result.cards] : result.cards).map(card => [card.id, card]),
			);
			this.cards = [...unique.values()];
			this.note = result.note ?? '';
			this.cursor = result.cursor;
			this.renderCards();
		} catch (error) {
			if (request.token.isCancellationRequested || !this.shown || isCancellationError(error)) return;
			this.cursor = undefined;
			this.more.domNode.hidden = true;
			this.setMessage(localize('customize.loadFailed', 'Could not load resources: {0}', String(error)));
			this.retry.domNode.hidden = false;
		} finally {
			if (this.request === request && !request.token.isCancellationRequested) {
				this.panel.setAttribute('aria-busy', 'false');
				this.more.enabled = true;
			}
		}
	}

	private async readDiscover(
		request: CancellationTokenSource,
		cursor?: ICustomizationMarketplaceCursor,
	): Promise<Catalog> {
		const query = this.search.value.trim();
		if (this.category === 'plugins') {
			const [snapshot, academy] = await Promise.all([
				this.extensions.refreshBrowse(query, { packageType: 'plugin', limit: 200 }),
				this.extensions.get(ACADEMY_PACKAGE_ID).catch(() => undefined),
			]);
			const packages = snapshot.packages.map(({ summary }) => summary).filter(summary => !isAcademyExtension(summary.id));
			const normalizedQuery = query.toLowerCase();
			if (academy && [academy.package.id, academy.displayName, academy.description].some(value => value.toLowerCase().includes(normalizedQuery))) {
				packages.push({
					id: academy.package.id, version: academy.package.version, packageType: academy.packageType,
					displayName: academy.displayName, description: academy.description, uiTargets: academy.uiTargets,
				});
			}
			return {
				cards: packages.map(summary => ({
					id: `${summary.id}/${summary.version}`,
					name: summary.displayName,
					description: summary.description,
					metadata: summary.version,
					open: () =>
						this.openInput(
							new ExtensionsInput(
								summary,
								snapshot.installed.find(
									item => item.package.id === summary.id && item.package.version === summary.version,
								)?.installationId,
							),
						),
				})),
				note: snapshot.unavailableSources.join(' · '),
			};
		}
		const skills = this.category === 'skills';
		const [page, installed] = await Promise.all([
			this.marketplace.query(
				{
					query,
					mediaType: skills
						? CustomizationMarketplaceMediaType.Skill
						: CustomizationMarketplaceMediaType.McpServer,
					sourceIds: this.sourceId ? [this.sourceId] : undefined,
					pageSize: 30,
					cursor,
				},
				request.token,
			),
			skills ? this.extensions.listInstalled() : Promise.resolve([]),
		]);
		return {
			cards: page.items.map(resource => ({
				id: JSON.stringify([resource.sourceId, resource.identifier, resource.version]),
				name: resource.displayName,
				description: resource.description,
				metadata: `${this.marketplace.allSources.find(source => source.id === resource.sourceId)?.displayName ?? resource.sourceId} · ${resource.version}`,
				installed:
					skills &&
					installed.some(
						item =>
							item.package.id === resource.installation.selectionId &&
							item.package.version === resource.version &&
							item.state === 'installed',
					),
				install:
					skills && !installed.some(item => item.package.id === resource.installation.selectionId)
						? async () => {
							const details = await this.extensions.get(
								resource.installation.selectionId,
								resource.version,
							);
							if (!this.shown || this.isDisposed) return;
							const result = await changeExtensionPackage(
								this.extensions,
								this.dialogs,
								this.notifications,
								'install',
								details,
							);
							if (result && this.shown && !this.isDisposed) {
								this.invalidateInstalled('plugins');
								await this.load();
							}
						}
						: undefined,
				open: () => this.openResource(resource),
			})),
			cursor: page.nextCursor,
			note: !this.marketplace.sources.length
				? localize(
					'customize.discoveryUnavailable',
					'Discovery is disabled or no catalog sources are available.',
				)
				: page.sourceErrors?.map(error => error.message).join(' · '),
		};
	}

	private invalidateInstalled(category: InstalledCategory): void {
		this.installedReads.delete(category);
		if (this.shown) this.installedRefresh.schedule();
	}

	private refreshInstalled(): void {
		if (!this.shown) return;
		this.installedRefresh.cancel();
		const sessionId = this.sessions.getActiveConversation()?.sessionId;
		for (const category of ['plugins', 'skills'] as const) {
			void this.readInstalled(category, sessionId).catch(() => {
				// The corresponding catalog reports its read failure and offers Retry.
			});
		}
	}

	/** The sidebar and the installed results use the same pending read and catalog. */
	private readInstalled(category: InstalledCategory, sessionId: string | undefined): Promise<Catalog> {
		const scope = category === 'skills' ? sessionId : undefined;
		const pending = this.installedReads.get(category);
		if (pending && pending.sessionId === scope) return pending.result;
		const result = this.loadInstalled(category, scope).then(catalog => {
			if (!this.isDisposed && this.installedReads.get(category)?.result === result
				&& (category === 'plugins' || scope === this.sessions.getActiveConversation()?.sessionId)) {
				this.installedCatalogs.set({ ...this.installedCatalogs.get(), [category]: catalog }, undefined);
			}
			return catalog;
		}).finally(() => {
			if (this.installedReads.get(category)?.result === result) this.installedReads.delete(category);
		});
		this.installedReads.set(category, { sessionId: scope, result });
		return result;
	}

	private async loadInstalled(category: InstalledCategory, sessionId: string | undefined): Promise<Catalog> {
		if (category === 'skills') {
			const snapshot = await this.prompts.readSkillManagement(sessionId);
			return {
				cards: snapshot.catalog.skills.map(skill => ({
					id: JSON.stringify(skill.id),
					name: skill.name,
					description: getSkillSummary(skill),
					open: () =>
						this.openInput(
							new ExtensionsCapabilityInput({
								kind: 'skill',
								source: skill.id.source,
								name: skill.id.name,
								sessionId,
							}),
						),
				})),
				note: snapshot.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
			};
		}
		const [installed, local] = await Promise.all([this.extensions.listInstalled(), this.plugins.list()]);
		const registryPlugins = await Promise.all(installed.map(async installation => {
			if (isAcademyExtension(installation.package.id)) return installation;
			if (!installation.capabilities.some(capability => capability.kind === 'editorExtension')) return installation;
			// Registry plugins can also contribute editors. Use the package type to keep standalone editor extensions in the IDE.
			const details = await this.extensions.get(installation.package.id, installation.package.version).catch(() => undefined);
			return details?.packageType === 'plugin' ? installation : undefined;
		}));
		return {
			cards: [
				...registryPlugins.filter(installation => installation !== undefined).map(installation => ({
					id: installation.installationId,
					name: installation.package.id,
					description: installation.capabilities.map(capability => capability.kind).join(' · '),
					metadata:
						installation.state === 'pendingRemoval'
							? localize('customize.removing', 'Removal pending')
							: installation.package.version,
					open: () =>
						this.openInput(
							new ExtensionsInput(
								{
									id: installation.package.id,
									version: installation.package.version,
									displayName: installation.package.id,
									description: '',
									packageType: 'installed',
								},
								installation.installationId,
							),
						),
				})),
				...local.packages.map(plugin => ({
					id: `local/${plugin.id}/${plugin.digest}`,
					name: plugin.displayName,
					description: localize('customize.localPlugin', 'Local plugin'),
					metadata: [
						plugin.version,
						plugin.enabled
							? localize('customize.enabled', 'Enabled')
							: localize('customize.disabled', 'Disabled'),
					].join(' · '),
					open: () =>
						this.openInput(
							new AgentPluginEditorInput(
								{
									id: plugin.id,
									version: plugin.version,
									displayName: plugin.displayName,
									description: '',
									packageType: 'editorExtension',
								},
								plugin.digest,
							),
						),
				})),
			],
		};
	}

	private async readConnections(): Promise<Catalog> {
		// Independent owners can fail separately; keep usable accounts and servers visible.
		const [accounts, configuration, runtime, packages] = await Promise.allSettled([
			this.connectors.list(),
			this.mcp.isAvailable ? this.mcp.readConfiguration() : Promise.resolve(undefined),
			this.mcpStatus.isAvailable ? this.mcpStatus.read() : Promise.resolve(undefined),
			this.extensions.listInstalled(),
		]);
		const connectors = accounts.status === 'fulfilled' ? accounts.value.connectors : [];
		const installations = packages.status === 'fulfilled' ? packages.value : [];
		const packageServers = new Map(installations.flatMap(installation => installation.capabilities
			.filter(capability => capability.kind === 'mcp')
			.map(capability => [getMarketplaceMcpServerId(installation.package.id, capability.id), { installation, capability }] as const)));
		const linked = new Set(
			connectors.flatMap(connector => [
				connector.mcpDeclarationId,
				...(connector.mcpServerId ? [connector.mcpServerId] : []),
			]),
		);
		const cards = new Map<string, Card>();
		for (const connector of connectors) {
			const owner = packageServers.get(connector.mcpDeclarationId)
				?? (connector.mcpServerId ? packageServers.get(connector.mcpServerId) : undefined);
			cards.set(`connector/${connector.id}`, {
				id: `connector/${connector.id}`,
				name: connector.displayName,
				description: connector.description,
				metadata: [describeConnectorState(connector.state, connector.enabled),
				owner && localize('customize.connectionFromPlugin', 'From {0}', owner.installation.package.id),
				].filter(Boolean).join(' · '),
				open: () =>
					this.openInput(new ExtensionsCapabilityInput({ kind: 'connector', connectorId: connector.id })),
			});
		}
		for (const [id, { installation, capability }] of packageServers) {
			if (linked.has(id)) continue;
			cards.set(id, {
				id,
				name: capability.id,
				description: localize('customize.connectionFromPlugin', 'From {0}', installation.package.id),
				metadata: installation.package.version,
				open: () =>
					this.openInput(
						new ExtensionsCapabilityInput({
							kind: 'mcp',
							serverId: id,
							installationId: installation.installationId,
							capabilityId: capability.reference.id,
						}),
					),
			});
		}
		for (const server of configuration.status === 'fulfilled' ? (configuration.value?.servers ?? []) : []) {
			if (linked.has(server.id) || cards.has(server.id)) continue;
			cards.set(server.id, {
				id: server.id,
				name: server.displayName,
				description: localize('customize.standaloneMcp', 'Standalone MCP server · {0}', server.id),
				metadata:
					server.enablement === 'enabled'
						? localize('customize.enabled', 'Enabled')
						: localize('customize.disabled', 'Disabled'),
				open: () => this.openInput(new ExtensionsCapabilityInput({ kind: 'mcp', serverId: server.id })),
			});
		}
		for (const server of runtime.status === 'fulfilled' ? (runtime.value?.servers ?? []) : []) {
			if (linked.has(server.id)) continue;
			const existing = cards.get(server.id);
			cards.set(server.id, {
				id: server.id,
				name: server.displayName || existing?.name || server.id,
				description: existing?.description ?? server.id,
				metadata: describeMcpServerState(server.state),
				open:
					existing?.open ??
					(() => this.openInput(new ExtensionsCapabilityInput({ kind: 'mcp', serverId: server.id }))),
			});
		}
		return {
			cards: [...cards.values()],
			note: [accounts, configuration, runtime, packages]
				.flatMap(result => (result.status === 'rejected' ? [String(result.reason)] : []))
				.join('\n'),
		};
	}

	private renderCards(): void {
		const active = this.root.ownerDocument.activeElement as HTMLElement | null;
		const focusedId = this.grid.contains(active)
			? active?.closest<HTMLElement>('[data-resource-id]')?.dataset.resourceId
			: undefined;
		this.cardResources.clear();
		this.grid.replaceChildren();
		const query = this.search.value.trim().toLocaleLowerCase();
		const cards = this.cards
			.filter(
				card =>
					this.collection === 'discover' ||
					`${card.name} ${card.description} ${card.metadata ?? ''}`.toLocaleLowerCase().includes(query),
			)
			.sort((left, right) => left.name.localeCompare(right.name) * (this.descending ? -1 : 1));
		for (const card of cards) {
			const article = h(this.grid.ownerDocument, 'article', { className: 'ash-customize-card' });
			article.dataset.resourceId = card.id;
			const icon = h(this.grid.ownerDocument, 'div', {
				className: 'ash-customize-card-icon',
				attributes: { 'aria-hidden': 'true' },
			});
			appendIcon(
				this.category === 'skills'
					? Lxicon.book
					: this.category === 'connectors'
						? Lxicon.plug
						: Lxicon.extensions,
				icon,
			);
			const content = h(this.grid.ownerDocument, 'div', { className: 'ash-customize-card-content' });
			const name = this.cardResources.add(
				new Button(content, {
					...defaultButtonStyles,
					label: card.name,
					onClick: () => {
						this.openCard(card);
					},
				}),
			);
			name.domNode.classList.add('ash-customize-card-name');
			const description = h(
				this.grid.ownerDocument,
				'p',
				{ className: 'ash-customize-card-description' },
				card.description,
			);
			content.append(description);
			if (card.metadata) {
				const metadata = h(
					this.grid.ownerDocument,
					'p',
					{ className: 'ash-customize-card-metadata' },
					card.metadata,
				);
				content.append(metadata);
				this.cardResources.add(this.hover.setupDelayedHover(metadata, { content: card.metadata }));
			}
			this.cardResources.add(this.hover.setupDelayedHover(description, { content: card.description }));
			this.cardResources.add(this.hover.setupDelayedHover(name.domNode, { content: card.name }));
			article.append(icon, content);
			const open = this.cardResources.add(
				new Button(article, {
					...defaultButtonStyles,
					label: card.installed
						? localize('customize.installedDetails', 'Installed: {0}. View details', card.name)
						: card.install
							? localize('customize.installSkill', 'Install {0}', card.name)
							: localize('customize.details', 'View {0}', card.name),
					icon: card.installed ? Lxicon.check : card.install ? Lxicon.add : Lxicon.arrowRight,
					iconOnly: true,
					onClick: () => {
						void this.run(async () => {
							const document = open.domNode.ownerDocument;
							const restoreFocus = document.activeElement === open.domNode;
							open.enabled = false;
							try {
								if (card.install) await card.install();
								else await this.showCardDetails(card);
							} finally {
								if (open.domNode.isConnected) open.enabled = true;
								// The review dialog cannot restore focus to the disabled install button.
								if (restoreFocus && this.shown && document.activeElement === document.body) {
									const row = [...this.grid.children].find(
										row => (row as HTMLElement).dataset.resourceId === card.id,
									);
									row?.querySelector<HTMLButtonElement>('.ash-customize-card-open')?.focus();
								}
							}
						});
					},
				}),
			);
			open.domNode.classList.add('ash-customize-card-open');
			open.domNode.classList.toggle('installed', !!card.installed);
			open.setTitle(open.label);
			this.grid.append(article);
		}
		this.count.setCount(cards.length);
		this.countContainer.hidden = false;
		const message = [
			this.note,
			cards.length
				? ''
				: query
					? localize('customize.noMatches', 'No matching resources. Try another search.')
					: this.collection === 'yours'
						? localize('customize.empty', 'Nothing here yet. Discover resources or use Add to get started.')
						: localize('customize.noResults', 'No resources are available from these sources.'),
		]
			.filter(Boolean)
			.join('\n');
		this.setMessage(message || localize('customize.count', '{0} resources', cards.length), !!message);
		this.more.domNode.hidden = !this.cursor;
		if (focusedId) {
			const row = [...this.grid.children].find(row => (row as HTMLElement).dataset.resourceId === focusedId);
			if (row) row.querySelector<HTMLButtonElement>('button')?.focus();
			else this.search.focus();
		}
	}

	private setMessage(text: string, visible = true): void {
		this.message.textContent = text;
		this.message.hidden = !text;
		// Counts and refresh announcements must not insert a row above the cards.
		this.message.classList.toggle('status-only', !visible);
	}

	private navigateCards(event: KeyboardEvent): void {
		const button = event.target as HTMLElement;
		if (!button.classList.contains('ash-customize-card-name')) return;
		const buttons = [...this.grid.querySelectorAll<HTMLButtonElement>('.ash-customize-card-name')];
		const index = buttons.indexOf(button as HTMLButtonElement);
		const columns = this.root.classList.contains('narrow') ? 1 : 2;
		const next =
			event.key === 'ArrowDown'
				? index + columns
				: event.key === 'ArrowUp'
					? index - columns
					: event.key === 'ArrowRight'
						? index + 1
						: event.key === 'ArrowLeft'
							? index - 1
							: event.key === 'Home'
								? 0
								: event.key === 'End'
									? buttons.length - 1
									: undefined;
		if (next === undefined) return;
		event.preventDefault();
		buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
	}

	private async openResource(resource: ICustomizationMarketplaceResource): Promise<void> {
		const location = this.location.get();
		const [details, installed] = await Promise.all([
			this.extensions.get(resource.installation.selectionId, resource.version),
			this.extensions.listInstalled(),
		]);
		if (!this.shown || this.isDisposed || location !== this.location.get()) return;
		const installation = installed.find(
			item => item.package.id === details.package.id && item.package.version === details.package.version,
		);
		await this.openInput(
			new ExtensionsInput(
				{
					id: details.package.id,
					version: details.package.version,
					displayName: details.displayName,
					description: details.description,
					packageType: details.packageType,
				},
				installation?.installationId,
			),
		);
	}

	private async openInput(input: ExtensionsInput | ExtensionsCapabilityInput): Promise<void> {
		if (!this.shown || this.isDisposed) {
			input.dispose();
			return;
		}
		if (!this.detailEditor) {
			this.catalogScrollTop = this.catalog.scrollTop;
		}
		this.detailResources.clear();
		const request = new AbortController();
		const pane = this.instantiationService.createInstance(ExtensionEditor, {
			presentation: 'page',
			openDetails: (next: ExtensionsInput | ExtensionsCapabilityInput) => this.openInput(next),
			openInstalledVersions: (query: string) => this.openCatalog('plugins', 'yours', query),
			accessibilityHelp: localize(
				'customize.detailHelp',
				'Use the Back button above the details to return to your resource list. Your category, search, sorting and scroll position are preserved, and focus returns to the control that opened the details.',
			),
		});
		// The embedded pane borrows services; this navigation owns its request, input and lifetime.
		this.detailResources.add(
			toDisposable(() => {
				request.abort();
				pane.clearInput();
				pane.setVisible(false);
			}),
		);
		this.detailResources.add(input);
		this.detailResources.add(pane);
		this.detailEditor = pane;
		this.catalog.hidden = true;
		this.details.hidden = false;
		this.back.label =
			this.category === 'skills'
				? localize('customize.skills', 'Skills')
				: this.category === 'connectors'
					? localize('customize.connectors', 'Connectors')
					: localize('customize.plugins', 'Plugins');
		this.back.domNode.setAttribute(
			'aria-label',
			localize('customize.backToCollection', 'Back to {0}', this.back.label),
		);
		pane.create(this.detailHost);
		pane.setVisible(true);
		this.back.focus();
		try {
			await raceCancellationError(pane.setInput(input, request.signal), request.signal);
		} catch (error) {
			if (request.signal.aborted || this.isDisposed || this.detailEditor !== pane) return;
			this.showCatalog(this.shown);
			this.message.hidden = false;
			this.message.textContent = localize('customize.loadFailed', 'Could not load resources: {0}', String(error));
		}
	}

	private showCatalog(restoreFocus = true): void {
		if (!this.detailEditor) return;
		this.detailResources.clear();
		this.detailEditor = undefined;
		this.installedSelection.set(undefined, undefined);
		this.details.hidden = true;
		this.catalog.hidden = false;
		const previous = this.returnFocus;
		this.returnFocus = undefined;
		if (restoreFocus) {
			const row = [...this.grid.children].find(
				row => (row as HTMLElement).dataset.resourceId === previous?.resourceId,
			);
			const target = previous?.element.isConnected
				? previous.element
				: row?.querySelector<HTMLButtonElement>(
					previous?.action ? '.ash-customize-card-open' : '.ash-customize-card-name',
				);
			if (target?.getClientRects().length) target.focus({ preventScroll: true });
			else this.searchActionViewItem.focus();
		}
		this.catalog.scrollTop = this.catalogScrollTop;
	}

	private openCard(card: Card): void {
		void this.run(() => this.showCardDetails(card));
	}

	private showCardDetails(card: Card): Promise<void> {
		if (this.collection === 'yours' && this.category !== 'connectors') {
			this.installedSelection.set({ category: this.category, id: card.id }, undefined);
		}
		return card.open();
	}

	private async run(action: () => Promise<unknown>): Promise<void> {
		if (this.opening) return;
		this.opening = true;
		const focused = this.root.ownerDocument.activeElement;
		if (!this.detailEditor && focused instanceof HTMLElement && this.catalog.contains(focused)) {
			this.returnFocus = {
				element: focused,
				resourceId: focused.closest<HTMLElement>('[data-resource-id]')?.dataset.resourceId,
				action: focused.classList.contains('ash-customize-card-open'),
			};
		}
		try {
			await action();
		} catch (error) {
			if (!this.isDisposed && this.shown && !isCancellationError(error)) this.setMessage(String(error));
		} finally {
			this.opening = false;
		}
	}

	private setSource(sourceId: string | undefined): void {
		this.sourceId = sourceId;
		this.updateControls();
		void this.load();
	}
	private menuAction(id: string, label: string, action: () => void | Promise<void>, checked?: boolean): IAction {
		return {
			id,
			label,
			tooltip: '',
			enabled: true,
			checked,
			run: async () => {
				await this.run(async () => action());
			},
		};
	}
	private addActions(): readonly IAction[] {
		if (this.category === 'skills')
			return [
				{
					...this.menuAction('uploadSkill', localize('customize.uploadSkill', 'Upload skill'), async () => {
						if (await this.skillActions.upload()) this.showYourSkills();
					}),
					icon: Lxicon.exportTray,
					enabled: this.skillActions.isAvailable,
				},
				{
					...this.menuAction('createSkill', localize('customize.createSkill', 'Create a skill'), async () => {
						if (await this.skillActions.create()) this.showYourSkills();
					}),
					icon: Lxicon.edit,
					enabled: this.skillActions.isAvailable,
				},
				{
					...this.menuAction('createWithAsh', localize('customize.createWithAsh', 'Create with Ash'), () =>
						this.skillActions.createWithAsh(),
					),
					icon: Lxicon.chat,
				},
			];
		return [
			{
				...this.menuAction('discover', localize('customize.browse', 'Browse catalog'), () =>
					this.selectCollection('discover'),
				),
				icon: Lxicon.search,
			},
			...(this.category === 'connectors'
				? [
					{
						...this.menuAction(
							'connect',
							localize('customize.addConnection', 'Add connection'),
							async () => {
								const target = await addConnection(
									this.connectors,
									this.mcp,
									this.quickInput,
									this.dialogs,
									this.actions.signal,
								);
								if (target) await this.openInput(new ExtensionsCapabilityInput(target));
							},
						),
						icon: Lxicon.plug,
					},
				]
				: []),
			...(this.category === 'plugins'
				? [
					{
						...this.menuAction(
							'local',
							localize('customize.installLocal', 'Install from workspace'),
							async () => {
								await this.commands.executeCommand('ash.extensions.installLocal');
							},
						),
						icon: Lxicon.folder,
					},
					{
						...this.menuAction(
							'git',
							localize('customize.installGit', 'Install from Git repository'),
							async () => {
								await this.commands.executeCommand('ash.extensions.installFromGit');
							},
						),
						icon: Lxicon.sourceControl,
					},
				]
				: []),
		];
	}

	private showYourSkills(): void {
		if (!this.shown || this.isDisposed || this.category !== 'skills') return;
		this.location.set({ category: this.category, collection: 'yours' }, undefined);
		this.search.value = '';
		this.updateControls();
		void this.load();
	}

	private registerAccessibility(): void {
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View])
			this._register(
				AccessibleViewRegistry.register({
					type,
					priority: 100,
					name: `sessionsCustomize-${type}`,
					when: ContextKeyExpr.has('sessionsCustomizeFocused'),
					getProvider: () => {
						const focused = this.root.ownerDocument.activeElement as HTMLElement | null;
						if (
							!this.shown ||
							!focused ||
							!this.root.contains(focused) ||
							this.detailHost.contains(focused)
						)
							return undefined;
						return new AccessibleContentProvider(
							AccessibleViewProviderId.Customize,
							{ type },
							() =>
								type === AccessibleViewType.View
									? this.detailEditor
										? this.details.innerText
										: this.panel.innerText
									: localize(
										'customize.help',
										'Choose Discover, an installed resource or Connections in the Customize sidebar. In Discover, use Left and Right Arrow on the category tabs, then Enter to select. When the sidebar is hidden, use the category tabs and switch between Yours and Discover here. Use Tab to reach the actions toolbar and resource cards. Activate Search to expand its input; Escape or Close search clears and collapses it, returning focus to Search. Empty search also collapses when focus leaves. In the toolbar, Left and Right Arrow move between Search, source filtering, sorting and Add; Up or Down Arrow opens the focused menu. Down Arrow in search moves to the first card. Arrow keys, Home and End move between card names; Enter opens resource details within Customize for installation, authorization and enablement. Use the Back button above the details to return to the same category, search, sorting and scroll position, with focus restored to the control that opened the details. In Skills, Add offers Upload skill (a SKILL.md file or skill folder), Create a skill, and Create with Ash. Upload and Create save a personal skill; Create opens its instructions in the editor. Create with Ash starts a new chat draft using the skill creator without sending it. In Connectors, open Add and choose Add connection to set up a service account or MCP server. In Plugins, Add offers catalog browsing and installation. Load more continues catalog results. Refresh reloads current state, and Retry repeats a failed read. Escape closes menus and restores focus. Global navigation remains available while this page is open.',
									),
							() => {
								if (
									focused.isConnected &&
									!focused.closest<HTMLElement>('.ash-toolbar-search-field')?.inert
								)
									focused.focus();
								else this.focus();
							},
							AccessibilityVerbositySettingId.Customize,
						);
					},
				}),
			);
	}
}
