import { Emitter, type Event } from "../../../common/event.js";
import { type IDisposable, Disposable, DisposableStore, toDisposable } from "../../../common/lifecycle.js";
import { clamp, isFiniteNumber } from "../../../common/numbers.js";
import { Sash, SashState, type SashDragEvent, type SashPresentation } from "../sash/sash.js";
import { h } from "../../dom.js";

export type SplitViewOrientation = "horizontal" | "vertical";
export type SplitViewLayoutPriority = "low" | "normal" | "high";

export interface SplitViewOptions {
	/** Optional Sash presentation shared by separators created for this view. */
	readonly sashPresentation?: SashPresentation;
	/** Whether a snap view at the leading outer edge can be restored by its sash. */
	readonly startSnappingEnabled?: boolean;
	/** Whether a snap view at the trailing outer edge can be restored by its sash. */
	readonly endSnappingEnabled?: boolean;
}

/**
 * A view hosted by SplitView.
 *
 * Constraints and layout use the SplitView's primary axis. Implementations
 * receive their position on that axis and the available orthogonal size.
 */
export interface ISplitViewView {
	readonly element: HTMLElement;
	readonly minimumSize: number;
	readonly maximumSize: number;
	readonly priority?: SplitViewLayoutPriority;
	/** Whether this pane may render interaction surfaces beyond its own bounds. */
	readonly paneOverflow?: "hidden" | "visible";
	/** Whether dragging through the minimum size may collapse this view. */
	readonly snap?: boolean;
	readonly onDidChange?: Event<number | undefined>;
	layout(size: number, offset: number, orthogonalSize: number): void;
	setVisible?(visible: boolean): void;
}

/** Controls the initial placement of a newly added SplitView view. */
export type SplitViewSizing =
	| number
	| { readonly type: "distribute" }
	| { readonly type: "split"; readonly index: number }
	| { readonly type: "invisible"; readonly cachedVisibleSize: number };

interface ViewItem {
	readonly view: ISplitViewView;
	readonly container: HTMLDivElement;
	size: number;
	visible: boolean;
	cachedVisibleSize: number | undefined;
	changeListener: IDisposable | undefined;
}

interface SashItem {
	readonly sash: Sash;
	readonly boundaryIndex: number;
}

interface SashDragState {
	snapshot: readonly SplitViewResizeItem[];
	baseline: number;
	altKey: boolean | undefined;
}

interface SplitViewResizeItem {
	readonly size: number;
	readonly cachedVisibleSize: number | undefined;
	readonly minimumSize: number;
	readonly maximumSize: number;
	readonly visible: boolean;
	readonly snap: boolean;
}

interface SplitViewResizeOptions {
	readonly boundaryIndex: number;
	readonly delta: number;
	readonly input: "pointer" | "keyboard";
	readonly altKey: boolean;
	readonly startSnappingEnabled: boolean;
	readonly endSnappingEnabled: boolean;
}

/** A constrained, explicit-pixel layout with accessible resize sashes. */
export class SplitView extends Disposable {
	readonly element: HTMLDivElement;
	private readonly items: ViewItem[] = [];
	private readonly sashes = this._register(new DisposableStore());
	private readonly sashItems: SashItem[] = [];
	private readonly _onDidChangeViewSizes = this._register(new Emitter<void>());
	private readonly _onDidSashReset = this._register(new Emitter<number>());
	private size = 0;
	private orthogonalSize = 0;
	private didLayout = false;
	private _startSnappingEnabled: boolean;
	private _endSnappingEnabled: boolean;
	private _orthogonalStartSash: Sash | undefined;
	private _orthogonalEndSash: Sash | undefined;
	private _sashPresentation: SashPresentation;

	readonly onDidChangeViewSizes: Event<void> =
		this._onDidChangeViewSizes.event;
	readonly onDidSashReset: Event<number> = this._onDidSashReset.event;

	constructor(
		container: HTMLElement,
		readonly orientation: SplitViewOrientation,
		private readonly options: SplitViewOptions = {},
	) {
		super();
		this._sashPresentation = options.sashPresentation;
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = `ash-split-view ash-split-view-${orientation}`;
		container.append(element);
		this._startSnappingEnabled = options.startSnappingEnabled ?? true;
		this._endSnappingEnabled = options.endSnappingEnabled ?? true;
	}

