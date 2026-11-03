import { addDisposableListener, Dimension, type IDimension } from '../../../base/browser/dom.js';
import { Direction, SerializableGrid, Sizing, type ISerializableView, type SerializedGridDescriptor } from '../../../base/browser/ui/grid/grid.js';
import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { Part } from '../../../workbench/browser/part.js';
import { WorkbenchPartView } from '../../../workbench/browser/workbenchPartView.js';
import type { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import './media/desktopEditorArea.css';

export type DesktopEditorTool = 'files' | 'changes' | 'browser' | 'terminal' | 'chat';
export const desktopEditorTools: readonly DesktopEditorTool[] = ['files', 'changes', 'browser', 'terminal', 'chat'];

class ToolPartView extends WorkbenchPartView<DesktopEditorTool> implements ISerializableView {
	constructor(tool: DesktopEditorTool, part: EditorPart, private readonly container: HTMLElement) {
		super(tool, part);
		container.append(this.frame);
		this.setFrameInsets({ top: 6, right: 6, bottom: 6, left: 6 });
	}
	public override get element(): HTMLElement { return this.container; }
}

/** Owns only the geometry of independent tool editor hosts, never their groups or documents. */
export class DesktopEditorArea extends Part {
	private readonly grid = this._register(new MutableDisposable<SerializableGrid<ToolPartView>>());
	private readonly gridConstraints = this._register(new MutableDisposable());
	private reportedMinimum = new Dimension(300, 120);
	private readonly views = new Map<DesktopEditorTool, ToolPartView>();
	private dimension: IDimension = new Dimension(0, 0);
	private desired = new Set<DesktopEditorTool>();
	private maximized: { readonly tool: DesktopEditorTool; readonly layout: SerializedGridDescriptor; } | undefined;
	private dragging: DesktopEditorTool | undefined;

	constructor(container: HTMLElement, @IThemeService theme: IThemeService, @IStorageService storage: IStorageService) {
		super(container, 'editor', theme, storage);
		this.titleDomNode.hidden = true;
		this.domNode.classList.add('ash-desktop-editor-area');
	}

	public override get minimumWidth(): number { return Math.max(300, this.grid.value?.minimumWidth ?? 0); }
	public override get minimumHeight(): number { return Math.max(120, this.grid.value?.minimumHeight ?? 0); }

	private setGrid(grid: SerializableGrid<ToolPartView>): void {
		this.gridConstraints.clear();
		this.grid.value = grid;
		this.gridConstraints.value = grid.onDidChange(() => this.publishMinimumSize());
		this.publishMinimumSize();
	}

	private publishMinimumSize(): void {
		const minimum = new Dimension(this.minimumWidth, this.minimumHeight);
		if (Dimension.equals(minimum, this.reportedMinimum)) return;
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
			this.setGrid(new SerializableGrid(this.contentDomNode, { type: 'leaf', view, size: 600 }));
		} else if (tool === 'chat') {
			this.restoreLayout(this.addChatToLayout(this.grid.value.serialize()));
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

	public syncVisible(tools: readonly DesktopEditorTool[]): void {
		this.desired = new Set(tools);
		if (this.maximized && !this.desired.has(this.maximized.tool)) { this.restoreLayout(this.maximized.layout); this.maximized = undefined; }
		for (const [tool, view] of this.views) {
			this.grid.value!.setViewVisible(view, this.desired.has(tool) && (!this.maximized || this.maximized.tool === tool));
		}
		this.layout(this.dimension);
	}

	public moveTool(tool: DesktopEditorTool, target: DesktopEditorTool, direction: Direction): void {
		const focused = this.domNode.ownerDocument.activeElement;
		this.grid.value!.moveView(this.views.get(tool)!, Sizing.Split, this.views.get(target)!, direction);
		if (focused instanceof this.domNode.ownerDocument.defaultView!.HTMLElement && focused.isConnected) { focused.focus(); }
	}

	public toggleMaximize(tool: DesktopEditorTool): void {
		if (this.maximized) {
			const saved = this.maximized.layout;
			this.maximized = undefined;
			this.restoreLayout(saved);
		} else {
			this.maximized = { tool, layout: this.saveLayout() };
		}
		this.syncVisible([...this.desired]);
	}

	public saveLayout(): SerializedGridDescriptor { return this.maximized?.layout ?? this.grid.value!.serialize(); }

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

	public restoreLayout(layout: SerializedGridDescriptor): void {
		this.validateLayout(layout);
		this.maximized = undefined;
		const previous = this.grid.value;
		const next = SerializableGrid.deserialize(this.contentDomNode, layout, { fromJSON: data => this.views.get(data as DesktopEditorTool)! });
		this.setGrid(next);
		previous?.element.remove();
		this.layout(this.dimension);
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.grid.value?.layout(dimension.width, dimension.height);
	}
}
