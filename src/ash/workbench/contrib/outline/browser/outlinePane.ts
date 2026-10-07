import './outlinePane.css';
import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import type { TreeElement } from '../../../../base/browser/ui/tree/tree.js';
import { TreeFindMode } from '../../../../base/browser/ui/tree/tree.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IEditorPane } from '../../../common/editor.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IOutlineService, OutlineTarget, type IOutline } from '../../../services/outline/browser/outline.js';
import { ctxFocused, OutlineSortOrder } from './outline.js';
import { OutlineViewState } from './outlineViewState.js';

/** Owns the tree, selection and request lifetime for the active Workbench editor. */
export class OutlinePane extends ViewPane {
	public readonly outlineViewState: OutlineViewState;
	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private readonly rowResources = this._register(new DisposableStore());
	private readonly emptyDomNode: HTMLDivElement;
	private tree: WorkbenchObjectTree<unknown> | undefined;
	private outline: IOutline<unknown> | undefined;
	private editor: IEditorPane | undefined;
	private generation = 0;
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IEditorPart private readonly editorPart: IEditorPart,
		@IOutlineService private readonly outlines: IOutlineService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService context: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IHoverService private readonly hover: IHoverService,
		@IContextMenuService menus: IContextMenuService,
		@ILogService private readonly log: ILogService,
	) {
		super(container, { ...options, headerActionsVisibility: 'whenExpanded' });
		this.contentElement.classList.add('ash-outline');
		this.emptyDomNode = h(container.ownerDocument, 'div');
		this.emptyDomNode.className = 'ash-outline-message';
		this.emptyDomNode.tabIndex = 0;
		this.emptyDomNode.setAttribute('role', 'status');
		this.contentElement.append(this.emptyDomNode);
		ctxFocused.bindTo(this._register(context.createScoped(this.contentElement))).set(true);
		this.outlineViewState = this._register(instantiation.createInstance(OutlineViewState));
		this.toolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, menus, { ariaLabel: localize('outline.actions', 'Outline Actions') }));
		this.updateActions();
		this._register(this.outlineViewState.onDidChange(() => {
			this.updateActions();
			this.render();
		}));
		this._register(this.onDidChangeBodyVisibility(() => void this.update()));
		this._register(editorPart.onDidChangeEditors(() => void this.update()));
		this._register(outlines.onDidChange(() => { this.editor = undefined; void this.update(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Outline)) this.updateAriaLabel();
		}));
		this.updateAriaLabel();
	}

	public override focus(): void {
		if (this.tree && !this.tree.element.hidden) this.tree.domFocus();
		else this.emptyDomNode.focus();
	}

	public collapseAll(): void { for (const node of this.tree?.model.rootNodes ?? []) this.tree!.collapseRecursive(node.id); }
	public expandAll(): void { for (const node of this.tree?.model.rootNodes ?? []) this.tree!.expandRecursive(node.id); }

	public getAccessibleContent(): string {
		const lines: string[] = [];
		const visit = (parent: unknown, depth: number): void => {
			for (const element of this.outline?.config.treeDataSource.getChildren(parent) ?? []) {
				const label = this.outline!.config.options.keyboardNavigationLabelProvider?.getKeyboardNavigationLabel(element);
				lines.push(`${'  '.repeat(depth)}${typeof label === 'string' ? label : label?.join(', ') ?? ''}`);
				visit(element, depth + 1);
			}
		};
		if (this.outline) visit(this.outline, 0);
		return [localize('outline.title', 'Outline'), lines.join('\n') || this.emptyDomNode.textContent].join('\n');
	}

	private async update(): Promise<void> {
		const editor = this.editorPart.activePane;
		if (this.isBodyVisible() && editor === this.editor && this.session.value) return;
		this.generation++;
		this.session.clear();
		this.rowResources.clear();
		this.tree = undefined;
		this.outline = undefined;
		this.editor = editor;
		if (!this.isBodyVisible()) return;
		this.emptyDomNode.hidden = false;
		this.emptyDomNode.textContent = localize('outline.noEditor', 'The active editor cannot provide outline information.');
		if (!editor || !this.outlines.canCreateOutline(editor)) return;
		const generation = this.generation;
		const lifetime = new DisposableStore();
		this.session.value = lifetime;
		const token = new CancellationTokenSource();
		lifetime.add(toDisposable(() => token.dispose(true)));
		this.emptyDomNode.textContent = localize('outline.loading', 'Loading document symbols…');
		try {
			const outline = await this.outlines.createOutline(editor, OutlineTarget.OutlinePane, token.token);
			if (this.isDisposed || generation !== this.generation || token.token.isCancellationRequested) { outline?.dispose(); return; }
			if (!outline) { this.emptyDomNode.textContent = localize('outline.noEditor', 'The active editor cannot provide outline information.'); return; }
			lifetime.add(outline);
			this.outline = outline;
			const tree = lifetime.add(new WorkbenchObjectTree<unknown>(this.contentElement, {
				...outline.config.options,
				configurationService: this.configuration,
				openOnSingleClick: true,
				onWillRender: () => this.rowResources.clear(),
				renderElement: (element, node) => {
					const row = outline.config.options.renderElement(element, node);
					this.rowResources.add(this.hover.setupDelayedHover(row, { content: row.textContent ?? '' }));
					return row;
				},
			}));
			this.tree = tree;
			tree.element.classList.add('ash-outline-tree');
			lifetime.add(addDisposableListener(tree.element, 'keydown', (event: KeyboardEvent) => {
				if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { stopEvent(event); tree.openFind(); }
			}));
			lifetime.add(toDisposable(() => tree.element.remove()));
			lifetime.add(tree.onDidOpen(event => {
				void Promise.resolve(outline.reveal(event.element, event.editorOptions, event.sideBySide, true)).catch(error => this.log.error('outline', 'Could not reveal symbol', error));
			}));
			lifetime.add(outline.onDidChange(event => {
				if (event.affectOnlyActiveElement) this.followCursor();
				else this.render();
			}));
			this.updateAriaLabel();
			this.render();
		} catch (error) {
			if (generation !== this.generation || token.token.isCancellationRequested || isCancellationError(error)) return;
			this.emptyDomNode.textContent = localize('outline.failed', 'Could not load document symbols.');
			this.log.error('outline', 'Could not load outline', error);
		}
	}

	private render(): void {
		const { tree, outline } = this;
		if (!tree || !outline) return;
		const { comparator, treeDataSource } = outline.config;
		let compare = comparator.compareByPosition;
		if (this.outlineViewState.sortBy === OutlineSortOrder.ByName) compare = comparator.compareByName;
		else if (this.outlineViewState.sortBy === OutlineSortOrder.ByKind) compare = comparator.compareByType;
		const children = (parent: IOutline<unknown> | unknown): TreeElement<unknown>[] => [...treeDataSource.getChildren(parent)].sort(compare).map(element => ({ element, children: children(element) }));
		const focused = tree.focus;
		const selected = tree.selection;
		tree.setChildren(children(outline));
		const identity = outline.config.options.modelOptions.identityProvider!;
		if (focused !== undefined && tree.model.has(identity.getId(focused))) tree.setFocus(identity.getId(focused));
		tree.setSelection(selected.map(element => identity.getId(element)).filter(id => tree.model.has(id)));
		tree.findMode = this.outlineViewState.filterOnType ? TreeFindMode.Filter : TreeFindMode.Highlight;
		this.emptyDomNode.textContent = localize('outline.noSymbols', 'No symbols found in the current document.');
		this.emptyDomNode.hidden = !outline.isEmpty;
		tree.element.hidden = outline.isEmpty;
		this.followCursor();
	}

	private followCursor(): void {
		if (!this.outlineViewState.followCursor || !this.tree || !this.outline?.activeElement) return;
		const id = this.outline.config.options.modelOptions.identityProvider!.getId(this.outline.activeElement);
		if (!this.tree.model.has(id)) return;
		this.tree.expandTo(id);
		this.tree.setSelection([id]);
		if (!this.hasFocus()) this.tree.setFocus(id);
	}

	private updateAriaLabel(): void {
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Outline);
		const label = localize('outline.title', 'Outline');
		this.tree?.element.setAttribute('aria-label', hint ? `${label}. ${hint}` : label);
		this.emptyDomNode.setAttribute('aria-label', hint ? `${label}. ${hint}` : label);
	}

	private updateActions(): void {
		const follow = localize('outline.followCursor', 'Follow Cursor');
		const collapse = localize('outline.collapseAll', 'Collapse All');
		const expand = localize('outline.expandAll', 'Expand All');
		const filter = localize('outline.filterOnType', 'Filter on Type');
		this.toolbar.setActions([
			{ id: 'outline.collapse', label: collapse, tooltip: collapse, icon: Lxicon.chevronUp, enabled: true, run: () => this.collapseAll() },
		], [
			{ id: 'outline.expand', label: expand, tooltip: expand, enabled: true, run: () => this.expandAll() },
			{ id: 'outline.followCursor', label: follow, tooltip: follow, enabled: true, checked: this.outlineViewState.followCursor, run: () => { this.outlineViewState.followCursor = !this.outlineViewState.followCursor; } },
			{ id: 'outline.filterOnType', label: filter, tooltip: filter, enabled: true, checked: this.outlineViewState.filterOnType, run: () => { this.outlineViewState.filterOnType = !this.outlineViewState.filterOnType; } },
			...[OutlineSortOrder.ByPosition, OutlineSortOrder.ByName, OutlineSortOrder.ByKind].map(sort => {
				const labels = [localize('outline.sortPosition', 'Sort by Position'), localize('outline.sortName', 'Sort by Name'), localize('outline.sortKind', 'Sort by Type')];
				const label = labels[sort]!;
				return { id: `outline.sort.${sort}`, label, tooltip: label, enabled: true, checked: this.outlineViewState.sortBy === sort, run: () => { this.outlineViewState.sortBy = sort; } };
			}),
		]);
	}
}