	get sashPresentation(): SashPresentation {
		return this._sashPresentation;
	}

	set sashPresentation(presentation: SashPresentation) {
		this._sashPresentation = presentation;
		for (const item of this.sashItems) item.sash.presentation = presentation;
	}

	get viewCount(): number {
		return this.items.length;
	}

	get startSnappingEnabled(): boolean {
		return this._startSnappingEnabled;
	}

	set startSnappingEnabled(enabled: boolean) {
		if (this._startSnappingEnabled === enabled) return;
		this._startSnappingEnabled = enabled;
		this.positionSashes();
	}

	get endSnappingEnabled(): boolean {
		return this._endSnappingEnabled;
	}

	set endSnappingEnabled(enabled: boolean) {
		if (this._endSnappingEnabled === enabled) return;
		this._endSnappingEnabled = enabled;
		this.positionSashes();
	}

	get orthogonalStartSash(): Sash | undefined {
		return this._orthogonalStartSash;
	}

	set orthogonalStartSash(sash: Sash | undefined) {
		this._orthogonalStartSash = sash;
		for (const item of this.sashItems) item.sash.orthogonalStartSash = sash;
	}

	get orthogonalEndSash(): Sash | undefined {
		return this._orthogonalEndSash;
	}

	set orthogonalEndSash(sash: Sash | undefined) {
		this._orthogonalEndSash = sash;
		for (const item of this.sashItems) item.sash.orthogonalEndSash = sash;
	}

	getSash(boundaryIndex: number): Sash | undefined {
		return this.sashItems.find((item) => item.boundaryIndex === boundaryIndex)?.sash;
	}

	get minimumSize(): number {
		return this.visibleItems().reduce(
			(total, item) => total + item.view.minimumSize,
			0,
		);
	}

	get maximumSize(): number {
		return this.visibleItems().reduce(
			(total, item) => total + item.view.maximumSize,
			0,
		);
	}

	addView(
		view: ISplitViewView,
		sizing: SplitViewSizing = { type: "distribute" },
		index = this.items.length,
	): void {
		if (this.items.some((item) => item.view === view)) {
			throw new Error("SplitView cannot contain the same view twice");
		}
		if (!Number.isInteger(index) || index < 0 || index > this.items.length) {
			throw new RangeError(`SplitView view index is out of range: ${index}`);
		}
		validateViewConstraints(view);
		const resolved = this.resolveSizing(sizing);
		const container = h(this.element.ownerDocument, "div");
		container.className = "ash-split-view-pane";
		container.classList.toggle("ash-split-view-pane-overflow-visible", view.paneOverflow === "visible");
		container.append(view.element);
		const item: ViewItem = {
			view,
			container,
			size: resolved.visible ? clamp(
				resolved.size,
				view.minimumSize,
				view.maximumSize,
			) : 0,
			visible: resolved.visible,
			cachedVisibleSize: resolved.visible ? undefined : resolved.size,
			changeListener: undefined,
		};
		this.items.splice(index, 0, item);
		const next = this.element.children[index];
		this.element.insertBefore(container, next ?? null);
		container.hidden = !item.visible;
		view.setVisible?.(item.visible);
		if (view.onDidChange) {
			item.changeListener = this._register(view.onDidChange((preferredSize) => {
				validateViewConstraints(view);
				if (!this.didLayout && preferredSize === undefined) return;
				if (preferredSize === undefined) {
					this.fitToSize();
				} else {
					this.resizeView(this.indexOf(view), preferredSize);
					return;
				}
				this.render();
			}));
		}
		if (this.didLayout) this.fitToSize();
		this.rebuildSashes();
		if (this.didLayout) this.render();
	}

	removeView(index: number): ISplitViewView {
		const item = this.item(index);
		this.items.splice(index, 1);
		item.changeListener?.dispose();
		item.container.remove();
		if (this.didLayout) this.fitToSize();
		this.rebuildSashes();
		if (this.didLayout) this.render();
		this._onDidChangeViewSizes.fire();
		return item.view;
	}

	layout(size: number, orthogonalSize: number): void {
		assertNonNegativeFinite(size, "size");
		assertNonNegativeFinite(orthogonalSize, "orthogonal size");
		this.size = size;
		this.orthogonalSize = orthogonalSize;
		this.didLayout = true;
		this.fitToSize();
		if (this.didLayout) this.render();
	}

