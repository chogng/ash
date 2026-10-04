import './libraryPage.css';
import { addDisposableListener, getActiveElement, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAssetService, type AssetCatalog, type AssetCatalogEntry } from '../../../../platform/assets/common/assetService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { ImageResource } from '../../../../platform/media/browser/image.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';

interface LibraryItem {
	readonly store: DisposableStore;
	readonly domNode: HTMLButtonElement;
	readonly image: HTMLImageElement;
	readonly favorite: HTMLElement;
	readonly resource: MutableDisposable<ImageResource>;
	readonly entry: AssetCatalogEntry;
	loading: boolean;
	inViewport: boolean;
}

/** Catalog state belongs to assets; this widget owns only browsing and preview lifetimes. */
export class LibraryPage extends Disposable {
	public readonly domNode: HTMLElement;
	private static readonly pages = new WeakMap<HTMLElement, LibraryPage>();
	private readonly ui = this._register(new DisposableStore());
	private readonly items = this._register(new DisposableMap<string, DisposableStore>());
	private readonly itemViews = new Map<string, LibraryItem>();
	private readonly navigation = this._register(new DisposableStore());
	private readonly details = this._register(new DisposableStore());
	private readonly preview = this._register(new MutableDisposable<ImageResource>());
	private catalog: AssetCatalog = { entries: [], collections: [] };
	private category = 'all';
	private selected: string | undefined;
	private viewMode: 'grid' | 'list';
	private readonly imageQueue = new Set<LibraryItem>();
	private imageReads = 0;
	private deleteCollectionButton!: Button;
	private sort = 'recent';
	private visible = false;
	private initialized = false;
	private busy = false;
	private loadSequence = 0;
	private observer: IntersectionObserver | undefined;
	private searchDomNode!: HTMLInputElement;
	private navigationDomNode!: HTMLElement;
	private titleDomNode!: HTMLElement;
	private resultsDomNode!: HTMLElement;
	private messageDomNode!: HTMLElement;
	private detailDomNode!: HTMLElement;
	private gridButton!: Button;
	private listButton!: Button;
	private refreshButton!: Button;
	private importButton!: Button;
	private fileDomNode!: HTMLInputElement;

	constructor(
		ownerDocument: Document,
		@IAssetService private readonly assets: IAssetService,
		@ICommandService private readonly commands: ICommandService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IStorageService private readonly storage: IStorageService,
		@IHoverService private readonly hover: IHoverService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.domNode = h(ownerDocument, 'section', { className: 'ash-library', attributes: { 'aria-label': localize('library.title', 'Library') } });
		const mode = storage.get('sessions.library.viewMode', StorageScope.PROFILE);
		if (mode !== undefined && mode !== 'grid' && mode !== 'list') { throw new TypeError('Invalid Library view mode'); }
		this.viewMode = mode ?? 'grid';
		this._register(contextKeys.createScoped(this.domNode)).createKey('sessionsLibraryFocused', true);
		LibraryPage.pages.set(this.domNode, this);
		this._register(toDisposable(() => LibraryPage.pages.delete(this.domNode)));
	}

