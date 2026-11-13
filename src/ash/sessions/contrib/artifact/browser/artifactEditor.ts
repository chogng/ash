import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import './artifactEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { Action } from '../../../../base/common/actions.js';
import { IdGenerator } from '../../../../base/common/idGenerator.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { parseArtifactKey } from '../../../../platform/artifactIntegrations/common/artifactLink.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { createArtifactCatalogSources, getArtifactWorkspace, type ArtifactCard, type ArtifactCatalogSource, type ArtifactWorkspaceRequest, type IArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { ArtifactTitleBarWidget } from './artifactTitleBarWidget.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ToolbarSearchActionViewItem } from '../../../browser/ui/toolbarSearchActionViewItem.js';
import { appendArtifactIcon, getArtifactTitle } from './artifactKindPresentation.js';
import { artifactKinds, isArtifactKind, type ArtifactKind } from '../../../common/artifactKind.js';
import { getArtifactExamples } from './artifactExamples.js';
import { ChatCreationWidget } from '../../chat/browser/chatCreationWidget.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ISessionsEditorPage } from '../../../browser/parts/editorPart.js';
import { Menus } from '../../../browser/menus.js';
import { IAuxiliaryWindowService, type IAuxiliaryWindow } from '../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ArtifactTitleActions } from './artifactTitleActions.js';
import { IArtifactPins } from './artifactPins.js';

type ArtifactFilter = 'all' | 'yours' | 'shared';

const pages = new WeakMap<Element, ArtifactEditorView>();
const artifactResultsIds = new IdGenerator('ash-artifacts-results-');

class ArtifactToggleActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		if (this.action.onDidChange) {
			this._register(this.action.onDidChange(() => { this.button.checked = this.action.checked; }));
		}
	}
}