	getViewSize(index: number): number {
		return this.item(index).size;
	}

	getViewCachedVisibleSize(index: number): number | undefined {
		return this.item(index).cachedVisibleSize;
	}

	isViewVisible(index: number): boolean {
		return this.item(index).visible;
	}

	setViewVisible(index: number, visible: boolean): void {
		const item = this.item(index);
		if (item.visible === visible) return;
		this.setItemVisible(item, visible);
		if (this.didLayout) this.render();
		this._onDidChangeViewSizes.fire();
	}

	resizeView(index: number, requestedSize: number): void {
		assertNonNegativeFinite(requestedSize, "view size");
		const item = this.item(index);
		if (!item.visible) {
			item.cachedVisibleSize = clamp(
				requestedSize,
				item.view.minimumSize,
				item.view.maximumSize,
			);
			return;
		}
		item.size = clamp(
			requestedSize,
			item.view.minimumSize,
			item.view.maximumSize,
		);
		if (this.didLayout) this.fitToSize(new Set([item]));
		if (this.didLayout) this.render();
		this._onDidChangeViewSizes.fire();
	}

	distributeViewSizes(): void {
		if (!this.didLayout) return;
		const flexible = this.visibleItems().filter(isResizable);
		if (flexible.length === 0) return;
		const fixedSize = this.visibleItems()
			.filter((item) => !isResizable(item))
			.reduce((total, item) => total + item.size, 0);
		const target = Math.max(0, this.size - fixedSize);
		const share = target / flexible.length;
		for (const item of flexible) {
			item.size = clamp(
				share,
				item.view.minimumSize,
				item.view.maximumSize,
			);
		}
		this.fitToSize();
		this.render();
		this._onDidChangeViewSizes.fire();
	}

