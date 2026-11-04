import { addDisposableListener, Dimension, type IDimension } from '../../../base/browser/dom.js';
import { Direction, Orientation, SerializableGrid, Sizing, type ISerializableView, type SerializedGridDescriptor } from '../../../base/browser/ui/grid/grid.js';
import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { Part } from '../../../workbench/browser/part.js';
import { NoWorkbenchPartFrameInsets, WorkbenchPartView, type WorkbenchPartFrameInsets } from '../../../workbench/browser/workbenchPartView.js';
import type { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { EDITOR_PART_MINIMUM_WIDTH } from './editorPartSizing.js';
import './media/desktopEditorArea.css';

const toolFrameInset = 6;
const toolFrameInsets = { top: toolFrameInset, right: toolFrameInset, bottom: toolFrameInset, left: toolFrameInset };

export type DesktopEditorTool = 'files' | 'changes' | 'browser' | 'terminal' | 'chat';
export const desktopEditorTools: readonly DesktopEditorTool[] = ['files', 'changes', 'browser', 'terminal', 'chat'];

export interface ToolSlot {
	readonly anchors: readonly DesktopEditorTool[];
	readonly opposite: readonly DesktopEditorTool[];
	readonly orientation: Orientation;
	readonly after: boolean;
	readonly ratio: number;
}

class ToolPartView extends WorkbenchPartView<DesktopEditorTool> implements ISerializableView {
	constructor(tool: DesktopEditorTool, private readonly editor: EditorPart, private readonly container: HTMLElement) {
		super(tool, editor);
		container.append(this.frame);
		this.setFrameInsets(toolFrameInsets);
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
		return this.partId === 'chat' ? Math.max(super.minimumWidth, EDITOR_PART_MINIMUM_WIDTH + 2 * toolFrameInset) : super.minimumWidth;
	}
}

type ToolBranch = Extract<SerializedGridDescriptor, { type: 'branch'; }>;
type ToolLeaf = Extract<SerializedGridDescriptor, { type: 'leaf'; }>;

function toolLeaves(node: SerializedGridDescriptor): ToolLeaf[] {
	return node.type === 'leaf' ? [node] : node.children.flatMap(toolLeaves);
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
export class DesktopEditorArea extends Part {
	private readonly grid = this._register(new MutableDisposable<SerializableGrid<ToolPartView>>());
	private readonly gridConstraints = this._register(new MutableDisposable());
	private reportedMinimum = new Dimension(EDITOR_PART_MINIMUM_WIDTH, 120);
	private readonly views = new Map<DesktopEditorTool, ToolPartView>();
	private dimension: IDimension = new Dimension(0, 0);
	private desired = new Set<DesktopEditorTool>();
	private maximized: { readonly tool: DesktopEditorTool; readonly layout: SerializedGridDescriptor; } | undefined;
	private dragging: DesktopEditorTool | undefined;
	private active: DesktopEditorTool | undefined;
	private compactLayout: SerializedGridDescriptor | undefined;
	private compact: 'stack' | 'single' | undefined;
	private readonly positioned = new Set<DesktopEditorTool>();
	private slots: Partial<Record<DesktopEditorTool, ToolSlot>> = {};
	private firstTool: DesktopEditorTool | undefined;
	private pendingInitialWidth = false;
	private restoringPlacement: 'legacy' | 'saved' | undefined;
	private manuallyArranged = false;
	private updatingVisibility = false;

	constructor(container: HTMLElement, @IThemeService theme: IThemeService, @IStorageService private readonly toolStorage: IStorageService) {
		super(container, 'editor', theme, toolStorage);
		this.titleDomNode.hidden = true;
		this.domNode.classList.add('ash-desktop-editor-area');
	}

	public override get minimumWidth(): number { return Math.max(EDITOR_PART_MINIMUM_WIDTH, this.grid.value?.minimumWidth ?? 0); }
	public override get minimumHeight(): number { return Math.max(120, this.grid.value?.minimumHeight ?? 0); }

	private setGrid(grid: SerializableGrid<ToolPartView>): void {
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

	public addTool(tool: DesktopEditorTool, part: EditorPart, container: HTMLElement): void {
		const view = new ToolPartView(tool, part, container);
		view.element.classList.add('ash-tool-editor-workspace');
		view.element.dataset.editorTool = tool;
		part.domNode.dataset.part = 'tool-editor';
		this.views.set(tool, view);
		if (!this.grid.value) {
			this.setGrid(new SerializableGrid(this.contentDomNode, { type: 'leaf', view, size: 600 }, { preserveSplitWeights: true }));
		} else if (tool === 'chat') {
			this.replaceGrid(this.addChatToLayout(this.grid.value.serialize()));
		} else {
			this.grid.value.addView(view, Sizing.Invisible(300), [...this.views.values()][this.views.size - 2]!, Direction.Down);
		}
		this._register(addDisposableListener(view.element, 'keydown', event => {
			if (event.defaultPrevented || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey ||
				!(event.target instanceof view.element.ownerDocument.defaultView!.Element) || !event.target.closest('.ash-editor-title-control')) { return; }
			const direction = ({ ArrowLeft: Direction.Left, ArrowRight: Direction.Right, ArrowUp: Direction.Up, ArrowDown: Direction.Down } as Record<string, Direction | undefined>)[event.key];
			if (direction === undefined) { return; }
			const neighbor = this.grid.value!.getNeighborViews(view, direction).find(candidate => this.desired.has(candidate.partId));
			if (!neighbor) { return; }
			event.preventDefault();
			this.moveTool(tool, neighbor.partId, direction);
		}));
		this._register(addDisposableListener(view.element, 'dragstart', event => {
			if (!event.altKey || !(event.target instanceof view.element.ownerDocument.defaultView!.Element) || !event.target.closest('.ash-editor-title-control') || event.target.closest('[role="tab"], button, input, a')) { return; }
			this.dragging = tool;
			event.stopPropagation();
			event.dataTransfer?.setData('application/vnd.ash.editor-tool', tool);
		}, true));
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
		this._register(addDisposableListener(view.element, 'dragend', () => { this.dragging = undefined; }));
	}

	/** Read constraints from the saved topology while the window is showing a temporary arrangement. */
	private expandedMinimum(axis: Orientation): number {
		const measure = (node: SerializedGridDescriptor): number => {
			if (node.type === 'leaf') {
				const tool = node.data as DesktopEditorTool;
				if (!this.desired.has(tool)) return 0;
				const view = this.views.get(tool)!;
				return axis === Orientation.HORIZONTAL ? view.minimumWidth : view.minimumHeight;
			}
			const sizes = node.children.map(measure);
			return node.orientation === axis ? sizes.reduce((sum, size) => sum + size, 0) : Math.max(...sizes);
		};
		return measure(this.saveLayout());
	}

	public get expandedMinimumWidth(): number {
		return this.maximized ? this.currentMinimumWidth
			: Math.max(EDITOR_PART_MINIMUM_WIDTH, this.expandedMinimum(Orientation.HORIZONTAL));
	}

	public get currentMinimumWidth(): number {
		const tool = this.currentTool;
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, tool ? this.views.get(tool)!.minimumWidth : 0);
	}

	public get hasTools(): boolean { return this.desired.size > 0; }

	private get currentTool(): DesktopEditorTool | undefined {
		return this.maximized?.tool ?? this.active ?? this.desired.values().next().value;
	}

	public isToolVisible(tool: DesktopEditorTool): boolean {
		return !(this.compact && this.domNode.hidden) && (this.grid.value?.isViewVisible(this.views.get(tool)!) ?? false);
	}

	public focusCurrentTool(): void {
		const tool = this.currentTool;
		if (tool) this.views.get(tool)!.focus();
	}

	public get expandedMinimumHeight(): number {
		return this.maximized ? this.views.get(this.maximized.tool)!.minimumHeight : this.expandedMinimum(Orientation.VERTICAL);
	}

	public get stackedMinimumHeight(): number {
		return [...this.desired].reduce((height, tool) => height + this.views.get(tool)!.minimumHeight, 0);
	}

	public get stackedMinimumWidth(): number {
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, ...[...this.desired].map(tool => this.views.get(tool)!.minimumWidth));
	}

	public takeInitialWidth(available: number): number | undefined {
		if (!this.pendingInitialWidth || !this.firstTool) return undefined;
		this.pendingInitialWidth = false;
		const saved = this.toolStorage.getNumber(`sessions.layout.toolShare.${this.firstTool}`, StorageScope.PROFILE);
		const share = saved !== undefined && saved > 0 && saved < 1
			? saved : this.firstTool === 'terminal' || this.firstTool === 'chat' ? 1 / 3 : 3 / 5;
		return Math.round(available * share);
	}

	public rememberWidth(share: number): void {
		if (this.firstTool && share > 0 && share < 1) {
			this.toolStorage.store(`sessions.layout.toolShare.${this.firstTool}`, share, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	public setCompact(compact: 'stack' | 'single' | undefined): void {
		if (this.compact === compact) return;
		this.compact = compact;
		this.applyVisibility();
	}

	public syncVisible(tools: readonly DesktopEditorTool[], active: DesktopEditorTool | undefined, productPage: boolean): void {
		const files = this.views.get('files')!;
		const frameChanged = files.element.classList.contains('ash-product-page-host') !== productPage;
		files.element.classList.toggle('ash-product-page-host', productPage);
		files.setFrameInsets(productPage ? NoWorkbenchPartFrameInsets : toolFrameInsets);
		const place = !productPage;
		if (active && !tools.includes(active)) active = undefined;
		const previous = this.desired;
		const restoring = this.restoringPlacement;
		this.restoringPlacement = undefined;
		const changed = frameChanged || active !== this.active || tools.length !== previous.size || tools.some(tool => !previous.has(tool));
		if (!restoring && place) {
			const layout = this.withDesiredVisibility(this.saveLayout());
			for (const tool of previous) {
				if (tools.includes(tool)) continue;
				const slot = this.findSlot(layout, tool);
				if (slot) this.slots[tool] = slot;
				else delete this.slots[tool];
			}
		}
		this.active = active;
		this.desired = new Set(tools);
		if (!tools.length) {
			this.firstTool = undefined;
			this.pendingInitialWidth = false;
		} else if (!previous.size && place) {
			this.firstTool = active ?? tools[0];
			this.pendingInitialWidth = !restoring;
		}
		if (this.maximized && !this.desired.has(this.maximized.tool)) this.toggleMaximize(this.maximized.tool);
		this.updatingVisibility = true;
		try {
			if (tools.length === 2 && place && !this.manuallyArranged && restoring === 'legacy') this.stackToolPair();
			for (const tool of tools) {
				if (!restoring && place && !previous.has(tool)) {
					const slot = this.slots[tool];
					if (slot) {
						if (!this.restoreSlot(tool, slot)) this.placeTool(tool);
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
		if (changed) this.notifyConstraintsChanged();
		this.applyVisibility();
		this.layout(this.dimension);
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
		const visible = (node: SerializedGridDescriptor) => toolLeaves(node).some(leaf => opened.has(leaf.data));
		const columns = layout.type === 'branch' && layout.orientation === Orientation.HORIZONTAL ? layout.children.filter(visible) : [layout];
		const last = columns.at(-1)!;
		const cards = toolLeaves(last).filter(leaf => opened.has(leaf.data));
		const canStack = this.dimension.height === 0 || this.dimension.height >= [...cards.map(card => card.data as DesktopEditorTool), tool]
			.reduce((height, id) => height + this.views.get(id)!.minimumHeight, 0);
		if (cards.length === 1 && canStack) {
			this.reposition(layout, tool, last, Orientation.VERTICAL, true);
		} else {
			this.reposition(layout, tool, layout, Orientation.HORIZONTAL, true);
		}
	}

	private applyVisibility(): void {
		const current = this.currentTool;
		this.updatingVisibility = true;
		try {
			if (this.compact && current && !this.maximized) {
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
					this.grid.value!.setViewVisible(view, this.desired.has(tool) && (!this.maximized || this.maximized.tool === tool));
				}
			}
		} finally {
			this.updatingVisibility = false;
		}
		this.publishMinimumSize();
	}

	private withDesiredVisibility(node: SerializedGridDescriptor): SerializedGridDescriptor {
		return mapToolLayout(node, node => node.type === 'leaf'
			? { ...node, visible: this.desired.has(node.data as DesktopEditorTool) } : node)!;
	}

	private reposition(layout: SerializedGridDescriptor, tool: DesktopEditorTool, target: SerializedGridDescriptor, orientation: Orientation, after: boolean, ratio?: number, parent?: ToolBranch): void {
		const source = toolLeaves(layout).find(leaf => leaf.data === tool)!;
		const isVisibleSibling = (node: SerializedGridDescriptor): boolean =>
			toolLeaves(node).some(leaf => leaf.visible && leaf.data !== tool);
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
		if (this.maximized) this.maximized = { tool: this.maximized.tool, layout: next };
		else if (this.compact) this.compactLayout = next;
		else this.replaceGrid(next);
	}

	public moveTool(tool: DesktopEditorTool, target: DesktopEditorTool, direction: Direction): void {
		if (this.compact) return;
		this.manuallyArranged = true;
		const focused = this.domNode.ownerDocument.activeElement;
		this.grid.value!.moveView(this.views.get(tool)!, Sizing.Split, this.views.get(target)!, direction);
		if (focused instanceof this.domNode.ownerDocument.defaultView!.HTMLElement && focused.isConnected) { focused.focus(); }
	}

	public toggleMaximize(tool: DesktopEditorTool): void {
		if (this.maximized) {
			const saved = this.maximized.layout;
			this.maximized = undefined;
			this.replaceGrid(saved);
			if (this.compact) this.compactLayout = saved;
		} else {
			this.maximized = { tool, layout: this.saveLayout() };
		}
		this.applyVisibility();
		this.layout(this.dimension);
		this.notifyConstraintsChanged();
	}

	public saveLayout(): SerializedGridDescriptor { return this.maximized?.layout ?? (this.compactLayout ? this.withDesiredVisibility(this.compactLayout) : this.grid.value!.serialize()); }

	public validateLayout(layout: unknown, allowMissingChat = false): void {
		const seen = new Set<string>();
		const validate = (node: unknown, depth: number, parentOrientation?: number): void => {
			if (!isRecord(node) || depth > 32 || typeof node.size !== 'number'
				|| !Number.isFinite(node.size) || node.size < 0 || ![0, 1, 2].includes(node.priority as number)) {
				throw new TypeError('Invalid tool workspace layout');
			}
			if (node.type === 'leaf') {
				if (typeof node.visible !== 'boolean' || !desktopEditorTools.includes(node.data as DesktopEditorTool) || seen.has(node.data as string)) {
					throw new TypeError('Invalid tool workspace identity');
				}
				seen.add(node.data as string);
			} else if (node.type === 'branch' && [0, 1].includes(node.orientation as number)
				&& node.orientation !== parentOrientation && Array.isArray(node.children) && node.children.length) {
				node.children.forEach(child => validate(child, depth + 1, node.orientation as number));
			} else {
				throw new TypeError('Invalid tool workspace layout');
			}
		};
		validate(layout, 0);
		if (allowMissingChat ? seen.has('chat') || seen.size !== this.views.size - 1 : seen.size !== this.views.size) { throw new TypeError('Tool workspace layout is incomplete'); }
	}

	/** Older tool layouts predate the rightmost Chat workspace. */
	public addChatToLayout(layout: SerializedGridDescriptor): SerializedGridDescriptor {
		this.validateLayout(layout, true);
		const chat = { type: 'leaf', data: 'chat', size: 300, priority: 0, visible: false } as const;
		return layout.type === 'branch' && layout.orientation === 1
			? { ...layout, children: [...layout.children, chat] }
			: { type: 'branch', orientation: 1, size: layout.size, priority: 0, children: [layout, chat] };
	}

	public get positionedTools(): readonly DesktopEditorTool[] { return [...this.positioned]; }
	public get hasManualArrangement(): boolean { return this.manuallyArranged; }
	public get closedSlots(): Readonly<Partial<Record<DesktopEditorTool, ToolSlot>>> { return { ...this.slots }; }

	public restoreLayout(layout: SerializedGridDescriptor, positioned?: readonly DesktopEditorTool[], manuallyArranged?: boolean, slots: Readonly<Partial<Record<DesktopEditorTool, ToolSlot>>> = {}): void {
		this.validateLayout(layout);
		this.slots = { ...slots };
		this.positioned.clear();
		for (const tool of positioned ?? toolLeaves(layout).filter(leaf => leaf.visible).map(leaf => leaf.data as DesktopEditorTool)) {
			this.positioned.add(tool);
		}
		this.manuallyArranged = manuallyArranged ?? false;
		this.restoringPlacement = manuallyArranged === undefined ? 'legacy' : 'saved';
		this.pendingInitialWidth = false;
		this.maximized = undefined;
		this.compactLayout = this.compact ? layout : undefined;
		this.replaceGrid(layout);
		if (!this.compact) this.layout(this.dimension);
	}

	private replaceGrid(layout: SerializedGridDescriptor): void {
		const focused = this.domNode.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.domNode.contains(focused);
		const previous = this.grid.value;
		const next = SerializableGrid.deserialize(this.contentDomNode, layout, { fromJSON: data => this.views.get(data as DesktopEditorTool)! }, { preserveSplitWeights: true });
		this.setGrid(next);
		previous?.element.remove();
		if (restoreFocus && focused.isConnected && !focused.closest('[hidden]')) focused.focus({ preventScroll: true });
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.grid.value?.layout(dimension.width, dimension.height);
	}
}
