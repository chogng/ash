import './library.css';
import { addDisposableListener, getActiveElement, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAssetService, type AssetCatalogEntry } from '../../../../platform/assets/common/assetService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { ImageResource } from '../../../../platform/media/browser/image.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import { ILibraryService, type LibraryState } from './libraryService.js';

interface LibraryItem {
	readonly store: DisposableStore;
	readonly domNode: HTMLButtonElement;
	readonly image: HTMLImageElement;
	readonly favorite: HTMLElement;
	readonly resource: MutableDisposable<ImageResource>;
	entry: AssetCatalogEntry;
	loading: boolean;
	inViewport: boolean;
}

/** Owns only the central browsing surface; side Views have independent DOM and visibility lifetimes. */
export class LibraryEditorPane extends Disposable implements IEditorPane {
	public readonly id = 'sessions.editor.library';
	public domNode!: HTMLElement;
	private readonly ui = this._register(new DisposableStore());
	private readonly items = this._register(new DisposableMap<string, DisposableStore>());
	private readonly itemViews = new Map<string, LibraryItem>();
	private readonly imageQueue = new Set<LibraryItem>();
	private imageReads = 0;
	private visible = false;
	private observer!: IntersectionObserver;
	private searchDomNode!: HTMLInputElement;
	private titleDomNode!: HTMLElement;
	private resultsDomNode!: HTMLElement;
	private messageDomNode!: HTMLElement;
	private gridButton!: Button;
	private listButton!: Button;
	private refreshButton!: Button;
	private importButton!: Button;
	private deleteCollectionButton!: Button;
	private fileDomNode!: HTMLInputElement;