	/**
	 * Resets the nearest visible views around one sash to an even split.
	 * Unrelated views retain their current sizes.
	 */
	resetSash(boundaryIndex: number): void {
		if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex >= this.items.length - 1) {
			throw new RangeError(`SplitView sash boundary is out of range: ${boundaryIndex}`);
		}
		if (!this.didLayout) return;
		const before = this.findVisibleItem(boundaryIndex, -1);
		const after = this.findVisibleItem(boundaryIndex + 1, 1);
		if (!before || !after) return;
		const total = before.size + after.size;
		const beforeSize = resetLeadingViewSize(total, before, after);
		before.size = beforeSize;
		after.size = total - beforeSize;
		this.render();
		this._onDidChangeViewSizes.fire();
	}

	private resolveSizing(
		sizing: SplitViewSizing,
	): { readonly size: number; readonly visible: boolean } {
		if (typeof sizing === "number") {
			assertNonNegativeFinite(sizing, "initial view size");
			return { size: sizing, visible: true };
		}
		if (sizing.type === "invisible") {
			assertNonNegativeFinite(
				sizing.cachedVisibleSize,
				"cached visible size",
			);
			return { size: sizing.cachedVisibleSize, visible: false };
		}
		if (sizing.type === "split") {
			const target = this.item(sizing.index);
			return { size: target.size / 2, visible: true };
		}
		if (sizing.type !== "distribute") {
			throw new TypeError("SplitView sizing has an unknown type");
		}
		const visible = this.visibleItems();
		return {
			size: visible.length === 0
				? this.size
				: visible.reduce((total, item) => total + item.size, 0) /
					visible.length,
			visible: true,
		};
	}

	private fitToSize(protectedItems: ReadonlySet<ViewItem> = new Set()): void {
		const visible = this.visibleItems();
		for (const item of visible) {
			validateViewConstraints(item.view);
			item.size = clamp(
				item.size,
				item.view.minimumSize,
				item.view.maximumSize,
			);
		}
		let delta = this.size -
			visible.reduce((total, item) => total + item.size, 0);
		delta = distributeByPriority(
			visible.filter((item) => !protectedItems.has(item)),
			delta,
		);
		if (Math.abs(delta) > 0.001) {
			distributeByPriority(
				visible.filter((item) => protectedItems.has(item)),
				delta,
			);
		}
	}

	private render(): void {
		let offset = 0;
		for (const item of this.items) {
			if (!item.visible) continue;
			const primarySize = Math.max(0, item.size);
			if (this.orientation === "horizontal") {
				item.container.style.left = `${offset}px`;
				item.container.style.top = "0px";
				item.container.style.width = `${primarySize}px`;
				item.container.style.height = `${this.orthogonalSize}px`;
			} else {
				item.container.style.left = "0px";
				item.container.style.top = `${offset}px`;
				item.container.style.width = `${this.orthogonalSize}px`;
				item.container.style.height = `${primarySize}px`;
			}
			item.view.layout(primarySize, offset, this.orthogonalSize);
			offset += primarySize;
		}
		this.positionSashes();
	}

	private rebuildSashes(): void {
		this.sashes.clear();
		this.sashItems.length = 0;
		for (let boundaryIndex = 0; boundaryIndex < this.items.length - 1; boundaryIndex += 1) {
			if (this.canResizeAtBoundary(boundaryIndex)) {
				this.addSash(boundaryIndex);
			}
		}
		this.positionSashes();
	}

	private addSash(boundaryIndex: number): void {
		const sash = this.sashes.add(new Sash(
			this.element,
			this.orientation === "horizontal" ? "vertical" : "horizontal",
			this._sashPresentation,
		));
		sash.orthogonalStartSash = this._orthogonalStartSash;
		sash.orthogonalEndSash = this._orthogonalEndSash;
		this.sashItems.push({ sash, boundaryIndex });
		let dragState: SashDragState | undefined;
		this.sashes.add(sash.onDidStart(() => {
			dragState = { snapshot: this.getResizeItems(), baseline: 0, altKey: undefined };
		}));
		this.sashes.add(sash.onDidChange((event) => {
			if (!dragState) return;
			if (event.input === "pointer" && dragState.altKey !== undefined && dragState.altKey !== event.altKey) {
				dragState.snapshot = this.getResizeItems();
				dragState.baseline = event.delta;
			}
			if (event.input === "pointer") dragState.altKey = event.altKey;
			this.resizeAtBoundary(boundaryIndex, dragState.snapshot, {
				...event,
				delta: event.input === "pointer" ? event.delta - dragState.baseline : event.delta,
			});
		}));
		this.sashes.add(sash.onDidEnd(() => {
			dragState = undefined;
		}));
		this.sashes.add(sash.onDidReset(() => this.handleSashReset(boundaryIndex)));
		this.element.append(sash.element);
	}

	private resizeAtBoundary(boundaryIndex: number, snapshot: readonly SplitViewResizeItem[], event: SashDragEvent): void {
		const resizedItems = solveSashResize(snapshot, {
			boundaryIndex,
			delta: event.delta,
			input: event.input,
			altKey: event.altKey,
			startSnappingEnabled: this.startSnappingEnabled,
			endSnappingEnabled: this.endSnappingEnabled,
		});
		const visibilityChanges: Array<{ readonly item: ViewItem; readonly visible: boolean }> = [];
		for (const [index, resized] of resizedItems.entries()) {
			const item = this.item(index);
			if (item.visible !== resized.visible) {
				item.visible = resized.visible;
				item.container.hidden = !resized.visible;
				visibilityChanges.push({ item, visible: resized.visible });
			}
			item.size = resized.size;
			item.cachedVisibleSize = resized.cachedVisibleSize;
		}
		for (const { item, visible } of visibilityChanges) {
			item.view.setVisible?.(visible);
		}
		this.fitToSize();
		this.render();
		this._onDidChangeViewSizes.fire();
	}

	private handleSashReset(boundaryIndex: number): void {
		const items = this.getResizeItems();
		const before = findFirstSnapIndex(items, Array.from({ length: boundaryIndex + 1 }, (_, index) => boundaryIndex - index));
		const after = findFirstSnapIndex(items, Array.from({ length: items.length - boundaryIndex - 1 }, (_, index) => boundaryIndex + index + 1));
		if (before !== undefined && !items[before]!.visible) return;
		if (after !== undefined && !items[after]!.visible) return;
		this._onDidSashReset.fire(boundaryIndex);
	}

	private setItemVisible(
		item: ViewItem,
		visible: boolean,
		visibleSize?: number,
		fit = true,
	): void {
		if (visible) {
			item.visible = true;
			item.size = clamp(
				visibleSize ?? item.cachedVisibleSize ?? item.view.minimumSize,
				item.view.minimumSize,
				item.view.maximumSize,
			);
			item.cachedVisibleSize = undefined;
			item.container.hidden = false;
			item.view.setVisible?.(true);
			if (fit && this.didLayout) this.fitToSize(new Set([item]));
			return;
		}
		item.cachedVisibleSize = visibleSize ?? item.size;
		item.size = 0;
		item.visible = false;
		item.container.hidden = true;
		item.view.setVisible?.(false);
		if (fit && this.didLayout) this.fitToSize();
	}

	private getResizeItems(): SplitViewResizeItem[] {
		return this.items.map((item) => ({
			size: item.size,
			cachedVisibleSize: item.cachedVisibleSize,
			minimumSize: item.view.minimumSize,
			maximumSize: item.view.maximumSize,
			visible: item.visible,
			snap: item.view.snap ?? false,
		}));
	}

	private canResizeAtBoundary(boundaryIndex: number): boolean {
		const canResize = (item: ViewItem) => isResizable(item) || item.view.snap === true;
		return this.items.slice(0, boundaryIndex + 1).some(canResize) && this.items.slice(boundaryIndex + 1).some(canResize);
	}

	private positionSashes(): void {
		const resizeItems = this.getResizeItems();
		for (const { sash, boundaryIndex: previousIndex } of this.sashItems) {
			let position = 0;
			for (let index = 0; index <= previousIndex; index += 1) {
				const item = this.items[index];
				if (item?.visible) position += item.size;
			}
			if (this.orientation === "horizontal") {
				sash.element.style.left = `${position}px`;
				sash.element.style.top = "0px";
				sash.element.style.height = `${this.orthogonalSize}px`;
			} else {
				sash.element.style.left = "0px";
				sash.element.style.top = `${position}px`;
				sash.element.style.width = `${this.orthogonalSize}px`;
			}
			sash.state = getSashState(resizeItems, previousIndex, this.startSnappingEnabled, this.endSnappingEnabled);
			const previous = this.items[previousIndex];
			const next = this.items[previousIndex + 1];
			if (previous && next && previous.visible && next.visible) {
				sash.element.setAttribute(
					"aria-valuemin",
					String(previous.view.minimumSize),
				);
				sash.element.setAttribute(
					"aria-valuemax",
					String(Math.min(
						previous.view.maximumSize,
						previous.size + next.size - next.view.minimumSize,
					)),
				);
				sash.element.setAttribute("aria-valuenow", String(previous.size));
			} else {
				sash.element.removeAttribute("aria-valuemin");
				sash.element.removeAttribute("aria-valuemax");
				sash.element.removeAttribute("aria-valuenow");
			}
		}
	}

	private visibleItems(): ViewItem[] {
		return this.items.filter((item) => item.visible);
	}

	private findVisibleItem(startIndex: number, direction: -1 | 1): ViewItem | undefined {
		for (let index = startIndex; index >= 0 && index < this.items.length; index += direction) {
			const item = this.items[index];
			if (item?.visible) return item;
		}
		return undefined;
	}

	private indexOf(view: ISplitViewView): number {
		const index = this.items.findIndex((item) => item.view === view);
		if (index < 0) throw new Error("SplitView view is not registered");
		return index;
	}

	private item(index: number): ViewItem {
		const item = this.items[index];
		if (!item) throw new RangeError(`SplitView view index is out of range: ${index}`);
		return item;
	}
}

