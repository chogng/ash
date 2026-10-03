import { Direction, Grid, Sizing, type IView } from '../../../base/browser/ui/grid/grid.js';
import { scheduleAtNextAnimationFrame } from '../../../base/browser/dom.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import type { SessionsPage } from '../../services/sessions/browser/sessionsService.js';

export interface ISessionGridEntry {
	readonly id: string;
	readonly view: IView;
}

/** Owns split geometry; its caller owns membership, active identity, and view lifetimes. */
export class SessionGridLayout extends Disposable {
	private readonly gridResource = this._register(new MutableDisposable<Grid<IView>>());
	private readonly gridChanges = this._register(new MutableDisposable<IDisposable>());
	private readonly restoreFrame = this._register(new MutableDisposable<IDisposable>());
	private get grid(): Grid<IView> { return this.gridResource.value!; }
	public get element(): HTMLDivElement { return this.grid.element; }
	private views: readonly IView[];
	private entries: readonly ISessionGridEntry[] = [];
	private pendingWidths: ReadonlyMap<string, number> | undefined;
	private readonly storageKey: string;
	private dimension: { width: number; height: number } | undefined;
	private visible = true;

	constructor(private readonly container: HTMLElement, initialView: IView, page: SessionsPage, @IStorageService private readonly storage: IStorageService) {
		super();
		this.storageKey = `sessions.gridState.${page}`;
		const raw = storage.get(this.storageKey, StorageScope.WORKSPACE);
		this.pendingWidths = raw === undefined ? undefined : parseStoredWidths(JSON.parse(raw));
		this.gridResource.value = new Grid<IView>(container, { type: 'leaf', view: initialView, size: 800 }, { sashPresentation: { type: 'inset', gap: 8 } });
		this.element.classList.add('ash-sessions-chat-grid');
		this.views = [initialView];
		this.gridChanges.value = this.grid.onDidChange(() => this.saveState());
		this._register(storage.onWillSaveState(() => this.saveState()));
	}

	public reconcile(entries: readonly ISessionGridEntry[], active: string): void {
		const activeView = entries.find(entry => entry.id === active)?.view;
		const focused = this.element.ownerDocument.activeElement;
		const restoreFocus = focused instanceof this.element.ownerDocument.defaultView!.HTMLElement && activeView?.element.contains(focused);
		const nextViews = entries.map(entry => entry.view);
		const retained = new Set(nextViews);
		const current = [...this.views];
		// Grid events during membership changes contain incomplete geometry; commit only the final entries.
		this.entries = [];
		// Insert before removing the last old leaf so a complete replacement stays in one live Grid.
		for (let index = 0; index < nextViews.length; index++) {
			const view = nextViews[index]!;
			const position = current.indexOf(view);
			if (position === index) {
				continue;
			}
			const reference = index === 0 ? current[0]! : nextViews[index - 1]!;
			const direction = index === 0 ? Direction.Left : Direction.Right;
			if (position < 0) {
				this.grid.addView(view, Sizing.Split, reference, direction);
			} else {
				const size = this.grid.getViewSize(view);
				this.grid.moveView(view, size.width, reference, direction);
				current.splice(position, 1);
			}
			current.splice(index, 0, view);
		}
		for (const view of this.views) {
			if (!retained.has(view)) {
				this.grid.removeView(view);
			}
		}
		this.views = nextViews;
		this.entries = entries.filter(entry => entry.id !== 'empty');
		if (this.dimension) {
			this.scheduleRestoreWidths();
		}
		this.saveState();
		if (restoreFocus && focused.isConnected) {
			focused.focus({ preventScroll: true });
		}
	}

	public layout(width: number, height: number): void {
		this.dimension = { width, height };
		this.scheduleRestoreWidths();
		this.grid.layout(width, height);
		this.saveState();
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) { this.restoreFrame.clear(); }
	}

	private saveState(): void {
		if (this.pendingWidths || !this.dimension || this.dimension.width <= 0 || this.entries.length === 0) {
			return;
		}
		const widths = this.entries.map(entry => ({ id: entry.id, width: this.grid.getViewSize(entry.view).width }));
		this.storage.store(this.storageKey, JSON.stringify({ version: 1, widths }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private scheduleRestoreWidths(): void {
		if (!this.visible || !this.pendingWidths || !this.dimension || this.dimension.width <= 0 || this.dimension.height <= 0 || this.entries.length === 0 || this.restoreFrame.value) {
			return;
		}
		// Page restoration changes which surrounding Parts are present. Apply widths after that layout settles.
		this.restoreFrame.value = scheduleAtNextAnimationFrame(this.element.ownerDocument.defaultView!, () => {
			this.restoreFrame.clear();
			const { width, height } = this.dimension!;
			this.restoreWidths(width, height);
			this.grid.layout(width, height);
			this.saveState();
		});
	}

	private restoreWidths(width: number, height: number): void {
		if (!this.pendingWidths || this.entries.length === 0 || width <= 0 || height <= 0) {
			return;
		}
		// An entirely new arrangement has no saved geometry to restore.
		if (!this.entries.some(entry => this.pendingWidths!.has(entry.id))) {
			this.pendingWidths = undefined;
			return;
		}
		const sizes = this.entries.map(entry => this.pendingWidths!.get(entry.id) ?? this.grid.getViewSize(entry.view).width);
		const total = sizes.reduce((sum, size) => sum + size, 0);
		const focused = this.element.ownerDocument.activeElement;
		const restoreFocus = focused instanceof this.element.ownerDocument.defaultView!.HTMLElement && this.entries.some(entry => entry.view.element.contains(focused));
		this.pendingWidths = undefined;
		// Replace only the initial geometry, keeping the page's already-restored widgets alive.
		this.gridResource.clear();
		this.gridResource.value = new Grid<IView>(this.container, {
			type: 'branch',
			orientation: 'horizontal',
			size: width,
			children: this.entries.map((entry, index) => ({ type: 'leaf', view: entry.view, size: sizes[index]! / total * width })),
		}, { sashPresentation: { type: 'inset', gap: 8 } });
		this.element.classList.add('ash-sessions-chat-grid');
		this.grid.layout(width, height);
		this.gridChanges.value = this.grid.onDidChange(() => this.saveState());
		if (restoreFocus && focused.isConnected) {
			focused.focus({ preventScroll: true });
		}
	}
}

function parseStoredWidths(value: unknown): ReadonlyMap<string, number> {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.widths) || value.widths.length === 0) {
		throw new TypeError('Invalid stored Sessions grid state');
	}
	const widths = new Map<string, number>();
	for (const entry of value.widths) {
		if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0 || widths.has(entry.id)
			|| typeof entry.width !== 'number' || !Number.isFinite(entry.width) || entry.width <= 0) {
			throw new TypeError('Invalid stored Sessions pane width');
		}
		widths.set(entry.id, entry.width);
	}
	return widths;
}
