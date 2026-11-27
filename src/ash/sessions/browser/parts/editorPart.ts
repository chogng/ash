import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { Direction, Orientation, SerializableGrid, Sizing, type ISerializableView, type SerializedGridDescriptor } from '../../../base/browser/ui/grid/grid.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { EditorPart as WorkbenchEditorPart, type IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import { EDITOR_PART_MINIMUM_WIDTH } from './editorPartSizing.js';
import { Emitter } from '../../../base/common/event.js';
import type { IEditorPane, IResourceEditorInput } from '../../../workbench/common/editor.js';
import type { EditorGroupView } from '../../../workbench/browser/parts/editor/editorGroupView.js';
import type { IEditorGroupEmptyStateContext, IEditorGroupView } from '../../../workbench/browser/parts/editor/editor.js';
import { EmptyEditorGroupAddTab } from '../../../workbench/browser/parts/sessions/emptyEditorGroupAddTab.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import { addDisposableListener, Dimension, type IDimension } from '../../../base/browser/dom.js';
import { MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { Part } from '../../../workbench/browser/part.js';
import { NoWorkbenchPartFrameInsets, WorkbenchPartView, type WorkbenchPartFrameInsets } from '../../../workbench/browser/workbenchPartView.js';
import { SessionsConfiguration, type SessionsLayoutStyle } from '../../common/configuration.js';
import type { DesktopEditorTool } from '../../common/contextkeys.js';
import { EditorHasMultipleToolsContext, Menus } from '../menus.js';

/** An editor page can supply its own window title and actions. The pane retains ownership of the element. */
export interface ISessionsEditorPage extends IEditorPane {
	readonly titlebarContent: HTMLElement;
}

/** Composes the Add Tab empty state in the owning editor group's command scope. */
export function createEmptyEditorGroupAddTab(context: IEditorGroupEmptyStateContext, instantiationService: IInstantiationService): EmptyEditorGroupAddTab {
	return instantiationService.createInstance(EmptyEditorGroupAddTab,
		context.document, context.groupId, Menus.SessionsEmptyEditorGroupAddTab, context.contextKeyService, context.contextMenuProvider);
}

/** Sessions keeps product pages alive independently of per-session document restoration. */
export class EditorPart extends WorkbenchEditorPart {
	public readonly pageGroupId: number;
	private readonly revealActiveEditor = this._register(new Emitter<void>());
	public readonly onDidRevealActiveEditor = this.revealActiveEditor.event;

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService uriIdentity: IUriIdentityService,
	) {
		super(container, options, instantiation, themeService, storageService, uriIdentity);
		// The retained page group participates in the same window-local ID allocator.
		const pages = this.insertGroup(this.activeGroup, Direction.Right).group;
		this.pageGroupId = pages.id;
		pages.setLocked(true);
		this.setGroupVisible(pages.id, false);
		this._register(this.onDidChangeEditors(event => {
			if (this.isDisposed || event.kind !== 'groupRemoved' || this.groups.length !== 1 || this.groups[0]!.id !== this.pageGroupId) { return; }
			// Working-set restoration temporarily detaches every group. Recreate a document host only
			// when the retained product group is actually the sole live group after a close.
			const documents = this.insertGroup(this.groups[0]!, Direction.Left).group;
			const productVisible = this.isGroupVisible(this.pageGroupId);
			this.setGroupVisible(documents.id, !productVisible);
			if (!productVisible) { this.activateGroup(documents.id); }
		}));
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.setEditorContentVisible(visible);
	}

	public override get minimumWidth(): number { return Math.max(EDITOR_PART_MINIMUM_WIDTH, super.minimumWidth); }

	protected override removeEmptyGroup(group: EditorGroupView): void {
		// Product entries reopen into this group even after its last tab closes.
		if (group.id !== this.pageGroupId) super.removeEmptyGroup(group);
	}

	public override removeGroup(group: IEditorGroupView | number): Promise<boolean> {
		const id = typeof group === 'number' ? group : group.id;
		return id === this.pageGroupId ? Promise.resolve(false) : super.removeGroup(group);
	}

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		const previous = this.activePane;
		const pane = await super.openEditor(input, options, target);
		// Reopening the same tab emits no active-editor change. Sessions may have
		// hidden its editor area meanwhile, so its layout owner still needs to reveal it.
		if (pane === previous && pane === this.activePane && !options.inactive && !options.preserveFocus && !this.isModalEditorVisible) {
			this.revealActiveEditor.fire();
		}
		return pane;
	}
}

const toolFrameInset = 6;
const conversationWeight = 2;
const modernToolFrameInsets = { top: toolFrameInset, right: toolFrameInset, bottom: toolFrameInset, left: toolFrameInset };
const toolGridOptions = {
	preserveSplitWeights: true,
	styles: { separatorBorder: 'var(--ash-sessions-tool-separator, var(--ash-contrastBorder, var(--ash-editorGroup-border)))' },
};