export class ArtifactEditorPane extends EditorPane implements ISessionsEditorPage {
	public readonly id = 'sessions.editor.creator';
	public page!: ArtifactEditorView;
	public get titlebarContent(): HTMLElement { return this.page.titlebarContent; }
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) { super('sessions.editor.creator', themeService, storageService); }
	public override create(parent: HTMLElement): void {
		this.page = this._register(this.instantiation.createInstance(ArtifactEditorView, parent.ownerDocument));
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
export class ArtifactEditorView extends Disposable {
	public readonly domNode: HTMLElement;
	public get titlebarContent(): HTMLElement { return this.titlebar.domNode; }
	private readonly homeDomNode: HTMLElement;
	private readonly workspacesDomNode: HTMLElement;
	private readonly titlebar: ArtifactTitleBarWidget;
	private readonly titleListener = this._register(new MutableDisposable());
	private readonly catalogSources: readonly ArtifactCatalogSource[];
	private readonly creation: ChatCreationWidget;
	private readonly artifactsDomNode: HTMLElement;
	private readonly artifactCards = this._register(new DisposableStore());
	private readonly search: HTMLInputElement;
	private readonly sortAction: Action;
	private filter: ArtifactFilter = 'all';
	private readonly workspaces = this._register(new DisposableMap<string, IArtifactWorkspace>());
	private readonly popouts = this._register(new DisposableMap<IArtifactWorkspace, DisposableStore>());
	private readonly openingPopouts = new Map<IArtifactWorkspace, Promise<void>>();
	private readonly popoutPlaceholders = new Map<IArtifactWorkspace, HTMLElement>();
	private readonly titleActions: ArtifactTitleActions;
	private activeWorkspace: ArtifactWorkspaceRequest | undefined;
	private readonly examples = getArtifactExamples();
	private visible = false;
	private dimension: IDimension = { width: 0, height: 0 };
	public get activeWorkspaceId(): string | undefined { return this.activeWorkspace?.entryId; }
	public get detailsContainerId(): string | undefined { return this.currentWorkspace?.detailsContainerId; }
	private get currentWorkspace(): IArtifactWorkspace | undefined {
		return this.activeWorkspace && this.workspaces.get(this.activeWorkspace.key);
	}

	constructor(
		ownerDocument: Document,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IAuxiliaryWindowService private readonly auxiliaryWindows: IAuxiliaryWindowService,
		@IArtifactPins private readonly pins: IArtifactPins,
	) {
		super();
		this.catalogSources = createArtifactCatalogSources(instantiation);
		this.domNode = h(ownerDocument, 'section', { className: 'ash-creator', attributes: { role: 'region', 'aria-label': localize('sessions.creator.title', 'Artifacts') } });
		pages.set(this.domNode, this);
		this._register(contextKeys.createScoped(this.domNode)).createKey('sessionsCreatorFocused', true);
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Creator);
		if (hint) { this.domNode.setAttribute('aria-description', hint); }
		this.titlebar = this._register(instantiation.createInstance(ArtifactTitleBarWidget, ownerDocument,
			localize('sessions.creator.workspaceActions', 'Workspace actions'), Menus.ArtifactTitleBar));
		this.titlebar.setTitle(localize('sessions.creator.title', 'Artifacts'));
		this.titlebar.setActionsVisible(false);
		this.titleActions = instantiation.createInstance(ArtifactTitleActions);
		this._register(this.titleActions.onDidChangeHandoffAvailability(() => this.titlebar.closeTitleMenu()));
		const header = this.titlebar.domNode;
		pages.set(header, this);
		this._register(contextKeys.createScoped(header)).createKey('sessionsCreatorFocused', true);
		this._register(toDisposable(() => { pages.delete(header); }));
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
		this.creation = this._register(instantiation.createInstance(ChatCreationWidget, ownerDocument));
		this.artifactsDomNode = h(ownerDocument, 'section', { className: 'ash-artifacts-results', attributes: { id: panelId, role: 'tabpanel', 'aria-labelledby': `${panelId}-${this.filter}`, 'aria-live': 'polite' } });
		this.homeDomNode.append(toolbar, introduction, this.creation.domNode, this.artifactsDomNode);
		this.workspacesDomNode = h(ownerDocument, 'div', { className: 'ash-creator-workspaces' });
		this.workspacesDomNode.hidden = true;
		this.domNode.append(this.homeDomNode, this.workspacesDomNode);
		this._register(autorun(reader => {
			for (const source of this.catalogSources) {
				source.cards.read(reader);
				source.isRestoring?.read(reader);
				source.error?.read(reader);
			}
			this.renderArtifacts();
		}));
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
		return this.catalogSources.flatMap(source => source.cards.get());
	}

	private renderArtifacts(): void {
		if (!this.artifactsDomNode) { return; }
		this.artifactCards.clear();
		this.artifactsDomNode.replaceChildren();
		const query = this.search.value.trim().toLocaleLowerCase();
		const cards = this.filter === 'shared' ? [] : this.getArtifacts().filter(card => card.title.toLocaleLowerCase().includes(query));
		const exampleSection = this.filter === 'all' ? this.examples : undefined;
		const examples = exampleSection?.cards.filter(card => card.title.toLocaleLowerCase().includes(query)) ?? [];
		const restoring = this.filter !== 'shared' && this.catalogSources.some(source => source.isRestoring?.get());
		this.artifactsDomNode.setAttribute('aria-busy', String(restoring));
		for (const source of this.filter === 'shared' ? [] : this.catalogSources) {
			const error = source.error?.get();
			if (error) this.artifactsDomNode.append(h(this.domNode.ownerDocument, 'p', { className: 'ash-artifacts-empty', attributes: { role: 'status' } }, error));
		}
		const byTitle = (a: ArtifactCard, b: ArtifactCard) => a.title.localeCompare(b.title) * (this.sortAction.checked ? -1 : 1);
		cards.sort(byTitle);
		if (cards.length) {
			const grid = h(this.domNode.ownerDocument, 'div', { className: 'ash-artifacts-work-grid' });
			this.artifactsDomNode.append(grid);
			for (const card of cards) {
				this.renderCard(card, grid);
			}
		}
		if (exampleSection && examples.length) {
			this.artifactsDomNode.append(h(this.domNode.ownerDocument, 'h2', { className: 'ash-artifacts-examples-heading' }, exampleSection.heading));
			const grid = h(this.domNode.ownerDocument, 'div', { className: 'ash-artifacts-examples-grid' });
			this.artifactsDomNode.append(grid);
			for (const card of examples) {
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
		const button = this.artifactCards.add(new Button(container, { ...defaultButtonStyles, label: card.title, title: card.title, onClick: () => { void this.commands.executeCommand(card.command.id, ...card.command.args).catch(error => this.notifications.error(error)); } }));
		button.domNode.classList.add('ash-artifacts-card', card.kind);
		if (card.workspaceKey) { button.domNode.dataset.artifactWorkspace = card.workspaceKey; }
		if (card.generatedFileResource) button.domNode.dataset.generatedFileResource = card.generatedFileResource;
		button.domNode.prepend(this.createIllustration(card.kind));
		button.domNode.append(h(this.domNode.ownerDocument, 'span', { className: 'ash-artifacts-card-detail' }, card.detail));
		return button.domNode;
	}

	public initialize(): void {
		const restored = this.storage.get('sessions.creator.activeMode', StorageScope.WORKSPACE);
		if (restored !== undefined) {
			if (!getArtifactWorkspace(restored)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
			this.openMode(restored as ArtifactWorkspaceId);
		}
	}
	public static getFocused(element: HTMLElement): ArtifactEditorView | undefined {
		const root = element.closest('.ash-creator, .ash-sessions-titlebar-editor-page');
		return root ? pages.get(root) : undefined;
	}
	public openMode(mode: ArtifactWorkspaceId): void {
		const contribution = getArtifactWorkspace(mode)!;
		this.openWorkspace({ ...contribution, key: mode, entryId: mode, restoreMode: mode });
	}

	public openWorkspace(request: ArtifactWorkspaceRequest): void {
		let workspace = this.workspaces.get(request.key);
		if (!workspace) {
			workspace = request.mount(this.instantiation, this.workspacesDomNode);
			this.workspaces.set(request.key, workspace);
		}
		this.storage.store('sessions.creator.activeMode', request.restoreMode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.activeWorkspace = request;
		const identity = parseArtifactKey(request.key);
		const currentWorkspace = workspace;
		this.titlebar.setTitleActions(() => {
			const remove = currentWorkspace.delete;
			return this.titleActions.getActions({
				title: currentWorkspace.title,
				identity,
				getCodeAttachment: currentWorkspace.getCodeAttachment?.bind(currentWorkspace),
				popOut: () => this.popOut(currentWorkspace),
				rename: currentWorkspace.rename && (() => this.titlebar.beginRename()),
				delete: remove && (async () => {
					currentWorkspace.domNode.inert = true;
					try { await remove(); }
					catch (error) {
						currentWorkspace.domNode.inert = false;
						throw error;
					}
					if (identity) this.pins.setPinned(identity, false);
					this.popouts.deleteAndDispose(currentWorkspace);
					this.workspaces.deleteAndDispose(request.key);
					if (this.activeWorkspace?.key === request.key) {
						await this.commands.executeCommand('sessions.show.creator');
					}
				}),
			});
		}, () => currentWorkspace.rename);
		const updateTitle = () => this.titlebar.setTitle(currentWorkspace.title);
		this.titleListener.value = workspace.onDidChangeTitle?.(updateTitle);
		updateTitle();
		this.titlebar.setActions([], workspace.exportActions);
		this.updateVisibility();
		this.layout(this.dimension);
		if (this.visible) {
			workspace.focus();
			status(localize('sessions.creator.entered', '{0} workspace', request.title));
		}
	}

	public revealInitialContent(): void {
		if (this.visible) this.currentWorkspace?.revealInitialContent?.();
	}

	public showHome(): void {
		const previous = this.activeWorkspace;
		this.activeWorkspace = undefined;
		this.titleListener.clear();
		this.titlebar.setTitleActions(undefined);
		this.titlebar.setActions([]);
		this.titlebar.setTitle(localize('sessions.creator.title', 'Artifacts'));
		this.storage.remove('sessions.creator.activeMode', StorageScope.WORKSPACE);
		this.updateVisibility();
		this.renderArtifacts();
		if (previous) {
			const example = previous.key.startsWith('example:')
				? this.artifactsDomNode.querySelector<HTMLElement>(`[data-artifact-example="${previous.key.slice('example:'.length)}"]`)
				: undefined;
			const artifact = Array.from(this.artifactsDomNode.querySelectorAll<HTMLElement>('[data-artifact-workspace]'))
				.find(card => card.dataset.artifactWorkspace === previous.key);
			const previousCard = example ?? artifact;
			if (previousCard) previousCard.focus();
			else this.creation.focus(isArtifactKind(previous.restoreMode) ? previous.restoreMode : undefined);
		}
	}
	private updateVisibility(): void {
		this.homeDomNode.hidden = this.activeWorkspace !== undefined;
		this.workspacesDomNode.hidden = this.activeWorkspace === undefined;
		this.titlebar.setActionsVisible(this.activeWorkspace !== undefined);
		for (const [key, workspace] of this.workspaces) {
			const active = key === this.activeWorkspace?.key;
			const detached = this.popouts.has(workspace);
			const placeholder = this.popoutPlaceholders.get(workspace);
			if (placeholder) placeholder.hidden = !active;
			workspace.domNode.hidden = !active && !detached;
			workspace.setVisible(detached || this.visible && active);
		}
	}
	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) this.titlebar.resetTitleInteraction();
		this.updateVisibility();
	}
	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.classList.toggle('narrow', dimension.width < 600);
		this.domNode.classList.toggle('compact', dimension.width < 420);
		if (this.currentWorkspace && !this.popouts.has(this.currentWorkspace)) this.currentWorkspace.layout(dimension);
	}
	public focus(): void {
		if (this.currentWorkspace) { this.currentWorkspace.focus(); }
		else { this.creation.focus(); }
	}

	private async popOut(workspace: IArtifactWorkspace): Promise<void> {
		if (this.popouts.has(workspace)) {
			workspace.domNode.ownerDocument.defaultView?.focus();
			workspace.focus();
			return;
		}
		const pending = this.openingPopouts.get(workspace);
		if (pending) return pending;
		const opening = this.auxiliaryWindows.open({ title: workspace.title }).then(window => this.mountPopout(window, workspace));
		this.openingPopouts.set(workspace, opening);
		try { await opening; }
		finally { this.openingPopouts.delete(workspace); }
	}

	private mountPopout(window: IAuxiliaryWindow, workspace: IArtifactWorkspace): void {
		if (this.isDisposed || ![...this.workspaces].some(([, candidate]) => candidate === workspace)) {
			window.dispose();
			return;
		}
		const resources = this.popouts.set(workspace, new DisposableStore());
		const document = window.window.document;
		try {
			window.container.classList.add('ash-sessions-window', 'ash-artifact-popout');
			const header = h(document, 'header', { className: 'ash-artifact-popout-header' });
			const title = h(document, 'h1');
			header.append(title);
			const updateTitle = () => { title.textContent = title.title = document.title = workspace.title; };
			updateTitle();
			if (workspace.onDidChangeTitle) resources.add(workspace.onDidChangeTitle(updateTitle));
			const returnLabel = localize('sessions.artifacts.returnToWindow', 'Return to main window');
			resources.add(new Button(header, {
				...defaultButtonStyles, label: returnLabel, icon: Lxicon.screenNormal, iconOnly: true,
				onClick: () => window.window.close(),
			}));
			const body = h(document, 'div', { className: 'ash-artifact-popout-body' });
			const main = this.workspacesDomNode;
			const placeholder = h(main.ownerDocument, 'div', { className: 'ash-artifact-popout-placeholder' });
			const focusPopup = () => { window.window.focus(); workspace.focus(); };
			resources.add(new Button(placeholder, {
				...defaultButtonStyles, label: localize('sessions.artifacts.focusWindow', 'Artifact is open in another window'),
				onClick: focusPopup,
			}));
			main.insertBefore(placeholder, workspace.domNode);
			this.popoutPlaceholders.set(workspace, placeholder);
			window.container.append(header, body);
			resources.add(toDisposable(() => {
				this.popoutPlaceholders.delete(workspace);
				if (!this.isDisposed) {
					main.insertBefore(workspace.domNode, placeholder);
					this.updateVisibility();
					this.layout(this.dimension);
					if (this.visible && this.currentWorkspace === workspace) workspace.focus();
				}
				placeholder.remove();
				window.dispose();
			}));
			resources.add(window.onDidClose(() => this.popouts.deleteAndDispose(workspace)));
			resources.add(window.onWillLayout(dimension => workspace.layout({
				width: dimension.width, height: Math.max(0, dimension.height - header.offsetHeight),
			})));
			body.append(workspace.domNode);
			this.updateVisibility();
			window.layout();
			focusPopup();
		} catch (error) {
			this.popouts.deleteAndDispose(workspace);
			window.dispose();
			throw error;
		}
	}
	public getWorkspaceAccessibilityHelp(): string | undefined {
		return this.currentWorkspace?.getAccessibilityHelp?.() ?? (!this.activeWorkspace && this.filter === 'all' ? this.examples?.accessibilityHelp : undefined);
	}

	public getAccessibleContent(): string {
		if (this.activeWorkspace) {
			const { help } = this.activeWorkspace;
			return [this.currentWorkspace?.title, help, this.currentWorkspace?.getAccessibleContent()].filter(Boolean).join('\n');
		}
		const cards = this.filter === 'all' ? [...this.getArtifacts(), ...(this.examples?.cards ?? [])] : this.filter === 'yours' ? this.getArtifacts() : [];
		return [localize('sessions.creator.title', 'Artifacts'), ...artifactKinds.map(getArtifactTitle), ...cards.map(card => `${card.title}: ${card.detail}`)].join('\n');
	}
	protected override disposeCore(): void { pages.delete(this.domNode); super.disposeCore(); this.domNode.remove(); }
}