function distributeDelta(items: readonly ViewItem[], delta: number): number {
	let candidates = items.filter((item) =>
		delta > 0
			? item.size < item.view.maximumSize
			: item.size > item.view.minimumSize
	);
	while (candidates.length > 0 && Math.abs(delta) > 0.001) {
		const share = delta / candidates.length;
		let applied = 0;
		for (const item of candidates) {
			const next = clamp(
				item.size + share,
				item.view.minimumSize,
				item.view.maximumSize,
			);
			applied += next - item.size;
			item.size = next;
		}
		if (Math.abs(applied) < 0.001) break;
		delta -= applied;
		candidates = candidates.filter((item) =>
			delta > 0
				? item.size < item.view.maximumSize
				: item.size > item.view.minimumSize
		);
	}
	return delta;
}

function distributeByPriority(
	items: readonly ViewItem[],
	delta: number,
): number {
	for (const priority of ["high", "normal", "low"] as const) {
		delta = distributeDelta(
			items.filter((item) => (item.view.priority ?? "normal") === priority),
			delta,
		);
		if (Math.abs(delta) <= 0.001) break;
	}
	return delta;
}

function validateViewConstraints(view: ISplitViewView): void {
	assertNonNegativeFinite(view.minimumSize, "view minimum size");
	if (
		typeof view.maximumSize !== "number" ||
		Number.isNaN(view.maximumSize) ||
		view.maximumSize < view.minimumSize
	) {
		throw new RangeError(
			"SplitView view maximum size must be at least its minimum size",
		);
	}
}

