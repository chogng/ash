import {
	defaultButtonStyles,
	defaultInputBoxStyles,
	defaultListStyles,
	defaultSelectBoxStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { getHoverDelegate, type IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	CustomizationMarketplaceMediaType, ICustomizationMarketplaceService,
	getCustomizationMarketplaceResourceKey, type ICustomizationMarketplaceResource,
	type ICustomizationMarketplaceCursor, type ICustomizationMarketplaceQuery, type ICustomizationMarketplaceSourceInfo,
} from '../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { IMcpServerStatusService } from '../../../../platform/mcp/common/mcpServerStatusService.js';
import { IMcpServerManagementService } from '../../../../platform/mcp/common/mcpServerManagementService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { configureMcpServer, describeMcpServerState } from './extensionsActions.js';
import { IExtensionManagementService, type ExtensionsOpenOptions, type ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { ExtensionsInput, ExtensionsCapabilityInput, type ExtensionsCapabilityTarget } from '../common/extensionsInput.js';
import { IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import './extensions.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Skills, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Skills accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize({ bundle: 'ash.extensions', key: 'skillsVerbosityTitle' }, 'Skills accessibility help'), description: localize({ bundle: 'ash.extensions', key: 'skillsVerbosityDescription' }, 'Announce keyboard help when Skills receives focus.') },
});

interface ExtensionsListSnapshot {
	readonly items: readonly ExtensionsListItem[];
	readonly note?: string;
	readonly sources?: readonly ICustomizationMarketplaceSourceInfo[];
	readonly nextCursor?: ICustomizationMarketplaceCursor;
	readonly total?: number;
}

interface ExtensionsListItem {
	readonly target: ExtensionsCapabilityTarget | { readonly kind: 'recommendation'; readonly id: string; readonly summary?: ExtensionsPackageSummary; } | { readonly kind: 'marketplace'; readonly resource: ICustomizationMarketplaceResource; };
	readonly name: string;
	readonly description: string;
	readonly metadata: string;
}

/** Each pane retains navigation only; capability state is read from its domain owner. */
abstract class ExtensionsListViewPane extends ViewPane {
	private readonly body: HTMLElement;
	private readonly query: InputBox;
	private readonly list: List<ExtensionsListItem>;
	protected readonly status: HTMLElement;
	private readonly statusHover: IManagedHover;
	private readonly rows = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private items: readonly ExtensionsListItem[] = [];
	private generation = 0;
	private readonly loadLifetime = this._register(new MutableDisposable());
	private catalogNote = '';
	private discovery = false;
	private discoveryButton: Button | undefined;
	private discoveryLabel = '';
	private sourcePicker: SelectBox | undefined;
	private sourceControls: HTMLElement | undefined;
	private sourceIdentity = '';
	private selectedSource: string | undefined;
	private nextCursor: ICustomizationMarketplaceCursor | undefined;
	private resultTotal: number | undefined;
	private pageCursor: ICustomizationMarketplaceCursor | undefined;
	private more: Button | undefined;
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => this.invalidate(), 250));

	protected constructor(container: HTMLElement, options: IViewPaneOptions, private readonly editors: IEditorService, contextKeys: IContextKeyService, configuration: IConfigurationService, private readonly packageManagement: IExtensionManagementService, private readonly verbositySetting = AccessibilityVerbositySettingId.Extensions) {
		super(container, { ...options, minimumBodySize: 80 });
		const body = h(mainWindow.document, 'section');
		this.body = body;
		body.className = 'ash-extensions extension-capability-pane';
		this.contentElement.append(body);
		const search = h(mainWindow.document, 'div'); search.className = 'extensions-search'; body.append(search);
		this.query = this._register(new InputBox(search, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search',
			presentation: 'compact',
			placeholder: options.title,
			ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchPane' }, 'Search {0}', options.title),
		}));
		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); body.append(this.status);
		this.statusHover = this._register(getHoverDelegate().setupHover({ target: this.status, content: '' }));
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; body.append(listContainer);
		this.trackBodyMinimum(listContainer, 64);
		this.list = this._register(new List(listContainer, {
			styles: defaultListStyles,
			ariaLabel: options.title,
			domFocusable: true,
			keyboardNavigation: true,
			getId: item => item.target.kind === 'recommendation' ? item.target.id : item.target.kind === 'marketplace' ? getCustomizationMarketplaceResourceKey(item.target.resource) : JSON.stringify(item.target),
			accessibilityProvider: { getAriaLabel: item => `${item.name}, ${item.description}, ${item.metadata}` },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.name },
			renderItem: (item, _index, row) => {
				const resources = new DisposableStore(); this.rows.set(row, resources);
				const content = h(mainWindow.document, 'div'); content.className = 'extension-row';
				const labels = h(mainWindow.document, 'div'); labels.className = 'extension-body';
				for (const [className, text] of [['extension-name', item.name], ['extension-description', item.description], ['extension-metadata', item.metadata]]) {
					const label = h(mainWindow.document, 'div'); label.className = className; label.textContent = text;
					resources.add(getHoverDelegate().setupHover({ target: label, content: text })); labels.append(label);
				}
				content.append(labels); return content;
			},
			onDidRemoveRow: row => this.rows.deleteAndDispose(row),
		}));
		this._register(this.list.onDidAccept(({ item }) => {
			if (item.target.kind === 'recommendation' && !item.target.summary) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'recommendationUnavailable' }, 'This recommendation is currently unavailable from the enabled extension sources.'); return; }
			void this.openItem(item).catch(error => { if (!this.isDisposed) { this.status.textContent = String(error); } });
		}));
		this._register(addDisposableListener(this.list.element, 'keydown', event => { if (event.key === 'Enter' && event.target === this.list.element) { event.preventDefault(); this.list.acceptActive(event); } }));
		this._register(this.query.onDidChange(() => { if (this.discovery) { this.searchScheduler.schedule(); } else { this.filter(); } }));
		this._register(this.query.onKeyDown(event => {
			if (event.key === 'ArrowDown') { event.preventDefault(); this.list.domFocus(); }
			else if (event.key === 'Enter' && this.discovery) { event.preventDefault(); this.searchScheduler.cancel(); this.invalidate(); }
		}));
		this._register(new Button(this.headerActionsElement, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'),
			icon: Lxicon.refresh,
			iconOnly: true,
			size: 'small',
			onClick: () => this.reload(),
		}));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { void this.refresh(); } else { ++this.generation; this.searchScheduler.cancel(); this.loadLifetime.clear(); } }));
		const scope = this._register(contextKeys.createScoped(this.element)); scope.createKey('extensionsCapabilitiesFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `extensions-capabilities-${type}-${generateUuid()}`, when: ContextKeyExpr.has('extensionsCapabilitiesFocused'),
				getProvider: () => {
					const focused = mainWindow.document.activeElement;
					if (!this.isBodyVisible() || !(focused instanceof HTMLElement) || !this.element.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type }, () => type === AccessibleViewType.Help
						? localize({ bundle: 'ash.extensions', key: 'capabilityHelp' }, 'Extensions contains collapsible Extensions, Installed Extensions, Skills, Connections and Recommended panes. Use Left and Right on a pane header to collapse or expand it, and Up and Down to move between headers. Search within a pane, use arrow keys to select an item, and Enter to open details in the editor. Discover searches enabled extension sources for skills or MCP servers. Show installed returns to your current resources. Press Enter in discovery search to search immediately. Choose a registry with Marketplace source, or use All sources to search every enabled registry. Load more continues the current search. Changing the source or search starts a new page sequence. Open a discovery result to review and install its package. Installed labels update after installation. Skill enablement and diagnostics are in its details. Package installation, permissions and removal are in package details. Refresh reloads the current catalog. Run Install extension from Git repository in the Command Palette to choose a repository revision and package directory. Press Escape during installation to cancel. MCP server details show backend connection status and diagnostics. Refresh reloads server status. Add MCP server opens a transport choice and configuration dialog. Independent server details provide Edit, Enable or Disable, Connect, Disconnect and Remove. Enablement is saved; Connect and Disconnect affect this running instance. HTTP server details provide Sign in, Cancel sign-in and Sign out when OAuth is available. Sign in opens a browser; credentials refresh automatically. Sign out deletes local credentials and cancels pending authorization. Operations refresh backend state. Escape cancels a dialog.')
						: [this.status.textContent, ...this.list.items.map(item => `${item.name}\n${item.description}\n${item.metadata}`)].join('\n\n'), () => focused.focus(), this.verbositySetting);
				},
			}));
		}
		this._register(this.onDidFocus(() => { if (configuration.getValue<boolean>(this.verbositySetting)) { this.query.element.setAttribute('aria-description', localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.')); } else { this.query.element.removeAttribute('aria-description'); } }));
	}

	public override focus(): void { this.query.focus(); this.invalidate(); }
	protected get isDiscovering(): boolean { return this.discovery; }
	protected get searchQuery(): string { return this.query.value.trim(); }
	protected get marketplaceOptions(): Pick<ICustomizationMarketplaceQuery, 'sourceIds' | 'cursor'> {
		return { sourceIds: this.selectedSource ? [this.selectedSource] : undefined, cursor: this.pageCursor };
	}

	protected enableDiscovery(label: string): void {
		this.discoveryLabel = label;
		this.discoveryButton = this._register(new Button(this.headerActionsElement, {
			...defaultButtonStyles,
			label,
			size: 'small',
			onClick: () => {
				this.setDiscovery(!this.discovery);
				this.invalidate();
			},
		}));
		this.sourceControls = h(mainWindow.document, 'div');
		this.sourceControls.className = 'extensions-marketplace-controls';
		this.sourceControls.hidden = true;
		this.status.before(this.sourceControls);
		this.sourcePicker = this._register(new SelectBox(this.sourceControls, {
			ariaLabel: localize({ bundle: 'ash.extensions', key: 'marketplaceSelectSource' }, 'Marketplace source'),
			options: [{ value: '', label: localize({ bundle: 'ash.extensions', key: 'marketplaceAllSources' }, 'All sources') }],
		}, defaultSelectBoxStyles));
		this._register(this.sourcePicker.onDidSelect(({ value }) => { this.selectedSource = value || undefined; this.invalidate(); }));
		this.more = this._register(new Button(this.body, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash.extensions', key: 'marketplaceLoadMore' }, 'Load more'),
			size: 'small',
			onClick: () => { void this.refresh(true); },
		}));
		this.more.domNode.classList.add('extensions-marketplace-more');
		this.more.domNode.hidden = true;
	}

	public async open(options: ExtensionsOpenOptions = {}): Promise<void> {
		this.setDiscovery(options.mode === 'browse');
		this.query.value = options.query ?? '';
		this.setExpanded(true);
		this.query.focus();
		await this.refresh();
	}

	private setDiscovery(discovering: boolean): void {
		this.discovery = discovering;
		this.searchScheduler.cancel();
		this.items = [];
		this.list.items = [];
		this.catalogNote = '';
		this.resultTotal = undefined;
		if (this.sourceControls) { this.sourceControls.hidden = !discovering; }
		if (this.more) { this.more.domNode.hidden = true; }
		if (this.discoveryButton) {
			this.discoveryButton.label = discovering ? localize({ bundle: 'ash.extensions', key: 'showInstalledResources' }, 'Show installed') : this.discoveryLabel;
		}
	}

	private async openItem(item: ExtensionsListItem): Promise<void> {
		let input: ExtensionsInput | ExtensionsCapabilityInput;
		if (item.target.kind === 'marketplace') {
			const resource = item.target.resource;
			const [details, installed] = await Promise.all([
				this.packageManagement.get(resource.installation.selectionId, resource.version),
				this.packageManagement.listInstalled(),
			]);
			const installation = installed.find(entry => entry.package.id === details.package.id && entry.package.version === details.package.version);
			input = new ExtensionsInput({
				id: details.package.id, version: details.package.version, packageType: details.packageType,
				displayName: details.displayName, description: details.description,
			}, installation?.installationId);
		} else {
			input = item.target.kind === 'recommendation' ? new ExtensionsInput(item.target.summary!) : new ExtensionsCapabilityInput(item.target);
		}
		if (this.isDisposed) { input.dispose(); return; }
		await this.editors.openEditor(input);
	}
	protected abstract readItems(signal: AbortSignal): Promise<ExtensionsListSnapshot>;
	protected invalidate(): void { if (this.isBodyVisible()) { void this.refresh(); } }
	protected reload(): void { void this.refresh(); }

	public async refresh(append = false): Promise<void> {
		const restoreMoreFocus = append && mainWindow.document.activeElement === this.more?.domNode;
		this.pageCursor = append ? this.nextCursor : undefined;
		if (append && !this.pageCursor) { return; }
		this.nextCursor = undefined;
		if (this.more) { this.more.enabled = false; }
		const generation = ++this.generation;
		const controller = new AbortController();
		this.loadLifetime.value = toDisposable(() => controller.abort());
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		this.contentElement.setAttribute('aria-busy', 'true');
		try {
			const snapshot = await this.readItems(controller.signal);
			if (this.isDisposed || generation !== this.generation) { return; }
			this.items = append ? [...this.items, ...snapshot.items] : snapshot.items;
			this.catalogNote = snapshot.note ?? '';
			this.nextCursor = snapshot.nextCursor;
			this.resultTotal = snapshot.total;
			if (this.sourcePicker && snapshot.sources) {
				const identity = JSON.stringify(snapshot.sources);
				if (identity !== this.sourceIdentity) {
					this.sourceIdentity = identity;
					this.sourcePicker.setOptions([
						{ value: '', label: localize({ bundle: 'ash.extensions', key: 'marketplaceAllSources' }, 'All sources') },
						...snapshot.sources.map(source => ({ value: source.id, label: source.displayName, disabled: source.enabled === false })),
					]);
					this.sourcePicker.value = this.selectedSource ?? '';
				}
			}
			if (this.more) {
				this.more.enabled = true;
				this.more.domNode.hidden = !this.discovery || !this.nextCursor;
				if (restoreMoreFocus && (mainWindow.document.activeElement === mainWindow.document.body || mainWindow.document.activeElement === this.more.domNode)) {
					if (this.more.domNode.hidden) { this.list.domFocus(); } else { this.more.domNode.focus(); }
				}
			}
			this.filter();
		} catch (error) {
			if (!this.isDisposed && generation === this.generation) {
				if (!append) { this.items = []; this.list.items = []; }
				this.status.textContent = error instanceof Error ? error.message : String(error);
				if (this.more) { this.more.domNode.hidden = true; }
			}
		} finally {
			if (!this.isDisposed && generation === this.generation) { this.contentElement.setAttribute('aria-busy', 'false'); }
		}
	}

	private filter(): void {
		const query = this.query.value.trim().toLowerCase();
		this.list.items = this.discovery ? this.items : this.items.filter(item => [item.name, item.description, item.metadata].some(text => text.toLowerCase().includes(query)));
		const count = this.discovery && this.resultTotal !== undefined
			? localize({ bundle: 'ash.extensions', key: 'marketplaceShowingResults' }, 'Showing {0} of {1} results', this.list.items.length, this.resultTotal)
			: localize({ bundle: 'ash.extensions', key: 'paneResults' }, '{0} items', this.list.items.length);
		this.status.textContent = [count, this.catalogNote].filter(Boolean).join(' · ');
		this.statusHover.update(this.status.textContent);
	}
}

export class RecommendedExtensionsView extends ExtensionsListViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IEditorService editors: IEditorService, @IContextKeyService contextKeys: IContextKeyService, @IConfigurationService configuration: IConfigurationService,
		@IExtensionRecommendationsService private readonly recommendations: IExtensionRecommendationsService, @IExtensionManagementService private readonly extensions: IExtensionManagementService,
	) {
		super(container, options, editors, contextKeys, configuration, extensions);
		this._register(recommendations.onDidChangeRecommendations(() => this.invalidate()));
		this._register(extensions.onDidChangeInstalled(() => this.invalidate()));
	}
	protected override reload(): void { this.recommendations.refresh(); }

	protected async readItems(signal: AbortSignal): Promise<ExtensionsListSnapshot> {
		const snapshot = await this.recommendations.getWorkspaceRecommendations();
		const items: ExtensionsListItem[] = [];
		for (let index = 0; index < snapshot.recommendations.length; index += 6) {
			if (signal.aborted) { throw new CancellationError(); }
			items.push(...await Promise.all(snapshot.recommendations.slice(index, index + 6).map(async recommendation => {
				let summary: ExtensionsPackageSummary | undefined;
				try {
					const packages = await this.extensions.search(recommendation.extensionId, { limit: 20 });
					summary = packages.find(entry => entry.id.toLowerCase() === recommendation.extensionId);
				} catch { /* Keep declared IDs visible while their catalog source is unavailable. */ }
				return {
					target: { kind: 'recommendation' as const, id: recommendation.extensionId, summary }, name: summary?.displayName ?? recommendation.extensionId,
					description: recommendation.reason.reasonText, metadata: summary?.id ?? localize({ bundle: 'ash.extensions', key: 'recommendationNotFound' }, 'Unavailable from enabled sources'),
				};
			})));
		}
		return { items, note: [...snapshot.diagnostics, ...(!items.length ? [snapshot.resources.length ? localize({ bundle: 'ash.extensions', key: 'workspaceRecommendationsEmpty' }, 'Add recommendations to .ash/extensions.json or the extensions field in the workspace file.') : localize({ bundle: 'ash.extensions', key: 'recommendationsNoWorkspace' }, 'Open a workspace to see its recommendations.')] : [])].join('\n') };
	}
}

