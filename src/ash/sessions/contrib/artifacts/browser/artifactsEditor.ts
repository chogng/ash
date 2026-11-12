import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import './artifactsEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { Action } from '../../../../base/common/actions.js';
import { IdGenerator } from '../../../../base/common/idGenerator.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { ArtifactWorkspaces, type IArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { IDesignEditorService } from './designEditorService.js';
import type { DesignDocumentController } from './designDocumentController.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../contrib/docs/common/docs.js';
import { basename } from '../../../../base/common/resources.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ToolbarSearchActionViewItem } from '../../../browser/ui/toolbarSearchActionViewItem.js';
import { appendArtifactIcon, getArtifactTitle } from './artifactKindPresentation.js';
import { artifactKinds, isArtifactKind, type ArtifactKind } from '../../../common/artifactKind.js';
import { ARTIFACT_EXAMPLE_SCHEME, getArtifactExamples, OPEN_ARTIFACT_EXAMPLE, type CanvasArtifactExample, type TableArtifactExample } from './artifactExamples.js';
import { ArtifactTableWorkspace, type TableArtifactKind } from './artifactTableWorkspace.js';

export const NEW_ARTIFACT = 'sessions.creator.newArtifact';
export const OPEN_CANVAS_ARTIFACT = 'sessions.creator.openCanvasArtifact';

interface ArtifactCard {
	readonly title: string;
	readonly kind: ArtifactKind;
	readonly detail: string;
	readonly slidesArtifactId?: string;
	readonly workspaceKey?: ArtifactWorkspaceKey;
	readonly open: () => void;
}

type ArtifactFilter = 'all' | 'yours' | 'shared';
type ArtifactWorkspaceKey = ArtifactWorkspaceId | `example:${ArtifactKind}` | `canvas:${string}` | `table:${string}`;

interface ActiveArtifactWorkspace {
	readonly key: ArtifactWorkspaceKey;
	readonly title: string;
	readonly mode?: ArtifactWorkspaceId;
	readonly kind?: ArtifactKind;
}

const pages = new WeakMap<Element, ArtifactsEditorView>();
const artifactResultsIds = new IdGenerator('ash-artifacts-results-');

class ArtifactToggleActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		if (this.action.onDidChange) {
			this._register(this.action.onDidChange(() => { this.button.checked = this.action.checked; }));
		}
	}
}

