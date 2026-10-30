import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { Orientation } from '../../../base/browser/ui/sash/sash.js';
import { scheduleAtNextAnimationFrame, isHTMLElement, type IDimension } from '../../../base/browser/dom.js';
import { Direction, SerializableGrid, Sizing, type GridDescriptor, type ISerializableView, type IView, type SerializedGridDescriptor } from '../../../base/browser/ui/grid/grid.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';

interface ISessionGridEntry {
	readonly id: string;
	readonly view: IView;
}

type SessionGridNode =
	| Omit<Extract<SerializedGridDescriptor, { type: 'leaf'; }>, 'data'> & { readonly data: { readonly id: string; }; }
	| Omit<Extract<SerializedGridDescriptor, { type: 'branch'; }>, 'children'> & { readonly children: readonly SessionGridNode[]; };

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
	private readonly storageKey = 'sessions.gridState';

	constructor(container: HTMLElement, initialView: IView, @IStorageService private readonly storage: IStorageService) {
		super();
		this.element = container.ownerDocument.createElement('div');
		this.element.className = 'ash-sessions-chat-grid';
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		try {
			const raw = storage.get(this.storageKey, StorageScope.WORKSPACE);
			if (raw !== undefined) {
				const value: unknown = JSON.parse(raw);
				if (isRecord(value) && value.version === 1) this.legacyWidths = parseStoredWidths(value);
				else this.savedLayout = parseStoredLayout(value);
			} else {
				const widths = new Map<string, number>();
				for (const key of ['sessions.gridState.code', 'sessions.gridState.chat']) {
					const legacy = storage.get(key, StorageScope.WORKSPACE);
					if (legacy !== undefined) {
						for (const [id, width] of parseStoredWidths(JSON.parse(legacy))) widths.set(id, width);
					}
				}
				if (widths.size) this.legacyWidths = widths;
			}
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
		if (this.changing || this.restorePending || this.restoring || !this.dimension?.width || !this.dimension.height || this.items.some(item => item.entry.id === 'empty')) return;
		this.savedLayout = this.grid.value!.serialize() as SessionGridNode;
		this.saveState();
	}

	private saveState(): void {
		if (this.changing || this.restorePending || this.restoring || !this.savedLayout) return;
		this.storage.store(this.storageKey, JSON.stringify({ version: 3, layout: this.savedLayout }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.storage.remove('sessions.gridState.chat', StorageScope.WORKSPACE);
		this.storage.remove('sessions.gridState.code', StorageScope.WORKSPACE);
	}

	private scheduleRestore(): void {
		if (!this.visible || !this.restorePending || !this.dimension?.width || !this.dimension.height || this.restoreFrame.value) return;
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

function parseStoredWidths(value: unknown): ReadonlyMap<string, number> {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.widths) || !value.widths.length) throw new TypeError('Invalid stored Sessions grid state');
	const widths = new Map<string, number>();
	for (const entry of value.widths) {
		if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.length || widths.has(entry.id)
			|| typeof entry.width !== 'number' || !Number.isFinite(entry.width) || entry.width <= 0) throw new TypeError('Invalid stored Sessions pane width');
		widths.set(entry.id, entry.width);
	}
	return widths;
}

/** Version 2 encoded editor groups. Migration resolves them once into Session identities. */
function parseStoredLayout(value: unknown): SessionGridNode {
	if (!isRecord(value) || (value.version !== 2 && value.version !== 3)) throw new TypeError('Invalid stored Sessions grid state');
	const groups = new Map<string, string>();
	if (value.version === 2) {
		if (!Array.isArray(value.groups) || !value.groups.length) throw new TypeError('Invalid stored Sessions grid bindings');
		const ids = new Set<string>();
		for (const binding of value.groups) {
			if (!isRecord(binding) || typeof binding.groupId !== 'string' || !binding.groupId.length || binding.groupId.length > 128 || groups.has(binding.groupId)
				|| typeof binding.id !== 'string' || !binding.id.length || ids.has(binding.id)) throw new TypeError('Invalid stored Sessions grid binding');
			groups.set(binding.groupId, binding.id);
			ids.add(binding.id);
		}
	}
	const seen = new Set<string>();
	const visit = (node: unknown, parentOrientation?: Orientation, depth = 0): SessionGridNode => {
		if (!isRecord(node)) throw new TypeError('Invalid stored Sessions grid node');
		const priority = node.priority === 'normal' ? LayoutPriority.Normal : node.priority === 'low' ? LayoutPriority.Low : node.priority === 'high' ? LayoutPriority.High : node.priority;
		const orientation = node.orientation === 'vertical' ? Orientation.VERTICAL : node.orientation === 'horizontal' ? Orientation.HORIZONTAL : node.orientation;
		if (depth > 64 || typeof node.size !== 'number' || !Number.isFinite(node.size) || node.size < 0
			|| (priority !== LayoutPriority.Low && priority !== LayoutPriority.Normal && priority !== LayoutPriority.High)) throw new TypeError('Invalid stored Sessions grid geometry');
		if (node.type === 'leaf') {
			const reference = isRecord(node.data) ? value.version === 2 ? node.data.groupId : node.data.id : undefined;
			const id = typeof reference === 'string' && value.version === 2 ? groups.get(reference) : reference;
			if (typeof id !== 'string' || !id.length || seen.has(id) || typeof node.visible !== 'boolean') throw new TypeError('Invalid stored Sessions grid reference');
			seen.add(id);
			return { type: 'leaf', data: { id }, size: node.size, priority, visible: node.visible };
		}
		if (node.type !== 'branch' || (orientation !== Orientation.HORIZONTAL && orientation !== Orientation.VERTICAL) || orientation === parentOrientation
			|| !Array.isArray(node.children) || !node.children.length) throw new TypeError('Invalid stored Sessions grid branch');
		return { type: 'branch', orientation, size: node.size, priority, children: node.children.map(child => visit(child, orientation, depth + 1)) };
	};
	const layout = visit(value.layout);
	if (value.version === 2 && seen.size !== groups.size) throw new TypeError('Incomplete stored Sessions grid bindings');
	return layout;
}
