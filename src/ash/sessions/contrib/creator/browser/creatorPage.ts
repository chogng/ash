import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import './creatorPage.css';
import { LoadingSkeleton } from '../../../browser/ui/loadingSkeleton.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CreatorMode } from '../common/creator.js';
import { CreatorModes, type ICreatorWorkspace } from './creatorWorkspace.js';
import { IDesignEditorService } from './designEditorService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../../../../workbench/contrib/documentEditor/browser/documentEditorInput.js';
import { basename } from '../../../../base/common/resources.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

interface ArtifactCard {
	readonly title: string;
	readonly kind: 'docs' | 'slides' | 'design';
	readonly detail: string;
	readonly open: () => void;
}

const pages = new WeakMap<Element, CreatorPage>();

export class CreatorEditorPane extends EditorPane implements IEditorPane {
	public readonly id = 'sessions.editor.creator';
	public page!: CreatorPage;
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) { super('sessions.editor.creator', themeService, storageService); }
	public override create(parent: HTMLElement): void {
		this.page = this._register(this.instantiation.createInstance(CreatorPage, parent.ownerDocument));
		parent.append(this.page.domNode);
		super.create(this.page.domNode);
		this.page.initialize();
	}
	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility); this.page.setVisible(visibility);
	}
	public override layout(dimension: IDimension): void { this.page.layout(dimension); }
	public override focus(): void { this.page.focus(); }
}

