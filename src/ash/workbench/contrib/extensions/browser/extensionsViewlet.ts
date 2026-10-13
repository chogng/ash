import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { appendLabelIcon } from '../../../../base/browser/ui/iconlabel/iconLabels.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, type ExtensionsInstalledPackage, type ExtensionsOpenOptions, type ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ExtensionsInput, ExtensionsInputSource } from '../common/extensionsInput.js';
import { changeExtensionPackage } from './extensionsEditor.js';
import { IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import { changeExtensionEnablement, extensionEnablementLabel } from './extensionsActions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, type WorkbenchViewRegistry } from '../../../common/views.js';
import { SkillsViewPane, McpServersViewPane, RecommendedExtensionsView } from './extensionsViews.js';
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
	private readonly query: InputBox;
	private readonly list: List<ExtensionListItem>;
	private readonly status: HTMLElement;
	private readonly rowResources = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => { void this.run(() => this.load()); }, 250));
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
		const search = h(mainWindow.document, 'div'); search.className = 'extensions-search'; this.domNode.append(search);
		this.query = this._register(new InputBox(search, { type: 'search', presentation: 'compact', placeholder: this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'searchPlugins' }, 'Search plugins') : localize({ bundle: 'ash.extensions', key: 'searchPackages' }, 'Search extensions'), ariaLabel: this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'searchPlugins' }, 'Search plugins') : localize({ bundle: 'ash.extensions', key: 'searchExtensions' }, 'Search Extensions') }));
		this.query.value = options.query ?? '';
		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); this.domNode.append(this.status);
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; this.domNode.append(listContainer);
		this.list = this._register(new List(listContainer, {
			ariaLabel: this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'pluginsPane' }, 'Plugins') : localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'), domFocusable: true, keyboardNavigation: true, focusOnMouseMove: false,
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
		this._register(this.query.onDidChange(() => this.searchScheduler.schedule()));
		this._register(this.query.onKeyDown(event => { if (event.key === 'Enter') { event.preventDefault(); this.searchScheduler.cancel(); void this.run(() => this.load()); } else if (event.key === 'ArrowDown') { event.preventDefault(); this.list.domFocus(); } }));
		this._register(extensionManagement.onDidChangeInstalled(() => { this.loaded = false; if (this.visible && !this.working) { void this.run(() => this.load()); } }));
		const refreshInstalled = () => { this.loaded = false; if (this.visible && !this.working) { void this.run(() => this.load()); } };
		this._register(this.enablement.onDidChangeEnablement(refreshInstalled));
		this._register(this.plugins.onDidChange(refreshInstalled));
		const scopedContext = this._register(contextKeys.createScoped(this.domNode)); scopedContext.createKey('extensionsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 100, name: `extensions-help-${generateUuid()}`, when: ContextKeyExpr.has('extensionsFocused'), getProvider: () => {
				const focused = mainWindow.document.activeElement;
				if (!this.visible || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type: AccessibleViewType.Help }, () => localize({ bundle: 'ash.extensions', key: 'accessibilityHelp' }, 'Extensions, Plugins, Skills, MCP Servers and Recommended are collapsible panes. Use Left and Right on headers to collapse or expand them. Open /extensions to browse and manage extensions. Use Tab to move between controls, arrow keys to select an extension, and Enter to open its details. Enable or Disable in a row or its details controls the whole editor extension, including scripts, themes, syntax and snippets. Language packs are managed through the display language setting. Execution authorization and permissions are reviewed separately in details. Escape closes this help. Run Install plugin from Git repository in the Command Palette to choose a repository revision and package directory. Press Escape during installation to cancel.'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
			}
		}));
	}

	public async open(options: ExtensionsOpenOptions = {}): Promise<void> {
		if (this.working) { this.focus(); return; }
		this.options = options; this.query.value = options.query ?? ''; this.searchScheduler.cancel();
		this.focus(); await this.run(() => this.load());
	}
	public setVisible(visible: boolean): void { this.visible = visible; if (!visible) { ++this.generation; this.searchScheduler.cancel(); } else if (!this.loaded) { void this.run(() => this.load()); } }
	public focus(): void { this.query.focus(); if (this.configuration.getValue<boolean>('accessibility.verbosity.extensions')) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.'); } }

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
			const install = resources.add(new Button(actions, { label: localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'), presentation: 'primary', size: 'small', enabled: !this.working }));
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
				const toggle = resources.add(new Button(actions, { label: extensionEnablementLabel(item.enabled), size: 'small', enabled: !this.working && item.installation?.state !== 'pendingRemoval' }));
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

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const query = this.query.value.trim();
		const isInstalled = this.options.mode === 'installed' || this.options.mode === undefined && !query && !this.options.capabilityKind && !this.options.languageId;
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		this.domNode.setAttribute('aria-busy', 'true');
		try {
			const installed = this.options.mode === 'builtIn' ? [] : await this.extensionManagement.listInstalled();
			const policies = this.options.mode === 'builtIn' ? { extensions: [] } : await this.extensionManagement.listEditorExtensions();
			let items: ExtensionListItem[];
			const builtInItems: ExtensionListItem[] = [];
			if (!this.isPluginsPane && (this.options.mode === 'builtIn' || isInstalled)) {
				const catalog = await this.extensionCatalog.list('cached', { includeDisabled: true });
				const providers = await this.extensionManagement.listBuiltInProviders().catch(() => undefined);
				const disabled = new Set(this.enablement.getDisabledExtensions().map(value => value.id));
				builtInItems.push(...catalog.extensions.filter(extension => extension.sourceKind === 'builtIn' && (!this.options.capabilityKind || this.options.capabilityKind === 'editorExtension' || this.options.capabilityKind === 'localization' && JSON.parse(extension.manifestJson).contributes?.localizations?.length)).map(extension => {
					const manifest = JSON.parse(extension.manifestJson);
					const provider = providers?.providers.find(value => value.id === extension.id);
					const isProvider = manifest.ashRuntime?.kind === 'rust' && !manifest.browser;
					return {
						source: ExtensionsInputSource.BuiltIn, enabled: isProvider ? provider?.enabled : !disabled.has(extension.id.toLowerCase()), canChangeEnablement: isProvider ? !!provider : !manifest.contributes?.localizations?.length,
						summary: { id: extension.id, version: extension.version, packageType: 'editorExtension', displayName: manifest.displayName?.startsWith('%') ? extension.id : manifest.displayName ?? extension.displayName, description: typeof manifest.description === 'string' && !manifest.description.startsWith('%') ? manifest.description : '' }
					};
				}));
			}
			if (this.options.mode === 'builtIn') {
				items = builtInItems;
			} else if (isInstalled) {
				items = installed.filter(entry => (!this.isPluginsPane || !entry.capabilities.some(capability => capability.kind === 'editorExtension')) && (!this.options.capabilityKind || entry.capabilities.some(capability => capability.kind === this.options.capabilityKind))).map(installation => {
					const policy = policies.extensions.find(value => value.installationId === installation.installationId);
					return { installation, enabled: policy?.enabled, canChangeEnablement: !!policy, summary: { id: installation.package.id, version: installation.package.version, displayName: installation.package.id.split('@')[0], packageType: 'installed', description: installation.capabilities.map(capability => capability.kind).join(' · ') } };
				});
				items.push(...builtInItems);
				if (this.isPluginsPane || !this.options.capabilityKind || this.options.capabilityKind === 'editorExtension') {
					const catalog = await this.plugins.list();
					items.push(...catalog.packages.filter(plugin => this.isPluginsPane || plugin.hasEditorExtensions).map(plugin => ({ source: ExtensionsInputSource.Local, enabled: plugin.enabled, canChangeEnablement: plugin.enabled || !plugin.revoked, summary: { id: plugin.id, version: plugin.version, packageType: 'editorExtension', displayName: plugin.displayName, description: this.isPluginsPane ? localize({ bundle: 'ash.extensions', key: 'localPlugin' }, 'Local plugin') : localize({ bundle: 'ash.extensions', key: 'localExtension' }, 'Local extension') } })));
				}
			} else {
				const options = { limit: 200, packageType: this.isPluginsPane ? 'plugin' : undefined, capabilityKind: this.options.capabilityKind, languageId: this.options.languageId };
				const snapshot = await this.extensionManagement.browse(query, options);
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

	private async run(operation: () => Promise<void>): Promise<void> { try { await operation(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } } }
}

export class ExtensionsViewPane extends ViewPane {
	private readonly content: ExtensionsContent;
	constructor(container: HTMLElement, options: IViewPaneOptions, @IInstantiationService instantiation: IInstantiationService) { super(container, { ...options, minimumBodySize: 160 }); this.content = this._register(instantiation.createInstance(ExtensionsContent, this.contentElement, options.id === 'ash.extensions.plugins' ? { view: 'plugins', mode: 'installed' } : {})); this._register(this.onDidChangeBodyVisibility(visible => this.content.setVisible(visible))); }
	public async open(options?: ExtensionsOpenOptions): Promise<void> { this.setExpanded(true); await this.content.open(this.id === 'ash.extensions.plugins' ? { ...options, view: 'plugins', mode: options?.mode === 'builtIn' ? 'installed' : options?.mode ?? 'installed' } : options); }
	public override focus(): void { this.content.focus(); }
}

/** Both product hosts use the same capability panes with their own view registry and location. */
export function registerExtensionsViewContainer(registry: WorkbenchViewRegistry, location = ViewContainerLocation.Sidebar): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registry.registerViewContainer({ id: 'ash.extensions', title: localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'), location, icon: Lxicon.extensions, order: 8 }));
	registrations.add(registry.registerViews('ash.extensions', [
		{ id: 'ash.extensions.view', title: localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'), canToggleVisibility: false, order: 0, ctorDescriptor: new SyncDescriptor(ExtensionsViewPane) },
		{ id: 'ash.extensions.plugins', title: localize({ bundle: 'ash.extensions', key: 'pluginsPane' }, 'Plugins'), canToggleVisibility: false, order: 1, collapsed: true, ctorDescriptor: new SyncDescriptor(ExtensionsViewPane) },
		{ id: 'ash.extensions.skills', title: localize({ bundle: 'ash.extensions', key: 'filterSkills' }, 'Skills'), canToggleVisibility: false, order: 2, collapsed: true, ctorDescriptor: new SyncDescriptor(SkillsViewPane) },
		{ id: 'ash.extensions.mcp', title: localize({ bundle: 'ash.extensions', key: 'mcpPane' }, 'MCP Servers'), canToggleVisibility: false, order: 3, collapsed: true, ctorDescriptor: new SyncDescriptor(McpServersViewPane) },
		{ id: 'ash.extensions.recommended', title: localize({ bundle: 'ash.extensions', key: 'recommendedPane' }, 'Recommended'), canToggleVisibility: false, order: 4, collapsed: true, ctorDescriptor: new SyncDescriptor(RecommendedExtensionsView) },
	]));
	return registrations;
}
