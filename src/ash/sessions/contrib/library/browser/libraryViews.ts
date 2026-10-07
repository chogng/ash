import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAssetService } from '../../../../platform/assets/common/assetService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { ImageResource } from '../../../../platform/media/browser/image.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ILibraryService, type LibraryState } from './libraryService.js';
import './library.css';

export class LibraryNavigationView extends ViewPane {
	private readonly navigation = this._register(new DisposableStore());
	private readonly navigationDomNode: HTMLElement;
	constructor(parent: HTMLElement, options: IViewPaneOptions,
		@ILibraryService private readonly library: ILibraryService,
		@IHoverService private readonly hover: IHoverService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(parent, options);
		this.contentElement.classList.add('ash-library-sidebar', 'ash-library-surface');
		this.contentElement.append(h(parent.ownerDocument, 'h2', {}, localize('library.title', 'Library')));
		this.navigationDomNode = h(parent.ownerDocument, 'nav', { className: 'ash-library-navigation', attributes: { 'aria-label': localize('library.categories', 'Library categories') } });
		this.contentElement.append(this.navigationDomNode);
		this._register(contextKeys.createScoped(this.contentElement)).createKey('sessionsLibraryFocused', true);
		this._register(addDisposableListener(this.contentElement, 'focusin', event => {
			if (!this.contentElement.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.Library)) { status(localize('library.helpHint', 'Press Alt+F1 for Library accessibility help.')); }
		}));
		let rendered: LibraryState | undefined;
		this._register(autorun(reader => {
			const state = this.library.state.read(reader);
			if (!rendered || rendered.catalog !== state.catalog || rendered.category !== state.category || rendered.busy !== state.busy) { this.renderNavigation(); }
			rendered = state;
		}));
	}
	public focus(): void { this.navigationDomNode.querySelector<HTMLButtonElement>('[data-library-category]')!.focus(); }
	private renderNavigation(): void {
		const focused = getActiveElement(this.contentElement.ownerDocument) as HTMLElement;
		const focusedCategory = this.navigationDomNode.contains(focused) ? focused.closest<HTMLElement>('[data-library-category]')?.dataset.libraryCategory : undefined;
		this.navigation.clear(); this.navigationDomNode.replaceChildren();
		for (const [id, name, icon] of [
			['all', localize('library.all', 'All'), Lxicon.library],
			['favorites', localize('library.favorites', 'Favorites'), Lxicon.star],
			['images', localize('library.images', 'Images'), Lxicon.image],
		] as const) { this.appendCategory(id, name, icon); }
		const section = h(this.contentElement.ownerDocument, 'div', { className: 'ash-library-collections-heading' }, localize('library.collections', 'Collections'));
		this.navigation.add(new Button(section, { label: localize('library.newCollection', 'New collection'), icon: Lxicon.add, iconOnly: true, enabled: !this.library.state.get().busy, onClick: () => { void this.library.createCollection(); } }));
		this.navigationDomNode.append(section);
		for (const collection of this.library.state.get().catalog.collections) { this.appendCategory(collection.id, collection.name, Lxicon.folders); }
		this.navigation.add(addDisposableListener(this.navigationDomNode, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const buttons = Array.from(this.navigationDomNode.querySelectorAll<HTMLButtonElement>('[data-library-category]'));
			const index = buttons.indexOf(getActiveElement(this.contentElement.ownerDocument) as HTMLButtonElement);
			if (index < 0) { return; }
			event.preventDefault();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
			buttons[next].focus();
		}));
		if (focusedCategory) { this.navigationDomNode.querySelector<HTMLButtonElement>(`[data-library-category="${focusedCategory}"]`)?.focus(); }
	}

	private appendCategory(id: string, name: string, icon: typeof Lxicon.library): void {
		const button = this.navigation.add(new Button(this.navigationDomNode, {
			label: name, icon, onClick: () => {
				this.library.selectCategory(id);
			}
		}));
		button.domNode.dataset.libraryCategory = id;
		button.domNode.classList.toggle('selected', id === this.library.state.get().category);
		if (id === this.library.state.get().category) { button.domNode.setAttribute('aria-current', 'page'); }
		this.navigation.add(this.hover.setupDelayedHover(button.domNode, { content: name }));
	}

}

