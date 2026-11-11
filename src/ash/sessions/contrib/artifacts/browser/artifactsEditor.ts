import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../../workbench/common/editor.js';
import './artifactsEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { Action } from '../../../../base/common/actions.js';
import { IdGenerator } from '../../../../base/common/idGenerator.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../contrib/docs/common/docs.js';
import { basename } from '../../../../base/common/resources.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { Icon } from '../../../../base/common/icon.js';
import { ToolbarSearchActionViewItem } from '../../../browser/ui/toolbarSearchActionViewItem.js';
import { getArtifactTitle, OPEN_ARTIFACT_DRAFT } from './artifactDraft.js';
import { artifactKinds, isArtifactKind, type ArtifactKind } from '../../../common/artifactKind.js';

const artifactIllustrations: Record<ArtifactKind, string | Icon> = {
	docs: 'M38 8H17a5 5 0 0 0-5 5v38a5 5 0 0 0 5 5h30a5 5 0 0 0 5-5V22L38 8Zm0 0v14h14',
	slides: 'M7 10h50M10 10v31a5 5 0 0 0 5 5h34a5 5 0 0 0 5-5V10M32 46v10m0-10L22 58m10-12 10 12',
	design: 'M33 9C18 9 7 19 7 33s11 23 24 23h5a6 6 0 0 0 5-9l-2-3c-2-3 0-6 4-6h4c8 0 12-5 10-12C55 15 44 9 33 9ZM20 26a2 2 0 1 0 0 .1m12-8a2 2 0 1 0 0 .1m12 6a2 2 0 1 0 0 .1M17 38a2 2 0 1 0 0 .1',
	sheet: Lxicon.table,
	whiteboard: Lxicon.pen,
	data: Lxicon.database,
	motion: Lxicon.motion,
};

interface ArtifactCard {
	readonly title: string;
	readonly kind: ArtifactKind;
	readonly detail: string;
	readonly open: () => void;
}

type ArtifactFilter = 'all' | 'yours' | 'shared';

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
	private readonly docsButton: Button;
	private readonly artifactsDomNode: HTMLElement;
	private readonly artifactCards = this._register(new DisposableStore());
	private readonly search: HTMLInputElement;
	private readonly sortAction: Action;
	private filter: ArtifactFilter = 'all';
	private readonly creationButtons = new Map<ArtifactKind, Button>();
	private readonly workspaces = this._register(new DisposableMap<ArtifactWorkspaceId, IArtifactWorkspace>());
	private mode: ArtifactWorkspaceId | undefined;
	public get activeMode(): ArtifactWorkspaceId | undefined { return this.mode; }
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
		this.renderArtifacts();
	}

	private createTile(container: HTMLElement, kind: ArtifactKind): Button {
		const button = this._register(new Button(container, {
			...defaultButtonStyles, label: getArtifactTitle(kind),
			onClick: () => { void this.commands.executeCommand(OPEN_ARTIFACT_DRAFT, kind); },
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
		const illustration = artifactIllustrations[kind];
		if (typeof illustration !== 'string') {
			appendIcon(illustration, preview);
			return preview;
		}
		const svg = this.domNode.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 64 64');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '3');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const path = this.domNode.ownerDocument.createElementNS(svg.namespaceURI, 'path');
		path.setAttribute('d', illustration);
		svg.append(path);
		preview.append(svg);
		return preview;
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
		return cards;
	}

	private renderArtifacts(): void {
		if (!this.artifactsDomNode) { return; }
		this.artifactCards.clear();
		this.artifactsDomNode.replaceChildren();
		const query = this.search.value.trim().toLocaleLowerCase();
		const cards = this.filter === 'shared' ? [] : this.getArtifacts().filter(card => card.title.toLocaleLowerCase().includes(query));
		const restoring = this.filter !== 'shared' && [ArtifactWorkspaceId.Design, ArtifactWorkspaceId.Slides].some(mode => this.designs.getDocument(mode).isRestoring);
		this.artifactsDomNode.setAttribute('aria-busy', String(restoring));
		cards.sort((a, b) => a.title.localeCompare(b.title) * (this.sortAction.checked ? -1 : 1));
		for (const card of cards) {
			const button = this.artifactCards.add(new Button(this.artifactsDomNode, { ...defaultButtonStyles, label: card.title, title: card.title, onClick: card.open }));
			button.domNode.classList.add('ash-artifacts-card', card.kind);
			button.domNode.prepend(this.createIllustration(card.kind));
			button.domNode.append(h(this.domNode.ownerDocument, 'span', { className: 'ash-artifacts-card-detail' }, card.detail));
		}
		if (cards.length === 0) {
			const message = restoring ? localize('sessions.artifacts.loading', 'Loading artifacts…') : this.filter === 'shared' ? localize('sessions.artifacts.noShared', 'No artifacts have been shared with you.')
				: query ? localize('sessions.artifacts.noResults', 'No artifacts match your search.') : localize('sessions.artifacts.empty', 'Your work will appear here.');
			this.artifactsDomNode.append(h(this.domNode.ownerDocument, 'p', { className: 'ash-artifacts-empty' }, message));
		}
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
		if (previous) {
			const button = isArtifactKind(previous) ? this.creationButtons.get(previous) : undefined;
			(button ?? this.docsButton).focus();
		}
		this.renderArtifacts();
	}
	private updateVisibility(): void {
		this.homeDomNode.hidden = this.mode !== undefined;
		this.workspacesDomNode.hidden = this.mode === undefined;
		this.back.hidden = this.mode === undefined;
		this.headerDomNode.hidden = this.mode === ArtifactWorkspaceId.Design;
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
		if (this.mode !== undefined) { return `${ArtifactWorkspaces.get(this.mode)!.title}\n${ArtifactWorkspaces.get(this.mode)!.help}\n\n${this.workspaces.get(this.mode)!.getAccessibleContent()}`; }
		return [localize('sessions.creator.title', 'Artifacts'), ...artifactKinds.map(getArtifactTitle), ...this.getArtifacts().map(card => `${card.title}: ${card.detail}`)].join('\n');
	}
	protected override disposeCore(): void { pages.delete(this.domNode); super.disposeCore(); this.domNode.remove(); }
}
