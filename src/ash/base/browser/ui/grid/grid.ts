import { Orientation } from '../sash/sash.js';
import { type IDimension } from '../../dom.js';
import { Event } from '../../../common/event.js';
import { Disposable } from '../../../common/lifecycle.js';
import { GridView, orthogonal, type GridNode, type GridLocation, type GridViewDescriptor, type IGridViewOptions, type GridViewSizing, type ISerializableView as ISerializableGridView, type IView as IGridView, type IViewDeserializer, type SerializedGridViewDescriptor } from './gridview.js';
import type { SashPresentation } from '../sash/sash.js';

export { Orientation, LayoutPriority } from './gridview.js';

/** A view hosted by the identity-addressed {@link Grid}. */
export type IView = IGridView;

export type ISerializableView = ISerializableGridView;

export type GridDescriptor<TView extends IView> = GridViewDescriptor<TView>;

export type SerializedGridDescriptor = SerializedGridViewDescriptor;

export type IGridOptions = IGridViewOptions;

export enum Direction {
	Up,
	Down,
	Left,
	Right,
}

export type Sizing =
	| { readonly type: 'distribute'; }
	| { readonly type: 'split'; }
	| { readonly type: 'invisible'; readonly cachedVisibleSize: number; };

export const Sizing = {
	Distribute: { type: 'distribute' } as const,
	Split: { type: 'split' } as const,
	Invisible(cachedVisibleSize: number): Sizing {
		return { type: 'invisible', cachedVisibleSize };
	},
};

/**
 * Identity-addressed wrapper over GridView.
 *
 * Grid keeps common call sites independent of GridLocation while GridView owns
 * the indexed tree and nested SplitViews.
 */
export class Grid<TView extends IView = IView> extends Disposable {
	protected readonly gridview: GridView;
	private readonly views = new Set<TView>();

	readonly onDidChange: Event<void>;
	/** Ash extension: a user pointer or keyboard resize has completed, independently of code-driven geometry. */
	readonly onDidSashChange: Event<void>;
	/** Ash extension: a user's double-click reset has been applied to the current tree. */
	readonly onDidSashReset: Event<void>;
	readonly onDidChangeViewMaximized: Event<boolean>;

	get element(): HTMLDivElement { return this.gridview.element; }
	get orientation(): Orientation { return this.gridview.orientation; }
	set orientation(orientation: Orientation) { this.gridview.orientation = orientation; }
	get width(): number { return this.gridview.width; }
	get height(): number { return this.gridview.height; }
	get minimumWidth(): number { return this.gridview.minimumWidth; }
	get maximumWidth(): number { return this.gridview.maximumWidth; }
	get minimumHeight(): number { return this.gridview.minimumHeight; }
	get maximumHeight(): number { return this.gridview.maximumHeight; }
	get edgeSnapping(): boolean { return this.gridview.edgeSnapping; }
	get sashPresentation(): SashPresentation { return this.gridview.sashPresentation; }

	set edgeSnapping(enabled: boolean) {
		this.gridview.edgeSnapping = enabled;
	}

	set sashPresentation(presentation: SashPresentation) {
		this.gridview.sashPresentation = presentation;
	}

	constructor(gridView: GridView);
	constructor(container: HTMLElement, descriptor: GridDescriptor<TView>, options?: IGridOptions);
	constructor(containerOrGridView: HTMLElement | GridView, ...descriptorAndOptions: [] | [descriptor: GridDescriptor<TView>, options?: IGridOptions]) {
		super();
		if (containerOrGridView instanceof GridView) {
			this.gridview = this._register(containerOrGridView);
		} else {
			const descriptor = descriptorAndOptions[0];
			if (!descriptor) throw new TypeError('Grid descriptor is required');
			this.gridview = this._register(new GridView(containerOrGridView, descriptor, descriptorAndOptions[1] ?? {}));
		}
		const collect = (node: GridNode): void => {
			if ('children' in node) node.children.forEach(collect);
			else this.views.add(node.view as TView);
		};
		collect(this.gridview.getView());
		this.onDidChange = this.gridview.onDidChange;
		this.onDidSashChange = this.gridview.onDidSashChange;
		this.onDidSashReset = Event.map(this.gridview.onDidSashReset, () => undefined);
		this.onDidChangeViewMaximized = this.gridview.onDidChangeViewMaximized;
	}

	layout(width: number, height: number): void {
		this.gridview.layout(width, height);
	}

	addView(
		newView: TView,
		sizing: number | Sizing,
		referenceView: TView,
		direction: Direction,
	): void {
		if (this.views.has(newView)) {
			throw new Error('Grid cannot contain the same view twice');
		}
		const referenceLocation = this.getViewLocation(referenceView);
		const location = getRelativeLocation(
			this.gridview.orientation,
			referenceLocation,
			direction,
		);
		this.gridview.addView(
			newView,
			toGridViewSizing(sizing, referenceLocation),
			location,
		);
		this.views.add(newView);
	}

	removeView(view: TView): void {
		this.gridview.removeView(this.getViewLocation(view));
		this.views.delete(view);
	}