/** Owns mode navigation and retained workspaces; each contribution owns its editing experience. */
export class CreatorPage extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly homeDomNode: HTMLElement;
	private readonly workspacesDomNode: HTMLElement;
	private readonly titleDomNode: HTMLElement;
	private readonly headerDomNode: HTMLElement;
	private readonly back: Button;
	private readonly docsButton: Button;
	private readonly artifactsDomNode: HTMLElement;
	private readonly loading: LoadingSkeleton;
	private readonly artifactCards = this._register(new DisposableStore());
	private readonly filterButtons: Button[] = [];
	private readonly search: HTMLInputElement;
	private filter = 0;
	private ascending = true;
	private readonly modeButtons = new Map<CreatorMode, Button>();
	private readonly workspaces = this._register(new DisposableMap<CreatorMode, ICreatorWorkspace>());
	private mode: CreatorMode | undefined;
	public get activeMode(): CreatorMode | undefined { return this.mode; }
	private visible = false;
	private dimension: IDimension = { width: 0, height: 0 };
	public get usesCanvasPanels(): boolean { return this.mode !== undefined && this.workspaces.get(this.mode)!.usesCanvasPanels; }

	constructor(
		ownerDocument: Document,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@ICommandService private readonly commands: ICommandService,
		@IEditorPart private readonly editors: IEditorPart,
		@IDesignEditorService private readonly designs: IDesignEditorService,
	) {
		super();
		this.domNode = h(ownerDocument, 'section', { className: 'ash-creator', attributes: { role: 'region', 'aria-label': localize('sessions.creator.title', 'Artifacts') } });
		pages.set(this.domNode, this);
		this._register(contextKeys.createScoped(this.domNode)).createKey('sessionsCreatorFocused', true);
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Creator);
		if (hint) { this.domNode.setAttribute('aria-description', hint); }
		const header = this.headerDomNode = h(ownerDocument, 'header', { className: 'ash-creator-header' });
		this.back = this._register(new Button(header, {
			...defaultButtonStyles,
			label: localize('sessions.creator.home', 'Artifacts home'),
			onClick: () => { void commands.executeCommand('sessions.show.creator'); },
		}));
		this.back.hidden = true;
		this.titleDomNode = h(ownerDocument, 'h1', { className: 'ash-creator-title' }, localize('sessions.creator.title', 'Artifacts'));
		header.append(this.titleDomNode);
		this.homeDomNode = h(ownerDocument, 'div', { className: 'ash-creator-home' });
		const toolbar = h(ownerDocument, 'div', { className: 'ash-artifacts-toolbar' });
		const filters = h(ownerDocument, 'div', { className: 'ash-artifacts-filters', attributes: { role: 'tablist', 'aria-label': localize('sessions.artifacts.filters', 'Artifact ownership') } });
		const labels = [localize('sessions.artifacts.all', 'All'), localize('sessions.artifacts.yours', 'Yours'), localize('sessions.artifacts.shared', 'Shared with you')];
		labels.forEach((label, index) => {
			const button = this._register(new Button(filters, { ...defaultButtonStyles, label, onClick: () => this.selectFilter(index) }));
			button.domNode.setAttribute('role', 'tab');
			button.domNode.setAttribute('aria-controls', 'ash-artifacts-results');
			this.filterButtons.push(button);
			this._register(addDisposableListener(button.domNode, 'keydown', event => {
				const target = event.key === 'Home' ? 0 : event.key === 'End' ? 2
					: event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : undefined;
				if (target === undefined) { return; }
				event.preventDefault();
				this.selectFilter(target);
				this.filterButtons[target].focus();
			}));
		});
		const actions = h(ownerDocument, 'div', { className: 'ash-artifacts-actions' });
		this.search = h(ownerDocument, 'input', { className: 'ash-artifacts-search', attributes: { type: 'search', 'aria-label': localize('sessions.artifacts.search', 'Search artifacts'), placeholder: localize('sessions.artifacts.search', 'Search artifacts') } });
		this.search.hidden = true;
		actions.append(this.search);
		this._register(addDisposableListener(this.search, 'input', () => this.renderArtifacts()));
		this._register(new Button(actions, {
			...defaultButtonStyles, label: localize('sessions.artifacts.search', 'Search artifacts'), icon: Lxicon.search, iconOnly: true,
			onClick: () => { this.search.hidden = !this.search.hidden; if (!this.search.hidden) { this.search.focus(); } else { this.search.value = ''; this.renderArtifacts(); } },
		}));
		const sort = this._register(new Button(actions, {
			...defaultButtonStyles, label: localize('sessions.artifacts.reverseSort', 'Reverse title order'), icon: Lxicon.sort, iconOnly: true, checked: false,
			onClick: () => { this.ascending = !this.ascending; sort.checked = !this.ascending; this.renderArtifacts(); },
		}));
		const list = this._register(new Button(actions, {
			...defaultButtonStyles, label: localize('sessions.artifacts.listView', 'List view'), icon: Lxicon.listUnordered, iconOnly: true, checked: false,
			onClick: () => { list.checked = !list.checked; this.artifactsDomNode.classList.toggle('list-view', list.checked); this.loading.element.classList.toggle('artifact-list', list.checked); },
		}));
		toolbar.append(filters, actions);
		const introduction = h(ownerDocument, 'h2', { className: 'ash-creator-introduction' }, localize('sessions.creator.introduction', 'Make something new'));
		const modes = h(ownerDocument, 'div', { className: 'ash-creator-modes' });
		const docsEntry = h(ownerDocument, 'div', { className: 'ash-artifacts-docs-entry' });
		modes.append(docsEntry);
		this.docsButton = this.createTile(docsEntry, 'docs', localize('sessions.artifacts.docs', 'Docs'), () => { void commands.executeCommand('sessions.creator.newDocument'); });
		const chooseEditor = this._register(new Button(docsEntry, {
			...defaultButtonStyles, label: localize('sessions.artifacts.chooseEditor', 'Choose Docs editor'), icon: Lxicon.chevronDown, iconOnly: true,
			onClick: () => { void commands.executeCommand('sessions.creator.chooseDocsEditor'); },
		}));
		chooseEditor.domNode.classList.add('ash-artifacts-editor-choice');
		for (const [mode, kind] of [[CreatorMode.Slides, 'slides'], [CreatorMode.Design, 'design']] as const) {
			const title = mode === CreatorMode.Slides ? localize('sessions.creator.slides.title', 'Slides') : localize('sessions.creator.design.title', 'Design');
			const button = this.createTile(modes, kind, title, () => { void commands.executeCommand('sessions.creator.openMode', mode); });
			button.domNode.dataset.creatorMode = mode;
			this.modeButtons.set(mode, button);
		}
		this.artifactsDomNode = h(ownerDocument, 'section', { className: 'ash-artifacts-results', attributes: { id: 'ash-artifacts-results', role: 'tabpanel', 'aria-label': labels[0], 'aria-live': 'polite' } });
		this.homeDomNode.append(toolbar, introduction, modes, this.artifactsDomNode);
		this.loading = this._register(new LoadingSkeleton(this.homeDomNode, localize('sessions.artifacts.loading', 'Loading artifacts…'), 'cards', 3));
		this.artifactsDomNode.before(this.loading.element);
		this.workspacesDomNode = h(ownerDocument, 'div', { className: 'ash-creator-workspaces' });
		this.workspacesDomNode.hidden = true;
		this.domNode.append(header, this.homeDomNode, this.workspacesDomNode);
		// Cards project the existing editor and canvas owners; they do not persist another catalog.
		this._register(editors.onDidChangeEditors(() => this.renderArtifacts()));
		for (const mode of [CreatorMode.Design, CreatorMode.Slides]) {
			const document = designs.getDocument(mode);
			this._register(document.onDidChangeContent(() => this.renderArtifacts()));
			this._register(document.onDidChangeLabel(() => this.renderArtifacts()));
			void document.ready.then(() => { if (!this.isDisposed) { this.renderArtifacts(); } });
		}
		this.selectFilter(0);
	}

	private createTile(container: HTMLElement, kind: ArtifactCard['kind'], title: string, open: () => void): Button {
		const button = this._register(new Button(container, { ...defaultButtonStyles, label: title, onClick: open }));
		button.domNode.classList.add('ash-artifacts-create', kind);
		button.domNode.prepend(this.createIllustration(kind));
		return button;
	}

	private createIllustration(kind: ArtifactCard['kind']): HTMLElement {
		const preview = h(this.domNode.ownerDocument, 'span', { className: `ash-artifacts-illustration ${kind}`, attributes: { 'aria-hidden': 'true' } });
		const svg = this.domNode.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 64 64');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '3');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const path = this.domNode.ownerDocument.createElementNS(svg.namespaceURI, 'path');
		path.setAttribute('d', kind === 'docs' ? 'M38 8H17a5 5 0 0 0-5 5v38a5 5 0 0 0 5 5h30a5 5 0 0 0 5-5V22L38 8Zm0 0v14h14'
			: kind === 'slides' ? 'M7 10h50M10 10v31a5 5 0 0 0 5 5h34a5 5 0 0 0 5-5V10M32 46v10m0-10L22 58m10-12 10 12'
				: 'M33 9C18 9 7 19 7 33s11 23 24 23h5a6 6 0 0 0 5-9l-2-3c-2-3 0-6 4-6h4c8 0 12-5 10-12C55 15 44 9 33 9ZM20 26a2 2 0 1 0 0 .1m12-8a2 2 0 1 0 0 .1m12 6a2 2 0 1 0 0 .1M17 38a2 2 0 1 0 0 .1');
		svg.append(path);
		preview.append(svg);
		return preview;
	}

	private selectFilter(index: number): void {
		this.filter = index;
		this.filterButtons.forEach((button, buttonIndex) => {
			button.domNode.setAttribute('aria-selected', String(index === buttonIndex));
			button.domNode.tabIndex = index === buttonIndex ? 0 : -1;
		});
		this.artifactsDomNode.setAttribute('aria-label', this.filterButtons[index].label);
		this.renderArtifacts();
	}

	private getArtifacts(): ArtifactCard[] {
		const cards: ArtifactCard[] = [];
		const documents = new Set<string>();
		for (const input of this.editors.groups.flatMap(group => group.editors.map(editor => editor.input))) {
			if (input.contentType !== GENERAL_DOCUMENT_CONTENT_TYPE && !input.resource.path.endsWith('.md')) { continue; }
			// Code and Artifacts may show the same working copy in separate editor groups.
			const identity = input.resource.toString();
			if (documents.has(identity)) { continue; }
			documents.add(identity);
			cards.push({
				title: input.label ?? basename(input.resource).replace(/\.(?:ash-doc|md)$/u, ''),
				kind: 'docs',
				detail: localize('sessions.artifacts.docs', 'Docs'),
				open: () => { void this.commands.executeCommand('sessions.creator.openDocument', input.resource.toString()); },
			});
		}
		for (const mode of [CreatorMode.Slides, CreatorMode.Design] as const) {
			const document = this.designs.getDocument(mode);
			if (document.model.value.shapes.length === 0) { continue; }
			cards.push({
				title: document.name,
				kind: mode,
				detail: mode === CreatorMode.Design ? document.saveStatus : localize('sessions.creator.slides.title', 'Slides'),
				open: () => { void this.commands.executeCommand('sessions.creator.openMode', mode); },
			});
		}
		return cards;
	}

	private renderArtifacts(): void {
		if (!this.artifactsDomNode) { return; }
		this.artifactCards.clear();
		this.artifactsDomNode.replaceChildren();
		const query = this.search.value.trim().toLocaleLowerCase();
		const cards = this.filter === 2 ? [] : this.getArtifacts().filter(card => card.title.toLocaleLowerCase().includes(query));
		const restoring = this.filter !== 2 && [CreatorMode.Design, CreatorMode.Slides].some(mode => this.designs.getDocument(mode).isRestoring);
		this.loading.setVisible(restoring && !cards.length);
		this.artifactsDomNode.setAttribute('aria-busy', String(restoring));
		cards.sort((a, b) => a.title.localeCompare(b.title) * (this.ascending ? 1 : -1));
		for (const card of cards) {
			const button = this.artifactCards.add(new Button(this.artifactsDomNode, { ...defaultButtonStyles, label: card.title, title: card.title, onClick: card.open }));
			button.domNode.classList.add('ash-artifacts-card', card.kind);
			button.domNode.prepend(this.createIllustration(card.kind));
			button.domNode.append(h(this.domNode.ownerDocument, 'span', { className: 'ash-artifacts-card-detail' }, card.detail));
		}
		if (cards.length === 0 && !restoring) {
			const message = this.filter === 2 ? localize('sessions.artifacts.noShared', 'No artifacts have been shared with you.')
				: query ? localize('sessions.artifacts.noResults', 'No artifacts match your search.') : localize('sessions.artifacts.empty', 'Your work will appear here. Create a doc, slide deck or design to get started.');
			this.artifactsDomNode.append(h(this.domNode.ownerDocument, 'p', { className: 'ash-artifacts-empty' }, message));
		}
	}

	public initialize(): void {
		const restored = this.storage.get('sessions.creator.activeMode', StorageScope.WORKSPACE);
		if (restored !== undefined) {
			if (!CreatorModes.has(restored as CreatorMode)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
			this.openMode(restored as CreatorMode);
		}
	}
	public static getFocused(element: HTMLElement): CreatorPage | undefined {
		const root = element.closest('.ash-creator');
		return root ? pages.get(root) : undefined;
	}
	public openMode(mode: CreatorMode): void {
		const contribution = CreatorModes.get(mode)!;
		let workspace = this.workspaces.get(mode);
		if (!workspace) {
			workspace = contribution.create(this.instantiation, this.domNode.ownerDocument);
			this.workspaces.set(mode, workspace);
			workspace.create(this.workspacesDomNode);
		}
		this.mode = mode;
		this.titleDomNode.textContent = contribution.title;
		this.storage.store('sessions.creator.activeMode', mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.updateVisibility();
		this.layout(this.dimension);
		if (this.visible) { workspace.focus(); status(localize('sessions.creator.entered', '{0} workspace', contribution.title)); }
	}
	public showHome(): void {
		const previous = this.mode;
		this.mode = undefined;
		this.titleDomNode.textContent = localize('sessions.creator.title', 'Artifacts');
		this.storage.remove('sessions.creator.activeMode', StorageScope.WORKSPACE);
		this.updateVisibility();
		if (previous) { (this.modeButtons.get(previous) ?? this.docsButton).focus(); }
		this.renderArtifacts();
	}
	private updateVisibility(): void {
		this.homeDomNode.hidden = this.mode !== undefined;
		this.workspacesDomNode.hidden = this.mode === undefined;
		this.back.hidden = this.mode === undefined;
		this.headerDomNode.hidden = this.mode === CreatorMode.Design;
		for (const [mode, workspace] of this.workspaces) {
			workspace.domNode.hidden = mode !== this.mode;
			workspace.setVisible(this.visible && mode === this.mode);
		}
	}
	public setVisible(visible: boolean): void { this.visible = visible; this.updateVisibility(); }
	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.classList.toggle('narrow', dimension.width < 600);
		this.domNode.classList.toggle('compact', dimension.width < 420);
		if (this.mode !== undefined) { this.workspaces.get(this.mode)!.layout({ width: dimension.width, height: Math.max(0, dimension.height - (this.headerDomNode.hidden ? 0 : 52)) }); }
	}
	public focus(): void {
		if (this.mode !== undefined) { this.workspaces.get(this.mode)!.focus(); }
		else { this.docsButton.focus(); }
	}
	public getAccessibleContent(): string {
		if (this.mode !== undefined) { return `${CreatorModes.get(this.mode)!.title}\n${CreatorModes.get(this.mode)!.help}\n\n${this.workspaces.get(this.mode)!.getAccessibleContent()}`; }
		return [localize('sessions.creator.title', 'Artifacts'), localize('sessions.artifacts.docs', 'Docs'), localize('sessions.creator.slides.title', 'Slides'), localize('sessions.creator.design.title', 'Design'), ...this.getArtifacts().map(card => `${card.title}: ${card.detail}`)].join('\n');
	}
	protected override disposeCore(): void { pages.delete(this.domNode); super.disposeCore(); this.domNode.remove(); }
}
