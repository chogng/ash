import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DialogSeverity, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IMarketplaceService, type MarketplaceCapabilityKind, type MarketplaceInstalledPackage, type MarketplaceOpenOptions, type MarketplacePackageDetails, type MarketplacePackageSummary } from '../../../../platform/marketplace/common/marketplaceService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import './marketplace.css';

export class MarketplaceViewPane extends ViewPane {
	private readonly mode: HTMLSelectElement;
	private readonly query: HTMLInputElement;
	private readonly capability: HTMLSelectElement;
	private readonly language: HTMLInputElement;
	private readonly list: HTMLSelectElement;
	private readonly detail: HTMLPreElement;
	private readonly status: HTMLDivElement;
	private readonly install: HTMLButtonElement;
	private readonly update: HTMLButtonElement;
	private readonly remove: HTMLButtonElement;
	private readonly manage: HTMLButtonElement;
	private packages: readonly MarketplacePackageSummary[] = [];
	private installed: readonly MarketplaceInstalledPackage[] = [];
	private selected: MarketplacePackageDetails | undefined;
	private generation = 0;
	private selectionGeneration = 0;
	private working = false;
	private loaded = false;

	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IMarketplaceService private readonly marketplace: IMarketplaceService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-marketplace');
		this.mode = h(document, 'select');
		this.mode.append(this.option('Browse', 'browse'), this.option('Installed', 'installed'));
		this.field('Package list', this.mode);
		this.query = h(document, 'input');
		this.query.type = 'search';
		this.field('Search packages', this.query);
		this.capability = h(document, 'select');
		for (const [value, label] of [['', 'All capabilities'], ['skill', 'Skills'], ['mcp', 'MCP servers'], ['connector', 'Connectors'], ['executable', 'Executables'], ['language', 'Languages'], ['theme', 'Themes'], ['localization', 'Language packs'], ['asset', 'Assets']]) {
			this.capability.append(this.option(label, value));
		}
		this.field('Capability', this.capability);
		this.language = h(document, 'input');
		this.field('Language server for language ID', this.language);
		const actions = h(document, 'div');
		actions.className = 'marketplace-actions';
		actions.append(this.button('Search', () => this.load()), this.button('Refresh', () => this.load()), this.button('Help', () => this.showHelp()));
		this.status = h(document, 'div');
		this.status.setAttribute('role', 'status');
		this.list = h(document, 'select');
		this.list.size = 8;
		this.contentElement.append(actions, this.status);
		this.field('Packages', this.list);
		this.detail = h(document, 'pre');
		this.detail.className = 'marketplace-detail';
		this.detail.tabIndex = 0;
		this.detail.setAttribute('aria-label', 'Package details');
		const mutations = h(document, 'div');
		mutations.className = 'marketplace-actions';
		this.install = this.button('Install package', () => this.changePackage('install'));
		this.update = this.button('Update package', () => this.changePackage('update'));
		this.remove = this.button('Uninstall package', () => this.changePackage('uninstall'));
		this.manage = this.button('Show installed versions', async () => { if (this.selected) { await this.open({ mode: 'installed', query: this.selected.package.id }); } });
		mutations.append(this.install, this.manage, this.update, this.remove);
		this.contentElement.append(this.detail, mutations);
		this._register(addDisposableListener(this.mode, 'change', () => { this.language.disabled = this.mode.value === 'installed'; void this.run(() => this.load()); }));
		this._register(addDisposableListener(this.capability, 'change', () => { void this.run(() => this.load()); }));
		this._register(addDisposableListener(this.list, 'change', () => { void this.run(() => this.select()); }));
		this._register(addDisposableListener(this.contentElement, 'keydown', event => {
			if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); }
			if (event.key === 'Enter' && (event.target === this.query || event.target === this.language)) { event.preventDefault(); void this.run(() => this.load()); }
		}));
		this._register(marketplace.onDidChangeInstalled(() => { this.loaded = false; if (this.isVisible() && !this.working) { void this.run(() => this.load()); } }));
		this.applyEnabled();
	}

	public async open(options: MarketplaceOpenOptions = {}): Promise<void> {
		if (this.working) { this.focus(); return; }
		this.mode.value = options.mode ?? 'browse';
		this.query.value = options.query ?? '';
		this.capability.value = options.capabilityKind ?? '';
		this.language.value = options.languageId ?? '';
		this.language.disabled = this.mode.value === 'installed';
		this.focus();
		await this.run(() => this.load());
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && !this.loaded) { void this.run(() => this.load()); }
	}

	public override focus(): void {
		this.query.focus();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.marketplace')) {
			this.status.textContent = 'Marketplace. Use Tab to navigate, arrow keys to select a package, and Alt+F1 for help.';
		}
	}

	private async load(packageId = this.list.value): Promise<void> {
		const generation = ++this.generation;
		++this.selectionGeneration;
		this.selected = undefined;
		this.detail.textContent = '';
		this.list.replaceChildren();
		this.applyEnabled();
		this.status.textContent = 'Loading packages…';
		const isInstalled = this.mode.value === 'installed';
		const capabilityKind = this.capability.value as MarketplaceCapabilityKind | '';
		const query = this.query.value.trim();
		const result = await Promise.all([
			this.marketplace.listInstalled(),
			isInstalled ? Promise.resolve([]) : this.marketplace.search(query, { limit: 200, capabilityKind: capabilityKind || undefined, languageId: this.language.value.trim() || undefined }),
		]).catch((error: unknown) => {
			if (!this.isDisposed && generation === this.generation) { throw error; }
			return undefined;
		});
		if (!result || this.isDisposed || generation !== this.generation) { return; }
		const [installed, packages] = result;
		this.installed = installed;
		this.packages = packages;
		const entries = isInstalled
			? installed.filter(entry => (!capabilityKind || entry.capabilities.some(capability => capability.kind === capabilityKind)) && [entry.package.id, ...entry.capabilities.map(capability => capability.id)].some(value => value.toLowerCase().includes(query.toLowerCase()))).map(entry => this.option(`${entry.package.id} · ${entry.package.version}${entry.state === 'pendingRemoval' ? ' · Removal pending' : ''}`, entry.installationId))
			: packages.map(entry => this.option(`${entry.displayName} · ${entry.version} · ${entry.id}`, entry.id));
		this.list.replaceChildren(...entries);
		this.list.value = entries.some(entry => entry.value === packageId) ? packageId : entries[0]?.value ?? '';
		this.loaded = true;
		this.status.textContent = `${entries.length} packages.${!isInstalled && entries.length === 200 ? ' Narrow your search to see more specific results.' : ''}`;
		await this.select();
	}

	private async select(): Promise<void> {
		const generation = ++this.selectionGeneration;
		this.selected = undefined;
		const installed = this.selectedInstallation();
		const summary = this.packages.find(entry => entry.id === this.list.value);
		this.detail.textContent = installed ? `${installed.package.id} · ${installed.package.version}\n${installed.state === 'pendingRemoval' ? 'Removal pending: active consumers must release this package.' : 'Installed'}\n${installed.capabilities.map(capability => `${capability.kind}: ${capability.id}`).join('\n')}` : '';
		this.applyEnabled();
		if (!this.list.value) { return; }
		const details = await this.marketplace.get(installed?.package.id ?? this.list.value, this.mode.value === 'installed' ? installed?.package.version : summary?.version).catch((error: unknown) => {
			if (!this.isDisposed && generation === this.selectionGeneration) { throw error; }
			return undefined;
		});
		if (!details || this.isDisposed || generation !== this.selectionGeneration) { return; }
		this.selected = details;
		this.detail.textContent = `${details.displayName}\n${details.package.id} · ${details.package.version}\n${details.description}\n\nSource: ${details.source === 'official' ? 'Official' : 'Third party'}\nLicense: ${details.license}\n${installed ? `Installed: ${installed.package.version} (${installed.state})\n` : ''}${this.describeCapabilities(details)}`;
		this.applyEnabled();
	}

	private selectedInstallation(): MarketplaceInstalledPackage | undefined {
		return this.mode.value === 'installed' ? this.installed.find(entry => entry.installationId === this.list.value) : undefined;
	}

	private describeCapabilities(details: MarketplacePackageDetails): string {
		return details.capabilities.map(capability => `${capability.kind}: ${capability.id}${capability.permissions.length ? `\n  Permissions: ${capability.permissions.join(', ')}` : ''}`).join('\n');
	}

	private async changePackage(operation: 'install' | 'update' | 'uninstall'): Promise<void> {
		if (this.working) { return; }
		const installed = this.selectedInstallation();
		const selected = this.selected;
		let selection = this.list.value;
		this.working = true;
		this.applyEnabled();
		try {
			if (operation === 'uninstall' && installed) {
				if (!await this.dialogs.confirm({ title: 'Uninstall package', message: `Uninstall ${installed.package.id}?`, detail: `This removes all capabilities in this package:\n${installed.capabilities.map(capability => `${capability.kind}: ${capability.id}`).join('\n')}\nActive consumers may delay removal.`, primaryButton: 'Uninstall' })) { return; }
				await this.marketplace.uninstall(installed.installationId);
			} else {
				const details = operation === 'update' && installed ? await this.marketplace.get(installed.package.id) : selected;
				if (!details) { return; }
				if (!await this.dialogs.confirm({ title: operation === 'install' ? 'Install package' : 'Update package', message: `${operation === 'install' ? 'Install' : 'Update to'} ${details.displayName} ${details.package.version}?`, detail: `${details.package.id}\nSource: ${details.source}\n${this.describeCapabilities(details)}\nAll capabilities in this package are installed together.`, primaryButton: operation === 'install' ? 'Install' : 'Update' })) { return; }
				if (operation === 'update' && installed) { selection = (await this.marketplace.update(installed.installationId, details.package.version)).installationId; }
				else { await this.marketplace.install(details.package.id, details.package.version); }
			}
			if (!this.isDisposed) { await this.load(selection); }
		} finally { this.working = false; if (!this.isDisposed) { this.applyEnabled(); this.list.focus(); } }
	}

	private applyEnabled(): void {
		for (const control of this.contentElement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')) { control.disabled = this.working; }
		this.language.disabled = this.working || this.mode.value === 'installed';
		const installed = this.selectedInstallation();
		const hasInstalled = this.installed.some(entry => entry.package.id === this.selected?.package.id);
		this.install.disabled = this.working || !this.selected || hasInstalled;
		this.manage.disabled = this.working || !hasInstalled || this.mode.value === 'installed';
		this.update.disabled = this.working || !installed || installed.state === 'pendingRemoval';
		this.remove.disabled = this.working || !installed || installed.state === 'pendingRemoval';
		this.contentElement.setAttribute('aria-busy', String(this.working));
	}

	private async run(operation: () => Promise<void>): Promise<void> {
		try { await operation(); }
		catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } }
	}

	private async showHelp(): Promise<void> {
		const focus = this.element.ownerDocument.activeElement;
		await this.dialogs.showMessage({ title: 'Marketplace help', severity: DialogSeverity.Info, message: 'Open with /marketplace [query] to search, or /plugins to manage installed packages. Search by package, capability, language name, alias, or file extension. Capability filters include capabilities bundled in Plugins. A language server ID filter requires an executable route for that exact language and excludes packages that only supply syntax resources. Installed lists local packages even when the catalog is unavailable. Install, update, and uninstall affect the whole package. Use Tab and Shift+Tab to navigate and arrow keys to select a package. Escape closes this help.' });
		if (focus instanceof HTMLElement && focus.isConnected) { focus.focus(); }
	}

	private option(label: string, value: string): HTMLOptionElement {
		const option = h(this.element.ownerDocument, 'option'); option.textContent = label; option.value = value; return option;
	}
	private field(text: string, control: HTMLElement): void {
		const label = h(this.element.ownerDocument, 'label');
		const caption = h(this.element.ownerDocument, 'span');
		caption.id = generateUuid(); caption.textContent = text;
		control.setAttribute('aria-labelledby', caption.id);
		label.append(caption, control); this.contentElement.append(label);
	}
	private button(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = h(this.element.ownerDocument, 'button'); button.type = 'button'; button.textContent = label;
		this._register(addDisposableListener(button, 'click', () => { void this.run(action); })); return button;
	}
}