export interface ToolSlot {
	readonly anchors: readonly DesktopEditorTool[];
	readonly opposite: readonly DesktopEditorTool[];
	readonly orientation: Orientation;
	readonly after: boolean;
	readonly ratio: number;
}

class ToolPartView extends WorkbenchPartView<DesktopEditorTool> implements ISerializableView {
	constructor(tool: DesktopEditorTool, private readonly editor: WorkbenchEditorPart, private readonly container: HTMLElement) {
		super(tool, editor);
		container.append(this.frame);
	}
	public override get element(): HTMLElement { return this.container; }
	public focus(): void { this.editor.focus(); }

	public override setFrameInsets(insets: WorkbenchPartFrameInsets): void {
		super.setFrameInsets(insets);
		// The chat composer offsets its padding by the actual symmetric frame inset.
		this.container.style.setProperty('--ash-sessions-editor-tool-inset', `${insets.left}px`);
	}
	public override get minimumWidth(): number {
		// The session composer needs its usable width inside the tool frame.
		const composerWidth = this.partId === 'chat' ? Math.max(0, EDITOR_PART_MINIMUM_WIDTH - this.editor.minimumWidth) : 0;
		return super.minimumWidth + composerWidth;
	}
}

type ToolBranch = Extract<SerializedGridDescriptor, { type: 'branch'; }>;
type ToolLeaf = Extract<SerializedGridDescriptor, { type: 'leaf'; }>;

function toolLeaves(node: SerializedGridDescriptor): ToolLeaf[] {
	return node.type === 'leaf' ? [node] : node.children.flatMap(toolLeaves);
}

function toolColumns(layout: SerializedGridDescriptor, isVisible: (leaf: ToolLeaf) => boolean): SerializedGridDescriptor[] {
	const columns = layout.type === 'branch' && layout.orientation === Orientation.HORIZONTAL ? layout.children : [layout];
	return columns.filter(column => toolLeaves(column).some(isVisible));
}

function mapToolLayout(node: SerializedGridDescriptor, map: (node: SerializedGridDescriptor) => SerializedGridDescriptor | undefined): SerializedGridDescriptor | undefined {
	if (node.type === 'leaf') return map(node);
	const children = node.children.flatMap(child => mapToolLayout(child, map) ?? []);
	return map({ ...node, children });
}

function normalizeToolLayout(node: SerializedGridDescriptor): SerializedGridDescriptor | undefined {
	return mapToolLayout(node, node => {
		if (node.type === 'leaf') return node;
		const children = node.children.flatMap(child =>
			child.type === 'branch' && child.orientation === node.orientation ? child.children : [child]);
		if (!children.length) return undefined;
		if (children.length === 1) return { ...children[0]!, size: node.size };
		return { ...node, children };
	});
}

/** Owns only the geometry of independent tool editor hosts, never their groups or documents. */
export class EditorArea extends Part {
	private readonly grid = this._register(new MutableDisposable<SerializableGrid<ToolPartView>>());
	private readonly gridConstraints = this._register(new MutableDisposable());
	private reportedMinimum = new Dimension(EDITOR_PART_MINIMUM_WIDTH, 120);
	private readonly views = new Map<DesktopEditorTool, ToolPartView>();
	private readonly titlebarToolChanged = this._register(new Emitter<void>());
	public readonly onDidChangeTitlebarTool = this.titlebarToolChanged.event;
	private topTool: DesktopEditorTool | undefined;
	private dimension: IDimension = new Dimension(0, 0);
	private desired = new Set<DesktopEditorTool>();
	private contentAvailable = false;
	private readonly multipleToolsContext;
	private dragging: DesktopEditorTool | undefined;
	private active: DesktopEditorTool | undefined;
	private compactLayout: SerializedGridDescriptor | undefined;
	private compact: 'stack' | 'single' | undefined;
	private readonly positioned = new Set<DesktopEditorTool>();
	private slots: Partial<Record<DesktopEditorTool, ToolSlot>> = {};
	private firstTool: DesktopEditorTool | undefined;
	private toolWidthWeight: number | undefined;
	private restoringPlacement: 'legacy' | 'saved' | undefined;
	private manuallyArranged = false;
	private updatingVisibility = false;