export class SkillsViewPane extends ExtensionsListViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IEditorService editors: IEditorService, @IContextKeyService contextKeys: IContextKeyService, @IConfigurationService configuration: IConfigurationService,
		@IPromptsService private readonly prompts: IPromptsService, @IChatSessionNavigationService private readonly sessions: IChatSessionNavigationService,
		@IExtensionManagementService private readonly extensions: IExtensionManagementService,
		@ICustomizationMarketplaceService private readonly marketplace: ICustomizationMarketplaceService,
	) {
		super(container, options, editors, contextKeys, configuration, extensions, AccessibilityVerbositySettingId.Skills);
		this.enableDiscovery(localize({ bundle: 'ash.extensions', key: 'discoverSkills' }, 'Discover skills'));
		this._register(marketplace.onDidChangeSources(() => this.invalidate()));
		this._register(prompts.onDidChangeSkills(() => this.invalidate()));
		this._register(extensions.onDidChangeInstalled(() => this.invalidate()));
		this._register(editors.onDidActiveEditorChange(() => this.invalidate()));
	}

	protected async readItems(signal: AbortSignal): Promise<ExtensionsListSnapshot> {
		if (this.isDiscovering) { return readMarketplaceItems(this.marketplace, this.extensions, CustomizationMarketplaceMediaType.Skill, this.searchQuery, signal, this.marketplaceOptions); }
		const sessionId = this.sessions.getActiveConversation()?.sessionId;
		const snapshot = await this.prompts.readSkillManagement(sessionId);
		if (sessionId !== this.sessions.getActiveConversation()?.sessionId) { throw new Error(localize({ bundle: 'ash.extensions', key: 'skillScopeChanged' }, 'The active conversation changed. Refresh Skills.')); }
		return {
			note: snapshot.diagnostics.map(entry => `${entry.source}${entry.subject ? ` / ${entry.subject}` : ''}: ${entry.message}`).join('\n'), items: snapshot.catalog.skills.map(skill => ({
				target: { kind: 'skill', source: skill.id.source, name: skill.id.name, sessionId }, name: skill.name, description: skill.description,
				metadata: `${skill.id.source} · ${skill.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled')}`,
			}))
		};
	}
}