	constructor(
		@ILibraryService private readonly library: ILibraryService,
		@IAssetService private readonly assets: IAssetService,
		@IHoverService private readonly hover: IHoverService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	public create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'section', { className: 'ash-library', attributes: { 'aria-label': localize('library.title', 'Library') } });
		parent.append(this.domNode);
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('sessionsLibraryFocused', true);
		this.initialize();
		this._register(this.library.onDidRequestItemFocus(assetId => [...this.itemViews.values()].find(item => item.entry.version.assetId === assetId)?.domNode.focus()));
		let rendered: LibraryState | undefined;
		this._register(autorun(reader => {
			const state = this.library.state.read(reader);
			this.searchDomNode.value = state.query;
			this.domNode.classList.toggle('list-view', state.viewMode === 'list');
			this.gridButton.checked = state.viewMode === 'grid';
			this.listButton.checked = state.viewMode === 'list';
			this.gridButton.domNode.setAttribute('aria-pressed', String(state.viewMode === 'grid'));
			this.listButton.domNode.setAttribute('aria-pressed', String(state.viewMode === 'list'));
			this.importButton.enabled = !state.busy;
			this.refreshButton.enabled = !state.busy && !state.loading;
			this.resultsDomNode.setAttribute('aria-busy', String(state.loading));
			this.deleteCollectionButton.enabled = !state.busy;
			// Selection changes must not move the focused item out of its current DOM position.
			if (!rendered || rendered.catalog !== state.catalog || rendered.category !== state.category || rendered.query !== state.query || rendered.sort !== state.sort) {
				this.renderResults();
			} else { this.renderSelection(); }
			rendered = state;
			const count = this.library.getEntries().length;
			this.messageDomNode.textContent = count ? localize('library.count', '{0} items', count) : state.query ? localize('library.noResults', 'No matching items. Try another search.') : localize('library.empty', 'No items here yet. Import images to build your library.');
			if (state.loading) { this.messageDomNode.textContent = localize('library.loading', 'Loading library…'); }
			else if (state.message) { this.messageDomNode.textContent = state.message; }
		}));
	}

	public async setInput(_input: EditorInput, _signal: AbortSignal): Promise<void> { }
	public clearInput(): void { }
	public setVisible(visibility: EditorPaneVisibility): void {
		this.visible = visibility === EditorPaneVisibility.Visible;
		if (this.visible) { void this.library.reload(); }
		else { this.releaseImages(); }
	}
	public layout(dimension: IDimension): void {
		this.domNode.classList.toggle('narrow', dimension.width < 760);
		this.domNode.classList.toggle('compact', dimension.width < 320);
	}
	public focus(): void { this.searchDomNode.focus(); }

	private initialize(): void {
		this.domNode.setAttribute('aria-label', localize('library.title', 'Library'));
		const document = this.domNode.ownerDocument;
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
		this.deleteCollectionButton = this.ui.add(new Button(options, { label: localize('library.deleteCollection', 'Delete collection'), icon: Lxicon.trash, enabled: false, onClick: () => { void this.library.runMutation(() => this.assets.deleteCollection(this.library.state.get().category)); } }));
		this.refreshButton = this.ui.add(new Button(options, { label: localize('library.refresh', 'Refresh'), icon: Lxicon.refresh, iconOnly: true, onClick: () => { void this.library.reload(); } }));
		this.gridButton = this.ui.add(new Button(options, { label: localize('library.grid', 'Grid view'), icon: Lxicon.layout, iconOnly: true, onClick: () => this.library.setViewMode('grid') }));
		this.listButton = this.ui.add(new Button(options, { label: localize('library.list', 'List view'), icon: Lxicon.listUnordered, iconOnly: true, onClick: () => this.library.setViewMode('list') }));
		this.messageDomNode = h(document, 'div', { className: 'ash-library-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		const body = h(document, 'div', { className: 'ash-library-body' });
		this.resultsDomNode = h(document, 'div', { className: 'ash-library-results', attributes: { role: 'list', 'aria-label': localize('library.items', 'Library items') } });
		body.append(this.resultsDomNode);
		main.append(heading, tools, options, this.messageDomNode, body);
		this.domNode.append(main);
		this.observer = new IntersectionObserver(entries => {
			for (const entry of entries) {
				const item = this.itemViews.get((entry.target as HTMLElement).dataset.versionId!);
				if (!item) { continue; }
				item.inViewport = entry.isIntersecting;
				if (entry.isIntersecting) { this.imageQueue.add(item); this.loadNextImages(); }
				else if (item.entry.version.assetId !== this.library.state.get().selected) { item.resource.clear(); item.image.removeAttribute('src'); }
			}
		}, { root: this.resultsDomNode, rootMargin: '100px' });
		this.ui.add(toDisposable(() => this.observer!.disconnect()));
		this.ui.add(addDisposableListener(this.searchDomNode, 'input', () => { this.library.setQuery(this.searchDomNode.value); }));
		this.ui.add(addDisposableListener(sort, 'change', () => { this.library.setSort(sort.value as 'recent' | 'name'); }));
		this.ui.add(addDisposableListener(this.fileDomNode, 'change', () => {
			const files = Array.from(this.fileDomNode.files!);
			this.fileDomNode.value = '';
			void this.library.importFiles(files);
		}));
		this.ui.add(addDisposableListener(this.resultsDomNode, 'keydown', event => this.handleResultsKey(event)));
		this.ui.add(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape' && this.library.state.get().selected) { event.stopPropagation(); this.library.closeDetails(); }
		}));
		this.ui.add(addDisposableListener(this.domNode, 'focusin', event => {
			if (!this.domNode.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Library)) {
				status(localize('library.helpHint', 'Press Alt+F1 for Library accessibility help.'));
			}
		}));
	}

	private renderResults(): void {
		const title = this.library.getCategoryTitle();
		this.titleDomNode.textContent = title;
		this.deleteCollectionButton.domNode.hidden = !this.library.state.get().catalog.collections.some(collection => collection.id === this.library.state.get().category);
		this.deleteCollectionButton.enabled = !this.library.state.get().busy;
		const entries = this.library.getEntries();
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
				store.add(addDisposableListener(button, 'click', () => { this.library.selectAsset(entry.version.assetId); }));
				const row = h(this.domNode.ownerDocument, 'div', { className: 'ash-library-item-row', attributes: { role: 'listitem' } }, button);
				this.resultsDomNode.append(row);
				store.add(toDisposable(() => row.remove()));
				item = { store, domNode: button, image, favorite, resource, entry, loading: false, inViewport: false };
				this.itemViews.set(entry.version.versionId, item);
				this.observer!.observe(button);
			}
			item.entry = entry;
			item.favorite.hidden = !entry.favorite;
			this.resultsDomNode.append(item.domNode.parentElement!);
			this.observer!.unobserve(item.domNode); this.observer!.observe(item.domNode);
		}
		this.renderSelection();
	}

	private renderSelection(): void {
		for (const item of this.itemViews.values()) {
			const selected = item.entry.version.assetId === this.library.state.get().selected;
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

	private releaseImages(): void {
		this.imageQueue.clear();
		for (const item of this.itemViews.values()) { item.resource.clear(); item.image.removeAttribute('src'); }
	}

	private handleResultsKey(event: KeyboardEvent): void {
		if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
		const buttons = Array.from(this.resultsDomNode.querySelectorAll<HTMLButtonElement>('.ash-library-item'));
		const index = buttons.indexOf(getActiveElement(this.domNode.ownerDocument) as HTMLButtonElement);
		if (index < 0) { return; }
		const columns = this.library.state.get().viewMode === 'list' ? 1 : getComputedStyle(this.resultsDomNode).gridTemplateColumns.split(' ').length;
		let next = index;
		if (event.key === 'Home') { next = 0; }
		else if (event.key === 'End') { next = buttons.length - 1; }
		else { next += event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowRight' ? 1 : -1; }
		event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, next))].focus();
	}
}