	constructor(
		container: HTMLElement,
		@IThemeService theme: IThemeService,
		@IStorageService private readonly toolStorage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(container, 'editor', theme, toolStorage);
		this.multipleToolsContext = EditorHasMultipleToolsContext.bindTo(contextKeys);
		this._register(toDisposable(() => this.multipleToolsContext.reset()));
		this.titleDomNode.hidden = true;
		this.domNode.classList.add('ash-desktop-editor-area');
		this._register(addDisposableListener(container.ownerDocument, 'keydown', event => {
			const target = event.target;
			if (!(target instanceof container.ownerDocument.defaultView!.Element) || !target.closest('.ash-editor-tab-strip-hosted')) return;
			const view = this.topTool && this.views.get(this.topTool);
			if (view) this.moveToolFromHeader(event, view);
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(SessionsConfiguration.layoutStyle)) return;
			for (const [tool, view] of this.views) {
				view.setFrameInsets(this.toolFrameInsets(tool));
			}
			this.layout(this.dimension);
			this.publishMinimumSize();
		}));
	}

	public override get minimumWidth(): number { return Math.max(EDITOR_PART_MINIMUM_WIDTH, this.grid.value?.minimumWidth ?? 0); }
	public override get minimumHeight(): number { return Math.max(120, this.grid.value?.minimumHeight ?? 0); }

	private toolFrameInsets(tool: DesktopEditorTool): WorkbenchPartFrameInsets {
		const modern = this.configuration.getValue<SessionsLayoutStyle>(SessionsConfiguration.layoutStyle) === 'modern';
		return modern && !(tool === 'files' && this.hasProductPage) ? modernToolFrameInsets : NoWorkbenchPartFrameInsets;
	}

	private setGrid(grid: SerializableGrid<ToolPartView>): void {
		grid.element.hidden = !this.contentAvailable;
		this.gridConstraints.clear();
		this.grid.value = grid;
		this.gridConstraints.value = grid.onDidChange(() => this.publishMinimumSize());
		this.publishMinimumSize();
	}

	private publishMinimumSize(): void {
		const minimum = new Dimension(this.minimumWidth, this.minimumHeight);
		if (this.updatingVisibility || Dimension.equals(minimum, this.reportedMinimum)) return;
		this.reportedMinimum = minimum;
		// The window grid must reserve space for the visible tool groups and their frames.
		this.notifyConstraintsChanged();
	}

	public addTool(tool: DesktopEditorTool, part: WorkbenchEditorPart, container: HTMLElement): void {
		const view = new ToolPartView(tool, part, container);
		view.setFrameInsets(this.toolFrameInsets(tool));
		view.element.classList.add('ash-tool-editor-workspace', 'ash-sessions-tool-editor');
		view.element.dataset.editorTool = tool;
		part.domNode.dataset.part = 'tool-editor';
		this.views.set(tool, view);
		if (!this.grid.value) {
			this.setGrid(new SerializableGrid(this.contentDomNode, { type: 'leaf', view, size: 600 }, toolGridOptions));
		} else if (tool === 'chat' || tool === 'search') {
			this.replaceGrid(this.addMissingToolsToLayout(this.grid.value.serialize(), [tool]));
		} else {
			this.grid.value.addView(view, Sizing.Invisible(300), [...this.views.values()][this.views.size - 2]!, Direction.Down);
		}
		const isHeader = (target: Element) => !!target.closest('.ash-editor-title-control, .ash-editor-group-header');
		this._register(addDisposableListener(view.element, 'dragstart', event => {
			if (!event.altKey || !(event.target instanceof view.element.ownerDocument.defaultView!.Element) || !isHeader(event.target) || event.target.closest('[role="tab"], button, input, a')) { return; }
			this.dragging = tool;
			event.stopPropagation();
			event.dataTransfer?.setData('application/vnd.ash.editor-tool', tool);
		}, true));
		this._register(addDisposableListener(view.element, 'dragend', () => { this.dragging = undefined; }));
		this._register(addDisposableListener(view.element, 'keydown', event => {
			if (event.target instanceof view.element.ownerDocument.defaultView!.Element && isHeader(event.target)) this.moveToolFromHeader(event, view);
		}));
		this._register(addDisposableListener(view.element, 'dragover', event => {
			if (this.dragging && this.dragging !== tool) { event.preventDefault(); event.stopPropagation(); }
		}));
		this._register(addDisposableListener(view.element, 'drop', event => {
			if (!this.dragging || this.dragging === tool) { return; }
			event.preventDefault(); event.stopPropagation();
			const bounds = view.element.getBoundingClientRect();
			const x = (event.clientX - bounds.left) / bounds.width;
			const y = (event.clientY - bounds.top) / bounds.height;
			const direction = Math.min(x, 1 - x) < Math.min(y, 1 - y) ? (x < 0.5 ? Direction.Left : Direction.Right) : (y < 0.5 ? Direction.Up : Direction.Down);
			this.moveTool(this.dragging, tool, direction);
			this.dragging = undefined;
		}));
	}

	/** Read constraints from the saved topology while the window is showing a temporary arrangement. */
	private expandedMinimum(node: SerializedGridDescriptor, axis: Orientation): number {
		if (node.type === 'leaf') {
			const tool = node.data as DesktopEditorTool;
			if (!this.desired.has(tool)) return 0;
			const view = this.views.get(tool)!;
			return axis === Orientation.HORIZONTAL ? view.minimumWidth : view.minimumHeight;
		}
		const sizes = node.children.map(child => this.expandedMinimum(child, axis));
		return node.orientation === axis ? sizes.reduce((sum, size) => sum + size, 0) : Math.max(...sizes);
	}

	public get expandedMinimumWidth(): number {
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, this.expandedMinimum(this.saveLayout(), Orientation.HORIZONTAL));
	}

	public get currentMinimumWidth(): number {
		const tool = this.currentTool;
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, tool ? this.views.get(tool)!.minimumWidth : 0);
	}

	public get hasTools(): boolean { return this.desired.size > 0; }
	public get hasContent(): boolean { return this.contentAvailable; }
	public get hasProductPage(): boolean { return this.domNode.classList.contains('has-product-page'); }

	/** A strip can use the titlebar region when its tool owns the full top edge. */
	public get titlebarTool(): DesktopEditorTool | undefined { return this.topTool; }

	private updateTitlebarTool(): void {
		const grid = this.grid.value;
		const tool = grid && [...this.views.values()].find(view => this.isToolVisible(view.partId)
			&& [Direction.Up, Direction.Left, Direction.Right].every(direction => !grid.getNeighborViews(view, direction).length))?.partId;
		if (this.topTool === tool) return;
		this.topTool = tool;
		this.titlebarToolChanged.fire();
	}

	private get currentTool(): DesktopEditorTool | undefined {
		return this.active ?? this.desired.values().next().value;
	}

	public isToolVisible(tool: DesktopEditorTool): boolean {
		return !(this.compact && this.domNode.hidden) && (this.grid.value?.isViewVisible(this.views.get(tool)!) ?? false);
	}

	public focusCurrentTool(): void {
		const tool = this.currentTool;
		if (tool) this.views.get(tool)!.focus();
	}

	public get expandedMinimumHeight(): number {
		return this.expandedMinimum(this.saveLayout(), Orientation.VERTICAL);
	}

	public get stackedMinimumHeight(): number {
		return [...this.desired].reduce((height, tool) => height + this.views.get(tool)!.minimumHeight, 0);
	}

	public get stackedMinimumWidth(): number {
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, ...[...this.desired].map(tool => this.views.get(tool)!.minimumWidth));
	}

	private initialToolWeight(): number {
		const saved = this.firstTool && this.toolStorage.getNumber(`sessions.layout.toolShare.${this.firstTool}`, StorageScope.PROFILE);
		if (typeof saved === 'number' && saved > 0 && saved < 1) return conversationWeight * saved / (1 - saved);
		return this.firstTool === 'terminal' || this.firstTool === 'chat' ? 1 : 3;
	}

	/** Allocate the conversation and the visible tool columns on the same width budget. */
	public getPreferredWidth(available: number, conversationMinimum: number, previousWidth: number): number {
		// Working sets saved before width weights used the outer Grid's stored pixel width.
		const previousShare = previousWidth / available;
		this.toolWidthWeight ??= previousShare > 0 && previousShare < 1
			? conversationWeight * previousShare / (1 - previousShare) : this.initialToolWeight();
		const columns = toolColumns(this.saveLayout(), leaf => this.desired.has(leaf.data as DesktopEditorTool));
		const columnTotal = columns.reduce((sum, column) => sum + (column.size || 1), 0);
		const toolWeight = this.toolWidthWeight;
		const constraints = columns.map(column => ({
			weight: toolWeight * ((column.size || 1) / columnTotal),
			minimum: this.expandedMinimum(column, Orientation.HORIZONTAL),
		}));
		// A column at its minimum takes that width out of the shared budget first.
		let width = available;
		let weight = conversationWeight + toolWeight;
		for (const column of constraints.sort((a, b) => b.minimum / b.weight - a.minimum / a.weight)) {
			if (width * column.weight / weight >= column.minimum) break;
			width -= column.minimum;
			weight -= column.weight;
		}
		const conversation = Math.max(conversationMinimum, width * conversationWeight / weight);
		return Math.max(this.minimumWidth, Math.round(available - conversation));
	}

	public get preferredWidthWeight(): number | undefined { return this.toolWidthWeight; }

	public rememberWidth(share: number): void {
		if (!this.hasTools || this.hasProductPage || !(share > 0 && share < 1)) return;
		this.toolWidthWeight = conversationWeight * share / (1 - share);
		if (this.firstTool && this.desired.has(this.firstTool) && toolColumns(this.saveLayout(), leaf => leaf.visible).length === 1) {
			this.toolStorage.store(`sessions.layout.toolShare.${this.firstTool}`, share, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	public setCompact(compact: 'stack' | 'single' | undefined): void {
		if (this.compact === compact) return;
		this.compact = compact;
		this.applyVisibility();
	}

	public syncVisible(tools: readonly DesktopEditorTool[], active: DesktopEditorTool | undefined, productPage: boolean, hasContent: boolean): void {
		const files = this.views.get('files')!;
		const frameChanged = this.hasProductPage !== productPage;
		files.element.classList.toggle('ash-product-page-host', productPage);
		this.domNode.classList.toggle('has-product-page', productPage);
		files.setFrameInsets(this.toolFrameInsets('files'));
		const place = !productPage;
		if (active && !tools.includes(active)) active = undefined;
		const previous = this.desired;
		const openingAutomaticPair = !this.manuallyArranged && previous.size === 1 && tools.length === 2
			&& tools.some(tool => previous.has(tool));
		const restoring = this.restoringPlacement;
		this.restoringPlacement = undefined;
		const changed = frameChanged || hasContent !== this.contentAvailable || active !== this.active
			|| tools.length !== previous.size || tools.some(tool => !previous.has(tool));
		if (!restoring && place) {
			const layout = this.withDesiredVisibility(this.saveLayout());
			for (const tool of previous) {
				if (tools.includes(tool)) continue;
				const slot = this.findSlot(layout, tool);
				if (slot) this.slots[tool] = slot;
				else delete this.slots[tool];
			}
			if (!frameChanged && this.toolWidthWeight !== undefined) {
				const columns = toolColumns(layout, leaf => leaf.visible);
				const total = columns.reduce((sum, column) => sum + (column.size || 1), 0);
				const retained = columns.filter(column => toolLeaves(column).some(leaf => leaf.visible && tools.includes(leaf.data as DesktopEditorTool)))
					.reduce((sum, column) => sum + (column.size || 1), 0);
				if (retained < total) this.toolWidthWeight = retained ? this.toolWidthWeight * (retained / total) : undefined;
			}
		}
		this.active = active;
		this.desired = new Set(tools);
		// Keep individual close actions available when a narrow layout shows a subset of the tools.
		this.multipleToolsContext.set(place && this.desired.size > 1);
		this.contentAvailable = hasContent;
		this.grid.value!.element.hidden = !hasContent;
		if (!tools.length) {
			this.firstTool = undefined;
			this.toolWidthWeight = undefined;
		} else if (restoring && place) {
			this.firstTool = toolLeaves(this.saveLayout()).find(leaf => this.desired.has(leaf.data as DesktopEditorTool))?.data as DesktopEditorTool | undefined;
		} else if (place && !tools.some(tool => previous.has(tool))) {
			this.firstTool = active ?? tools[0];
			this.toolWidthWeight = this.initialToolWeight();
		}
		this.updatingVisibility = true;
		try {
			if (tools.length === 2 && place && !this.manuallyArranged && restoring === 'legacy') this.stackToolPair();
			for (const tool of tools) {
				if (!restoring && place && !previous.has(tool)) {
					const slot = this.slots[tool];
					if (slot) {
						const stacksBelow = slot.orientation === Orientation.VERTICAL && slot.after;
						if (openingAutomaticPair && !stacksBelow || !this.restoreSlot(tool, slot)) this.placeTool(tool);
						delete this.slots[tool];
					} else if (!this.manuallyArranged || !this.positioned.has(tool)) {
						this.placeTool(tool);
					}
				}
				if (place) this.positioned.add(tool);
			}
		} finally {
			this.updatingVisibility = false;
		}
		this.applyVisibility();
		this.layout(this.dimension);
		if (changed || restoring) this.notifyConstraintsChanged();
	}

	/** Repair an automatic pair without changing a recorded manual split. */
	private stackToolPair(): void {
		const layout = this.withDesiredVisibility(this.saveLayout());
		const leaves = toolLeaves(layout).filter(leaf => leaf.visible);
		const [first, second] = leaves;
		if (!first || !second) return;
		const fits = this.dimension.height === 0 || this.stackedMinimumHeight <= this.dimension.height;
		if (!fits) return;
		let split = layout;
		while (split.type === 'branch') {
			const shared = split.children.find(child => {
				const leaves = toolLeaves(child);
				return leaves.includes(first) && leaves.includes(second);
			});
			if (!shared) break;
			split = shared;
		}
		if (split.type === 'branch' && split.orientation === Orientation.HORIZONTAL) {
			this.reposition(layout, second.data as DesktopEditorTool, first, Orientation.VERTICAL, true);
		}
	}

	private findSlot(layout: SerializedGridDescriptor, tool: DesktopEditorTool): ToolSlot | undefined {
		let node = layout;
		let slot: ToolSlot | undefined;
		while (node.type === 'branch') {
			const children = node.children.filter(child => toolLeaves(child).some(leaf => leaf.visible));
			const index = children.findIndex(child => toolLeaves(child).some(leaf => leaf.data === tool));
			if (index < 0) break;
			const source = children[index]!;
			if (children.length > 1) {
				const after = index > 0;
				const anchor = children[after ? index - 1 : index + 1]!;
				const siblingSize = children.reduce((sum, child) => sum + (child === source ? 0 : child.size), 0);
				slot = {
					anchors: toolLeaves(anchor).filter(leaf => leaf.visible).map(leaf => leaf.data as DesktopEditorTool),
					opposite: after && children[index + 1]
						? toolLeaves(children[index + 1]!).filter(leaf => leaf.visible).map(leaf => leaf.data as DesktopEditorTool) : [],
					orientation: node.orientation, after,
					ratio: source.size > 0 && siblingSize > 0 ? Math.min(1000, Math.max(0.001, source.size / siblingSize)) : 1,
				};
			}
			node = source;
		}
		return slot;
	}

	private restoreSlot(tool: DesktopEditorTool, slot: ToolSlot): boolean {
		const layout = this.saveLayout();
		const anchors = slot.anchors.filter(anchor => this.desired.has(anchor));
		if (!anchors.length) return false;
		let target = layout;
		let parent: ToolBranch | undefined;
		while (target.type === 'branch') {
			const child = target.children.find(candidate => anchors.every(anchor =>
				toolLeaves(candidate).some(leaf => leaf.data === anchor)));
			if (!child) break;
			parent = target;
			target = child;
		}
		if (parent?.orientation === Orientation.HORIZONTAL && parent.orientation === slot.orientation) {
			const siblings = parent.children.filter(child => child === target ||
				toolLeaves(child).some(leaf => leaf.data !== tool && this.desired.has(leaf.data as DesktopEditorTool)));
			const opposite = siblings[siblings.indexOf(target) + (slot.after ? 1 : -1)];
			if (opposite && !toolLeaves(opposite).some(leaf => slot.opposite.includes(leaf.data as DesktopEditorTool))) return false;
		}
		// A surviving neighbor identifies a branch, even when a split was collapsed on close.
		this.reposition(layout, tool, target, slot.orientation, slot.after, slot.ratio, parent);
		return true;
	}

	private placeTool(tool: DesktopEditorTool): void {
		const layout = this.saveLayout();
		const leaves = toolLeaves(layout);
		const opened = new Set(leaves.filter(leaf => leaf.visible && leaf.data !== tool && this.desired.has(leaf.data as DesktopEditorTool)).map(leaf => leaf.data));
		if (!opened.size) return;
		const columns = toolColumns(layout, leaf => opened.has(leaf.data));
		const last = columns.at(-1)!;
		const cards = toolLeaves(last).filter(leaf => opened.has(leaf.data));
		const canStack = this.dimension.height === 0 || this.dimension.height >= [...cards.map(card => card.data as DesktopEditorTool), tool]
			.reduce((height, id) => height + this.views.get(id)!.minimumHeight, 0);
		if (cards.length === 1 && canStack) {
			this.reposition(layout, tool, last, Orientation.VERTICAL, true);
		} else {
			const toolWeight = this.toolWidthWeight ?? this.initialToolWeight();
			this.reposition(layout, tool, layout, Orientation.HORIZONTAL, true, 1 / toolWeight);
		}
	}

	private applyVisibility(): void {
		const current = this.currentTool;
		this.updatingVisibility = true;
		try {
			if (this.compact && current) {
				this.compactLayout ??= this.grid.value!.serialize();
				const leaves = toolLeaves(this.withDesiredVisibility(this.compactLayout));
				const visible = this.compact === 'stack' ? leaves.filter(leaf => leaf.visible).length : 1;
				const size = Math.max(1, this.dimension.height / Math.max(visible, 1));
				const children = leaves.map(leaf => ({
					...leaf, size, visible: leaf.visible && (this.compact === 'stack' || leaf.data === current),
				}));
				const grid = this.grid.value!;
				const projection = grid.serialize();
				if (projection.type !== 'branch' || projection.orientation !== Orientation.VERTICAL ||
					projection.children.length !== children.length || projection.children.some((node, index) =>
						node.type !== 'leaf' || node.data !== children[index]!.data || node.visible !== children[index]!.visible)) {
					this.replaceGrid({ type: 'branch', orientation: Orientation.VERTICAL, size: this.dimension.width, priority: 0, children });
				}
			} else {
				if (this.compactLayout) {
					const saved = this.withDesiredVisibility(this.compactLayout);
					this.compactLayout = undefined;
					this.replaceGrid(saved);
				}
				for (const [tool, view] of this.views) {
					this.grid.value!.setViewVisible(view, this.desired.has(tool));
				}
			}
		} finally {
			this.updatingVisibility = false;
		}
		this.publishMinimumSize();
		this.updateTitlebarTool();
	}

	private withDesiredVisibility(node: SerializedGridDescriptor): SerializedGridDescriptor {
		return mapToolLayout(node, node => node.type === 'leaf'
			? { ...node, visible: this.desired.has(node.data as DesktopEditorTool) } : node)!;
	}

	private reposition(layout: SerializedGridDescriptor, tool: DesktopEditorTool, target: SerializedGridDescriptor, orientation: Orientation, after: boolean, ratio?: number, parent?: ToolBranch): void {
		const source = toolLeaves(layout).find(leaf => leaf.data === tool)!;
		const isVisibleSibling = (node: SerializedGridDescriptor): boolean =>
			toolLeaves(node).some(leaf => leaf.visible && leaf.data !== tool && this.desired.has(leaf.data as DesktopEditorTool));
		const restoreShare = (children: readonly SerializedGridDescriptor[], available: number, ratio: number) => {
			const total = children.reduce((sum, child) => sum + (isVisibleSibling(child) ? child.size : 0), 0);
			const siblingSpace = (available || total || 2) / (1 + ratio);
			const visibleCount = children.filter(isVisibleSibling).length;
			return {
				moved: { ...source, size: siblingSpace * ratio, visible: true },
				resize: (child: SerializedGridDescriptor) => isVisibleSibling(child)
					? { ...child, size: total ? siblingSpace * child.size / total : siblingSpace / visibleCount }
					: child,
			};
		};
		const move = (node: SerializedGridDescriptor, width: number, height: number): SerializedGridDescriptor | undefined => {
			if (node.type === 'leaf' && node.data === tool) return undefined;
			const available = orientation === Orientation.VERTICAL ? height : width;
			const moveChild = (child: SerializedGridDescriptor) => node.type === 'branch' && node.orientation === Orientation.HORIZONTAL
				? move(child, child.size, height)
				: move(child, width, child.size);
			if (ratio !== undefined && node.type === 'branch' && node === parent && node.orientation === orientation) {
				const { moved, resize } = restoreShare(node.children.filter(child => child !== source), available, ratio);
				return {
					...node, children: node.children.flatMap(child => {
						const remaining = moveChild(child);
						if (!remaining) return [];
						const resized = resize(remaining);
						if (child !== target) return [resized];
						return after ? [resized, moved] : [moved, resized];
					})
				};
			}
			const insertBeside = ratio !== undefined && parent?.orientation === orientation;
			const remaining = node.type === 'leaf' ? node : { ...node, children: node.children.flatMap(child => moveChild(child) ?? []) };
			if (node !== target || insertBeside) return remaining;
			if (ratio !== undefined) {
				const siblings = remaining.type === 'branch' && remaining.orientation === orientation ? remaining.children : [remaining];
				const { moved, resize } = restoreShare(siblings, available, ratio);
				const children = siblings.map(resize);
				return { type: 'branch', orientation, size: node.size, priority: node.priority, children: after ? [...children, moved] : [moved, ...children] };
			}
			const size = Math.max(1, Math.floor((orientation === Orientation.VERTICAL ? this.dimension.height : this.dimension.width) / 2));
			const moved = { ...source, size, visible: true };
			if (remaining.type === 'branch' && remaining.orientation === orientation) {
				const visible = remaining.children.filter(isVisibleSibling);
				const inserted = orientation === Orientation.VERTICAL && visible.length === 1 ? { ...moved, size: visible[0]!.size } : moved;
				return { ...remaining, children: after ? [...remaining.children, inserted] : [inserted, ...remaining.children] };
			}
			const sibling = { ...remaining, size };
			return { type: 'branch', orientation, size: node.size, priority: node.priority, children: after ? [sibling, moved] : [moved, sibling] };
		};
		const next = normalizeToolLayout(move(layout, this.dimension.width, this.dimension.height)!);
		if (!next) return;
		if (orientation === Orientation.HORIZONTAL && ratio !== undefined) {
			const visible = (leaf: ToolLeaf) => leaf.visible && this.desired.has(leaf.data as DesktopEditorTool);
			if (toolColumns(next, visible).length > toolColumns(layout, leaf => leaf.data !== tool && visible(leaf)).length) {
				this.toolWidthWeight = (this.toolWidthWeight ?? this.initialToolWeight()) * (1 + ratio);
			}
		}
		if (this.compact) this.compactLayout = next;
		else this.replaceGrid(next);
	}

	public moveTool(tool: DesktopEditorTool, target: DesktopEditorTool, direction: Direction): void {
		if (this.compact) return;
		this.manuallyArranged = true;
		const focused = this.domNode.ownerDocument.activeElement;
		this.grid.value!.moveView(this.views.get(tool)!, Sizing.Split, this.views.get(target)!, direction);
		this.updateTitlebarTool();
		if (focused instanceof this.domNode.ownerDocument.defaultView!.HTMLElement && focused.isConnected) { focused.focus(); }
	}

	private moveToolFromHeader(event: KeyboardEvent, view: ToolPartView): void {
		if (event.defaultPrevented || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
		const direction = ({ ArrowLeft: Direction.Left, ArrowRight: Direction.Right, ArrowUp: Direction.Up, ArrowDown: Direction.Down } as Record<string, Direction | undefined>)[event.key];
		if (direction === undefined) return;
		const neighbor = this.grid.value?.getNeighborViews(view, direction).find(candidate => this.desired.has(candidate.partId));
		if (!neighbor) return;
		event.preventDefault();
		this.moveTool(view.partId, neighbor.partId, direction);
	}

	public saveLayout(): SerializedGridDescriptor { return this.compactLayout ? this.withDesiredVisibility(this.compactLayout) : this.grid.value!.serialize(); }

	public validateLayout(layout: unknown, missing: readonly DesktopEditorTool[] = [], legacyChanges = false): void {
		const seen = new Set<DesktopEditorTool | 'changes'>();
		const validate = (node: unknown, depth: number, parentOrientation?: number): void => {
			if (!isRecord(node) || depth > 32 || typeof node.size !== 'number'
				|| !Number.isFinite(node.size) || node.size < 0 || ![0, 1, 2].includes(node.priority as number)) {
				throw new TypeError('Invalid tool workspace layout');
			}
			if (node.type === 'leaf') {
				const tool = node.data as DesktopEditorTool | 'changes';
				if (typeof node.visible !== 'boolean' || !(tool === 'changes' ? legacyChanges : this.views.has(tool)) || seen.has(tool)) {
					throw new TypeError('Invalid tool workspace identity');
				}
				seen.add(tool);
			} else if (node.type === 'branch' && [0, 1].includes(node.orientation as number)
				&& node.orientation !== parentOrientation && Array.isArray(node.children) && node.children.length) {
				node.children.forEach(child => validate(child, depth + 1, node.orientation as number));
			} else {
				throw new TypeError('Invalid tool workspace layout');
			}
		};
		validate(layout, 0);
		const expected = [...this.views.keys()].filter(tool => !missing.includes(tool));
		if (seen.size !== expected.length + Number(legacyChanges) || expected.some(tool => !seen.has(tool))) { throw new TypeError('Tool workspace layout is incomplete'); }
	}

	public migrateChangesLayout(layout: SerializedGridDescriptor, missing: readonly DesktopEditorTool[]): { layout: SerializedGridDescriptor; filesVisible: boolean; changesVisible: boolean; } {
		this.validateLayout(layout, missing, true);
		const leaves = toolLeaves(layout);
		const filesVisible = leaves.some(leaf => leaf.data === 'files' && leaf.visible);
		const changesVisible = leaves.some(leaf => leaf.data === 'changes' && leaf.visible);
		// A Changes-only layout keeps its position. With both open, keep the Files position.
		const keepChangesPosition = changesVisible && !filesVisible;
		const projected = mapToolLayout(layout, node => {
			if (node.type !== 'leaf') return node;
			if (node.data === 'files' && keepChangesPosition) return undefined;
			if (node.data === 'changes') return keepChangesPosition ? { ...node, data: 'files' } : undefined;
			return node;
		});
		return { layout: normalizeToolLayout(projected!)!, filesVisible, changesVisible };
	}

	/** Append newly registered tools while retaining the saved splits of existing tools. */
	public addMissingToolsToLayout(layout: SerializedGridDescriptor, missing: readonly DesktopEditorTool[]): SerializedGridDescriptor {
		this.validateLayout(layout, missing);
		const leaves = missing.map(tool => ({ type: 'leaf', data: tool, size: 300, priority: 0, visible: false } as const));
		return layout.type === 'branch' && layout.orientation === 1
			? { ...layout, children: [...layout.children, ...leaves] }
			: { type: 'branch', orientation: 1, size: layout.size, priority: 0, children: [layout, ...leaves] };
	}

	public get positionedTools(): readonly DesktopEditorTool[] { return [...this.positioned]; }
	public get hasManualArrangement(): boolean { return this.manuallyArranged; }
	public get closedSlots(): Readonly<Partial<Record<DesktopEditorTool, ToolSlot>>> { return { ...this.slots }; }

	public restoreLayout(layout: SerializedGridDescriptor, positioned?: readonly DesktopEditorTool[], manuallyArranged?: boolean, slots: Readonly<Partial<Record<DesktopEditorTool, ToolSlot>>> = {}, widthWeight?: number): void {
		this.validateLayout(layout);
		this.slots = { ...slots };
		this.positioned.clear();
		for (const tool of positioned ?? toolLeaves(layout).filter(leaf => leaf.visible).map(leaf => leaf.data as DesktopEditorTool)) {
			this.positioned.add(tool);
		}
		this.manuallyArranged = manuallyArranged ?? false;
		this.restoringPlacement = manuallyArranged === undefined ? 'legacy' : 'saved';
		this.toolWidthWeight = widthWeight;
		this.compactLayout = this.compact ? layout : undefined;
		this.replaceGrid(layout);
		if (!this.compact) this.layout(this.dimension);
	}

	private replaceGrid(layout: SerializedGridDescriptor): void {
		const focused = this.domNode.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.domNode.contains(focused);
		const previous = this.grid.value;
		const next = SerializableGrid.deserialize(this.contentDomNode, layout, { fromJSON: data => this.views.get(data as DesktopEditorTool)! }, toolGridOptions);
		this.setGrid(next);
		previous?.element.remove();
		if (restoreFocus && focused.isConnected && !focused.closest('[hidden]')) focused.focus({ preventScroll: true });
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.grid.value?.layout(dimension.width, dimension.height);
		this.updateTitlebarTool();
	}
}