function isResizable(item: ViewItem): boolean {
	return item.view.minimumSize < item.view.maximumSize;
}

function resetLeadingViewSize(total: number, leading: ViewItem, trailing: ViewItem): number {
	const minimum = Math.max(
		leading.view.minimumSize,
		total - trailing.view.maximumSize,
	);
	const maximum = Math.min(
		leading.view.maximumSize,
		total - trailing.view.minimumSize,
	);
	return clamp(total / 2, minimum, maximum);
}

function assertNonNegativeFinite(value: number, name: string): void {
	if (!isFiniteNumber(value) || value < 0) {
		throw new RangeError(
			`SplitView ${name} must be a non-negative finite number`,
		);
	}
}

function solveSashResize(items: readonly SplitViewResizeItem[], options: SplitViewResizeOptions): readonly SplitViewResizeItem[] {
	if (options.altKey && options.input === "pointer") {
		return solveSymmetricResize(items, options.boundaryIndex, options.delta);
	}
	const result = items.map((item) => ({ ...item }));
	const originalSizes = items.map((item) => item.size);
	const toggledSnapIndexes = new Set<number>();

	for (;;) {
		const beforeIndexes = indexesBefore(options.boundaryIndex);
		const afterIndexes = indexesAfter(options.boundaryIndex, result.length);
		const { minimumDelta, maximumDelta } = resizeLimits(result, originalSizes, beforeIndexes, afterIndexes);
		const snapBeforeIndex = findFirstSnapIndex(result, beforeIndexes);
		const snapAfterIndex = findFirstSnapIndex(result, afterIndexes);
		const snapBeforeBlocked = snapBeforeIndex !== undefined && (toggledSnapIndexes.has(snapBeforeIndex) || !result[snapBeforeIndex]!.visible && snapBeforeIndex === 0 && !options.startSnappingEnabled);
		const snapAfterBlocked = snapAfterIndex !== undefined && (toggledSnapIndexes.has(snapAfterIndex) || !result[snapAfterIndex]!.visible && snapAfterIndex === result.length - 1 && !options.endSnappingEnabled);
		const snapBefore = snapBeforeBlocked ? undefined : snapBeforeIndex;
		const snapAfter = snapAfterBlocked ? undefined : snapAfterIndex;
		const snappedIndex = findSnapCandidate(result, options, minimumDelta, maximumDelta, snapBefore, snapAfter);
		if (snappedIndex === undefined) {
			applyResize(result, originalSizes, beforeIndexes, afterIndexes, clamp(options.delta, minimumDelta, maximumDelta));
			return result;
		}
		const item = result[snappedIndex]!;
		const visible = !item.visible;
		result[snappedIndex] = {
			...item,
			size: visible ? clamp(item.cachedVisibleSize ?? item.minimumSize, item.minimumSize, item.maximumSize) : 0,
			cachedVisibleSize: visible ? undefined : item.size,
			visible,
		};
		toggledSnapIndexes.add(snappedIndex);
	}
}

