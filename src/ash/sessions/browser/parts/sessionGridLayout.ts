import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { Orientation } from '../../../base/browser/ui/sash/sash.js';
import { scheduleAtNextAnimationFrame, isHTMLElement, type IDimension } from '../../../base/browser/dom.js';
import { Direction, SerializableGrid, Sizing, type GridDescriptor, type ISerializableView, type IView } from '../../../base/browser/ui/grid/grid.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { loadSessionGridLayout, saveSessionGridLayout, type SessionGridNode } from '../../services/sessions/browser/sessionGridState.js';

interface ISessionGridEntry {
	readonly id: string;
	readonly view: IView;
}

/** Owns conversation geometry, independently of document editors and their tabs. */
export class SessionGridLayout extends Disposable {
	readonly element: HTMLElement;
	private readonly grid = this._register(new MutableDisposable<SerializableGrid<SessionGridItem>>());
	private readonly gridListener = this._register(new MutableDisposable<IDisposable>());
	private readonly restoreFrame = this._register(new MutableDisposable<IDisposable>());
	private items: readonly SessionGridItem[] = [];
	private savedLayout: SessionGridNode | undefined;
	private legacyWidths: ReadonlyMap<string, number> | undefined;
	private restoring = false;
	private restorePending = false;
	private changing = false;
	private visible = true;
	private dimension: IDimension | undefined;

	constructor(container: HTMLElement, initialView: IView, @IStorageService private readonly storage: IStorageService) {
		super();
		this.element = container.ownerDocument.createElement('div');
		this.element.className = 'ash-sessions-chat-grid';
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		try {
			const saved = loadSessionGridLayout(storage);
			this.savedLayout = saved.layout;
			this.legacyWidths = saved.widths;
		} catch (error) {
			console.warn('Failed to restore Sessions grid state', error);
		}
		this.restoring = this.savedLayout !== undefined;
		this.restorePending = this.restoring || this.legacyWidths !== undefined;
		this._register(storage.onWillSaveState(() => this.saveState()));
		this.reconcile([{ id: 'empty', view: initialView }], 'empty');
	}

	reconcile(entries: readonly ISessionGridEntry[], active: string): void {
		if (!entries.length) throw new Error('A Sessions grid must have at least one view');
		const previous = this.items;
		const retained = new Map(previous.map(item => [item.entry.view, item]));
		const renames = new Map<string, string>();
		const next = entries.map(entry => {
			const item = retained.get(entry.view);
			if (!item) return new SessionGridItem(entry);
			if (item.entry.id !== entry.id) renames.set(item.entry.id, entry.id);
			item.entry = entry;
			return item;
		});
		if (this.savedLayout && renames.size) this.savedLayout = renameLayout(this.savedLayout, renames);
		if (this.restoring && this.savedLayout) {
			const savedIds = layoutIds(this.savedLayout);
			if (entries.some(entry => entry.id !== 'empty' && !savedIds.has(entry.id))) {
				// Explicit navigation supersedes unresolved provider restoration.
				this.restoring = false;
				this.savedLayout = undefined;
				this.restorePending = this.legacyWidths !== undefined;
			} else if (next.some(item => !previous.includes(item))) {
				this.restorePending = true;
			}
		}
		this.changing = true;
		try {
			const changed = previous.length !== next.length || previous.some((item, index) => item !== next[index]);
			const grid = this.grid.value;
			if (grid?.hasMaximizedView() && (changed || !next.some(item => item.entry.id === active && grid.isViewMaximized(item)))) {
				this.preserveFocus(() => grid.exitMaximizedView());
			}
			if (changed) {
				this.preserveFocus(() => {
					const reordered = previous.length === next.length && previous.every(item => next.includes(item));
					const replacements = previous.filter(item => !next.includes(item));
					const additions = next.filter(item => !previous.includes(item));
					const bindings = new Map(previous.filter(item => next.includes(item)).map(item => [item.entry.id, item]));
					for (const [index, item] of replacements.entries()) {
						if (additions[index]) bindings.set(item.entry.id, additions[index]!);
					}
					const current = this.grid.value?.serialize() as SessionGridNode | undefined;
					const descriptor = !reordered && current ? bindLayout(current, bindings) : undefined;
					this.replaceGrid(descriptor ?? horizontalLayout(next, this.dimension?.width ?? next.length));
					const included = descriptor ? [...bindings.values()] : next;
					let last = included.at(-1)!;
					for (const item of next) {
						if (included.includes(item)) continue;
						this.grid.value!.addView(item, Sizing.Split, last, Direction.Right);
						last = item;
					}
				});
			}
			this.items = next;
			for (const item of next) {
				item.element.classList.toggle('active', item.entry.id === active);
				item.element.setAttribute('aria-current', item.entry.id === active ? 'true' : 'false');
			}
			if (this.dimension) this.grid.value!.layout(this.dimension.width, this.dimension.height);
		} finally {
			this.changing = false;
		}
		this.captureLayout();
		this.scheduleRestore();
	}

