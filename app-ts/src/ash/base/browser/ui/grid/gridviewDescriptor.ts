import { type IPositionedRectangle } from "../../geometry.js";
import { type Event } from "../../../common/event.js";
import { isFiniteNumber } from "../../../common/numbers.js";
import { type SplitViewLayoutPriority, type SplitViewOrientation, type SplitViewSizing } from "../splitview/splitview.js";

/** A leaf hosted by a GridView. */
export interface IView {
	readonly element: HTMLElement;
	readonly minimumWidth: number;
	readonly maximumWidth: number;
	readonly minimumHeight: number;
	readonly maximumHeight: number;
	/** Whether the view can snap closed along its primary Grid axis. */
	readonly snap?: boolean;
	readonly onDidChange?: Event<void>;
	layout(bounds: IPositionedRectangle): void;
	setVisible?(visible: boolean): void;
}

export interface ISerializableView extends IView {
	toJSON(): unknown;
}

export interface IViewDeserializer<TView extends ISerializableView> {
	fromJSON(data: unknown): TView;
}

export type GridLocation = readonly number[];

export type GridViewDescriptor<TView extends IView> =
	| {
		readonly type: "leaf";
		readonly view: TView;
		readonly size: number;
		readonly visible?: boolean;
		readonly priority?: SplitViewLayoutPriority;
	}
	| {
		readonly type: "branch";
		readonly orientation: SplitViewOrientation;
		readonly size: number;
		readonly children: readonly GridViewDescriptor<TView>[];
		readonly priority?: SplitViewLayoutPriority;
	};

export type SerializedGridViewDescriptor =
	| {
		readonly type: "leaf";
		readonly data: unknown;
		readonly size: number;
		readonly visible: boolean;
		readonly priority: SplitViewLayoutPriority;
	}
	| {
		readonly type: "branch";
		readonly orientation: SplitViewOrientation;
		readonly size: number;
		readonly children: readonly SerializedGridViewDescriptor[];
		readonly priority: SplitViewLayoutPriority;
	};

export type GridViewSizing =
	| number
	| { readonly type: "distribute" }
	| { readonly type: "split"; readonly index: number }
	| { readonly type: "invisible"; readonly cachedVisibleSize: number };

export function normalizeRootDescriptor(
	descriptor: GridViewDescriptor<IView>,
): GridViewDescriptor<IView> {
	if (descriptor.type === "branch") return descriptor;
	return {
		type: "branch",
		orientation: "horizontal",
		size: descriptor.size,
		children: [descriptor],
	};
}

export function normalizeDescriptor(
	descriptor: GridViewDescriptor<IView>,
	root: boolean,
): GridViewDescriptor<IView> {
	const normalized = normalizeDescriptorNode(descriptor, root);
	if (!normalized) {
		throw new Error("GridView cannot normalize an empty tree");
	}
	return normalizeRootDescriptor(normalized);
}

function normalizeDescriptorNode(
	descriptor: GridViewDescriptor<IView>,
	root: boolean,
): GridViewDescriptor<IView> | undefined {
	if (descriptor.type === "leaf") return descriptor;
	const normalized = descriptor.children
		.map((child) => normalizeDescriptorNode(child, false))
		.filter((child): child is GridViewDescriptor<IView> => child !== undefined);
	if (normalized.length === 0) return undefined;
	const flattened: GridViewDescriptor<IView>[] = [];
	for (const child of normalized) {
		if (child.type === "branch" && child.orientation === descriptor.orientation) {
			flattened.push(...child.children);
		} else {
			flattened.push(child);
		}
	}
	if (!root && flattened.length === 1) {
		return { ...flattened[0]!, size: descriptor.size };
	}
	if (root && flattened.length === 1 && flattened[0]!.type === "branch") {
		return { ...flattened[0]!, size: descriptor.size };
	}
	return { ...descriptor, children: flattened };
}

export function descriptorNode(
	root: GridViewDescriptor<IView>,
	location: GridLocation,
): GridViewDescriptor<IView> {
	let node = root;
	for (const index of location) {
		if (node.type !== "branch") {
			throw new Error("GridView location traverses through a leaf");
		}
		assertChildIndex(index, node.children.length);
		node = node.children[index]!;
	}
	return node;
}

export function replaceDescriptorNode(
	root: GridViewDescriptor<IView>,
	location: GridLocation,
	replacement: GridViewDescriptor<IView>,
): GridViewDescriptor<IView> {
	if (location.length === 0) return replacement;
	if (root.type !== "branch") {
		throw new Error("GridView replacement parent is not a branch");
	}
	const index = location[0]!;
	assertChildIndex(index, root.children.length);
	const children = [...root.children];
	children[index] = replaceDescriptorNode(
		children[index]!,
		location.slice(1),
		replacement,
	);
	return { ...root, children };
}