export class LibraryDetailsView extends ViewPane {
	private readonly details = this._register(new DisposableStore());
	private readonly preview = this._register(new MutableDisposable<ImageResource>());
	private readonly detailDomNode: HTMLElement;
	constructor(parent: HTMLElement, options: IViewPaneOptions,
		@ILibraryService private readonly library: ILibraryService,
		@IAssetService private readonly assets: IAssetService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(parent, options);
		this.detailDomNode = h(parent.ownerDocument, 'aside', { className: 'ash-library-details ash-library-surface', attributes: { 'aria-label': localize('library.details', 'Asset details') } });
		this.contentElement.append(this.detailDomNode);
		this._register(contextKeys.createScoped(this.detailDomNode)).createKey('sessionsLibraryFocused', true);
		this._register(addDisposableListener(this.detailDomNode, 'focusin', event => {
			if (!this.detailDomNode.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.Library)) { status(localize('library.helpHint', 'Press Alt+F1 for Library accessibility help.')); }
		}));
		this._register(addDisposableListener(this.detailDomNode, 'keydown', event => {
			if (event.key === 'Escape' && this.library.state.get().selected) { event.stopPropagation(); this.library.closeDetails(); }
		}));
		let rendered: LibraryState | undefined;
		this._register(autorun(reader => {
			const state = this.library.state.read(reader);
			if (!rendered || rendered.catalog !== state.catalog || rendered.selected !== state.selected || rendered.busy !== state.busy) { this.renderDetails(); }
			rendered = state;
		}));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) { this.renderDetails(); }
			else { this.preview.clear(); this.detailDomNode.querySelector('img')?.removeAttribute('src'); }
		}));
	}
	public focus(): void { (this.detailDomNode.querySelector<HTMLElement>('button, input') ?? this.element).focus(); }
	private renderDetails(): void {
		const focused = getActiveElement(this.contentElement.ownerDocument) as HTMLElement;
		const focusKey = this.detailDomNode.contains(focused) ? focused.dataset.libraryControl : undefined;
		this.details.clear(); this.preview.clear(); this.detailDomNode.replaceChildren();
		const entry = this.library.state.get().catalog.entries.find(entry => entry.version.assetId === this.library.state.get().selected);
		this.detailDomNode.hidden = !entry;
		if (!entry) { return; }
		const heading = h(this.contentElement.ownerDocument, 'div', { className: 'ash-library-detail-heading' });
		heading.append(h(this.contentElement.ownerDocument, 'h2', {}, entry.version.name));
		this.details.add(new Button(heading, { label: localize('library.closeDetails', 'Close details'), icon: Lxicon.close, iconOnly: true, onClick: () => this.library.closeDetails() }));
		const image = h(this.contentElement.ownerDocument, 'img', { className: 'ash-library-detail-image', properties: { alt: entry.version.name } });
		this.detailDomNode.append(heading, image, h(this.contentElement.ownerDocument, 'p', {}, `${entry.version.width} × ${entry.version.height} · ${Math.ceil(entry.version.size / 1024)} KB`));
		for (const [label, value] of [[localize('library.source', 'Source'), entry.version.source.toString()], [localize('library.version', 'Version'), entry.version.versionId]] as const) {
			this.detailDomNode.append(h(this.contentElement.ownerDocument, 'h3', {}, label), h(this.contentElement.ownerDocument, 'p', { className: 'ash-library-detail-value' }, value));
		}
		const favoriteButton = this.details.add(new Button(this.detailDomNode, { label: entry.favorite ? localize('library.unfavorite', 'Remove from favorites') : localize('library.addFavorite', 'Add to favorites'), icon: entry.favorite ? Lxicon.starFilled : Lxicon.star, enabled: !this.library.state.get().busy, onClick: () => { void this.library.runMutation(() => this.assets.updateEntry(entry.version.assetId, !entry.favorite, entry.collectionIds)); } }));
		favoriteButton.domNode.dataset.libraryControl = 'favorite';
		this.details.add(new Button(this.detailDomNode, { label: localize('library.addToChat', 'Add to conversation'), icon: Lxicon.chat4, enabled: !this.library.state.get().busy, onClick: () => { void this.library.runMutation(() => this.commands.executeCommand('sessions.library.addToChat', entry.version)); } }));
		this.details.add(new Button(this.detailDomNode, { label: localize('library.useInDesign', 'Use in Design'), icon: Lxicon.image, enabled: !this.library.state.get().busy, onClick: () => { void this.library.runMutation(() => this.commands.executeCommand('sessions.library.useInDesign', entry.version)); } }));
		this.detailDomNode.append(h(this.contentElement.ownerDocument, 'h3', {}, localize('library.collections', 'Collections')));
		for (const collection of this.library.state.get().catalog.collections) {
			const label = h(this.contentElement.ownerDocument, 'label', { className: 'ash-library-membership' });
			const checkbox = h(this.contentElement.ownerDocument, 'input', { properties: { type: 'checkbox', checked: entry.collectionIds.includes(collection.id), disabled: this.library.state.get().busy } });
			checkbox.dataset.libraryControl = collection.id;
			label.append(checkbox, h(this.contentElement.ownerDocument, 'span', {}, collection.name)); this.detailDomNode.append(label);
			this.details.add(addDisposableListener(checkbox, 'change', () => { void this.library.runMutation(() => this.assets.updateEntry(entry.version.assetId, entry.favorite, checkbox.checked ? [...entry.collectionIds, collection.id] : entry.collectionIds.filter(id => id !== collection.id))); }));
		}
		this.details.add(new Button(this.detailDomNode, { label: localize('library.newCollection', 'New collection'), icon: Lxicon.add, enabled: !this.library.state.get().busy, onClick: () => { void this.library.createCollection(); } }));
		if (focusKey) { this.detailDomNode.querySelector<HTMLElement>(`[data-library-control="${focusKey}"]`)?.focus(); }
		if (!this.isBodyVisible()) { return; }
		const selection = this.library.state.get().selected;
		void this.assets.readVersion(entry.version).then(bytes => {
			// Selection and DOM identity prevent a completed read from populating another asset's pane.
			if (this.isDisposed || !this.isBodyVisible() || this.library.state.get().selected !== selection || !image.isConnected) { return; }
			const resource = new ImageResource(bytes, entry.version.mediaType); this.preview.value = resource; image.src = resource.url;
		}).catch(error => { if (image.isConnected) { image.alt = localize('library.previewFailed', 'Could not load preview: {0}', String(error)); } });
	}

}