	neighbor(id: string, direction: Direction): string | undefined {
		const item = this.items.find(candidate => candidate.entry.id === id);
		return item && this.grid.value!.getNeighborViews(item, direction)[0]?.entry.id;
	}

	toggleMaximized(id: string): void {
		const item = this.items.find(candidate => candidate.entry.id === id);
		const grid = this.grid.value;
		if (!item || !grid || this.items.length < 2) return;
		this.restoreFrame.clear();
		this.preserveFocus(() => {
			if (grid.isViewMaximized(item)) {
				grid.exitMaximizedView();
			} else {
				grid.maximizeView(item);
			}
		});
		this.scheduleRestore();
	}
	layout(width: number, height: number): void {
		if (this.savedLayout && (this.dimension?.width !== width || this.dimension?.height !== height)) this.restorePending = true;
		this.dimension = { width, height };
		this.changing = true;
		try { this.grid.value!.layout(width, height); }
		finally { this.changing = false; }
		this.scheduleRestore();
		this.captureLayout();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) this.restoreFrame.clear();
		else this.scheduleRestore();
	}

	private replaceGrid(descriptor: GridDescriptor<SessionGridItem>): void {
		this.gridListener.clear();
		this.grid.clear();
		this.grid.value = new SerializableGrid(this.element, descriptor);
		this.gridListener.value = this.grid.value.onDidChange(() => this.captureLayout());
		if (this.dimension) this.grid.value.layout(this.dimension.width, this.dimension.height);
	}

	private preserveFocus(update: () => void): void {
		const focused = this.element.ownerDocument.activeElement;
		const restore = isHTMLElement(focused) && this.element.contains(focused);
		update();
		if (restore && focused.isConnected && focused.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
	}

	private captureLayout(): void {
		if (this.changing || this.restorePending || this.restoring || this.grid.value?.hasMaximizedView() || !this.dimension?.width || !this.dimension.height || this.items.some(item => item.entry.id === 'empty')) return;
		this.savedLayout = this.grid.value!.serialize() as SessionGridNode;
		this.saveState();
	}

	private saveState(): void {
		if (this.changing || this.restorePending || this.restoring || !this.savedLayout) return;
		saveSessionGridLayout(this.storage, this.savedLayout);
	}

	private scheduleRestore(): void {
		if (!this.visible || this.grid.value?.hasMaximizedView() || !this.restorePending || !this.dimension?.width || !this.dimension.height || this.restoreFrame.value) return;
		this.restoreFrame.value = scheduleAtNextAnimationFrame(this.element.ownerDocument.defaultView!, () => {
			this.restoreFrame.clear();
			if (this.items.some(item => item.entry.id === 'empty')) return;
			this.changing = true;
			try {
				if (this.legacyWidths) {
					const widths = this.items.map(item => this.legacyWidths!.get(item.entry.id) ?? this.grid.value!.getViewSize(item).width);
					const total = widths.reduce((sum, width) => sum + width, 0);
					this.savedLayout = {
						type: 'branch', orientation: Orientation.HORIZONTAL, size: this.dimension!.width, priority: LayoutPriority.Normal,
						children: this.items.map((item, index) => ({ type: 'leaf', data: { id: item.entry.id }, size: widths[index]! / total * this.dimension!.width, visible: true, priority: LayoutPriority.Normal })),
					};
					this.legacyWidths = undefined;
				}
				if (this.savedLayout) {
					const bindings = new Map(this.items.map(item => [item.entry.id, item]));
					const descriptor = bindLayout(this.savedLayout, bindings);
					if (descriptor) {
						// Scale before Grid applies live view minimums; adding resize deltas to
						// stored pixel sizes would distort nested proportions on another viewport.
						this.preserveFocus(() => this.replaceGrid(scaleLayout(descriptor, this.dimension!)));
						if ([...layoutIds(this.savedLayout)].every(id => bindings.has(id))) this.restoring = false;
					} else {
						this.savedLayout = undefined;
						this.restoring = false;
					}
				}
			} finally {
				this.changing = false;
				this.restorePending = false;
			}
			if (this.savedLayout) this.saveState();
			else this.captureLayout();
		});
	}
}