function solveSymmetricResize(items: readonly SplitViewResizeItem[], boundaryIndex: number, requestedDelta: number): readonly SplitViewResizeItem[] {
	const oppositeBoundaryIndex = boundaryIndex === items.length - 2 ? boundaryIndex - 1 : boundaryIndex + 1;
	if (oppositeBoundaryIndex < 0 || oppositeBoundaryIndex >= items.length - 1) {
		return solveWithoutSnapping(items, boundaryIndex, requestedDelta);
	}
	const targetIndex = boundaryIndex === items.length - 2 ? boundaryIndex : boundaryIndex + 1;
	const target = items[targetIndex]!;
	if (!target.visible) return solveWithoutSnapping(items, boundaryIndex, requestedDelta);
	const firstRange = sashRange(items, boundaryIndex);
	const oppositeRange = sashRange(items, oppositeBoundaryIndex);
	const growsWithDelta = targetIndex === boundaryIndex;
	const targetMinimumDelta = growsWithDelta
		? (target.minimumSize - target.size) / 2
		: (target.size - target.maximumSize) / 2;
	const targetMaximumDelta = growsWithDelta
		? (target.maximumSize - target.size) / 2
		: (target.size - target.minimumSize) / 2;
	const minimumDelta = Math.max(firstRange.minimumDelta, -oppositeRange.maximumDelta, targetMinimumDelta);
	const maximumDelta = Math.min(firstRange.maximumDelta, -oppositeRange.minimumDelta, targetMaximumDelta);
	if (minimumDelta > maximumDelta) return items.map((item) => ({ ...item }));
	const delta = clamp(requestedDelta, minimumDelta, maximumDelta);
	const result = items.map((item) => ({ ...item }));
	applyResizeAtBoundary(result, boundaryIndex, delta);
	applyResizeAtBoundary(result, oppositeBoundaryIndex, -delta);
	return result;
}

function solveWithoutSnapping(items: readonly SplitViewResizeItem[], boundaryIndex: number, requestedDelta: number): readonly SplitViewResizeItem[] {
	const result = items.map((item) => ({ ...item }));
	const range = sashRange(result, boundaryIndex);
	applyResizeAtBoundary(result, boundaryIndex, clamp(requestedDelta, range.minimumDelta, range.maximumDelta));
	return result;
}

function sashRange(items: readonly SplitViewResizeItem[], boundaryIndex: number): { readonly minimumDelta: number; readonly maximumDelta: number } {
	const sizes = items.map((item) => item.size);
	return resizeLimits(items, sizes, indexesBefore(boundaryIndex), indexesAfter(boundaryIndex, items.length));
}

function applyResizeAtBoundary(items: SplitViewResizeItem[], boundaryIndex: number, delta: number): void {
	const sizes = items.map((item) => item.size);
	applyResize(items, sizes, indexesBefore(boundaryIndex), indexesAfter(boundaryIndex, items.length), delta);
}

function getSashState(items: readonly SplitViewResizeItem[], boundaryIndex: number, startSnappingEnabled: boolean, endSnappingEnabled: boolean): SashState {
	const adjacentBefore = items[boundaryIndex];
	const adjacentAfter = items[boundaryIndex + 1];
	if (!adjacentBefore || !adjacentAfter || !adjacentBefore.visible && !adjacentAfter.visible) {
		return SashState.Disabled;
	}
	const collapsesBefore = hasCapacity(items, 0, boundaryIndex + 1, "collapse");
	const expandsBefore = hasCapacity(items, 0, boundaryIndex + 1, "expand");
	const collapsesAfter = hasCapacity(items, boundaryIndex + 1, items.length, "collapse");
	const expandsAfter = hasCapacity(items, boundaryIndex + 1, items.length, "expand");
	const atMinimum = !(collapsesBefore && expandsAfter);
	const atMaximum = !(expandsBefore && collapsesAfter);
	if (!atMinimum && !atMaximum) return SashState.Enabled;
	if (atMinimum && !atMaximum) return SashState.AtMinimum;
	if (!atMinimum && atMaximum) return SashState.AtMaximum;

	const beforeIndexes = indexesBefore(boundaryIndex);
	const afterIndexes = indexesAfter(boundaryIndex, items.length);
	const snapBefore = findFirstSnapIndex(items, beforeIndexes);
	const snapAfter = findFirstSnapIndex(items, afterIndexes);
	const position = items.slice(0, boundaryIndex + 1).reduce((total, item) => total + item.size, 0);
	const contentSize = items.reduce((total, item) => total + item.size, 0);
	if (snapBefore !== undefined && !items[snapBefore]!.visible && collapsesAfter && (position > 0 || startSnappingEnabled)) {
		return SashState.AtMinimum;
	}
	if (snapAfter !== undefined && !items[snapAfter]!.visible && collapsesBefore && (position < contentSize || endSnappingEnabled)) {
		return SashState.AtMaximum;
	}
	return SashState.Disabled;
}

