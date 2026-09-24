import { type IDimension } from "../../dom.js";
import { type Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import { GridView, type GridLocation, type GridViewDescriptor, type GridViewOptions, type GridViewSizing, type ISerializableView as ISerializableGridView, type IView as IGridView, type IViewDeserializer, type SerializedGridViewDescriptor } from "./gridview.js";
import type { SashPresentation } from '../sash/sash.js';

/** A view hosted by the identity-addressed {@link Grid}. */
export type IView = IGridView;

export type ISerializableView = ISerializableGridView;

export type GridDescriptor<TView extends IView> = GridViewDescriptor<TView>;

export type SerializedGridDescriptor = SerializedGridViewDescriptor;

export type GridOptions = GridViewOptions;

export type Direction = "up" | "right" | "down" | "left";

export const Direction = {
	Up: "up",
	Right: "right",
	Down: "down",
	Left: "left",
} as const;

export type Sizing =
	| { readonly type: "distribute" }
	| { readonly type: "split" }
	| { readonly type: "invisible"; readonly cachedVisibleSize: number };

export const Sizing = {
	Distribute: { type: "distribute" } as const,
	Split: { type: "split" } as const,
	Invisible(cachedVisibleSize: number): Sizing {
		return { type: "invisible", cachedVisibleSize };
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

	get element(): HTMLDivElement { return this.gridview.element; }
	get orientation(): "horizontal" | "vertical" { return this.gridview.orientation; }
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
	constructor(container: HTMLElement, descriptor: GridDescriptor<TView>, options?: GridOptions);
	constructor(containerOrGridView: HTMLElement | GridView, ...descriptorAndOptions: [] | [descriptor: GridDescriptor<TView>, options?: GridOptions]) {
		super();
		if (containerOrGridView instanceof GridView) {
			this.gridview = this._register(containerOrGridView);
		} else {
			const descriptor = descriptorAndOptions[0];
			if (!descriptor) throw new TypeError("Grid descriptor is required");
			this.gridview = this._register(new GridView(containerOrGridView, descriptor, descriptorAndOptions[1] ?? {}));
		}
		for (const view of this.gridview.getViews()) {
			this.views.add(view as TView);
		}
		this.onDidChange = this.gridview.onDidChange;
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
			throw new Error("Grid cannot contain the same view twice");
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
			throw new Error("Grid cannot move a view relative to itself");
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
		this.removeView(view);
		this.addView(view, sizing, referenceView, direction);
	}

	getViewSize(view: TView): IDimension {
		return this.gridview.getViewSize(this.getViewLocation(view));
	}

	resizeView(view: TView, dimension: IDimension): void {
		this.gridview.resizeView(this.getViewLocation(view), dimension);
	}

	isViewVisible(view: TView): boolean {
		return this.gridview.isViewVisible(this.getViewLocation(view));
	}

	setViewVisible(view: TView, visible: boolean): void {
		this.gridview.setViewVisible(this.getViewLocation(view), visible);
	}

	private getViewLocation(view: TView): GridLocation {
		if (!this.views.has(view)) {
			throw new Error("Grid view is not registered");
		}
		return this.gridview.getViewLocation(view);
	}
}

/** A Grid whose view identity and runtime geometry can cross persistence boundaries. */
export class SerializableGrid<TView extends ISerializableView> extends Grid<TView> {
	static deserialize<TView extends ISerializableView>(
		container: HTMLElement,
		descriptor: SerializedGridDescriptor,
		deserializer: IViewDeserializer<TView>,
		options: GridOptions = {},
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
	if (typeof sizing === "number") return sizing;
	if (sizing.type === "split") {
		return {
			type: "split",
			index: referenceLocation[referenceLocation.length - 1]!,
		};
	}
	return sizing;
}

function getRelativeLocation(
	rootOrientation: "horizontal" | "vertical",
	location: GridLocation,
	direction: Direction,
): GridLocation {
	const parentDepth = location.length - 1;
	const parentOrientation = parentDepth % 2 === 0
		? rootOrientation
		: orthogonal(rootOrientation);
	const directionOrientation =
		direction === "left" || direction === "right"
			? "horizontal"
			: "vertical";
	if (parentOrientation === directionOrientation) {
		const parentLocation = location.slice(0, -1);
		const referenceIndex = location[location.length - 1]!;
		const index =
			direction === "right" || direction === "down"
				? referenceIndex + 1
				: referenceIndex;
		return [...parentLocation, index];
	}
	const index = direction === "right" || direction === "down" ? 1 : 0;
	return [...location, index];
}

function orthogonal(
	orientation: "horizontal" | "vertical",
): "horizontal" | "vertical" {
	return orientation === "horizontal" ? "vertical" : "horizontal";
}

function locationsEqual(left: GridLocation, right: GridLocation): boolean {
	return left.length === right.length &&
		left.every((index, position) => index === right[position]);
}