export class ArtifactsEditorPane extends EditorPane implements IEditorPane {
	public readonly id = 'sessions.editor.creator';
	public page!: ArtifactsEditorView;
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) { super('sessions.editor.creator', themeService, storageService); }
	public override create(parent: HTMLElement): void {
		this.page = this._register(this.instantiation.createInstance(ArtifactsEditorView, parent.ownerDocument));
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
export class ArtifactsEditorView extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly homeDomNode: HTMLElement;
	private readonly workspacesDomNode: HTMLElement;
	private readonly titleDomNode: HTMLElement;
	private readonly headerDomNode: HTMLElement;
	private readonly back: Button;
	private tableActions: WorkbenchToolBar | undefined;
	private readonly docsButton: Button;
	private readonly artifactsDomNode: HTMLElement;
	private readonly artifactCards = this._register(new DisposableStore());
	private readonly search: HTMLInputElement;
	private readonly sortAction: Action;
	private filter: ArtifactFilter = 'all';
	private readonly creationButtons = new Map<ArtifactKind, Button>();
	private readonly workspaces = this._register(new DisposableMap<ArtifactWorkspaceKey, IArtifactWorkspace>());
	private activeWorkspace: ActiveArtifactWorkspace | undefined;
	private readonly examples = getArtifactExamples();
	public get activeMode(): ArtifactWorkspaceId | undefined { return this.activeWorkspace?.mode; }
	public get activeKind(): ArtifactKind | undefined { return this.activeWorkspace?.kind; }
	private visible = false;
	private dimension: IDimension = { width: 0, height: 0 };
	public get usesCanvasPanels(): boolean { return this.activeWorkspace !== undefined && this.workspaces.get(this.activeWorkspace.key)!.usesCanvasPanels; }
	public get isHome(): boolean { return this.activeWorkspace === undefined; }

	constructor(
		ownerDocument: Document,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@ICommandService private readonly commands: ICommandService,
		@IEditorPart private readonly editors: IEditorPart,
		@IDesignEditorService private readonly designs: IDesignEditorService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
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
		const panelId = artifactResultsIds.nextId();
		const filterTabs = [
			{ id: 'all', label: localize('sessions.artifacts.all', 'All') },
			{ id: 'yours', label: localize('sessions.artifacts.yours', 'Yours') },
			{ id: 'shared', label: localize('sessions.artifacts.shared', 'Shared with you') },
		] as const;
		const tabs = filterTabs.map(tab => ({ ...tab, value: tab.id, tabId: `${panelId}-${tab.id}`, panelId }));
		const filters = this._register(new TabList<ArtifactFilter>(toolbar, {
			ariaLabel: localize('sessions.artifacts.filters', 'Artifact ownership'),
			presentation: 'navigation',
			onActivate: filter => {
				this.filter = filter;
				filters.setTabs(tabs, filter);
				this.artifactsDomNode.setAttribute('aria-labelledby', `${panelId}-${filter}`);
				this.renderArtifacts();
			},
		}));
		filters.setTabs(tabs, this.filter);
		const searchLabel = localize('sessions.artifacts.search', 'Search artifacts');
		this.search = h(ownerDocument, 'input', {
			properties: { type: 'search', placeholder: searchLabel },
			attributes: { 'aria-label': searchLabel },
		});
		this._register(addDisposableListener(this.search, 'input', () => this.renderArtifacts()));
		let searchItem: ToolbarSearchActionViewItem;
		const searchAction = {
			id: 'sessions.artifacts.search',
			label: searchLabel,
			tooltip: searchLabel,
			icon: Lxicon.search,
			enabled: true,
			run: () => {
				searchItem.setExpanded(true);
				searchItem.focus();
			},
		};
		const sortLabel = localize('sessions.artifacts.reverseSort', 'Reverse title order');
		this.sortAction = this._register(new Action('sessions.artifacts.reverseSort', sortLabel, '', true, () => {
			this.sortAction.checked = !this.sortAction.checked;
			this.renderArtifacts();
		}));
		this.sortAction.icon = Lxicon.sort;
		this.sortAction.tooltip = sortLabel;
		this.sortAction.checked = false;
		const layoutLabel = localize('sessions.artifacts.layoutGrid', 'Layout grid');
		const layoutAction = this._register(new Action('sessions.artifacts.layoutGrid', layoutLabel, '', true, () => {
			layoutAction.checked = !layoutAction.checked;
			this.artifactsDomNode.classList.toggle('list-view', !layoutAction.checked);
		}));
		layoutAction.icon = Lxicon.layoutGrid;
		layoutAction.tooltip = layoutLabel;
		layoutAction.checked = true;
		const actionBar = this._register(new ActionBar(toolbar, {
			ariaLabel: localize('sessions.artifacts.actions', 'Artifact actions'),
			actions: [searchAction, this.sortAction, layoutAction],
			actionViewItemOptions: { buttonStyles: defaultButtonStyles, iconOnly: true },
			actionViewItemProvider: (action, options) => {
				if (action === searchAction) {
					searchItem = new ToolbarSearchActionViewItem(action, options, this.search, () => {
						this.search.value = '';
						searchItem.setExpanded(false);
						searchItem.focus();
						this.renderArtifacts();
					}, localize('sessions.artifacts.closeSearch', 'Close artifact search'));
					return searchItem;
				}
				return new ArtifactToggleActionViewItem(action, options);
			},
		}));
		actionBar.domNode.classList.add('ash-artifacts-actions');
		actionBar.domNode.querySelector(`[data-action-id="${layoutAction.id}"] button`)!.setAttribute('aria-controls', panelId);
		const introduction = h(ownerDocument, 'h2', { className: 'ash-creator-introduction' }, localize('sessions.creator.introduction', 'Make something new'));
		const modes = h(ownerDocument, 'div', { className: 'ash-creator-modes' });
		this.docsButton = this.createTile(modes, 'docs');
		for (const kind of artifactKinds) {
			if (kind === 'docs') continue;
			const button = this.createTile(modes, kind);
			if (kind === ArtifactWorkspaceId.Slides || kind === ArtifactWorkspaceId.Design || kind === ArtifactWorkspaceId.Whiteboard) {
				button.domNode.dataset.creatorMode = kind;
			}
			this.creationButtons.set(kind, button);
		}
		this.artifactsDomNode = h(ownerDocument, 'section', { className: 'ash-artifacts-results', attributes: { id: panelId, role: 'tabpanel', 'aria-labelledby': `${panelId}-${this.filter}`, 'aria-live': 'polite' } });
		this.homeDomNode.append(toolbar, introduction, modes, this.artifactsDomNode);
		this.workspacesDomNode = h(ownerDocument, 'div', { className: 'ash-creator-workspaces' });
		this.workspacesDomNode.hidden = true;
		this.domNode.append(header, this.homeDomNode, this.workspacesDomNode);
		// Cards project the existing editor and canvas owners; they do not persist another catalog.
		this._register(editors.onDidChangeEditors(() => this.renderArtifacts()));
		for (const mode of [ArtifactWorkspaceId.Design, ArtifactWorkspaceId.Slides]) {
			const document = designs.getDocument(mode);
			this._register(document.onDidChangeContent(() => this.renderArtifacts()));
			this._register(document.onDidChangeLabel(() => this.renderArtifacts()));
			void document.ready.then(() => { if (!this.isDisposed) { this.renderArtifacts(); } });
		}
		this._register(autorun(reader => {
			designs.canvasArtifacts.read(reader);
			this.renderArtifacts();
		}));
		void designs.loadCanvasArtifacts();
	}

	private createTile(container: HTMLElement, kind: ArtifactKind): Button {
		const button = this._register(new Button(container, {
			...defaultButtonStyles, label: getArtifactTitle(kind),
			onClick: () => { void this.commands.executeCommand(NEW_ARTIFACT, kind); },
		}));
		button.domNode.classList.add('ash-artifacts-create', kind);
		button.domNode.prepend(this.createIllustration(kind));
		return button;
	}

	private createIllustration(kind: ArtifactKind): HTMLElement {
		const preview = h(this.domNode.ownerDocument, 'span', {
			className: 'ash-artifacts-illustration ash-artifact-type',
			attributes: { 'aria-hidden': 'true', 'data-artifact-kind': kind },
		});
		appendArtifactIcon(kind, preview);
		return preview;
	}

	private getArtifacts(): ArtifactCard[] {
		const cards: ArtifactCard[] = [];
		const documents = new Set<string>();
		for (const input of this.editors.groups.flatMap(group => group.editors.map(editor => editor.input))) {
			if (input.resource.scheme === ARTIFACT_EXAMPLE_SCHEME) { continue; }
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
		for (const mode of [ArtifactWorkspaceId.Slides, ArtifactWorkspaceId.Design] as const) {
			const document = this.designs.getDocument(mode);
			if (document.model.value.shapes.length === 0) { continue; }
			cards.push({
				title: document.name,
				kind: mode,
				detail: mode === ArtifactWorkspaceId.Design ? document.saveStatus : localize('sessions.creator.slides.title', 'Slides'),
				open: () => { void this.commands.executeCommand('sessions.creator.openMode', mode); },
			});
		}
		for (const [id, document] of this.designs.canvasArtifacts.get()) {
			const kind = document.artifactKind!;
			cards.push({
				title: document.name,
				kind,
				detail: getArtifactTitle(kind),
				slidesArtifactId: kind === 'slides' ? id : undefined,
				workspaceKey: `canvas:${id}`,
				open: () => { void this.commands.executeCommand(OPEN_CANVAS_ARTIFACT, id); },
			});
		}
		for (const [key, workspace] of this.workspaces) {
			if (workspace instanceof ArtifactTableWorkspace && key.startsWith('table:')) {
				cards.push({
					title: workspace.title, kind: workspace.kind, detail: getArtifactTitle(workspace.kind), workspaceKey: key,
					open: () => { void this.commands.executeCommand('sessions.creator.openTable', key); }
				});
			}
		}
		return cards;
	}

	private renderArtifacts(): void {
		if (!this.artifactsDomNode) { return; }
		this.artifactCards.clear();
		this.artifactsDomNode.replaceChildren();
		const query = this.search.value.trim().toLocaleLowerCase();
		const cards = this.filter === 'shared' ? [] : this.getArtifacts().filter(card => card.title.toLocaleLowerCase().includes(query));
		const examples = this.filter === 'all' ? this.examples.filter(card => card.title.toLocaleLowerCase().includes(query)) : [];
		const restoring = this.filter !== 'shared' && [ArtifactWorkspaceId.Design, ArtifactWorkspaceId.Slides].some(mode => this.designs.getDocument(mode).isRestoring);
		this.artifactsDomNode.setAttribute('aria-busy', String(restoring));
		const byTitle = (a: ArtifactCard, b: ArtifactCard) => a.title.localeCompare(b.title) * (this.sortAction.checked ? -1 : 1);
		cards.sort(byTitle);
		if (cards.length) {
			const grid = h(this.domNode.ownerDocument, 'div', { className: 'ash-artifacts-work-grid' });
			this.artifactsDomNode.append(grid);
			for (const card of cards) {
				this.renderCard(card, grid);
			}
		}
		if (examples.length) {
			this.artifactsDomNode.append(h(this.domNode.ownerDocument, 'h2', { className: 'ash-artifacts-examples-heading' }, localize('sessions.artifacts.examples', 'Examples')));
			const grid = h(this.domNode.ownerDocument, 'div', { className: 'ash-artifacts-examples-grid' });
			this.artifactsDomNode.append(grid);
			for (const example of examples) {
				const card = {
					...example, open: () => { void this.commands.executeCommand(OPEN_ARTIFACT_EXAMPLE, example.kind); },
				};
				this.renderCard(card, grid).dataset.artifactExample = card.kind;
			}
		}
		if (cards.length === 0 && examples.length === 0) {
			const message = restoring ? localize('sessions.artifacts.loading', 'Loading artifacts…') : this.filter === 'shared' ? localize('sessions.artifacts.noShared', 'No artifacts have been shared with you.')
				: query ? localize('sessions.artifacts.noResults', 'No artifacts match your search.') : localize('sessions.artifacts.empty', 'Your work will appear here.');
			this.artifactsDomNode.append(h(this.domNode.ownerDocument, 'p', { className: 'ash-artifacts-empty' }, message));
		}
	}

	private renderCard(card: ArtifactCard, container: HTMLElement): HTMLElement {
		const button = this.artifactCards.add(new Button(container, { ...defaultButtonStyles, label: card.title, title: card.title, onClick: card.open }));
		button.domNode.classList.add('ash-artifacts-card', card.kind);
		if (card.slidesArtifactId) { button.domNode.dataset.slidesArtifact = card.slidesArtifactId; }
		if (card.workspaceKey) { button.domNode.dataset.artifactWorkspace = card.workspaceKey; }
		button.domNode.prepend(this.createIllustration(card.kind));
		button.domNode.append(h(this.domNode.ownerDocument, 'span', { className: 'ash-artifacts-card-detail' }, card.detail));
		return button.domNode;
	}

	public initialize(): void {
		const restored = this.storage.get('sessions.creator.activeMode', StorageScope.WORKSPACE);
		if (restored !== undefined) {
			if (!ArtifactWorkspaces.has(restored as ArtifactWorkspaceId)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
			this.openMode(restored as ArtifactWorkspaceId);
		}
	}
	public static getFocused(element: HTMLElement): ArtifactsEditorView | undefined {
		const root = element.closest('.ash-creator');
		return root ? pages.get(root) : undefined;
	}
	public openMode(mode: ArtifactWorkspaceId): void {
		const contribution = ArtifactWorkspaces.get(mode)!;
		let workspace = this.workspaces.get(mode);
		if (!workspace) {
			workspace = contribution.create(this.instantiation, this.domNode.ownerDocument);
			this.workspaces.set(mode, workspace);
			workspace.create(this.workspacesDomNode);
		}
		this.storage.store('sessions.creator.activeMode', mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.activateWorkspace({ key: mode, title: contribution.title, mode }, workspace);
	}

	public openExample(example: CanvasArtifactExample | TableArtifactExample): void {
		if (example.type === 'canvas' && example.mode === ArtifactWorkspaceId.Slides) {
			this.openCanvasArtifact(this.designs.createCanvasArtifact('slides', example.createShapes()));
			return;
		}
		const key = `example:${example.kind}` as const;
		let workspace = this.workspaces.get(key);
		if (!workspace) {
			if (example.type === 'canvas') {
				const contribution = ArtifactWorkspaces.get(example.mode)!;
				workspace = contribution.create(this.instantiation, this.domNode.ownerDocument);
				workspace.create(this.workspacesDomNode, example);
			} else {
				workspace = this.instantiation.createInstance(ArtifactTableWorkspace, this.domNode.ownerDocument, example.kind, example.title, example);
				workspace.create(this.workspacesDomNode);
			}
			this.workspaces.set(key, workspace);
		}
		this.activateWorkspace({ key, title: example.title, kind: example.kind, mode: example.type === 'canvas' ? example.mode : undefined }, workspace);
	}

	public openCanvasArtifact(document: DesignDocumentController): void {
		const mode = document.mode;
		const key = `canvas:${document.model.value.documentId}` as const;
		let workspace = this.workspaces.get(key);
		if (!workspace) {
			workspace = ArtifactWorkspaces.get(mode)!.create(this.instantiation, this.domNode.ownerDocument);
			this.workspaces.set(key, workspace);
			workspace.create(this.workspacesDomNode, undefined, document);
		}
		this.storage.remove('sessions.creator.activeMode', StorageScope.WORKSPACE);
		this.activateWorkspace({ key, title: document.name, kind: document.artifactKind, mode }, workspace);
	}

	public createTable(kind: TableArtifactKind): void {
		const key = `table:${generateUuid()}` as const;
		const title = localize('sessions.creator.untitled', 'Untitled {0}', getArtifactTitle(kind));
		const workspace = this.instantiation.createInstance(ArtifactTableWorkspace, this.domNode.ownerDocument, kind, title, undefined);
		this.workspaces.set(key, workspace);
		workspace.create(this.workspacesDomNode);
		this.activateWorkspace({ key, title, kind }, workspace);
	}

	public openTable(key: string): void {
		if (!key.startsWith('table:')) { return; }
		const workspaceKey = key as `table:${string}`;
		const workspace = this.workspaces.get(workspaceKey);
		if (workspace instanceof ArtifactTableWorkspace) this.activateWorkspace({ key: workspaceKey, title: workspace.title, kind: workspace.kind }, workspace);
	}

	public revealInitialContent(): void {
		if (this.activeWorkspace && this.visible) {
			this.workspaces.get(this.activeWorkspace.key)?.revealInitialContent?.();
		}
	}

	private activateWorkspace(active: ActiveArtifactWorkspace, workspace: IArtifactWorkspace): void {
		this.activeWorkspace = active;
		this.titleDomNode.textContent = active.title;
		if (workspace instanceof ArtifactTableWorkspace) {
			this.tableActions ??= this._register(new WorkbenchToolBar(this.headerDomNode, this.contextMenus, { ariaLabel: localize('sessions.creator.workspaceActions', 'Workspace actions') }));
			this.tableActions.setActions([...workspace.toolbarActions]);
		}
		this.updateVisibility();
		this.layout(this.dimension);
		if (this.visible) { workspace.focus(); status(localize('sessions.creator.entered', '{0} workspace', active.title)); }
	}
	public showHome(): void {
		const previous = this.activeWorkspace;
		this.activeWorkspace = undefined;
		this.tableActions?.setActions([]);
		this.titleDomNode.textContent = localize('sessions.creator.title', 'Artifacts');
		this.storage.remove('sessions.creator.activeMode', StorageScope.WORKSPACE);
		this.updateVisibility();
		this.renderArtifacts();
		if (previous) {
			const example = previous.key.startsWith('example:')
				? this.artifactsDomNode.querySelector<HTMLElement>(`[data-artifact-example="${previous.key.slice('example:'.length)}"]`)
				: undefined;
			const artifact = this.artifactsDomNode.querySelector<HTMLElement>(`[data-artifact-workspace="${previous.key}"]`);
			const button = isArtifactKind(previous.mode) ? this.creationButtons.get(previous.mode) : undefined;
			(example ?? artifact ?? button ?? this.docsButton).focus();
		}
	}
	private updateVisibility(): void {
		this.homeDomNode.hidden = this.activeWorkspace !== undefined;
		this.workspacesDomNode.hidden = this.activeWorkspace === undefined;
		this.back.hidden = this.activeWorkspace === undefined;
		this.headerDomNode.hidden = this.activeWorkspace?.mode !== undefined;
		for (const [key, workspace] of this.workspaces) {
			const active = key === this.activeWorkspace?.key;
			workspace.domNode.hidden = !active;
			workspace.setVisible(this.visible && active);
		}
	}
	public setVisible(visible: boolean): void { this.visible = visible; this.updateVisibility(); }
	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.classList.toggle('narrow', dimension.width < 600);
		this.domNode.classList.toggle('compact', dimension.width < 420);
		if (this.activeWorkspace) { this.workspaces.get(this.activeWorkspace.key)!.layout({ width: dimension.width, height: Math.max(0, dimension.height - (this.headerDomNode.hidden ? 0 : 52)) }); }
	}
	public focus(): void {
		if (this.activeWorkspace) { this.workspaces.get(this.activeWorkspace.key)!.focus(); }
		else { this.docsButton.focus(); }
	}
	public getAccessibleContent(): string {
		if (this.activeWorkspace) {
			const { key, title, mode } = this.activeWorkspace;
			const help = mode ? ArtifactWorkspaces.get(mode)!.help : undefined;
			return [title, help, this.workspaces.get(key)!.getAccessibleContent()].filter(Boolean).join('\n');
		}
		const cards = this.filter === 'all' ? [...this.getArtifacts(), ...this.examples] : this.filter === 'yours' ? this.getArtifacts() : [];
		return [localize('sessions.creator.title', 'Artifacts'), ...artifactKinds.map(getArtifactTitle), ...cards.map(card => `${card.title}: ${card.detail}`)].join('\n');
	}
	protected override disposeCore(): void { pages.delete(this.domNode); super.disposeCore(); this.domNode.remove(); }
}