/** Borrows a live view; only its identity and geometry enter persisted grid state. */
class SessionGridItem implements ISerializableView {
	constructor(public entry: ISessionGridEntry) { }
	get element() { return this.entry.view.element; }
	get minimumWidth() { return this.entry.view.minimumWidth; }
	get maximumWidth() { return this.entry.view.maximumWidth; }
	get minimumHeight() { return this.entry.view.minimumHeight; }
	get maximumHeight() { return this.entry.view.maximumHeight; }
	get onDidChange() { return this.entry.view.onDidChange; }
	layout(bounds: Parameters<IView['layout']>[0]): void { this.entry.view.layout(bounds); }
	toJSON(): { readonly id: string; } { return { id: this.entry.id }; }
}

function horizontalLayout(items: readonly SessionGridItem[], width: number): GridDescriptor<SessionGridItem> {
	return { type: 'branch', orientation: Orientation.HORIZONTAL, size: width, children: items.map(view => ({ type: 'leaf', view, size: width / items.length })) };
}

function bindLayout(node: SessionGridNode, bindings: ReadonlyMap<string, SessionGridItem>): GridDescriptor<SessionGridItem> | undefined {
	if (node.type === 'leaf') {
		const view = bindings.get(node.data.id);
		return view ? { type: 'leaf', view, size: node.size, priority: node.priority } : undefined;
	}
	const children = node.children.map(child => bindLayout(child, bindings)).filter(child => child !== undefined);
	return children.length ? { ...node, children } : undefined;
}

function layoutIds(node: SessionGridNode): Set<string> {
	return new Set(node.type === 'leaf' ? [node.data.id] : node.children.flatMap(child => [...layoutIds(child)]));
}

function scaleLayout(node: GridDescriptor<SessionGridItem>, dimension: IDimension): GridDescriptor<SessionGridItem> {
	if (node.type === 'leaf') return node;
	const horizontal = node.orientation === Orientation.HORIZONTAL;
	const available = horizontal ? dimension.width : dimension.height;
	const total = node.children.reduce((sum, child) => sum + child.size, 0);
	return {
		...node, size: available,
		children: node.children.map(child => {
			const size = total > 0 ? child.size / total * available : available / node.children.length;
			return { ...scaleLayout(child, horizontal ? { width: size, height: dimension.height } : { width: dimension.width, height: size }), size };
		}),
	};
}

function renameLayout(node: SessionGridNode, renames: ReadonlyMap<string, string>): SessionGridNode {
	return node.type === 'leaf'
		? { ...node, data: { id: renames.get(node.data.id) ?? node.data.id } }
		: { ...node, children: node.children.map(child => renameLayout(child, renames)) };
}