	moveView(
		view: TView,
		sizing: number | Sizing,
		referenceView: TView,
		direction: Direction,
	): void {
		if (view === referenceView) {
			throw new Error('Grid cannot move a view relative to itself');
		}
		const sourceLocation = this.getViewLocation(view);
		const referenceLocation = this.getViewLocation(referenceView);
		const targetLocation = getRelativeLocation(
			this.gridview.orientation,
			referenceLocation,
			direction,
		);
		const sourceParent = sourceLocation.slice(0, -1);
		const targetParent = targetLocation.slice(0, -1);
		if (locationsEqual(sourceParent, targetParent)) {
			const from = sourceLocation[sourceLocation.length - 1]!;
			let to = targetLocation[targetLocation.length - 1]!;
			if (from < to) to -= 1;
			this.gridview.moveView(sourceParent, from, to);
			return;
		}
		const focused = view.element.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && view.element.contains(focused);
		this.removeView(view);
		this.addView(view, sizing, referenceView, direction);
		if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
	}

	getViewSize(view?: TView): IDimension {
		return this.gridview.getViewSize(view ? this.getViewLocation(view) : undefined);
	}

	/** Navigate from committed layout coordinates, independently of content insets and animation. */
	public getNeighborViews(view: TView, direction: Direction): TView[] {
		this.getViewLocation(view);
		if (!this.isViewVisible(view)) { return []; }
		const source = this.gridview.getView(this.getViewLocation(view)).box;
		const horizontal = direction === Direction.Left || direction === Direction.Right;
		const forward = direction === Direction.Right || direction === Direction.Down;
		const sourceStart = horizontal ? source.top : source.left;
		const sourceEnd = horizontal ? source.top + source.height : source.left + source.width;
		const boundary = horizontal ? (forward ? source.left + source.width : source.left) : (forward ? source.top + source.height : source.top);
		const candidates: { view: TView; gap: number; offset: number; }[] = [];
		for (const candidate of this.views) {
			if (candidate === view || !this.isViewVisible(candidate)) { continue; }
			const bounds = this.gridview.getView(this.getViewLocation(candidate)).box;
			const start = horizontal ? bounds.top : bounds.left;
			const end = horizontal ? bounds.top + bounds.height : bounds.left + bounds.width;
			if (Math.min(sourceEnd, end) <= Math.max(sourceStart, start)) { continue; }
			const edge = horizontal ? (forward ? bounds.left : bounds.left + bounds.width) : (forward ? bounds.top : bounds.top + bounds.height);
			const gap = forward ? edge - boundary : boundary - edge;
			if (gap < -0.5) { continue; }
			candidates.push({ view: candidate, gap, offset: Math.abs(start + end - sourceStart - sourceEnd) });
		}
		candidates.sort((left, right) => left.gap - right.gap || left.offset - right.offset);
		const nearest = candidates[0]?.gap;
		return candidates.filter(candidate => candidate.gap <= nearest! + 0.5).map(candidate => candidate.view);
	}

	resizeView(view: TView, dimension: Partial<IDimension>): void {
		this.gridview.resizeView(this.getViewLocation(view), dimension);
	}

	isViewVisible(view: TView): boolean {
		return this.gridview.isViewVisible(this.getViewLocation(view));
	}

	setViewVisible(view: TView, visible: boolean): void {
		this.gridview.setViewVisible(this.getViewLocation(view), visible);
	}

	maximizeView(view: TView, excludeViews: readonly TView[] = []): void {
		if (this.views.size < 2) throw new Error('Grid needs at least two views to maximize');
		this.gridview.maximizeView(this.getViewLocation(view), excludeViews);
	}

	exitMaximizedView(): void {
		this.gridview.exitMaximizedView();
	}

	hasMaximizedView(): boolean {
		return this.gridview.hasMaximizedView();
	}

	isViewMaximized(view: TView): boolean {
		return this.gridview.isViewMaximized(this.getViewLocation(view));
	}

	private getViewLocation(view: TView): GridLocation {
		if (!this.views.has(view)) {
			throw new Error('Grid view is not registered');
		}
		return this.gridview.getViewLocation(view);
	}
}

/** A Grid whose view identity and runtime geometry can cross persistence boundaries. */
export class SerializableGrid<TView extends ISerializableView> extends Grid<TView> {
	static deserialize<TView extends ISerializableView>(
		container: HTMLElement,
		descriptor: unknown,
		deserializer: IViewDeserializer<TView>,
		options: IGridOptions = {},
	): SerializableGrid<TView> {
		return new SerializableGrid(
			GridView.deserialize(container, descriptor, deserializer, options),
		);
	}

	serialize(): SerializedGridDescriptor {
		return this.gridview.serialize();
	}
}

function toGridViewSizing(
	sizing: number | Sizing,
	referenceLocation: GridLocation,
): GridViewSizing {
	if (typeof sizing === 'number') return sizing;
	if (sizing.type === 'split') {
		return {
			type: 'split',
			index: referenceLocation[referenceLocation.length - 1]!,
		};
	}
	return sizing;
}

function getRelativeLocation(
	rootOrientation: Orientation,
	location: GridLocation,
	direction: Direction,
): GridLocation {
	const parentDepth = location.length - 1;
	const parentOrientation = parentDepth % 2 === 0
		? rootOrientation
		: orthogonal(rootOrientation);
	const directionOrientation =
		direction === Direction.Left || direction === Direction.Right
			? Orientation.HORIZONTAL
			: Orientation.VERTICAL;
	if (parentOrientation === directionOrientation) {
		const parentLocation = location.slice(0, -1);
		const referenceIndex = location[location.length - 1]!;
		const index =
			direction === Direction.Right || direction === Direction.Down
				? referenceIndex + 1
				: referenceIndex;
		return [...parentLocation, index];
	}
	const index = direction === Direction.Right || direction === Direction.Down ? 1 : 0;
	return [...location, index];
}

function locationsEqual(left: GridLocation, right: GridLocation): boolean {
	return left.length === right.length &&
		left.every((index, position) => index === right[position]);
}