export class McpServersViewPane extends ExtensionsListViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IEditorService editors: IEditorService, @IContextKeyService contextKeys: IContextKeyService, @IConfigurationService configuration: IConfigurationService,
		@IExtensionManagementService private readonly extensions: IExtensionManagementService, @IMcpServerStatusService private readonly mcpStatus: IMcpServerStatusService,
		@IMcpServerManagementService private readonly mcpManagement: IMcpServerManagementService, @IDialogService dialogs: IDialogService,
		@ICustomizationMarketplaceService private readonly marketplace: ICustomizationMarketplaceService,
	) {
		super(container, options, editors, contextKeys, configuration, extensions);
		this.enableDiscovery(localize({ bundle: 'ash.extensions', key: 'discoverMcpServers' }, 'Discover connections'));
		this._register(marketplace.onDidChangeSources(() => this.invalidate()));
		this._register(extensions.onDidChangeInstalled(() => this.invalidate()));
		this._register(mcpManagement.onDidChange(() => this.invalidate()));
		const add = this._register(new Button(this.headerActionsElement, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash.extensions', key: 'mcpAddServer' }, 'Add MCP server'),
			size: 'small',
			enabled: mcpManagement.isAvailable,
		}));
		let adding = false;
		const addLifetime = this._register(new MutableDisposable());
		this._register(mcpManagement.onDidChange(() => { add.enabled = !adding && mcpManagement.isAvailable; }));
		this._register(add.onDidClick(() => {
			if (adding) { return; }
			adding = true;
			add.enabled = false;
			const controller = new AbortController();
			addLifetime.value = toDisposable(() => controller.abort());
			void (async () => {
				const snapshot = await mcpManagement.readConfiguration();
				if (controller.signal.aborted) { return; }
				const id = await configureMcpServer(mcpManagement, dialogs, snapshot, undefined, controller.signal);
				if (controller.signal.aborted) { return; }
				await this.refresh();
				if (id && !this.isDisposed) {
					await editors.openEditor(new ExtensionsCapabilityInput({ kind: 'mcp', serverId: id }));
					if (!this.isDisposed) { editors.focusActiveEditor(); }
				}
			})().catch(async error => {
				if (this.isDisposed) { return; }
				await this.refresh();
				if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); }
			}).finally(() => {
				addLifetime.clear();
				adding = false;
				if (!this.isDisposed) { add.enabled = mcpManagement.isAvailable; if (mainWindow.document.activeElement === mainWindow.document.body) { add.focus(); } }
			});
		}));
	}

	protected async readItems(signal: AbortSignal): Promise<ExtensionsListSnapshot> {
		if (this.isDiscovering) { return readMarketplaceItems(this.marketplace, this.extensions, CustomizationMarketplaceMediaType.McpServer, this.searchQuery, signal, this.marketplaceOptions); }
		const [installedResult, statusResult, configurationResult] = await Promise.allSettled([
			this.extensions.listInstalled(),
			this.mcpStatus.isAvailable ? this.mcpStatus.read() : Promise.resolve(undefined),
			this.mcpManagement.isAvailable ? this.mcpManagement.readConfiguration() : Promise.resolve(undefined),
		]);
		const installed = installedResult.status === 'fulfilled' ? installedResult.value : [];
		const configured = configurationResult.status === 'fulfilled' ? configurationResult.value : undefined;
		const snapshot = statusResult.status === 'fulfilled' ? statusResult.value : undefined;
		// Package identity enriches backend status; installation alone says nothing about connection state.
		const items: ExtensionsListItem[] = installed.flatMap(installation => installation.capabilities.filter(capability => capability.kind === 'mcp').map(capability => ({
			target: { kind: 'mcp' as const, serverId: `marketplace:${installation.package.id}:mcp:${capability.id}`, installationId: installation.installationId, capabilityId: capability.reference.id },
			name: capability.id, description: `${installation.package.id} · ${installation.package.version}`, metadata: installation.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'),
		})));
		for (const server of configured?.servers ?? []) {
			items.push({
				target: { kind: 'mcp', serverId: server.id }, name: server.displayName,
				description: server.id,
				metadata: server.enablement === 'enabled'
					? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled')
					: localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled'),
			});
		}
		for (const server of snapshot?.servers ?? []) {
			const index = items.findIndex(item => item.target.kind === 'mcp' && item.target.serverId === server.id);
			const installedItem = index >= 0 ? items[index] : undefined;
			const item: ExtensionsListItem = {
				target: installedItem?.target ?? { kind: 'mcp', serverId: server.id },
				name: server.displayName || installedItem?.name || server.id,
				description: [
					installedItem?.description,
					localize({ bundle: 'ash.extensions', key: 'mcpToolsCount' }, '{0} registered tools', server.toolCount),
					server.state.status === 'unavailable' ? server.state.reason : '',
				].filter(Boolean).join(' · '),
				metadata: describeMcpServerState(server.state),
			};
			if (index >= 0) { items[index] = item; } else { items.push(item); }
		}
		const statusNote = statusResult.status === 'rejected'
			? localize({ bundle: 'ash.extensions', key: 'mcpStatusReadFailed' }, 'Could not load MCP server status: {0}', String(statusResult.reason))
			: !snapshot ? localize({ bundle: 'ash.extensions', key: 'mcpStatusUnavailable' }, 'MCP server status is unavailable.') : '';
		return {
			items,
			note: [
				installedResult.status === 'rejected' ? localize({ bundle: 'ash.extensions', key: 'mcpPackagesReadFailed' }, 'Could not load installed packages: {0}', String(installedResult.reason)) : '',
				statusNote,
				configurationResult.status === 'rejected' ? localize({ bundle: 'ash.extensions', key: 'mcpConfigurationReadFailed' }, 'Could not load MCP configuration: {0}', String(configurationResult.reason)) : '',
			].filter(Boolean).join(' · '),
		};
	}
}