	public static getFocused(element: HTMLElement): LibraryPage | undefined {
		const root = element.closest<HTMLElement>('.ash-library');
		return root ? LibraryPage.pages.get(root) : undefined;
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) { this.releaseImages(); return; }
		if (!this.initialized) { this.initialize(); }
		void this.reload();
	}

	public focus(): void { this.searchDomNode?.focus(); }

	public layout(dimension: IDimension): void {
		this.domNode.classList.toggle('narrow', dimension.width < 760);
	}

	public getAccessibleContent(): string {
		return [this.titleDomNode.textContent, this.messageDomNode.textContent, ...this.filteredEntries().map(entry => localize('library.accessibleEntry', '{0}; {1} × {2}; {3}; source: {4}; version: {5}', entry.version.name, entry.version.width, entry.version.height, entry.favorite ? localize('library.favorite', 'Favorite') : '', entry.version.source.toString(), entry.version.versionId))].join('\n');
	}

	private initialize(): void {
		this.initialized = true;
		this.domNode.setAttribute('aria-label', localize('library.title', 'Library'));
		const document = this.domNode.ownerDocument;
		const sidebar = h(document, 'aside', { className: 'ash-library-sidebar' });
		const sidebarTitle = h(document, 'h2', {}, localize('library.title', 'Library'));
		this.navigationDomNode = h(document, 'nav', { className: 'ash-library-navigation', attributes: { 'aria-label': localize('library.categories', 'Library categories') } });
		sidebar.append(sidebarTitle, this.navigationDomNode);
		const main = h(document, 'div', { className: 'ash-library-main' });
		const heading = h(document, 'header', { className: 'ash-library-heading' });
		this.titleDomNode = h(document, 'h1');
		heading.append(this.titleDomNode);
		const tools = h(document, 'div', { className: 'ash-library-tools' });
		this.searchDomNode = h(document, 'input', { className: 'ash-library-search', properties: { type: 'search', placeholder: localize('library.search', 'Search library') }, attributes: { 'aria-label': localize('library.search', 'Search library') } });
		tools.append(this.searchDomNode);
		this.importButton = this.ui.add(new Button(tools, { label: localize('library.import', 'Import'), icon: Lxicon.add, presentation: 'primary', onClick: () => this.fileDomNode.click() }));
		this.fileDomNode = h(document, 'input', { properties: { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true } });
		tools.append(this.fileDomNode);
		const options = h(document, 'div', { className: 'ash-library-options' });
		const sort = h(document, 'select', { attributes: { 'aria-label': localize('library.sort', 'Sort by') } });
		sort.append(h(document, 'option', { properties: { value: 'recent' } }, localize('library.recent', 'Recently added')), h(document, 'option', { properties: { value: 'name' } }, localize('library.name', 'Name')));
		options.append(sort);
		this.deleteCollectionButton = this.ui.add(new Button(options, { label: localize('library.deleteCollection', 'Delete collection'), icon: Lxicon.trash, enabled: false, onClick: () => { void this.runMutation(() => this.assets.deleteCollection(this.category)); } }));
		this.refreshButton = this.ui.add(new Button(options, { label: localize('library.refresh', 'Refresh'), icon: Lxicon.refresh, iconOnly: true, onClick: () => { void this.reload(); } }));
		this.gridButton = this.ui.add(new Button(options, { label: localize('library.grid', 'Grid view'), icon: Lxicon.layout, iconOnly: true, onClick: () => this.setViewMode('grid') }));
		this.listButton = this.ui.add(new Button(options, { label: localize('library.list', 'List view'), icon: Lxicon.listUnordered, iconOnly: true, onClick: () => this.setViewMode('list') }));
		this.messageDomNode = h(document, 'div', { className: 'ash-library-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		const body = h(document, 'div', { className: 'ash-library-body' });
		this.resultsDomNode = h(document, 'div', { className: 'ash-library-results', attributes: { role: 'list', 'aria-label': localize('library.items', 'Library items') } });
		this.detailDomNode = h(document, 'aside', { className: 'ash-library-details', properties: { hidden: true }, attributes: { 'aria-label': localize('library.details', 'Asset details') } });
		body.append(this.resultsDomNode, this.detailDomNode);
		main.append(heading, tools, options, this.messageDomNode, body);
		this.domNode.append(sidebar, main);
		this.observer = new IntersectionObserver(entries => {
			for (const entry of entries) {
				const item = this.itemViews.get((entry.target as HTMLElement).dataset.versionId!);
				if (!item) { continue; }
				item.inViewport = entry.isIntersecting;
				if (entry.isIntersecting) { this.imageQueue.add(item); this.loadNextImages(); }
				else if (item.entry.version.assetId !== this.selected) { item.resource.clear(); item.image.removeAttribute('src'); }
			}
		}, { root: this.resultsDomNode, rootMargin: '100px' });
		this.ui.add(toDisposable(() => this.observer!.disconnect()));
		this.ui.add(addDisposableListener(this.searchDomNode, 'input', () => { this.selected = undefined; this.renderResults(); this.renderDetails(); }));
		this.ui.add(addDisposableListener(sort, 'change', () => { this.sort = sort.value; this.renderResults(); }));
		this.ui.add(addDisposableListener(this.fileDomNode, 'change', () => {
			const files = Array.from(this.fileDomNode.files!);
			this.fileDomNode.value = '';
			void this.runMutation(async () => {
				for (const file of files) {
					await this.assets.importImage({ assetId: generateUuid(), versionId: generateUuid(), name: file.name, source: URI.from({ scheme: 'file-upload', path: `/${file.name}` }), bytes: new Uint8Array(await file.arrayBuffer()) });
				}
				this.category = 'all'; this.searchDomNode.value = '';
			});
		}));
		this.ui.add(addDisposableListener(this.resultsDomNode, 'keydown', event => this.handleResultsKey(event)));
		this.ui.add(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape' && this.selected) { event.stopPropagation(); this.closeDetails(); }
		}));
		this.ui.add(addDisposableListener(this.domNode, 'focusin', event => {
			if (!this.domNode.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Library)) {
				status(localize('library.helpHint', 'Press Alt+F1 for Library accessibility help.'));
			}
		}));
		this.setViewMode(this.viewMode);
		this.renderNavigation(); this.renderResults();
	}

	private setViewMode(mode: 'grid' | 'list'): void {
		this.viewMode = mode;
		this.domNode.classList.toggle('list-view', mode === 'list');
		this.gridButton.checked = mode === 'grid'; this.listButton.checked = mode === 'list';
		this.gridButton.domNode.setAttribute('aria-pressed', String(mode === 'grid'));
		this.listButton.domNode.setAttribute('aria-pressed', String(mode === 'list'));
		this.storage.store('sessions.library.viewMode', mode, StorageScope.PROFILE, StorageTarget.USER);
	}

	private async reload(): Promise<void> {
		const sequence = ++this.loadSequence;
		this.resultsDomNode.setAttribute('aria-busy', 'true');
		this.refreshButton.enabled = false;
		this.messageDomNode.textContent = localize('library.loading', 'Loading library…');
		try {
			const catalog = await this.assets.getCatalog();
			if (this.isDisposed || sequence !== this.loadSequence) { return; }
			this.catalog = catalog;
			if (!['all', 'favorites', 'images', ...catalog.collections.map(collection => collection.id)].includes(this.category)) { this.category = 'all'; }
			this.renderNavigation(); this.renderResults(); this.renderDetails();
		} catch (error) {
			if (this.isDisposed || sequence !== this.loadSequence) { return; }
			this.messageDomNode.textContent = localize('library.loadFailed', 'Could not load the library. Choose Refresh to retry. {0}', String(error));
		} finally {
			if (!this.isDisposed && sequence === this.loadSequence) {
				this.resultsDomNode.setAttribute('aria-busy', 'false'); this.refreshButton.enabled = !this.busy;
			}
		}
	}

	private renderNavigation(): void {
		const focused = getActiveElement(this.domNode.ownerDocument) as HTMLElement;
		const focusedCategory = focused.closest<HTMLElement>('[data-library-category]')?.dataset.libraryCategory;
		this.navigation.clear(); this.navigationDomNode.replaceChildren();
		for (const [id, name, icon] of [
			['all', localize('library.all', 'All'), Lxicon.library],
			['favorites', localize('library.favorites', 'Favorites'), Lxicon.star],
			['images', localize('library.images', 'Images'), Lxicon.image],
		] as const) { this.appendCategory(id, name, icon); }
		const section = h(this.domNode.ownerDocument, 'div', { className: 'ash-library-collections-heading' }, localize('library.collections', 'Collections'));
		this.navigation.add(new Button(section, { label: localize('library.newCollection', 'New collection'), icon: Lxicon.add, iconOnly: true, enabled: !this.busy, onClick: () => { void this.createCollection(); } }));
		this.navigationDomNode.append(section);
		for (const collection of this.catalog.collections) { this.appendCategory(collection.id, collection.name, Lxicon.folders); }
		this.navigation.add(addDisposableListener(this.navigationDomNode, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const buttons = Array.from(this.navigationDomNode.querySelectorAll<HTMLButtonElement>('[data-library-category]'));
			const index = buttons.indexOf(getActiveElement(this.domNode.ownerDocument) as HTMLButtonElement);
			if (index < 0) { return; }
			event.preventDefault();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
			buttons[next].focus();
		}));
		if (focusedCategory) { this.navigationDomNode.querySelector<HTMLButtonElement>(`[data-library-category="${focusedCategory}"]`)?.focus(); }
	}

	private appendCategory(id: string, name: string, icon: typeof Lxicon.library): void {
		const button = this.navigation.add(new Button(this.navigationDomNode, { label: name, icon, onClick: () => {
			this.category = id; this.selected = undefined; this.renderNavigation(); this.renderResults(); this.renderDetails();
		} }));
		button.domNode.dataset.libraryCategory = id;
		button.domNode.classList.toggle('selected', id === this.category);
		if (id === this.category) { button.domNode.setAttribute('aria-current', 'page'); }
		this.navigation.add(this.hover.setupDelayedHover(button.domNode, { content: name }));
	}

	private filteredEntries(): readonly AssetCatalogEntry[] {
		const query = this.searchDomNode.value.trim().toLocaleLowerCase();
		return this.catalog.entries.filter(entry => {
			const included = this.category === 'all' || this.category === 'images' || (this.category === 'favorites' ? entry.favorite : entry.collectionIds.includes(this.category));
			return included && `${entry.version.name} ${entry.version.source.toString()}`.toLocaleLowerCase().includes(query);
		}).sort((left, right) => this.sort === 'name' ? left.version.name.localeCompare(right.version.name) : right.addedAt - left.addedAt);
	}

	private renderResults(): void {
		const title = this.category === 'all' ? localize('library.all', 'All') : this.category === 'favorites' ? localize('library.favorites', 'Favorites') : this.category === 'images' ? localize('library.images', 'Images') : this.catalog.collections.find(collection => collection.id === this.category)!.name;
		this.titleDomNode.textContent = title;
		this.deleteCollectionButton.domNode.hidden = !this.catalog.collections.some(collection => collection.id === this.category);
		this.deleteCollectionButton.enabled = !this.busy;
		const entries = this.filteredEntries();
		const shown = new Set(entries.map(entry => entry.version.versionId));
		for (const [id, item] of this.itemViews) {
			if (!shown.has(id)) { this.observer!.unobserve(item.domNode); this.items.deleteAndDispose(id); item.domNode.remove(); this.itemViews.delete(id); }
		}
		for (const entry of entries) {
			let item = this.itemViews.get(entry.version.versionId);
			if (!item) {
				const store = new DisposableStore(); this.items.set(entry.version.versionId, store);
				const resource = store.add(new MutableDisposable<ImageResource>());
				const button = h(this.domNode.ownerDocument, 'button', { className: 'ash-library-item', properties: { type: 'button' }, attributes: { 'aria-label': entry.version.name } });
				button.dataset.versionId = entry.version.versionId;
				const image = h(this.domNode.ownerDocument, 'img', { className: 'ash-library-item-image', properties: { alt: '' } });
				const caption = h(this.domNode.ownerDocument, 'span', { className: 'ash-library-item-caption' });
				const favorite = h(this.domNode.ownerDocument, 'span', { className: 'ash-library-item-favorite', attributes: { 'aria-hidden': 'true' } }, '★');
				caption.append(h(this.domNode.ownerDocument, 'span', { className: 'ash-library-item-name' }, entry.version.name), h(this.domNode.ownerDocument, 'span', { className: 'ash-library-item-meta' }, `${entry.version.width} × ${entry.version.height} · ${entry.version.mediaType.split('/')[1].toUpperCase()}`), favorite);
				button.append(image, caption);
				store.add(this.hover.setupDelayedHover(button, { content: entry.version.name }));
				store.add(addDisposableListener(button, 'click', () => { this.selected = entry.version.assetId; this.renderSelection(); this.renderDetails(); }));
				const row = h(this.domNode.ownerDocument, 'div', { className: 'ash-library-item-row', attributes: { role: 'listitem' } }, button);
				this.resultsDomNode.append(row);
				store.add(toDisposable(() => row.remove()));
				item = { store, domNode: button, image, favorite, resource, entry, loading: false, inViewport: false };
				this.itemViews.set(entry.version.versionId, item);
				this.observer!.observe(button);
			}
			item.favorite.hidden = !entry.favorite;
			this.resultsDomNode.append(item.domNode.parentElement!);
			this.observer!.unobserve(item.domNode); this.observer!.observe(item.domNode);
		}
		this.renderSelection();
		this.messageDomNode.textContent = entries.length ? localize('library.count', '{0} items', entries.length) : this.searchDomNode.value ? localize('library.noResults', 'No matching items. Try another search.') : localize('library.empty', 'No items here yet. Import images to build your library.');
	}

	private renderSelection(): void {
		for (const item of this.itemViews.values()) {
			const selected = item.entry.version.assetId === this.selected;
			item.domNode.classList.toggle('selected', selected);
			item.domNode.setAttribute('aria-pressed', String(selected));
		}
	}

	private loadNextImages(): void {
		while (this.visible && !this.isDisposed && this.imageReads < 3 && this.imageQueue.size > 0) {
			const item = this.imageQueue.values().next().value!; this.imageQueue.delete(item);
			if (item.store.isDisposed || !item.inViewport || item.loading || item.resource.value) { continue; }
			this.imageReads++;
			void this.loadImage(item).finally(() => { this.imageReads--; this.loadNextImages(); });
		}
	}

	private async loadImage(item: LibraryItem): Promise<void> {
		if (item.loading || item.resource.value || !this.visible) { return; }
		item.loading = true;
		try {
			const bytes = await this.assets.readVersion(item.entry.version);
			if (item.store.isDisposed || !this.visible || !item.inViewport) { return; }
			const resource = new ImageResource(bytes, item.entry.version.mediaType);
			item.resource.value = resource; item.image.src = resource.url;
		} catch (error) {
			if (!item.store.isDisposed) { item.image.alt = localize('library.previewFailed', 'Could not load preview: {0}', String(error)); }
		} finally { item.loading = false; }
	}

	private renderDetails(): void {
		this.details.clear(); this.preview.clear(); this.detailDomNode.replaceChildren();
		const entry = this.catalog.entries.find(entry => entry.version.assetId === this.selected);
		this.detailDomNode.hidden = !entry;
		if (!entry) { return; }
		const heading = h(this.domNode.ownerDocument, 'div', { className: 'ash-library-detail-heading' });
		heading.append(h(this.domNode.ownerDocument, 'h2', {}, entry.version.name));
		this.details.add(new Button(heading, { label: localize('library.closeDetails', 'Close details'), icon: Lxicon.close, iconOnly: true, onClick: () => this.closeDetails() }));
		const image = h(this.domNode.ownerDocument, 'img', { className: 'ash-library-detail-image', properties: { alt: entry.version.name } });
		this.detailDomNode.append(heading, image, h(this.domNode.ownerDocument, 'p', {}, `${entry.version.width} × ${entry.version.height} · ${Math.ceil(entry.version.size / 1024)} KB`));
		for (const [label, value] of [[localize('library.source', 'Source'), entry.version.source.toString()], [localize('library.version', 'Version'), entry.version.versionId]] as const) {
			this.detailDomNode.append(h(this.domNode.ownerDocument, 'h3', {}, label), h(this.domNode.ownerDocument, 'p', { className: 'ash-library-detail-value' }, value));
		}
		const favoriteButton = this.details.add(new Button(this.detailDomNode, { label: entry.favorite ? localize('library.unfavorite', 'Remove from favorites') : localize('library.addFavorite', 'Add to favorites'), icon: entry.favorite ? Lxicon.starFilled : Lxicon.star, enabled: !this.busy, onClick: () => { void this.runMutation(() => this.assets.updateEntry(entry.version.assetId, !entry.favorite, entry.collectionIds)); } }));
		favoriteButton.domNode.dataset.libraryControl = 'favorite';
		this.details.add(new Button(this.detailDomNode, { label: localize('library.addToChat', 'Add to conversation'), icon: Lxicon.chat4, enabled: !this.busy, onClick: () => { void this.runMutation(() => this.commands.executeCommand('sessions.library.addToChat', entry.version)); } }));
		this.details.add(new Button(this.detailDomNode, { label: localize('library.useInDesign', 'Use in Design'), icon: Lxicon.image, enabled: !this.busy, onClick: () => { void this.runMutation(() => this.commands.executeCommand('sessions.library.useInDesign', entry.version)); } }));
		this.detailDomNode.append(h(this.domNode.ownerDocument, 'h3', {}, localize('library.collections', 'Collections')));
		for (const collection of this.catalog.collections) {
			const label = h(this.domNode.ownerDocument, 'label', { className: 'ash-library-membership' });
			const checkbox = h(this.domNode.ownerDocument, 'input', { properties: { type: 'checkbox', checked: entry.collectionIds.includes(collection.id), disabled: this.busy } });
			checkbox.dataset.libraryControl = collection.id;
			label.append(checkbox, h(this.domNode.ownerDocument, 'span', {}, collection.name)); this.detailDomNode.append(label);
			this.details.add(addDisposableListener(checkbox, 'change', () => { void this.runMutation(() => this.assets.updateEntry(entry.version.assetId, entry.favorite, checkbox.checked ? [...entry.collectionIds, collection.id] : entry.collectionIds.filter(id => id !== collection.id))); }));
		}
		this.details.add(new Button(this.detailDomNode, { label: localize('library.newCollection', 'New collection'), icon: Lxicon.add, enabled: !this.busy, onClick: () => { void this.createCollection(); } }));
		if (!this.visible) { return; }
		const selection = this.selected;
		void this.assets.readVersion(entry.version).then(bytes => {
			// Selection and DOM identity prevent a completed read from populating another asset's pane.
			if (this.isDisposed || !this.visible || this.selected !== selection || !image.isConnected) { return; }
			const resource = new ImageResource(bytes, entry.version.mediaType); this.preview.value = resource; image.src = resource.url;
		}).catch(error => { if (image.isConnected) { image.alt = localize('library.previewFailed', 'Could not load preview: {0}', String(error)); } });
	}

	private closeDetails(): void {
		const item = [...this.itemViews.values()].find(item => item.entry.version.assetId === this.selected);
		this.selected = undefined; this.renderSelection(); this.renderDetails(); item?.domNode.focus();
	}

	private async createCollection(): Promise<void> {
		const name = await this.quickInput.input({ title: localize('library.newCollection', 'New collection'), placeHolder: localize('library.collectionName', 'Collection name'), validateInput: async value => value.trim().length === 0 || new TextEncoder().encode(value.trim()).length > 512 ? localize('library.invalidCollection', 'Enter a collection name of at most 512 bytes.') : undefined });
		if (name === undefined || this.isDisposed) { return; }
		await this.runMutation(() => this.assets.createCollection({ id: generateUuid(), name: name.trim() }));
	}

	private async runMutation(operation: () => Promise<void>): Promise<void> {
		if (this.busy) { return; }
		const focusKey = (getActiveElement(this.domNode.ownerDocument) as HTMLElement).dataset.libraryControl;
		this.busy = true; this.importButton.enabled = false; this.refreshButton.enabled = false;
		this.renderNavigation(); this.renderDetails();
		try { await operation(); await this.reload(); }
		catch (error) {
			if (!this.isDisposed) { await this.reload(); this.messageDomNode.textContent = localize('library.operationFailed', 'Could not update the library. {0}', String(error)); }
		}
		finally {
			if (!this.isDisposed) { this.busy = false; this.importButton.enabled = true; this.refreshButton.enabled = true; this.renderNavigation(); this.renderDetails();
				if (focusKey) { this.detailDomNode.querySelector<HTMLElement>(`[data-library-control="${focusKey}"]`)?.focus(); }
			}
		}
	}

	private releaseImages(): void {
		this.preview.clear(); this.imageQueue.clear();
		for (const item of this.itemViews.values()) { item.resource.clear(); item.image.removeAttribute('src'); }
	}

	private handleResultsKey(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
		const buttons = Array.from(this.resultsDomNode.querySelectorAll<HTMLButtonElement>('.ash-library-item'));
		const index = buttons.indexOf(getActiveElement(this.domNode.ownerDocument) as HTMLButtonElement);
		if (index < 0) { return; }
		const columns = this.viewMode === 'list' ? 1 : getComputedStyle(this.resultsDomNode).gridTemplateColumns.split(' ').length;
		let next = index;
		if (event.key === 'Home') { next = 0; }
		else if (event.key === 'End') { next = buttons.length - 1; }
		else { next += event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowRight' ? 1 : -1; }
		event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, next))].focus();
	}
}

export const LIBRARY_EDITOR_RESOURCE = URI.from({ scheme: 'ash-library', path: '/library' });

/** The Editor Part owns mounting and visibility; browsing state stays in the widget. */
export class LibraryEditorPane extends Disposable implements IEditorPane {
	public static readonly ID = 'sessions.library.editor';
	public readonly id = LibraryEditorPane.ID;
	private library!: LibraryPage;

	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { super(); }

	public create(parent: HTMLElement): void {
		this.library = this._register(this.instantiation.createInstance(LibraryPage, parent.ownerDocument));
		parent.append(this.library.domNode);
		this._register(toDisposable(() => this.library.domNode.remove()));
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (input.resource.toString() !== LIBRARY_EDITOR_RESOURCE.toString()) { throw new TypeError('Invalid Library editor input'); }
		signal.throwIfAborted();
	}
	public clearInput(): void { this.library.setVisible(false); }
	public setVisible(visibility: EditorPaneVisibility): void { this.library.setVisible(visibility === EditorPaneVisibility.Visible); }
	public layout(dimension: IDimension): void { this.library.layout(dimension); }
	public focus(): void { this.library.focus(); }
}
