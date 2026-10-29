import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { SegmentedControl } from '../../../../base/browser/ui/segmentedControl/segmentedControl.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { raceCancellationError, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConnectorService } from '../../../../platform/connectors/common/connectorService.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { CustomizationMarketplaceMediaType, ICustomizationMarketplaceService, type ICustomizationMarketplaceCursor, type ICustomizationMarketplaceResource } from '../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpServerManagementService } from '../../../../platform/mcp/common/mcpServerManagementService.js';
import { IMcpServerStatusService } from '../../../../platform/mcp/common/mcpServerStatusService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { addConnection, describeConnectorState, describeMcpServerState, getSkillSummary } from '../../../../workbench/contrib/extensions/browser/extensionsActions.js';
import { changeExtensionPackage, ExtensionEditor } from '../../../../workbench/contrib/extensions/browser/extensionEditor.js';
import { ExtensionsCapabilityInput, ExtensionsInput, ExtensionsInputSource } from '../../../../workbench/contrib/extensions/common/extensionsInput.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { CustomizeSkillActions } from './customizeSkillActions.js';
import './customizeEditor.css';
import { LoadingSkeleton } from '../../../browser/ui/loadingSkeleton.js';

type Category = 'skills' | 'connectors' | 'plugins';
type Collection = 'yours' | 'discover';
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
	private details!: HTMLElement;
	private detailHost!: HTMLElement;
	private back!: Button;
	private detailEditor: ExtensionEditor | undefined;
	private catalogScrollTop = 0;
	private returnFocus: { readonly element: HTMLElement; readonly resourceId?: string; readonly action: boolean; } | undefined;
	private readonly detailResources = this._register(new DisposableStore());
	private panel!: HTMLElement;
	private grid!: HTMLElement;
	private loading!: LoadingSkeleton;
	private message!: HTMLElement;
	private heading!: HTMLElement;
	private hero!: HTMLElement;
	private heroTitle!: HTMLElement;
	private heroDescription!: HTMLElement;
	private search!: InputBox;
	private tabs!: TabList<Category>;
	private collectionControl!: SegmentedControl<Collection>;
	private toolbar!: ActionBar;
	private toolbarActions: readonly CatalogMenuAction[] = [];
	private more!: Button;
	private retry!: Button;
	private category: Category = 'skills';
	private collection: Collection = 'yours';
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
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super('sessions.editor.customize', theme, storage);
		for (const event of [prompts.onDidChangeSkills, marketplace.onDidChangeSources, extensions.onDidChangeInstalled, plugins.onDidChange, connectors.onDidChange, mcp.onDidChange]) {
			this._register(event(() => { if (this.shown) this.refresh.schedule(); }));
		}
		this._register(toDisposable(() => {
			this.request?.dispose(true);
			this.actions.abort();
			this.root?.remove();
		}));
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
		this.catalog.append(h(document, 'h1', {}, localize('customize.title', 'Customize')));
		const toolbar = h(document, 'div', { className: 'ash-customize-toolbar' });
		this.catalog.append(toolbar);
		this.tabs = this._register(new TabList(toolbar, {
			ariaLabel: localize('customize.categories', 'Customization categories'), presentation: 'navigation',
			onActivate: category => {
				if (category === this.category) return;
				this.category = category;
				this.sourceId = undefined;
				this.search.value = '';
				this.updateControls();
				void this.load();
			},
		}));
		this.collectionControl = this._register(new SegmentedControl(toolbar, {
			ariaLabel: localize('customize.collection', 'Resource collection'),
			items: [{ id: 'yours', label: localize('customize.yours', 'Yours') }, { id: 'discover', label: localize('customize.discover', 'Discover') }],
			selectedId: this.collection,
			onActivate: collection => this.selectCollection(collection),
		}));
		const tools = h(document, 'div', { className: 'ash-customize-tools' });
		toolbar.append(tools);
		this.search = this._register(new InputBox(tools, {
			inputBoxStyles: defaultInputBoxStyles, type: 'search', presentation: 'field',
			placeholder: localize('customize.search', 'Search'), ariaLabel: localize('customize.search', 'Search'),
		}));
		this.search.element.classList.add('ash-customize-search');
		appendIcon(Lxicon.search, this.search.element);
		this._register(this.search.onDidChange(() => {
			if (this.collection === 'discover') {
				this.request?.dispose(true);
				this.cursor = undefined;
				this.more.domNode.hidden = true;
				this.refresh.schedule();
			} else this.renderCards();
		}));
		this._register(addDisposableListener(this.search.inputElement, 'keydown', event => {
			if (event.key === 'Escape') { this.search.value = ''; this.refresh.schedule(); }
			if (event.key === 'ArrowDown') { event.preventDefault(); this.grid.querySelector<HTMLButtonElement>('button')?.focus(); }
		}));
		this.toolbarActions = [
			{
				id: 'filterSources', label: localize('customize.filter', 'Filter sources'), icon: Lxicon.listFilter,
				getActions: () => [
					this.menuAction('all', localize('customize.allSources', 'All sources'), () => this.setSource(undefined), !this.sourceId),
					...this.marketplace.sources.map(source => this.menuAction(source.id, source.displayName, () => this.setSource(source.id), this.sourceId === source.id)),
				],
			},
			{
				id: 'sortResources', label: localize('customize.sort', 'Sort resources'), icon: Lxicon.sort,
				getActions: () => [
					this.menuAction('ascending', localize('customize.ascending', 'Name: A to Z'), () => { this.descending = false; this.renderCards(); }, !this.descending),
					this.menuAction('descending', localize('customize.descending', 'Name: Z to A'), () => { this.descending = true; this.renderCards(); }, this.descending),
				],
			},
			{ id: 'addResource', label: localize('customize.add', 'Add'), icon: Lxicon.add, getActions: () => this.addActions() },
		].map(action => ({ ...action, tooltip: action.label, enabled: true, run: () => undefined }));
		this.toolbar = this._register(new ActionBar(tools, {
			ariaLabel: localize('customize.actions', 'Customization actions'),
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			actionViewItemProvider: (action, options) => {
				const menuAction = this.toolbarActions.find(item => item.id === action.id);
				if (!menuAction) return undefined;
				const provider = action.id === 'addResource' ? {
					showContextMenu: (delegate: Parameters<IContextMenuService['showContextMenu']>[0]) => this.menus.showContextMenu({
						...delegate, anchorAlignment: AnchorAlignment.Right, gap: 8,
						getMenuClassName: () => 'ash-customize-add-menu',
					}),
				} : this.menus;
				return new DropdownMenuActionViewItem(action, menuAction.getActions, provider, {
					...options, buttonPresentation: action.id === 'addResource' ? 'primary' : 'quiet',
				});
			},
		}));
		this.toolbar.element.classList.add('ash-customize-actions');
		this.panel = h(document, 'div', { className: 'ash-customize-panel', attributes: { id: 'ash-customize-panel', role: 'tabpanel' } });
		this.catalog.append(this.panel);
		this.hero = h(document, 'div', { className: 'ash-customize-hero' });
		this.heroTitle = h(document, 'h2');
		this.heroDescription = h(document, 'p');
		this.hero.append(this.heroTitle, this.heroDescription);
		this.panel.append(this.hero);
		const header = h(document, 'div', { className: 'ash-customize-results-heading' });
		this.heading = h(document, 'h2');
		header.append(this.heading);
		const refresh = this._register(new Button(header, { ...defaultButtonStyles, label: localize('customize.refresh', 'Refresh'), icon: Lxicon.refresh, iconOnly: true, onClick: () => { void this.load(); } }));
		refresh.setTitle(refresh.label);
		this.message = h(document, 'p', { className: 'ash-customize-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		this.retry = this._register(new Button(this.panel, { ...defaultButtonStyles, label: localize('customize.retry', 'Retry'), onClick: () => { void this.load(); } }));
		this.retry.domNode.hidden = true;
		this.grid = h(document, 'div', { className: 'ash-customize-grid' });
		this.panel.append(header, this.message, this.retry.domNode, this.grid);
		this.more = this._register(new Button(this.panel, { ...defaultButtonStyles, label: localize('customize.more', 'Load more'), onClick: () => { void this.load(true); } }));
		this.more.domNode.hidden = true;
		this._register(addDisposableListener(this.grid, 'keydown', event => this.navigateCards(event)));
		this.details = h(document, 'div', { className: 'ash-customize-details' });
		this.details.hidden = true;
		const navigation = h(document, 'div', { className: 'ash-customize-detail-navigation' });
		this.back = this._register(new Button(navigation, {
			...defaultButtonStyles, label: localize('customize.skills', 'Skills'), icon: Lxicon.arrowLeft,
			onClick: () => this.showCatalog(),
		}));
		this.detailHost = h(document, 'div', { className: 'ash-customize-detail-host' });
		this.details.append(navigation, this.detailHost);
		this.root.append(this.details);
		this.registerAccessibility();
		this.updateControls();
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); }
	public override clearInput(): void {
		this.request?.dispose(true);
		this.refresh.cancel();
		this.showCatalog(false);
	}
	public override focus(): void {
		if (this.detailEditor) this.back.focus();
		else this.search.focus();
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
		if (visible) void this.load();
		else { this.refresh.cancel(); this.request?.dispose(true); }
	}

	private selectCollection(collection: Collection): void {
		if (collection === this.collection) return;
		this.collection = collection;
		this.updateControls();
		void this.load();
	}

	private updateControls(): void {
		const categories = [
			{ id: 'skills' as const, label: localize('customize.skills', 'Skills') },
			{ id: 'connectors' as const, label: localize('customize.connectors', 'Connectors') },
			{ id: 'plugins' as const, label: localize('customize.plugins', 'Plugins') },
		];
		this.tabs.setTabs(categories.map(item => ({ ...item, value: item.id, tabId: `ash-customize-${item.id}`, panelId: this.panel.id })), this.category);
		this.panel.setAttribute('aria-labelledby', `ash-customize-${this.category}`);
		this.collectionControl.setSelection(this.collection);
		this.toolbar.setActions(this.toolbarActions.filter(action => action.id !== 'filterSources' || this.collection === 'discover' && this.category !== 'plugins'));
		this.toolbar.element.querySelector('[data-action-id="filterSources"] button')?.setAttribute('aria-pressed', String(!!this.sourceId));
		this.hero.hidden = this.collection !== 'discover';
		this.heroTitle.textContent = this.category === 'skills' ? localize('customize.skillsTitle', 'Give Ash new ways to work')
			: this.category === 'connectors' ? localize('customize.connectorsTitle', 'Bring your tools into the conversation')
				: localize('customize.pluginsTitle', 'Make Ash your own');
		this.heroDescription.textContent = this.category === 'skills' ? localize('customize.skillsDescription', 'Discover reusable instructions for writing, research, coding and everyday work.')
			: this.category === 'connectors' ? localize('customize.connectorsDescription', 'Connect your services and MCP servers to work with the context you need.')
				: localize('customize.pluginsDescription', 'Explore plugins that add tools and capabilities to your workspace.');
		this.heading.textContent = this.collection === 'yours' ? localize('customize.yourResources', 'Your {0}', categories.find(item => item.id === this.category)!.label.toLocaleLowerCase())
			: localize('customize.discoverResources', 'Discover {0}', categories.find(item => item.id === this.category)!.label.toLocaleLowerCase());
	}

	private async load(append = false): Promise<void> {
		if (!this.shown || !this.grid) return;
		this.refresh.cancel();
		this.request?.dispose(true);
		const request = this.request = new CancellationTokenSource();
		const sessionId = this.sessions.getActiveConversation()?.sessionId;
		const cursor = append ? this.cursor : undefined;
		const queryKey = JSON.stringify([this.category, this.collection, this.sourceId, this.collection === 'discover' ? this.search.value : '', sessionId]);
		if (!append && queryKey !== this.loadedQuery) {
			this.cards = [];
			this.note = '';
			this.cursor = undefined;
			this.loadedQuery = queryKey;
			this.renderCards();
		}
		this.panel.setAttribute('aria-busy', 'true');
		this.loading ??= this._register(new LoadingSkeleton(this.panel, localize('customize.loading', 'Loading resources…'), 'cards', 6));
		this.grid.before(this.loading.element);
		this.loading.setVisible(!this.cards.length);
		this.more.enabled = false;
		this.retry.domNode.hidden = true;
		this.message.hidden = !this.cards.length;
		this.message.textContent = this.cards.length ? localize('customize.loading', 'Loading resources…') : '';
		try {
			const result = this.collection === 'discover' ? await this.readDiscover(request, cursor) : await this.readYours(sessionId);
			if (request.token.isCancellationRequested || !this.shown) return;
			if (sessionId !== this.sessions.getActiveConversation()?.sessionId) { this.refresh.schedule(); return; }
			const unique = new Map((append ? [...this.cards, ...result.cards] : result.cards).map(card => [card.id, card]));
			this.cards = [...unique.values()];
			this.note = result.note ?? '';
			this.cursor = result.cursor;
			this.message.hidden = false;
			this.renderCards();
		} catch (error) {
			if (request.token.isCancellationRequested || !this.shown || isCancellationError(error)) return;
			this.cursor = undefined;
			this.more.domNode.hidden = true;
			this.message.textContent = localize('customize.loadFailed', 'Could not load resources: {0}', String(error));
			this.message.hidden = false;
			this.retry.domNode.hidden = false;
		} finally {
			if (this.request === request && !request.token.isCancellationRequested) {
				this.panel.setAttribute('aria-busy', 'false');
				this.loading.setVisible(false);
				this.more.enabled = true;
			}
		}
	}

	private async readDiscover(request: CancellationTokenSource, cursor?: ICustomizationMarketplaceCursor): Promise<Catalog> {
		const query = this.search.value.trim();
		if (this.category === 'plugins') {
			const snapshot = await this.extensions.refreshBrowse(query, { packageType: 'plugin', limit: 200 });
			return {
				cards: snapshot.packages.map(({ summary }) => ({
					id: `${summary.id}/${summary.version}`, name: summary.displayName, description: summary.description, metadata: summary.version,
					open: () => this.openInput(new ExtensionsInput(summary, snapshot.installed.find(item => item.package.id === summary.id && item.package.version === summary.version)?.installationId)),
				})),
				note: snapshot.unavailableSources.join(' · '),
			};
		}
		const skills = this.category === 'skills';
		const [page, installed] = await Promise.all([
			this.marketplace.query({ query, mediaType: skills ? CustomizationMarketplaceMediaType.Skill : CustomizationMarketplaceMediaType.McpServer, sourceIds: this.sourceId ? [this.sourceId] : undefined, pageSize: 30, cursor }, request.token),
			skills ? this.extensions.listInstalled() : Promise.resolve([]),
		]);
		return {
			cards: page.items.map(resource => ({
				id: JSON.stringify([resource.sourceId, resource.identifier, resource.version]), name: resource.displayName, description: resource.description,
				metadata: `${this.marketplace.allSources.find(source => source.id === resource.sourceId)?.displayName ?? resource.sourceId} · ${resource.version}`,
				installed: skills && installed.some(item => item.package.id === resource.installation.selectionId && item.package.version === resource.version && item.state === 'installed'),
				install: skills && !installed.some(item => item.package.id === resource.installation.selectionId) ? async () => {
					const details = await this.extensions.get(resource.installation.selectionId, resource.version);
					if (!this.shown || this.isDisposed) return;
					const result = await changeExtensionPackage(this.extensions, this.dialogs, this.notifications, 'install', details);
					if (result && this.shown && !this.isDisposed) await this.load();
				} : undefined,
				open: () => this.openResource(resource),
			})),
			cursor: page.nextCursor,
			note: !this.marketplace.sources.length ? localize('customize.discoveryUnavailable', 'Discovery is disabled or no catalog sources are available.') : page.sourceErrors?.map(error => error.message).join(' · '),
		};
	}

	private async readYours(sessionId: string | undefined): Promise<Catalog> {
		if (this.category === 'skills') {
			const snapshot = await this.prompts.readSkillManagement(sessionId);
			return {
				cards: snapshot.catalog.skills.map(skill => ({
					id: JSON.stringify(skill.id), name: skill.name, description: getSkillSummary(skill),
					open: () => this.openInput(new ExtensionsCapabilityInput({ kind: 'skill', source: skill.id.source, name: skill.id.name, sessionId })),
				})),
				note: snapshot.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
			};
		}
		if (this.category === 'connectors') return this.readConnections();
		const [installed, local] = await Promise.all([this.extensions.listInstalled(), this.plugins.list()]);
		return {
			cards: [
				...installed.map(installation => ({
					id: installation.installationId, name: installation.package.id, description: installation.capabilities.map(capability => capability.kind).join(' · '),
					metadata: installation.state === 'pendingRemoval' ? localize('customize.removing', 'Removal pending') : installation.package.version,
					open: () => this.openInput(new ExtensionsInput({ id: installation.package.id, version: installation.package.version, displayName: installation.package.id, description: '', packageType: 'installed' }, installation.installationId)),
				})),
				...local.packages.map(plugin => ({
					id: `local/${plugin.id}`, name: plugin.displayName, description: localize('customize.localPlugin', 'Local plugin'),
					metadata: [plugin.version, plugin.enabled ? localize('customize.enabled', 'Enabled') : localize('customize.disabled', 'Disabled')].join(' · '),
					open: () => this.openInput(new ExtensionsInput({ id: plugin.id, version: plugin.version, displayName: plugin.displayName, description: '', packageType: 'editorExtension' }, undefined, ExtensionsInputSource.Local)),
				})),
			]
		};
	}

	private async readConnections(): Promise<Catalog> {
		// Independent owners can fail separately; keep usable accounts and servers visible.
		const [accounts, configuration, runtime, packages] = await Promise.allSettled([
			this.connectors.list(), this.mcp.isAvailable ? this.mcp.readConfiguration() : Promise.resolve(undefined),
			this.mcpStatus.isAvailable ? this.mcpStatus.read() : Promise.resolve(undefined), this.extensions.listInstalled(),
		]);
		const connectors = accounts.status === 'fulfilled' ? accounts.value.connectors : [];
		const linked = new Set(connectors.flatMap(connector => [connector.mcpDeclarationId, ...(connector.mcpServerId ? [connector.mcpServerId] : [])]));
		const cards = new Map<string, Card>();
		for (const connector of connectors) cards.set(`connector/${connector.id}`, {
			id: `connector/${connector.id}`, name: connector.displayName, description: connector.description,
			metadata: describeConnectorState(connector.state, connector.enabled),
			open: () => this.openInput(new ExtensionsCapabilityInput({ kind: 'connector', connectorId: connector.id })),
		});
		for (const installation of packages.status === 'fulfilled' ? packages.value : []) {
			for (const capability of installation.capabilities.filter(capability => capability.kind === 'mcp')) {
				const id = `marketplace:${installation.package.id}:mcp:${capability.id}`;
				if (linked.has(id)) continue;
				cards.set(id, {
					id, name: capability.id, description: installation.package.id, metadata: installation.package.version,
					open: () => this.openInput(new ExtensionsCapabilityInput({ kind: 'mcp', serverId: id, installationId: installation.installationId, capabilityId: capability.reference.id }))
				});
			}
		}
		for (const server of configuration.status === 'fulfilled' ? configuration.value?.servers ?? [] : []) {
			if (linked.has(server.id)) continue;
			cards.set(server.id, {
				id: server.id, name: server.displayName, description: server.id,
				metadata: server.enablement === 'enabled' ? localize('customize.enabled', 'Enabled') : localize('customize.disabled', 'Disabled'),
				open: () => this.openInput(new ExtensionsCapabilityInput({ kind: 'mcp', serverId: server.id }))
			});
		}
		for (const server of runtime.status === 'fulfilled' ? runtime.value?.servers ?? [] : []) {
			if (linked.has(server.id)) continue;
			const existing = cards.get(server.id);
			cards.set(server.id, {
				id: server.id, name: server.displayName || existing?.name || server.id,
				description: existing?.description ?? server.id, metadata: describeMcpServerState(server.state),
				open: existing?.open ?? (() => this.openInput(new ExtensionsCapabilityInput({ kind: 'mcp', serverId: server.id })))
			});
		}
		return { cards: [...cards.values()], note: [accounts, configuration, runtime, packages].flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []).join('\n') };
	}

	private renderCards(): void {
		const active = this.root.ownerDocument.activeElement as HTMLElement | null;
		const focusedId = this.grid.contains(active) ? active?.closest<HTMLElement>('[data-resource-id]')?.dataset.resourceId : undefined;
		this.cardResources.clear();
		this.grid.replaceChildren();
		const query = this.search.value.trim().toLocaleLowerCase();
		const cards = this.cards.filter(card => this.collection === 'discover' || `${card.name} ${card.description} ${card.metadata ?? ''}`.toLocaleLowerCase().includes(query))
			.sort((left, right) => left.name.localeCompare(right.name) * (this.descending ? -1 : 1));
		for (const card of cards) {
			const article = h(this.grid.ownerDocument, 'article', { className: 'ash-customize-card' });
			article.dataset.resourceId = card.id;
			const icon = h(this.grid.ownerDocument, 'div', { className: 'ash-customize-card-icon', attributes: { 'aria-hidden': 'true' } });
			appendIcon(this.category === 'skills' ? Lxicon.book : this.category === 'connectors' ? Lxicon.plug : Lxicon.extensions, icon);
			const content = h(this.grid.ownerDocument, 'div', { className: 'ash-customize-card-content' });
			const name = this.cardResources.add(new Button(content, { ...defaultButtonStyles, label: card.name, onClick: () => { void this.run(card.open); } }));
			name.domNode.classList.add('ash-customize-card-name');
			const description = h(this.grid.ownerDocument, 'p', { className: 'ash-customize-card-description' }, card.description);
			content.append(description);
			if (card.metadata) {
				const metadata = h(this.grid.ownerDocument, 'p', { className: 'ash-customize-card-metadata' }, card.metadata);
				content.append(metadata);
				this.cardResources.add(this.hover.setupDelayedHover(metadata, { content: card.metadata }));
			}
			this.cardResources.add(this.hover.setupDelayedHover(description, { content: card.description }));
			this.cardResources.add(this.hover.setupDelayedHover(name.domNode, { content: card.name }));
			article.append(icon, content);
			const open = this.cardResources.add(new Button(article, {
				...defaultButtonStyles,
				label: card.installed ? localize('customize.installedDetails', 'Installed: {0}. View details', card.name)
					: card.install ? localize('customize.installSkill', 'Install {0}', card.name) : localize('customize.details', 'View {0}', card.name),
				icon: card.installed ? Lxicon.check : card.install ? Lxicon.add : Lxicon.arrowRight, iconOnly: true,
				onClick: () => {
					void this.run(async () => {
						const document = open.domNode.ownerDocument;
						const restoreFocus = document.activeElement === open.domNode;
						open.enabled = false;
						try { await (card.install ?? card.open)(); }
						finally {
							if (open.domNode.isConnected) open.enabled = true;
							// The review dialog cannot restore focus to the disabled install button.
							if (restoreFocus && this.shown && document.activeElement === document.body) {
								const row = [...this.grid.children].find(row => (row as HTMLElement).dataset.resourceId === card.id);
								row?.querySelector<HTMLButtonElement>('.ash-customize-card-open')?.focus();
							}
						}
					});
				},
			}));
			open.domNode.classList.add('ash-customize-card-open');
			open.domNode.classList.toggle('installed', !!card.installed);
			open.setTitle(open.label);
			this.grid.append(article);
		}
		this.message.textContent = [this.note, cards.length ? localize('customize.count', '{0} resources', cards.length)
			: query ? localize('customize.noMatches', 'No matching resources. Try another search.')
				: this.collection === 'yours' ? localize('customize.empty', 'Nothing here yet. Discover resources or use Add to get started.')
					: localize('customize.noResults', 'No resources are available from these sources.')].filter(Boolean).join('\n');
		this.more.domNode.hidden = !this.cursor;
		if (focusedId) {
			const row = [...this.grid.children].find(row => (row as HTMLElement).dataset.resourceId === focusedId);
			if (row) row.querySelector<HTMLButtonElement>('button')?.focus();
			else this.search.focus();
		}
	}

	private navigateCards(event: KeyboardEvent): void {
		const button = event.target as HTMLElement;
		if (!button.classList.contains('ash-customize-card-name')) return;
		const buttons = [...this.grid.querySelectorAll<HTMLButtonElement>('.ash-customize-card-name')];
		const index = buttons.indexOf(button as HTMLButtonElement);
		const columns = this.root.classList.contains('narrow') ? 1 : 2;
		const next = event.key === 'ArrowDown' ? index + columns : event.key === 'ArrowUp' ? index - columns
			: event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1
				: event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
		if (next === undefined) return;
		event.preventDefault();
		buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
	}

	private async openResource(resource: ICustomizationMarketplaceResource): Promise<void> {
		const [details, installed] = await Promise.all([this.extensions.get(resource.installation.selectionId, resource.version), this.extensions.listInstalled()]);
		if (!this.shown || this.isDisposed) return;
		const installation = installed.find(item => item.package.id === details.package.id && item.package.version === details.package.version);
		await this.openInput(new ExtensionsInput({ id: details.package.id, version: details.package.version, displayName: details.displayName, description: details.description, packageType: details.packageType }, installation?.installationId));
	}

	private async openInput(input: ExtensionsInput | ExtensionsCapabilityInput): Promise<void> {
		if (!this.shown || this.isDisposed) { input.dispose(); return; }
		if (!this.detailEditor) {
			this.catalogScrollTop = this.catalog.scrollTop;
		}
		this.detailResources.clear();
		const request = new AbortController();
		const pane = this.instantiationService.createInstance(ExtensionEditor, {
			presentation: 'page',
			openDetails: (next: ExtensionsInput | ExtensionsCapabilityInput) => this.openInput(next),
			accessibilityHelp: localize('customize.detailHelp', 'Use the Back button above the details to return to your resource list. Your category, search, sorting and scroll position are preserved, and focus returns to the resource card.'),
		});
		// The embedded pane borrows services; this navigation owns its request, input and lifetime.
		this.detailResources.add(toDisposable(() => {
			request.abort();
			pane.clearInput();
			pane.setVisible(false);
		}));
		this.detailResources.add(input);
		this.detailResources.add(pane);
		this.detailEditor = pane;
		this.catalog.hidden = true;
		this.details.hidden = false;
		this.back.label = this.category === 'skills' ? localize('customize.skills', 'Skills')
			: this.category === 'connectors' ? localize('customize.connectors', 'Connectors') : localize('customize.plugins', 'Plugins');
		this.back.domNode.setAttribute('aria-label', localize('customize.backToCollection', 'Back to {0}', this.back.label));
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
		this.details.hidden = true;
		this.catalog.hidden = false;
		const previous = this.returnFocus;
		this.returnFocus = undefined;
		if (restoreFocus) {
			const row = [...this.grid.children].find(row => (row as HTMLElement).dataset.resourceId === previous?.resourceId);
			const target = previous?.element.isConnected ? previous.element
				: row?.querySelector<HTMLButtonElement>(previous?.action ? '.ash-customize-card-open' : '.ash-customize-card-name');
			if (target) target.focus({ preventScroll: true });
			else this.search.focus();
		}
		this.catalog.scrollTop = this.catalogScrollTop;
	}

	private async run(action: () => Promise<unknown>): Promise<void> {
		if (this.opening) return;
		this.opening = true;
		const focused = this.root.ownerDocument.activeElement;
		if (!this.detailEditor && focused instanceof HTMLElement && this.catalog.contains(focused)) {
			this.returnFocus = {
				element: focused, resourceId: focused.closest<HTMLElement>('[data-resource-id]')?.dataset.resourceId,
				action: focused.classList.contains('ash-customize-card-open'),
			};
		}
		try { await action(); }
		catch (error) { if (!this.isDisposed && this.shown && !isCancellationError(error)) this.message.textContent = String(error); }
		finally { this.opening = false; }
	}

	private setSource(sourceId: string | undefined): void { this.sourceId = sourceId; this.updateControls(); void this.load(); }
	private menuAction(id: string, label: string, action: () => void | Promise<void>, checked?: boolean): IAction {
		return { id, label, tooltip: '', enabled: true, checked, run: async () => { await this.run(async () => action()); } };
	}
	private addActions(): readonly IAction[] {
		if (this.category === 'skills') return [
			{ ...this.menuAction('uploadSkill', localize('customize.uploadSkill', 'Upload skill'), async () => { if (await this.skillActions.upload()) this.showYourSkills(); }), icon: Lxicon.exportTray, enabled: this.skillActions.isAvailable },
			{ ...this.menuAction('createSkill', localize('customize.createSkill', 'Create a skill'), async () => { if (await this.skillActions.create()) this.showYourSkills(); }), icon: Lxicon.edit, enabled: this.skillActions.isAvailable },
			{ ...this.menuAction('createWithAsh', localize('customize.createWithAsh', 'Create with Ash'), () => this.skillActions.createWithAsh()), icon: Lxicon.chat1 },
		];
		return [
			{ ...this.menuAction('discover', localize('customize.browse', 'Browse catalog'), () => this.selectCollection('discover')), icon: Lxicon.search },
			...(this.category === 'connectors' ? [{
				...this.menuAction('connect', localize('customize.addConnection', 'Add connection'), async () => {
					const target = await addConnection(this.connectors, this.mcp, this.quickInput, this.dialogs, this.actions.signal);
					if (target) await this.openInput(new ExtensionsCapabilityInput(target));
				}), icon: Lxicon.plug
			}] : []),
			...(this.category === 'plugins' ? [
				{ ...this.menuAction('local', localize('customize.installLocal', 'Install from workspace'), async () => { await this.commands.executeCommand('ash.extensions.installLocal'); }), icon: Lxicon.folder },
				{ ...this.menuAction('git', localize('customize.installGit', 'Install from Git repository'), async () => { await this.commands.executeCommand('ash.extensions.installFromGit'); }), icon: Lxicon.sourceControl },
			] : []),
		];
	}

	private showYourSkills(): void {
		if (!this.shown || this.isDisposed || this.category !== 'skills') return;
		this.collection = 'yours';
		this.search.value = '';
		this.updateControls();
		void this.load();
	}

	private registerAccessibility(): void {
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) this._register(AccessibleViewRegistry.register({
			type, priority: 100, name: `sessionsCustomize-${type}`, when: ContextKeyExpr.has('sessionsCustomizeFocused'),
			getProvider: () => {
				const focused = this.root.ownerDocument.activeElement as HTMLElement | null;
				if (!this.shown || !focused || !this.root.contains(focused) || this.detailHost.contains(focused)) return undefined;
				return new AccessibleContentProvider(AccessibleViewProviderId.Customize, { type }, () => type === AccessibleViewType.View ? (this.detailEditor ? this.details.innerText : this.panel.innerText)
					: localize('customize.help', 'Customize brings Skills, Connectors and Plugins together. Use Left and Right Arrow on category tabs, then Enter to select. Yours lists current resources; Discover searches catalogs. In Discover, activate Install on a skill card, review and confirm. A green check marks installed skills; activate it to open details. Successful installation shows a notification. Use Tab to reach search, the actions toolbar and resource cards. In the toolbar, Left and Right Arrow move between source filtering, sorting and Add; Up or Down Arrow opens the focused menu. Down Arrow in search moves to the first card. Arrow keys, Home and End move between card names; Enter opens resource details within Customize for installation, authorization and enablement. Use the Back button above the details to return to the same category, search, sorting and scroll position, with focus restored to the resource card. In Skills, Add offers Upload skill (a SKILL.md file or skill folder), Create a skill, and Create with Ash. Upload and Create save a personal skill; Create opens its instructions in the editor. Create with Ash starts a new chat draft using the skill creator without sending it. Other categories offer catalog browsing, connection setup or plugin installation. Load more continues catalog results. Refresh reloads current state, and Retry repeats a failed read. Escape closes menus and restores focus. Global navigation remains available while this page is open.'),
					() => { if (focused.isConnected) focused.focus(); else this.focus(); }, AccessibilityVerbositySettingId.Customize);
			},
		}));
	}
}