export function descriptorSizing(
	descriptor: GridViewDescriptor<IView>,
): SplitViewSizing {
	return descriptor.type === "leaf" && descriptor.visible === false
		? { type: "invisible", cachedVisibleSize: descriptor.size }
		: descriptor.size;
}

export function validateDescriptor(
	descriptor: GridViewDescriptor<IView>,
	seenViews: Set<IView>,
	parentOrientation: SplitViewOrientation | undefined,
): void {
	assertDimension(descriptor.size, "descriptor size");
	assertPriority(descriptor.priority ?? "normal");
	if (descriptor.type === "leaf") {
		if (seenViews.has(descriptor.view)) {
			throw new Error("GridView cannot contain the same view twice");
		}
		seenViews.add(descriptor.view);
		validateViewConstraints(descriptor.view);
		return;
	}
	if (descriptor.children.length === 0) {
		throw new TypeError("GridView branches must contain at least one child");
	}
	if (parentOrientation === descriptor.orientation) {
		throw new TypeError("GridView nested branches must alternate orientation");
	}
	for (const child of descriptor.children) {
		validateDescriptor(child, seenViews, descriptor.orientation);
	}
}

export function validateSerializedGridViewDescriptor(
	descriptor: SerializedGridViewDescriptor,
	parentOrientation?: SplitViewOrientation,
): void {
	assertDimension(descriptor.size, "serialized descriptor size");
	assertPriority(descriptor.priority);
	if (descriptor.type === "leaf") {
		if (typeof descriptor.visible !== "boolean") {
			throw new TypeError("GridView serialized leaf visibility is invalid");
		}
		return;
	}
	if (parentOrientation === descriptor.orientation) {
		throw new TypeError("GridView serialized branches must alternate orientation");
	}
	if (descriptor.children.length === 0) {
		throw new TypeError("GridView serialized branches must contain at least one child");
	}
	for (const child of descriptor.children) {
		validateSerializedGridViewDescriptor(child, descriptor.orientation);
	}
}

export function deserializeGridViewDescriptor<TView extends ISerializableView>(
	descriptor: SerializedGridViewDescriptor,
	deserializer: IViewDeserializer<TView>,
): GridViewDescriptor<TView> {
	if (descriptor.type === "leaf") {
		return {
			type: "leaf",
			view: deserializer.fromJSON(descriptor.data),
			size: descriptor.size,
			visible: descriptor.visible,
			priority: descriptor.priority,
		};
	}
	return {
		type: "branch",
		orientation: descriptor.orientation,
		size: descriptor.size,
		children: descriptor.children.map((child) =>
			deserializeGridViewDescriptor(child, deserializer)
		),
		priority: descriptor.priority,
	};
}

export function splitLocation(location: GridLocation): [GridLocation, number] {
	if (location.length === 0) {
		throw new Error("GridView location must include a child index");
	}
	return [location.slice(0, -1), location[location.length - 1]!];
}

export function assertInsertionIndex(index: number, length: number): void {
	if (!Number.isInteger(index) || index < 0 || index > length) {
		throw new RangeError(`GridView insertion index is out of range: ${index}`);
	}
}

export function assertChildIndex(index: number, length: number): void {
	if (!Number.isInteger(index) || index < 0 || index >= length) {
		throw new RangeError(`GridView child index is out of range: ${index}`);
	}
}

export function assertDimension(value: number, name: string): void {
	if (!isFiniteNumber(value) || value < 0) {
		throw new RangeError(`GridView ${name} must be a non-negative finite number`);
	}
}

export function validateViewConstraints(view: IView): void {
	for (
		const [minimum, maximum, axis] of [
			[view.minimumWidth, view.maximumWidth, "width"],
			[view.minimumHeight, view.maximumHeight, "height"],
		] as const
	) {
		assertDimension(minimum, `view minimum ${axis}`);
		if (typeof maximum !== "number" || Number.isNaN(maximum) || maximum < minimum) {
			throw new RangeError(
				`GridView view maximum ${axis} must be at least its minimum ${axis}`,
			);
		}
	}
}

export function isSerializableView(view: IView): view is ISerializableView {
	return "toJSON" in view && typeof view.toJSON === "function";
}

export function orthogonal(
	orientation: SplitViewOrientation,
): SplitViewOrientation {
	return orientation === "horizontal" ? "vertical" : "horizontal";
}

function assertPriority(priority: SplitViewLayoutPriority): void {
	if (priority !== "low" && priority !== "normal" && priority !== "high") {
		throw new TypeError("GridView descriptor priority is invalid");
	}
}
