import {
	defaultButtonStyles,
	defaultCountBadgeStyles,
	defaultListStyles,
	defaultSelectBoxStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { createObjectUrl } from '../../../../base/browser/fileAccess.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { getHoverDelegate, type IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable, Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
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
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { addConnection, describeConnectorState, describeMcpServerState, changeExtensionEnablement, extensionEnablementLabel, getSkillSummary } from './extensionsActions.js';
import { IConnectorService } from '../../../../platform/connectors/common/connectorService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IExtensionManagementService, type ExtensionsOpenOptions, type ExtensionsPackageSummary, type ExtensionsInstalledPackage } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { ExtensionsInput, ExtensionsCapabilityInput, type ExtensionsCapabilityTarget, ExtensionsInputSource } from '../common/extensionsInput.js';
import { getExtensionAttribution } from '../common/extensionAttribution.js';
import { IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionUiTarget } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { extensionUiTargetsLabel } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { appendLabelIcon } from '../../../../base/browser/ui/iconlabel/iconLabels.js';
import { Emitter } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { changeExtensionPackage } from './extensionEditor.js';
import { IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IExtensionApi, type ExtensionCatalog, type ExtensionResourceRequest } from '../../../../platform/extensions/common/extensionApi.js';
import { MainThreadLocalization } from '../../../api/browser/mainThreadLocalization.js';
import './media/extension.css';

interface ExtensionListItem {
	readonly summary: ExtensionsPackageSummary;
	readonly attribution?: string;
	readonly searchTerms?: readonly string[];
	readonly installation?: ExtensionsInstalledPackage;
	readonly source?: ExtensionsInputSource;
	readonly enabled?: boolean;
	readonly canChangeEnablement?: boolean;
	readonly icon?: ExtensionResourceRequest;
}

/** The Workbench and Sessions share catalog rendering; package authority stays in the backend. */
class ExtensionsContent extends Disposable {
	private readonly loadingChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeLoading = this.loadingChanged.event;
	public readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<number>());
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
	private readonly localization: MainThreadLocalization;

	constructor(container: HTMLElement, options: ExtensionsOpenOptions & { readonly beforeOpenEditor?: () => Promise<void>; },
		@IExtensionManagementService private readonly extensionManagement: IExtensionManagementService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IEditorService private readonly editors: IEditorService,
		@IGlobalExtensionEnablementService private readonly enablement: IGlobalExtensionEnablementService,
		@IPluginManagementService private readonly plugins: IPluginManagementService,
		@IExtensionApi private readonly extensionCatalog: IExtensionApi,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.localization = instantiation.createInstance(MainThreadLocalization);
		this.options = options;
		this.isPluginsPane = options.view === 'plugins';
		this.domNode = h(mainWindow.document, 'section'); this.domNode.className = 'ash-extensions';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));

		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); this.domNode.append(this.status);
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; this.domNode.append(listContainer);
		this.list = this._register(new List(listContainer, {
			styles: defaultListStyles,
			scrolling: 'managed',
			ariaLabel: this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'installedPlugins' }, 'Plugins') : localize({ bundle: 'ash.extensions', key: 'marketplacePane' }, 'Marketplace'),
			domFocusable: true,
			keyboardNavigation: true,
			focusOnMouseMove: false,
			getId: item => `${item.source ?? ExtensionsInputSource.Registry}/${item.installation?.installationId ?? item.summary.id}/${item.summary.version}`,
			accessibilityProvider: {
				getAriaLabel: item => [
					item.summary.displayName,
					extensionUiTargetsLabel(item.summary.uiTargets),
					...this.isPluginsPane ? [item.attribution, item.summary.description] : [item.summary.version, item.summary.description],
					item.enabled === false ? localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled') : '',
				].filter(Boolean).join(', ')
			},
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
				return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type: AccessibleViewType.Help }, () => localize({ bundle: 'ash.extensions', key: 'accessibilityHelp' }, 'Extensions opens your installed Skills, Plugins and Connections, followed by Recommended. Skills contain Agent working methods, Plugins add features, and Connections lists external services and tool servers together. The search box above all panes searches the Marketplace and installed Plugins, including built-in language servers. Use Filter extensions to choose installed categories, built-in plugins or recommendations. Clear Search removes the query and filters. Use @installed to filter installed items, or clear the search to return to these categories. One Refresh extensions action reloads all categories. The title bar More Actions menu provides marketplace, installed, source management and installation commands. Pane actions appear on hover or keyboard focus. Use Left and Right on pane headers to collapse or expand them. Use Tab to move between controls, arrow keys to select an item, and Enter to open details. Plugin rows show the name, publisher and description. Search also matches the publisher. Open Plugin details to enable or disable it and view its version and identifier. Skill enablement and connection actions are managed separately in their details. Execution authorization and permissions are reviewed in package details. Language packs are managed through the display language setting. Run Install extension from Git repository in the Command Palette to install a repository package. Press Escape during installation to cancel. Recommendations combine open files, current languages, project configuration, workspace declarations, available tools, keymaps, remote workspaces and browser use, with a reason for each item. Run Show recommended keymaps in the Command Palette to browse optional keyboard shortcuts. Recommendation notifications offer Install, Show recommendations and Don\'t show again. Enable recommendations only on demand to hide automatic notifications. Recent file recommendations remain available for seven days. Use Ignore an extension recommendation and Restore an ignored extension recommendation in the Command Palette or Extensions menu. Restore dismissed extension recommendation notifications resets notification dismissals. Escape closes this help.'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
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
		if (item.icon) {
			const path = item.icon.path.toLowerCase();
			void this.extensionCatalog.resources.readExtensionResourceBytes(item.icon).then(bytes => {
				if (resources.isDisposed) { return; }
				const image = h(mainWindow.document, 'img'); image.alt = ''; image.draggable = false;
				const mime = path.endsWith('.svg') ? 'image/svg+xml' : `image/${path.split('.').at(-1)!.replace('jpg', 'jpeg')}`;
				const object = createObjectUrl(mainWindow, new Blob([new Uint8Array(bytes)], { type: mime }));
				resources.add(object.registration);
				resources.add(addDisposableListener(image, 'load', () => icon.replaceChildren(image)));
				image.src = object.url.toString();
			}).catch(() => { /* Keep the generic icon when a package resource is unavailable. */ });
		}
		const body = h(mainWindow.document, 'div'); body.className = 'extension-body';
		const labels: readonly [string, string | undefined][] = this.isPluginsPane
			? [['extension-name', item.summary.displayName], ['extension-metadata', [extensionUiTargetsLabel(item.summary.uiTargets), item.attribution].filter(Boolean).join(' · ')], ['extension-description', item.summary.description]]
			: [['extension-name', item.summary.displayName], ['extension-description', item.summary.description], ['extension-metadata', `${extensionUiTargetsLabel(item.summary.uiTargets)} · ${item.summary.id} · ${item.summary.version}`]];
		for (const [className, value] of labels) {
			if (!value) { continue; }
			const label = resources.add(new IconLabel(body, { label: value, title: value, hideIcon: true }));
			label.element.classList.add(className);
		}
		if (this.isPluginsPane) {
			content.append(icon, body);
			return content;
		}
		const footer = h(mainWindow.document, 'div'); footer.className = 'extension-footer';
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
					try { const details = await this.extensionManagement.get(item.summary.id, item.summary.version); await changeExtensionPackage(this.extensionManagement, this.dialogs, this.notifications, 'install', details); }
					finally { this.working = false; if (!this.isDisposed) { await this.load(); } }
				});
			}));
		} else {
			const state = h(mainWindow.document, 'span'); state.className = 'extension-state'; state.textContent = item.source === ExtensionsInputSource.BuiltIn ? localize({ bundle: 'ash.extensions', key: 'builtInFilter' }, 'Built-in') : item.installation?.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'); actions.append(state);
		}
		if (item.enabled !== undefined) {
			if (!item.enabled) {
				const state = h(mainWindow.document, 'span'); state.className = 'extension-state';
				state.textContent = localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
				footer.append(state);
			}
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
		footer.append(actions); body.append(footer);
		content.append(icon, body); return content;
	}

	private async load(force = false): Promise<void> {
		const generation = ++this.generation;
		this.loadingChanged.fire(true);
		const query = this.query.trim();
		const isInstalled = this.options.mode === 'installed' || this.options.mode === undefined && !query && !this.options.capabilityKind && !this.options.languageId;
		if (!force || !this.list.items.length) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…'); }
		this.domNode.setAttribute('aria-busy', 'true');
		try {
			const installed = this.options.mode === 'builtIn' ? [] : await this.extensionManagement.listInstalled();
			// Package execution policy applies to marketplace installations. Local
			// plugins have their own owner and remain manageable from a Web client.
			const policies = installed.length ? await this.extensionManagement.listEditorExtensions() : { extensions: [] };
			let items: ExtensionListItem[];
			let editorCatalog: ExtensionCatalog | undefined;
			const builtInItems: ExtensionListItem[] = [];
			if (this.options.mode === 'builtIn' || isInstalled) {
				const catalog = await this.extensionCatalog.list('cached', { includeDisabled: true });
				editorCatalog = catalog;
				const providers = await this.extensionManagement.listBuiltInProviders().catch(() => undefined);
				const disabled = new Set(this.enablement.getDisabledExtensions().map(value => value.id));
				builtInItems.push(...await Promise.all(catalog.extensions.filter(extension => extension.sourceKind === 'builtIn' && (!this.options.capabilityKind || this.options.capabilityKind === 'editorExtension' || this.options.capabilityKind === 'localization' && JSON.parse(extension.manifestJson).contributes?.localizations?.length)).map(async extension => {
					const manifest = JSON.parse(await this.localization.localizeManifest(extension.id, extension.manifestJson, catalog.generation));
					const provider = providers?.providers.find(value => value.id === extension.id);
					const isProvider = (manifest.ashRuntime?.kind === 'rust' && !manifest.browser) || !!manifest.ashLanguageServers;
					return {
						attribution: getExtensionAttribution(manifest),
						source: ExtensionsInputSource.BuiltIn, enabled: isProvider ? provider?.enabled : !disabled.has(extension.id.toLowerCase()), canChangeEnablement: isProvider ? !!provider && providers?.canChangeEnablement === true : !manifest.contributes?.localizations?.length,
						searchTerms: manifest.ashLanguageServers?.servers?.map((server: { id: string; }) => server.id),
						summary: { id: extension.id, version: extension.version, packageType: 'editorExtension', displayName: manifest.displayName?.startsWith('%') ? extension.name : manifest.displayName ?? extension.displayName, uiTargets: manifest.ashUiTargets, description: typeof manifest.description === 'string' && !manifest.description.startsWith('%') ? manifest.description : '' }
					};
				})));
			}
			if (this.options.mode === 'builtIn') {
				items = builtInItems;
			} else if (isInstalled) {
				items = await Promise.all(installed.filter(entry => (!this.options.capabilityKind || entry.capabilities.some(capability => capability.kind === this.options.capabilityKind))).map(async installation => {
					const policy = policies.extensions.find(value => value.installationId === installation.installationId);
					const editor = editorCatalog?.extensions.find(value => value.id === installation.package.id.split('@')[0] && value.version === installation.package.version);
					const manifest = editor && editorCatalog ? JSON.parse(await this.localization.localizeManifest(editor.id, editor.manifestJson, editorCatalog.generation)) : undefined;
					const details = await this.extensionManagement.get(installation.package.id, installation.package.version).catch(() => undefined);
					return { installation, attribution: getExtensionAttribution(manifest), enabled: policy?.enabled, canChangeEnablement: !!policy, summary: { id: installation.package.id, version: installation.package.version, displayName: typeof manifest?.displayName === 'string' && !manifest.displayName.startsWith('%') ? manifest.displayName : editor?.displayName ?? installation.package.id.split('@')[0], packageType: 'installed', uiTargets: details?.uiTargets, description: typeof manifest?.description === 'string' && !manifest.description.startsWith('%') ? manifest.description : installation.capabilities.map(capability => capability.kind === 'editorExtension' ? localize({ bundle: 'ash.extensions', key: 'pluginEditorTag' }, 'Editor') : capability.kind).join(' · ') } };
				}));
				items.push(...builtInItems);
				if (this.isPluginsPane || !this.options.capabilityKind || this.options.capabilityKind === 'editorExtension') {
					const catalog = await this.plugins.list();
					items.push(...catalog.packages.filter(plugin => this.isPluginsPane || !this.options.capabilityKind || plugin.hasEditorExtensions).map(plugin => ({ source: ExtensionsInputSource.Local, enabled: plugin.enabled, canChangeEnablement: plugin.enabled || !plugin.revoked, summary: { id: plugin.id, version: plugin.version, packageType: 'editorExtension', displayName: plugin.displayName, uiTargets: plugin.uiTargets, description: localize({ bundle: 'ash.extensions', key: 'localExtension' }, 'Local extension') } })));
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
			const catalog = editorCatalog;
			if (catalog) {
				items = items.map(item => {
					const id = item.summary.id.replace(/@[^@]+$/u, '');
					const extension = catalog.extensions.find(value => value.id === id && value.version === item.summary.version);
					if (!extension) { return item; }
					const path = JSON.parse(extension.manifestJson).icon;
					return typeof path === 'string' && /\.(?:png|jpe?g|gif|webp|svg)$/iu.test(path)
						? { ...item, icon: { generation: catalog.generation, extensionId: extension.id, path } }
						: item;
				});
			}
			this.installed = installed;
			this.list.items = this.options.mode === 'browse' || this.options.mode === undefined ? items : items.filter(item =>
				[item.summary.id, item.summary.displayName, item.summary.description, item.attribution ?? '', ...item.searchTerms ?? []]
					.some(value => value.toLowerCase().includes(query.toLowerCase())));
			this.loaded = true;
			this.status.textContent = '';
			this.changed.fire(this.list.items.length);
		} catch (error) { if (!this.isDisposed && generation === this.generation) { throw error; } }
		finally {
			if (!this.isDisposed && generation === this.generation) {
				this.domNode.setAttribute('aria-busy', 'false');
				this.loadingChanged.fire(false);
			}
		}
	}

	public refresh(): Promise<void> { return this.run(() => this.load(true)); }
	public setSearch(query: string): void { this.query = query; this.options = { mode: 'installed', view: this.options.view }; this.loaded = false; if (this.visible) { void this.run(() => this.load()); } }

	private async run(operation: () => Promise<void>): Promise<void> { try { await operation(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } } }
}

export class ExtensionsListView extends ViewPane {
	private readonly content: ExtensionsContent;
	constructor(container: HTMLElement, options: IViewPaneOptions, @IInstantiationService instantiation: IInstantiationService) {
		super(container, { ...options, minimumBodySize: 160 });
		this.element.classList.add('ash-extensions-view');
		const isPluginsPane = options.id === 'ash.extensions.plugins';
		const badge = this._register(new CountBadge(this.headerElement, {
			titleFormat: isPluginsPane
				? localize({ bundle: 'ash.extensions', key: 'pluginResults' }, '{0} plugins')
				: localize({ bundle: 'ash.extensions', key: 'results' }, '{0} extensions'),
		}, defaultCountBadgeStyles));
		badge.domNode.id = `${this.id}-count`;
		this.headerElement.setAttribute('aria-describedby', badge.domNode.id);
		this.content = this._register(instantiation.createInstance(ExtensionsContent, this.contentElement, isPluginsPane ? { view: 'plugins', mode: 'installed' } : { mode: 'browse' }));
		const loading = this._register(new MutableDisposable());
		this._register(this.content.onDidChangeLoading(active => {
			if (active && !loading.value) {
				const progress = this.getProgressIndicator().show(true, 150);
				loading.value = toDisposable(() => progress.done());
			} else if (!active) loading.clear();
		}));
		this._register(this.content.onDidChange(count => badge.setCount(count)));
		this._register(this.onDidChangeVisibility(visible => this.content.setVisible(visible)));
	}
	public async open(options?: ExtensionsOpenOptions): Promise<void> { this.setExpanded(true); await this.content.open(this.id === 'ash.extensions.plugins' ? { ...options, view: 'plugins', mode: options?.mode ?? 'installed' } : { mode: 'browse', ...options }); }
	public override focus(): void { this.content.focus(); }
	public refresh(): Promise<void> { return this.content.refresh(); }
	public setSearch(query: string): void { this.content.setSearch(query); }
}


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
	private readonly badge: CountBadge;
	private query = '';
	private readonly list: List<ExtensionsListItem>;
	protected readonly status: HTMLElement;
	private readonly statusHover: IManagedHover;
	private readonly rows = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private items: readonly ExtensionsListItem[] = [];
	private generation = 0;
	private readonly loadLifetime = this._register(new MutableDisposable());
	private refreshPending = false;
	private catalogNote = '';
	private discovery = false;
	private sourcePicker: SelectBox | undefined;
	private sourceControls: HTMLElement | undefined;
	private sourceIdentity = '';
	private selectedSource: string | undefined;
	private nextCursor: ICustomizationMarketplaceCursor | undefined;
	private resultTotal: number | undefined;
	private pageCursor: ICustomizationMarketplaceCursor | undefined;
	private more: Button | undefined;

	protected constructor(container: HTMLElement, options: IViewPaneOptions, private readonly editors: IEditorService, contextKeys: IContextKeyService, configuration: IConfigurationService, private readonly packageManagement: IExtensionManagementService, private readonly verbositySetting = AccessibilityVerbositySettingId.Extensions) {
		super(container, { ...options, minimumBodySize: 80 });
		this.element.classList.add('ash-extensions-view');
		this.badge = this._register(new CountBadge(this.headerElement, {
			titleFormat: localize({ bundle: 'ash.extensions', key: 'paneResults' }, '{0} items'),
		}, defaultCountBadgeStyles));
		this.badge.domNode.id = `${this.id}-count`;
		this.headerElement.setAttribute('aria-describedby', this.badge.domNode.id);
		const body = h(mainWindow.document, 'section');
		this.body = body;
		body.className = 'ash-extensions extension-capability-pane';
		this.contentElement.append(body);

		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); body.append(this.status);
		this.statusHover = this._register(getHoverDelegate().setupHover({ target: this.status, content: '' }));
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; body.append(listContainer);
		this.trackBodyMinimum(listContainer, 64);
		this.list = this._register(new List<ExtensionsListItem>(listContainer, {
			styles: defaultListStyles,
			scrolling: 'managed',
			ariaLabel: options.title,
			domFocusable: true,
			keyboardNavigation: true,
			focusOnMouseMove: false,
			getId: item => item.target.kind === 'recommendation' ? item.target.id : item.target.kind === 'marketplace' ? getCustomizationMarketplaceResourceKey(item.target.resource) : JSON.stringify(item.target),
			accessibilityProvider: { getAriaLabel: item => [item.name, item.description, item.metadata].filter(Boolean).join(', ') },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.name },
			renderItem: (item, _index, row) => {
				const resources = new DisposableStore(); this.rows.set(row, resources);
				const content = h(mainWindow.document, 'div'); content.className = 'extension-row';
				const labels = h(mainWindow.document, 'div'); labels.className = 'extension-body';
				for (const [className, text] of [['extension-name', item.name], ['extension-description', item.description], ['extension-metadata', item.metadata]]) {
					if (!text) { continue; }
					const label = resources.add(new IconLabel(labels, { label: text, title: text, hideIcon: true }));
					label.element.classList.add(className);
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

		// Collapsed panes still expose a count, so their domain projection follows pane visibility.
		this._register(this.onDidChangeVisibility(visible => {
			if (visible) {
				if (!this.isExpanded()) { this.invalidate(); }
			} else {
				++this.generation;
				this.refreshPending = false;
				this.loadLifetime.clear();
			}
		}));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { this.invalidate(); } }));
		const scope = this._register(contextKeys.createScoped(this.element)); scope.createKey('extensionsCapabilitiesFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `extensions-capabilities-${type}-${generateUuid()}`, when: ContextKeyExpr.has('extensionsCapabilitiesFocused'),
				getProvider: () => {
					const focused = mainWindow.document.activeElement;
					if (!this.isBodyVisible() || !(focused instanceof HTMLElement) || !this.element.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type }, () => type === AccessibleViewType.Help
						? localize({ bundle: 'ash.extensions', key: 'capabilityHelp' }, 'Extensions opens installed Skills, Plugins and Connections, followed by Recommended. Use Left and Right on a pane header to collapse or expand it, and Up and Down to move between headers. Use the single search box above the panes to search the Marketplace and installed Plugins, including built-in language servers; @installed filters current resources. Clear the search to return to installed categories. Down moves to results; arrow keys select items; Enter opens details. Refresh extensions reloads all categories. Pane actions appear on hover or keyboard focus. Marketplace source selects a registry; Load more continues the search. Skill details control only that skill. Connections shows all connections in one list. Open details for account authorization, server status and available actions. A service’s associated MCP server appears only in its details. Add connection offers service account authorization or custom MCP configuration. Choose a service to sign in or connect with an API token, or configure an HTTP server or local process. Server details provide Edit, Enable or Disable, Connect, Disconnect and Remove when available. Connection actions keep packages installed. Package details manage installation, permissions and removal. Refresh reads current domain state. Run Install extension from Git repository in the Command Palette to install a repository package. Recommendations combine open files, current languages, project configuration, workspace declarations, available tools, keymaps, remote workspaces and browser use, with a reason for each item. Run Show recommended keymaps in the Command Palette to browse optional keyboard shortcuts. Recommendation notifications offer Install, Show recommendations and Don\'t show again. Enable recommendations only on demand to hide automatic notifications. Recent file recommendations remain available for seven days. Use Ignore an extension recommendation and Restore an ignored extension recommendation in the Command Palette or Extensions menu. Restore dismissed extension recommendation notifications resets notification dismissals. Escape cancels a dialog.')
						: [localize({ bundle: 'ash.extensions', key: 'paneResults' }, '{0} items', this.list.items.length), this.status.textContent, ...this.list.items.map(item => `${item.name}\n${item.description}\n${item.metadata}`)].filter(Boolean).join('\n\n'), () => focused.focus(), this.verbositySetting);
				},
			}));
		}
		this._register(this.onDidFocus(() => { if (configuration.getValue<boolean>(this.verbositySetting)) { this.list.element.setAttribute('aria-description', localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.')); } else { this.list.element.removeAttribute('aria-description'); } }));
	}

	public override focus(): void { this.list.domFocus(); }
	protected get isDiscovering(): boolean { return this.discovery; }
	protected get searchQuery(): string { return this.query.trim(); }
	protected get marketplaceOptions(): Pick<ICustomizationMarketplaceQuery, 'sourceIds' | 'cursor'> {
		return { sourceIds: this.selectedSource ? [this.selectedSource] : undefined, cursor: this.pageCursor };
	}

	protected enableDiscovery(): void {
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
		this.query = options.query ?? '';
		this.setExpanded(true);
		await this.refresh();
	}

	private setDiscovery(discovering: boolean): void {
		this.discovery = discovering;
		this.items = [];
		this.list.items = [];
		this.badge.setCount(0);
		this.catalogNote = '';
		this.resultTotal = undefined;
		if (this.sourceControls) { this.sourceControls.hidden = !discovering; }
		if (this.more) { this.more.domNode.hidden = true; }
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
	protected invalidate(): void {
		if (!this.isVisible()) { return; }
		// Domain reads may not support physical cancellation. Keep one trailing
		// read instead of multiplying requests for every notification in a burst.
		if (this.loadLifetime.value && !this.discovery) { this.refreshPending = true; }
		else { void this.refresh(); }
	}
	public setSearch(query: string): void { this.query = query; if (this.discovery) { this.setDiscovery(false); void this.refresh(); } else { this.filter(); } }

	public async refresh(append = false): Promise<void> {
		const restoreMoreFocus = append && mainWindow.document.activeElement === this.more?.domNode;
		this.pageCursor = append ? this.nextCursor : undefined;
		if (append && !this.pageCursor) { return; }
		this.refreshPending = false;
		this.nextCursor = undefined;
		if (this.more) { this.more.enabled = false; }
		const generation = ++this.generation;
		const controller = new AbortController();
		const progress = this.getProgressIndicator().show(true, 150);
		this.loadLifetime.value = toDisposable(() => { progress.done(); controller.abort(); });
		// Keep retained rows stationary during refresh; aria-busy exposes the pending state.
		if (!this.list.items.length) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…'); }
		this.contentElement.setAttribute('aria-busy', 'true');
		try {
			const snapshot = await this.readItems(controller.signal);
			if (this.isDisposed || generation !== this.generation || this.refreshPending) { return; }
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
			if (!this.isDisposed && generation === this.generation && !this.refreshPending) {
				if (!append) { this.items = []; this.filter(); }
				this.status.textContent = error instanceof Error ? error.message : String(error);
				if (this.more) { this.more.domNode.hidden = true; }
			}
		} finally {
			if (!this.isDisposed && generation === this.generation) {
				this.loadLifetime.clear();
				if (this.refreshPending && this.isVisible()) { void this.refresh(); }
				else { this.contentElement.setAttribute('aria-busy', 'false'); }
			}
		}
	}

	private filter(): void {
		const query = this.query.trim().toLowerCase();
		const items = this.discovery ? this.items : this.items.filter(item => [item.name, item.description, item.metadata].some(text => text.toLowerCase().includes(query)));
		this.list.items = items;
		this.badge.setCount(this.list.items.length);
		const count = this.discovery && this.resultTotal !== undefined
			? localize({ bundle: 'ash.extensions', key: 'marketplaceShowingResults' }, 'Showing {0} of {1} results', this.list.items.length, this.resultTotal)
			: '';
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
	public refreshRecommendations(): Promise<void> { this.recommendations.refresh(); return this.refresh(); }

	protected async readItems(signal: AbortSignal): Promise<ExtensionsListSnapshot> {
		const snapshot = await this.recommendations.getRecommendations();
		const items: ExtensionsListItem[] = [];
		for (let index = 0; index < snapshot.recommendations.length; index += 6) {
			if (signal.aborted) { throw new CancellationError(); }
			items.push(...await Promise.all(snapshot.recommendations.slice(index, index + 6).map(async recommendation => {
				let summary: ExtensionsPackageSummary | undefined;
				try {
					const details = await this.extensions.get(recommendation.extensionId);
					summary = { id: details.package.id, version: details.package.version, packageType: details.packageType, displayName: details.displayName, description: details.description, uiTargets: details.uiTargets };
				} catch { /* Keep declared IDs visible while their catalog source is unavailable. */ }
				const audience = extensionUiTargetsLabel(summary ? summary.uiTargets : recommendation.uiTargets);
				return {
					target: { kind: 'recommendation' as const, id: recommendation.extensionId, summary }, name: summary?.displayName ?? recommendation.extensionId,
					description: recommendation.reason.reasonText, metadata: [audience, summary?.id ?? localize({ bundle: 'ash.extensions', key: 'recommendationNotFound' }, 'Unavailable from enabled sources')].filter(Boolean).join(' · '),
				};
			})));
		}
		const emptyMessage = this.recommendations.target === ExtensionUiTarget.Agents
			? localize({ bundle: 'ash.extensions', key: 'agentRecommendationsEmpty' }, 'No recommendations for this window. Browse the marketplace to discover skills, connectors and other extensions.')
			: localize({ bundle: 'ash.extensions', key: 'contextRecommendationsEmpty' }, 'Open a file or workspace to discover extensions. Workspaces can also declare recommendations in .ash/extensions.json.');
		return { items, note: [...snapshot.diagnostics, ...(!items.length ? [emptyMessage] : [])].join('\n') };
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
		this.enableDiscovery();
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
				target: { kind: 'skill', source: skill.id.source, name: skill.id.name, sessionId }, name: skill.name, description: getSkillSummary(skill),
				metadata: [skill.metadata?.author, skill.enabled ? '' : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled')].filter(Boolean).join(' · '),
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
		@IConnectorService private readonly connectors: IConnectorService,
		@IQuickInputService quickInput: IQuickInputService,
	) {
		super(container, options, editors, contextKeys, configuration, extensions);
		this.enableDiscovery();
		this._register(marketplace.onDidChangeSources(() => this.invalidate()));
		this._register(extensions.onDidChangeInstalled(() => this.invalidate()));
		this._register(mcpManagement.onDidChange(() => this.invalidate()));
		this._register(connectors.onDidChange(() => this.invalidate()));
		const add = this._register(new Button(this.headerActionsElement, {
			...defaultButtonStyles,
			label: localize({ bundle: 'ash.extensions', key: 'addConnection' }, 'Add connection'),
			icon: Lxicon.add, iconOnly: true,
			size: 'small',
		}));
		let adding = false;
		const addLifetime = this._register(new MutableDisposable());
		this._register(add.onDidClick(() => {
			if (adding) { return; }
			adding = true;
			this.element.classList.add('extensions-action-running');
			add.enabled = false;
			const controller = new AbortController();
			addLifetime.value = toDisposable(() => controller.abort());
			void (async () => {
				const target = await addConnection(connectors, mcpManagement, quickInput, dialogs, controller.signal);
				if (controller.signal.aborted) { return; }
				await this.refresh();
				if (target && !this.isDisposed) {
					await editors.openEditor(new ExtensionsCapabilityInput(target));
					if (!this.isDisposed) { editors.focusActiveEditor(); }
				}
			})().catch(async error => {
				if (this.isDisposed) { return; }
				await this.refresh();
				if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); }
			}).finally(() => {
				addLifetime.clear();
				adding = false;
				if (!this.isDisposed) {
					add.enabled = true;
					if (mainWindow.document.activeElement === mainWindow.document.body) { add.focus(); }
					this.element.classList.remove('extensions-action-running');
				}
			});
		}));
	}

	protected async readItems(signal: AbortSignal): Promise<ExtensionsListSnapshot> {
		if (this.isDiscovering) { return readMarketplaceItems(this.marketplace, this.extensions, CustomizationMarketplaceMediaType.McpServer, this.searchQuery, signal, this.marketplaceOptions); }
		const [installedResult, statusResult, configurationResult, connectorsResult] = await Promise.allSettled([
			this.extensions.listInstalled(),
			this.mcpStatus.isAvailable ? this.mcpStatus.read() : Promise.resolve(undefined),
			this.mcpManagement.isAvailable ? this.mcpManagement.readConfiguration() : Promise.resolve(undefined),
			this.connectors.list(),
		]);
		const installed = installedResult.status === 'fulfilled' ? installedResult.value : [];
		const configured = configurationResult.status === 'fulfilled' ? configurationResult.value : undefined;
		const snapshot = statusResult.status === 'fulfilled' ? statusResult.value : undefined;
		const connectors = connectorsResult.status === 'fulfilled' ? connectorsResult.value.connectors : [];
		const linkedServers = new Set(connectors.flatMap(connector => [connector.mcpDeclarationId, ...(connector.mcpServerId ? [connector.mcpServerId] : [])]));
		// Package identity enriches backend status; installation alone says nothing about connection state.
		const items: ExtensionsListItem[] = installed.flatMap(installation => installation.capabilities.filter(capability => capability.kind === 'mcp' && !linkedServers.has(`marketplace:${installation.package.id}:mcp:${capability.id}`)).map(capability => ({
			target: { kind: 'mcp' as const, serverId: `marketplace:${installation.package.id}:mcp:${capability.id}`, installationId: installation.installationId, capabilityId: capability.reference.id },
			name: capability.id, description: `${installation.package.id} · ${installation.package.version}`, metadata: installation.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'),
		})));
		for (const connector of connectors) {
			items.push({
				target: { kind: 'connector', connectorId: connector.id },
				name: connector.displayName,
				description: connector.description,
				metadata: [describeConnectorState(connector.state, connector.enabled), connector.state.status === 'unavailable' ? connector.state.reason : ''].filter(Boolean).join(' · '),
			});
		}
		for (const server of configured?.servers ?? []) {
			if (linkedServers.has(server.id)) { continue; }
			items.push({
				target: { kind: 'mcp', serverId: server.id }, name: server.displayName,
				description: server.id,
				metadata: server.enablement === 'enabled'
					? ''
					: localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled'),
			});
		}
		for (const server of snapshot?.servers ?? []) {
			if (linkedServers.has(server.id)) { continue; }
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
				connectorsResult.status === 'rejected' ? localize({ bundle: 'ash.extensions', key: 'connectorsReadFailed' }, 'Could not load external connections: {0}', String(connectorsResult.reason)) : '',
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