function findFirstSnapIndex(items: readonly SplitViewResizeItem[], indexes: readonly number[]): number | undefined {
	for (const index of indexes) {
		const item = items[index]!;
		if (item.visible && item.snap) return index;
	}
	for (const index of indexes) {
		const item = items[index]!;
		if (item.visible && item.maximumSize > item.minimumSize) return undefined;
		if (!item.visible && item.snap) return index;
	}
	return undefined;
}

function findSnapCandidate(items: readonly SplitViewResizeItem[], options: SplitViewResizeOptions, minimumDelta: number, maximumDelta: number, beforeIndex: number | undefined, afterIndex: number | undefined): number | undefined {
	if (beforeIndex !== undefined) {
		const item = items[beforeIndex]!;
		const threshold = Math.floor(item.minimumSize / 2);
		const crossesThreshold = item.visible
			? options.delta < minimumDelta - threshold
			: options.delta >= minimumDelta + threshold;
		const keyboardCrossesEdge = options.input === "keyboard" && (item.visible ? options.delta < 0 && item.size <= item.minimumSize : options.delta > 0);
		if (crossesThreshold || keyboardCrossesEdge) return beforeIndex;
	}
	if (afterIndex !== undefined) {
		const item = items[afterIndex]!;
		const threshold = Math.floor(item.minimumSize / 2);
		const crossesThreshold = item.visible
			? options.delta >= maximumDelta + threshold
			: options.delta < maximumDelta - threshold;
		const keyboardCrossesEdge = options.input === "keyboard" && (item.visible ? options.delta > 0 && item.size <= item.minimumSize : options.delta < 0);
		if (crossesThreshold || keyboardCrossesEdge) return afterIndex;
	}
	return undefined;
}

function resizeLimits(items: readonly SplitViewResizeItem[], originalSizes: readonly number[], beforeIndexes: readonly number[], afterIndexes: readonly number[]): { readonly minimumDelta: number; readonly maximumDelta: number } {
	const minimumBefore = beforeIndexes.reduce((total, index) => total + effectiveMinimum(items[index]!) - originalSizes[index]!, 0);
	const maximumBefore = beforeIndexes.reduce((total, index) => total + items[index]!.maximumSize - originalSizes[index]!, 0);
	const maximumAfter = afterIndexes.reduce((total, index) => total + originalSizes[index]! - effectiveMinimum(items[index]!), 0);
	const minimumAfter = afterIndexes.reduce((total, index) => total + originalSizes[index]! - items[index]!.maximumSize, 0);
	return {
		minimumDelta: Math.max(minimumBefore, minimumAfter),
		maximumDelta: Math.min(maximumBefore, maximumAfter),
	};
}

function applyResize(items: SplitViewResizeItem[], originalSizes: readonly number[], beforeIndexes: readonly number[], afterIndexes: readonly number[], delta: number): void {
	let remaining = delta;
	for (const index of beforeIndexes) {
		const item = items[index]!;
		const size = clamp(originalSizes[index]! + remaining, effectiveMinimum(item), effectiveMaximum(item));
		remaining -= size - originalSizes[index]!;
		items[index] = { ...item, size };
	}
	remaining = delta;
	for (const index of afterIndexes) {
		const item = items[index]!;
		const size = clamp(originalSizes[index]! - remaining, effectiveMinimum(item), effectiveMaximum(item));
		remaining += size - originalSizes[index]!;
		items[index] = { ...item, size };
	}
}

function hasCapacity(items: readonly SplitViewResizeItem[], start: number, end: number, direction: "collapse" | "expand"): boolean {
	return items.slice(start, end).some((item) => direction === "collapse" ? item.size > effectiveMinimum(item) : effectiveMaximum(item) > item.size);
}

function effectiveMinimum(item: SplitViewResizeItem): number {
	return item.visible ? item.minimumSize : 0;
}

function effectiveMaximum(item: SplitViewResizeItem): number {
	return item.visible ? item.maximumSize : 0;
}

function indexesBefore(boundaryIndex: number): number[] {
	return Array.from({ length: boundaryIndex + 1 }, (_, index) => boundaryIndex - index);
}

function indexesAfter(boundaryIndex: number, itemCount: number): number[] {
	return Array.from({ length: itemCount - boundaryIndex - 1 }, (_, index) => boundaryIndex + index + 1);
}
