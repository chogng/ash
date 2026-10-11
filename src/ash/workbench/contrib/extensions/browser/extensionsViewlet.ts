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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IExtensionManagementService, type ExtensionsCapabilityKind, type ExtensionsInstalledPackage, type ExtensionsOpenOptions, type ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ExtensionsInput } from '../common/extensionsInput.js';
import { changeExtensionPackage } from './extensionsEditor.js';
import './extensions.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.extensions', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Extensions accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize({ bundle: 'ash.extensions', key: 'verbosityTitle' }, 'Extensions accessibility help'), description: localize({ bundle: 'ash.extensions', key: 'verbosityDescription' }, 'Announce keyboard help when Extensions receives focus.') },
});

interface ExtensionListItem {
	readonly summary: ExtensionsPackageSummary;
	readonly installation?: ExtensionsInstalledPackage;
}

/** The Workbench and Sessions share catalog rendering; package authority stays in the backend. */
export class ExtensionsContent extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly query: InputBox;
	private readonly list: List<ExtensionListItem>;
	private readonly status: HTMLElement;
	private readonly installedButton: Button;
	private readonly filterButton: Button;
	private readonly rowResources = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => { void this.run(() => this.load()); }, 250));
	private options: ExtensionsOpenOptions;
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
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.options = options;
		this.domNode = h(mainWindow.document, 'section'); this.domNode.className = 'ash-extensions';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const search = h(mainWindow.document, 'div'); search.className = 'extensions-search'; this.domNode.append(search);
		this.query = this._register(new InputBox(search, { type: 'search', presentation: 'compact', placeholder: localize({ bundle: 'ash.extensions', key: 'searchPackages' }, 'Search extensions'), ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchExtensions' }, 'Search Extensions') }));
		this.query.value = options.query ?? '';
		const controls = h(mainWindow.document, 'div'); controls.className = 'extensions-controls'; this.domNode.append(controls);
		this.installedButton = this._register(new Button(controls, { label: localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'), size: 'small', checked: options.mode === 'installed', onClick: () => { this.options = { ...this.options, mode: this.options.mode === 'installed' ? 'browse' : 'installed' }; this.installedButton.checked = this.options.mode === 'installed'; void this.run(() => this.load()); } }));
		this.filterButton = this._register(new Button(controls, { label: this.filterLabel(), size: 'small', onClick: () => { void this.run(() => this.chooseFilter()); } }));
		this._register(new Button(controls, { label: localize({ bundle: 'ash.extensions', key: 'sources' }, 'Sources'), size: 'small', onClick: () => { void this.run(async () => { await this.commands.executeCommand('ash.extensions.manageSources'); await this.load(); }); } }));
		this._register(new Button(controls, { label: localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'), icon: Lxicon.refresh, iconOnly: true, size: 'small', onClick: () => { void this.run(() => this.load(true)); } }));
		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); this.domNode.append(this.status);
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; this.domNode.append(listContainer);
		this.list = this._register(new List(listContainer, {
			ariaLabel: localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'), domFocusable: true, keyboardNavigation: true, focusOnMouseMove: false,
			getId: item => item.installation?.installationId ?? item.summary.id,
			accessibilityProvider: { getAriaLabel: item => `${item.summary.displayName}, ${item.summary.version}, ${item.summary.description}` },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.summary.displayName },
			renderItem: (item, _index, row) => this.renderItem(item, row),
			onDidRemoveRow: row => this.rowResources.deleteAndDispose(row),
		}));
		this._register(this.list.onDidAccept(({ item }) => {
			void this.run(async () => {
				const editors = this.editors;
				const input = new ExtensionsInput(item.summary, item.installation?.installationId);
				await options.beforeOpenEditor?.();
				await editors.openEditor(input);
			});
		}));
		this._register(addDisposableListener(this.list.element, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.list.acceptActive(event); } }));
		this._register(this.query.onDidChange(() => this.searchScheduler.schedule()));
		this._register(this.query.onKeyDown(event => { if (event.key === 'Enter') { event.preventDefault(); this.searchScheduler.cancel(); void this.run(() => this.load()); } else if (event.key === 'ArrowDown') { event.preventDefault(); this.list.domFocus(); } }));
		this._register(extensionManagement.onDidChangeInstalled(() => { this.loaded = false; if (this.visible && !this.working) { void this.run(() => this.load()); } }));
		const scopedContext = this._register(contextKeys.createScoped(this.domNode)); scopedContext.createKey('extensionsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 100, name: `extensions-help-${generateUuid()}`, when: ContextKeyExpr.has('extensionsFocused'), getProvider: () => {
				const focused = mainWindow.document.activeElement;
				if (!this.visible || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type: AccessibleViewType.Help }, () => localize({ bundle: 'ash.extensions', key: 'accessibilityHelp' }, 'Open /extensions to browse and manage extensions. Search by package, capability, or language. Use Installed to manage local versions even while sources are offline. Use Tab to move between controls, arrow keys to select an extension, and Enter to open its details. Installation includes all capabilities in a package. Execution and permissions are managed separately. Use Sources to add or pause an Ash open source. Escape closes this help.'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
			}
		}));
	}

	public async open(options: ExtensionsOpenOptions = {}): Promise<void> {
		if (this.working) { this.focus(); return; }
		this.options = options; this.query.value = options.query ?? ''; this.searchScheduler.cancel();
		this.installedButton.checked = options.mode === 'installed'; this.filterButton.label = this.filterLabel();
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
		if (!item.installation && !this.installed.some(entry => entry.package.id === item.summary.id)) {
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
			const state = h(mainWindow.document, 'span'); state.className = 'extension-state'; state.textContent = item.installation?.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'); actions.append(state);
		}
		content.append(icon, body, actions); return content;
	}

	private async load(refresh = false): Promise<void> {
		const generation = ++this.generation;
		const isInstalled = this.options.mode === 'installed';
		const query = this.query.value.trim();
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		this.domNode.setAttribute('aria-busy', 'true');
		try {
			const installed = await this.extensionManagement.listInstalled();
			const snapshot = isInstalled ? undefined : await (refresh ? this.extensionManagement.refreshBrowse(query, { limit: 200, capabilityKind: this.options.capabilityKind, languageId: this.options.languageId }) : this.extensionManagement.browse(query, { limit: 200, capabilityKind: this.options.capabilityKind, languageId: this.options.languageId }));
			if (this.isDisposed || generation !== this.generation) { return; }
			this.installed = installed;
			this.list.items = isInstalled ? installed.filter(entry => (!this.options.capabilityKind || entry.capabilities.some(capability => capability.kind === this.options.capabilityKind)) && [entry.package.id, ...entry.capabilities.map(capability => capability.id)].some(value => value.toLowerCase().includes(query.toLowerCase()))).map(installation => ({ installation, summary: { id: installation.package.id, version: installation.package.version, displayName: installation.package.id.split('@')[0], packageType: 'installed', description: installation.capabilities.map(capability => capability.kind).join(' · ') } })) : snapshot?.packages.map(entry => ({ summary: entry.summary })) ?? [];
			this.loaded = true;
			this.status.textContent = snapshot?.unavailableSources.length ? localize({ bundle: 'ash.extensions', key: 'sourcesUnavailable' }, 'Some sources are unavailable: {0}', snapshot.unavailableSources.join(', ')) : this.list.items.length ? localize({ bundle: 'ash.extensions', key: 'results' }, '{0} extensions', this.list.items.length) : localize({ bundle: 'ash.extensions', key: 'noMatching' }, 'No matching extensions.');
			this.changed.fire();
		} catch (error) { if (!this.isDisposed && generation === this.generation) { throw error; } }
		finally { if (!this.isDisposed && generation === this.generation) { this.domNode.setAttribute('aria-busy', 'false'); } }
	}

	private filterLabel(): string {
		const label = extensionCapabilityFilters().find(item => item.kind === this.options.capabilityKind)!.label;
		return this.options.languageId ? localize({ bundle: 'ash.extensions', key: 'languageFilter' }, '{0} · {1}', label, this.options.languageId) : label;
	}

	private async chooseFilter(): Promise<void> {
		using resources = new DisposableStore();
		const picker = resources.add(this.quickInput.createQuickPick<IQuickPickItem & { readonly kind?: ExtensionsCapabilityKind; }>());
		picker.ariaLabel = localize({ bundle: 'ash.extensions', key: 'packageTypes' }, 'Extension capabilities');
		picker.items = extensionCapabilityFilters();
		const selected = await new Promise<(IQuickPickItem & { readonly kind?: ExtensionsCapabilityKind; }) | undefined>(resolve => {
			resources.add(picker.onDidAccept(item => { resolve(item); picker.hide(); })); resources.add(picker.onDidHide(() => resolve(undefined))); resources.add(picker.onDidBlur(() => picker.hide())); picker.show();
		});
		if (selected) { this.options = { ...this.options, capabilityKind: selected.kind, languageId: undefined }; this.filterButton.label = this.filterLabel(); await this.load(); }
	}
	private async run(operation: () => Promise<void>): Promise<void> { try { await operation(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } } }
}

export class ExtensionsViewPane extends ViewPane {
	private readonly content: ExtensionsContent;
	constructor(container: HTMLElement, options: IViewPaneOptions, @IInstantiationService instantiation: IInstantiationService) { super(container, options); this.setHeaderVisible(false); this.content = this._register(instantiation.createInstance(ExtensionsContent, this.contentElement, {})); }
	public async open(options?: ExtensionsOpenOptions): Promise<void> { await this.content.open(options); }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.content.setVisible(visible); }
	public override focus(): void { this.content.focus(); }
}

function extensionCapabilityFilters(): readonly (IQuickPickItem & { readonly kind?: ExtensionsCapabilityKind; })[] {
	return [
		{ label: localize({ bundle: 'ash.extensions', key: 'filterAll' }, 'All capabilities') },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterEditorExtensions' }, 'Editor extensions (Open VSX)'), kind: 'editorExtension' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterSkills' }, 'Skills'), kind: 'skill' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterMcps' }, 'MCP servers'), kind: 'mcp' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterConnectors' }, 'Connectors'), kind: 'connector' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterLanguages' }, 'Languages'), kind: 'language' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterThemes' }, 'Themes'), kind: 'theme' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterLocalization' }, 'Language packs'), kind: 'localization' },
		{ label: localize({ bundle: 'ash.extensions', key: 'filterExecutables' }, 'Providers'), kind: 'executable' },
	];
}