/** Discovery carries inert identities and current installation labels; opening a row resolves reviewed package details. */
async function readMarketplaceItems(marketplace: ICustomizationMarketplaceService, extensions: IExtensionManagementService, mediaType: CustomizationMarketplaceMediaType, query: string, signal: AbortSignal, options: Pick<ICustomizationMarketplaceQuery, 'sourceIds' | 'cursor'>): Promise<ExtensionsListSnapshot> {
	if (signal.aborted) { throw new CancellationError(); }
	using lifetime = new DisposableStore();
	const cancellation = new CancellationTokenSource();
	lifetime.add(toDisposable(() => cancellation.dispose(true)));
	const cancel = () => cancellation.cancel();
	signal.addEventListener('abort', cancel, { once: true });
	lifetime.add(toDisposable(() => signal.removeEventListener('abort', cancel)));
	const [page, installed] = await Promise.all([
		marketplace.query({ ...options, query, mediaType, pageSize: 30 }, cancellation.token),
		extensions.listInstalled(),
	]);
	if (signal.aborted) { throw new CancellationError(); }
	const items = page.items.map(resource => {
		const installation = installed.find(entry => entry.package.id === resource.identifier && entry.package.version === resource.version);
		return {
			target: { kind: 'marketplace' as const, resource },
			name: resource.displayName, description: resource.description,
			metadata: [resource.version, installation ? installation.state === 'pendingRemoval'
				? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending')
				: localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed') : ''].filter(Boolean).join(' · '),
		};
	});
	return {
		items,
		nextCursor: page.nextCursor, total: page.total, sources: marketplace.allSources,
		note: [
			!marketplace.sources.length ? localize({ bundle: 'ash.extensions', key: 'marketplaceDisabled' }, 'Discovery is disabled in Settings.') : '',
			...(page.sourceErrors?.map(error => error.message) ?? []),
		].filter(Boolean).join(' · '),
	};
}
