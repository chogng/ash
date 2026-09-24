import { type IDimension } from "../../dom.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, DisposableStore, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import { type Sash, type SashPresentation } from "../sash/sash.js";
import { type ISplitViewView, SplitView, type SplitViewLayoutPriority, type SplitViewOrientation } from "../splitview/splitview.js";
import { assertChildIndex, assertDimension, assertInsertionIndex, descriptorNode, descriptorSizing, deserializeGridViewDescriptor, isSerializableView, normalizeDescriptor, normalizeRootDescriptor, orthogonal, replaceDescriptorNode, splitLocation, type GridLocation, type GridViewDescriptor, type GridViewSizing, type ISerializableView, type IView, type IViewDeserializer, type SerializedGridViewDescriptor, validateDescriptor, validateSerializedGridViewDescriptor, validateViewConstraints } from "./gridviewDescriptor.js";
import { h } from "../../dom.js";

export { type GridLocation, type GridViewDescriptor, type GridViewSizing, type ISerializableView, type IView, type IViewDeserializer, type SerializedGridViewDescriptor } from "./gridviewDescriptor.js";

export interface GridViewOptions {
	/** Optional presentation applied to every Grid-owned Sash. */
	readonly sashPresentation?: SashPresentation;
	/** Whether hidden snap views remain recoverable from an outer Grid edge. Defaults to false. */
	readonly edgeSnapping?: boolean;
}

interface BoundarySashes {
	readonly start?: Sash;
	readonly end?: Sash;
	readonly orthogonalStart?: Sash;
	readonly orthogonalEnd?: Sash;
}

interface ParentLink {
	readonly branch: BranchNode;
	readonly index: number;
}

interface GridNodeHost {
	readonly container: HTMLElement;
	readonly sashPresentation: SashPresentation;
	ownSplitView(splitView: SplitView): SplitView;
	registerEvent(disposable: IDisposable): void;
	createNode(descriptor: GridViewDescriptor<IView>): GridNode;
	handleSplitViewChange(): void;
}

abstract class GridNode {
	constructor(readonly initialSize: number) {}

	abstract readonly element: HTMLElement;
	parent: ParentLink | undefined;
	width = 0;
	height = 0;
	top = 0;
	left = 0;
	priority: SplitViewLayoutPriority = "normal";

	abstract get minimumWidth(): number;
	abstract get maximumWidth(): number;
	abstract get minimumHeight(): number;
	abstract get maximumHeight(): number;
	abstract isVisible(): boolean;
	abstract setDisplayed(visible: boolean): void;
	abstract layout(width: number, height: number, top: number, left: number): void;
	setBoundarySashes(_sashes: BoundarySashes): void {}
	setEdgeSnapping(_enabled: boolean): void {}
	setSashPresentation(_presentation: SashPresentation): void {}
}

class LeafNode extends GridNode {
	constructor(
		readonly view: IView,
		public visible: boolean,
		initialSize: number,
	) {
		super(initialSize);
	}

	get element(): HTMLElement { return this.view.element; }
	get minimumWidth(): number { return this.view.minimumWidth; }
	get maximumWidth(): number { return this.view.maximumWidth; }
	get minimumHeight(): number { return this.view.minimumHeight; }
	get maximumHeight(): number { return this.view.maximumHeight; }
	isVisible(): boolean { return this.visible; }

	setDisplayed(visible: boolean): void {
		this.element.hidden = !visible;
		this.view.setVisible?.(visible);
	}

	layout(width: number, height: number, top: number, left: number): void {
		this.width = width;
		this.height = height;
		this.top = top;
		this.left = left;
		this.view.layout({ width, height, top, left });
	}
}

class BranchNode extends GridNode {
	readonly element: HTMLElement;
	readonly children: readonly GridNode[];
	readonly splitView: SplitView;
	private boundarySashes: BoundarySashes = {};
	private edgeSnapping = false;

	constructor(
		readonly orientation: SplitViewOrientation,
		descriptors: readonly GridViewDescriptor<IView>[],
		priority: SplitViewLayoutPriority,
		initialSize: number,
		host: GridNodeHost,
	) {
		super(initialSize);
		this.priority = priority;
		this.splitView = host.ownSplitView(new SplitView(
			host.container,
			orientation,
			{ sashPresentation: host.sashPresentation },
		));
		this.element = this.splitView.element;
		this.children = descriptors.map((descriptor) => host.createNode(descriptor));
		for (const [index, child] of this.children.entries()) {
			child.parent = { branch: this, index };
			this.splitView.addView(new AxisView(child, orientation), descriptorSizing(descriptors[index]!));
		}
		this.updateBoundarySashes();
		this.tryLink2x2Sashes(host);
		host.registerEvent(this.splitView.onDidChangeViewSizes(() => host.handleSplitViewChange()));
		host.registerEvent(this.splitView.onDidSashReset((boundaryIndex) => this.splitView.resetSash(boundaryIndex)));
	}

	get minimumWidth(): number {
		return this.axisConstraint("minimumWidth", Math.max, 0);
	}

	get maximumWidth(): number {
		return this.axisConstraint("maximumWidth", Math.min, Number.POSITIVE_INFINITY);
	}

	get minimumHeight(): number {
		return this.axisConstraint("minimumHeight", Math.max, 0);
	}

	get maximumHeight(): number {
		return this.axisConstraint("maximumHeight", Math.min, Number.POSITIVE_INFINITY);
	}

	isVisible(): boolean {
		return this.children.some((child) => child.isVisible());
	}

	setDisplayed(visible: boolean): void {
		this.element.hidden = !visible;
	}

	layout(width: number, height: number, top: number, left: number): void {
		this.width = width;
		this.height = height;
		this.top = top;
		this.left = left;
		this.updateSplitViewEdgeSnappingEnablement();
		if (this.orientation === "horizontal") {
			this.splitView.layout(width, height);
		} else {
			this.splitView.layout(height, width);
		}
	}

	override setBoundarySashes(sashes: BoundarySashes): void {
		if (sameBoundarySashes(this.boundarySashes, sashes)) return;
		this.boundarySashes = sashes;
		this.splitView.orthogonalStartSash = sashes.orthogonalStart;
		this.splitView.orthogonalEndSash = sashes.orthogonalEnd;
		this.updateBoundarySashes();
	}

	override setEdgeSnapping(enabled: boolean): void {
		if (this.edgeSnapping === enabled) return;
		this.edgeSnapping = enabled;
		for (const child of this.children) child.setEdgeSnapping(enabled);
		this.updateSplitViewEdgeSnappingEnablement();
	}

	override setSashPresentation(presentation: SashPresentation): void {
		this.splitView.sashPresentation = presentation;
		for (const child of this.children) child.setSashPresentation(presentation);
	}

	private axisConstraint(
		property: "minimumWidth" | "maximumWidth" | "minimumHeight" | "maximumHeight",
		orthogonalReducer: (left: number, right: number) => number,
		orthogonalInitial: number,
	): number {
		const visible = this.children.filter((child) => child.isVisible());
		if (visible.length === 0) return 0;
		const isPrimary = this.orientation === "horizontal"
			? property.endsWith("Width")
			: property.endsWith("Height");
		if (isPrimary) {
			return visible.reduce((total, child) => total + child[property], 0);
		}
		return visible.reduce(
			(result, child) => orthogonalReducer(result, child[property]),
			orthogonalInitial,
		);
	}

	private updateBoundarySashes(): void {
		for (const [index, child] of this.children.entries()) {
			child.setBoundarySashes({
				start: this.boundarySashes.orthogonalStart,
				end: this.boundarySashes.orthogonalEnd,
				orthogonalStart: index === 0 ? this.boundarySashes.start : this.splitView.getSash(index - 1),
				orthogonalEnd: index === this.children.length - 1 ? this.boundarySashes.end : this.splitView.getSash(index),
			});
		}
	}

	private tryLink2x2Sashes(host: GridNodeHost): void {
		if (this.children.length !== 2) return;
		const [first, second] = this.children;
		if (!(first instanceof BranchNode) || !(second instanceof BranchNode)) return;
		if (first.orientation !== second.orientation || first.children.length !== 2 || second.children.length !== 2) return;
		if (first.splitView.getViewSize(0) !== second.splitView.getViewSize(0)) return;
		const firstSash = first.splitView.getSash(0);
		const secondSash = second.splitView.getSash(0);
		if (!firstSash || !secondSash) return;
		firstSash.linkedSash = secondSash;
		secondSash.linkedSash = firstSash;
		host.registerEvent(toDisposable(() => {
			if (firstSash.linkedSash === secondSash) firstSash.linkedSash = undefined;
			if (secondSash.linkedSash === firstSash) secondSash.linkedSash = undefined;
		}));
	}

	private updateSplitViewEdgeSnappingEnablement(): void {
		const root = this.rootNode();
		const offset = this.orientation === "horizontal" ? this.left : this.top;
		const size = this.orientation === "horizontal" ? this.width : this.height;
		const absoluteSize = this.orientation === "horizontal" ? root.width : root.height;
		this.splitView.startSnappingEnabled = this.edgeSnapping || offset > 0;
		this.splitView.endSnappingEnabled = this.edgeSnapping || offset + size < absoluteSize;
	}

	private rootNode(): GridNode {
		let node: GridNode = this;
		while (node.parent) node = node.parent.branch;
		return node;
	}
}

class AxisView implements ISplitViewView {
	constructor(
		readonly node: GridNode,
		readonly orientation: SplitViewOrientation,
	) {}

	get element(): HTMLElement { return this.node.element; }
	get priority(): SplitViewLayoutPriority { return this.node.priority; }
	get minimumSize(): number {
		return this.orientation === "horizontal"
			? this.node.minimumWidth
			: this.node.minimumHeight;
	}
	get maximumSize(): number {
		return this.orientation === "horizontal"
			? this.node.maximumWidth
			: this.node.maximumHeight;
	}
	get snap(): boolean {
		return this.node instanceof LeafNode && this.node.view.snap === true;
	}
	get paneOverflow(): "hidden" | "visible" {
		return this.node instanceof BranchNode ? "visible" : "hidden";
	}

	layout(size: number, offset: number, orthogonalSize: number): void {
		const parent = this.node.parent?.branch;
		const parentTop = parent?.top ?? 0;
		const parentLeft = parent?.left ?? 0;
		if (this.orientation === "horizontal") {
			this.node.layout(size, orthogonalSize, parentTop, parentLeft + offset);
		} else {
			this.node.layout(orthogonalSize, size, parentTop + offset, parentLeft);
		}
	}

	setVisible(visible: boolean): void {
		if (this.node instanceof LeafNode) this.node.visible = visible;
		this.node.setDisplayed(visible);
	}
}

/**
 * Index-addressed two-dimensional layout engine.
 *
 * GridView owns the nested SplitView tree. Callers that identify leaves by
 * object identity should use Grid instead.
 */
export class GridView extends Disposable {
	readonly element: HTMLDivElement;
	private _sashPresentation: SashPresentation;
	private readonly treeResources = this._register(new DisposableStore());
	private readonly leaves = new Map<IView, LeafNode>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	private root!: BranchNode;
	private layoutWidth = 0;
	private layoutHeight = 0;
	private didLayout = false;
	private layingOut = false;
	private _edgeSnapping: boolean;

	readonly onDidChange: Event<void> = this._onDidChange.event;

	static deserialize<TView extends ISerializableView>(
		container: HTMLElement,
		descriptor: SerializedGridViewDescriptor,
		deserializer: IViewDeserializer<TView>,
		options: GridViewOptions = {},
	): GridView {
		validateSerializedGridViewDescriptor(descriptor);
		return new GridView(
			container,
			deserializeGridViewDescriptor(descriptor, deserializer),
			options,
		);
	}

	constructor(
		container: HTMLElement,
		descriptor: GridViewDescriptor<IView>,
		options: GridViewOptions = {},
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-grid ash-grid-view";
		this._sashPresentation = options.sashPresentation;
		this._edgeSnapping = options.edgeSnapping ?? false;
		this._register(toDisposable(() => this.element.remove()));
		container.append(this.element);
		this.rebuild(normalizeRootDescriptor(descriptor));
	}

	get orientation(): SplitViewOrientation {
		return this.root.orientation;
	}

	get width(): number { return this.root.width; }
	get height(): number { return this.root.height; }
	get minimumWidth(): number { return this.root.minimumWidth; }
	get maximumWidth(): number { return this.root.maximumWidth; }
	get minimumHeight(): number { return this.root.minimumHeight; }
	get maximumHeight(): number { return this.root.maximumHeight; }
	get edgeSnapping(): boolean { return this._edgeSnapping; }
	get sashPresentation(): SashPresentation { return this._sashPresentation; }

	set edgeSnapping(enabled: boolean) {
		if (this._edgeSnapping === enabled) return;
		this._edgeSnapping = enabled;
		this.root.setEdgeSnapping(enabled);
	}

	set sashPresentation(presentation: SashPresentation) {
		this._sashPresentation = presentation;
		this.root.setSashPresentation(presentation);
	}

	layout(width: number, height: number): void {
		assertDimension(width, "width");
		assertDimension(height, "height");
		this.layoutWidth = width;
		this.layoutHeight = height;
		this.didLayout = true;
		this.layingOut = true;
		try {
			this.root.layout(width, height, 0, 0);
		} finally {
			this.layingOut = false;
		}
	}

	addView(view: IView, sizing: GridViewSizing, location: GridLocation): void {
		if (this.leaves.has(view)) {
			throw new Error("GridView cannot contain the same view twice");
		}
		validateViewConstraints(view);
		const [parentLocation, index] = splitLocation(location);
		const runtimeParent = this.node(parentLocation);
		let descriptor = this.snapshot();
		const parent = descriptorNode(descriptor, parentLocation);
		const leaf = createAddedLeaf(view, sizing, runtimeParent);
		if (parent.type === "branch") {
			assertInsertionIndex(index, parent.children.length);
			const children = [...parent.children];
			if (typeof sizing !== "number" && sizing.type === "split") {
				const target = children[sizing.index];
				if (!target) throw new RangeError("GridView split target is out of range");
				const splitSize = target.size / 2;
				children[sizing.index] = { ...target, size: splitSize };
				leaf.size = splitSize;
			}
			children.splice(index, 0, leaf);
			descriptor = replaceDescriptorNode(
				descriptor,
				parentLocation,
				{ ...parent, children },
			);
		} else {
			if (index !== 0 && index !== 1) {
				throw new RangeError("GridView nested insertion index must be 0 or 1");
			}
			const orientation = orthogonal(runtimeParent.parent?.branch.orientation ?? this.root.orientation);
			const existingSize = orientation === "horizontal"
				? runtimeParent.width
				: runtimeParent.height;
			const childSize = existingSize > 0 ? existingSize : parent.size;
			const existing = { ...parent, size: childSize };
			if (typeof sizing !== "number" && sizing.type === "split") {
				existing.size = childSize / 2;
				leaf.size = childSize / 2;
			}
			const children = index === 0 ? [leaf, existing] : [existing, leaf];
			descriptor = replaceDescriptorNode(descriptor, parentLocation, {
				type: "branch",
				orientation,
				size: parent.size,
				children,
				priority: parent.priority,
			});
		}
		this.rebuild(descriptor);
		this._onDidChange.fire();
	}

	removeView(location: GridLocation): IView {
		const leaf = this.leafAt(location);
		if (this.leaves.size === 1) {
			throw new Error("GridView cannot remove its last view");
		}
		let descriptor = this.snapshot();
		const [parentLocation, index] = splitLocation(location);
		const parent = descriptorNode(descriptor, parentLocation);
		if (parent.type !== "branch" || parent.children[index]?.type !== "leaf") {
			throw new Error("GridView location does not identify a leaf");
		}
		const children = parent.children.filter((_, childIndex) => childIndex !== index);
		descriptor = replaceDescriptorNode(
			descriptor,
			parentLocation,
			{ ...parent, children },
		);
		this.rebuild(normalizeDescriptor(descriptor, true));
		leaf.view.element.remove();
		this._onDidChange.fire();
		return leaf.view;
	}

	moveView(parentLocation: GridLocation, from: number, to: number): void {
		let descriptor = this.snapshot();
		const parent = descriptorNode(descriptor, parentLocation);
		if (parent.type !== "branch") {
			throw new Error("GridView parent location does not identify a branch");
		}
		assertChildIndex(from, parent.children.length);
		assertChildIndex(to, parent.children.length);
		if (from === to) return;
		const children = [...parent.children];
		const [moved] = children.splice(from, 1);
		children.splice(to, 0, moved!);
		descriptor = replaceDescriptorNode(
			descriptor,
			parentLocation,
			{ ...parent, children },
		);
		this.rebuild(descriptor);
		this._onDidChange.fire();
	}

	getViewLocation(view: IView): GridLocation {
		const leaf = this.leaf(view);
		const location: number[] = [];
		let node: GridNode = leaf;
		while (node.parent) {
			location.unshift(node.parent.index);
			node = node.parent.branch;
		}
		return location;
	}

	getViews(): readonly IView[] {
		return [...this.leaves.keys()];
	}

	getViewSize(location?: GridLocation): IDimension {
		const node = location ? this.node(location) : this.root;
		if (node instanceof LeafNode && !node.visible && node.parent) {
			const { branch, index } = node.parent;
			const primarySize =
				branch.splitView.getViewCachedVisibleSize(index) ??
				branch.splitView.getViewSize(index);
			return branch.orientation === "horizontal"
				? { width: primarySize, height: branch.height }
				: { width: branch.width, height: primarySize };
		}
		return { width: node.width, height: node.height };
	}

	getViewCachedVisibleSize(location: GridLocation): number | undefined {
		const leaf = this.leafAt(location);
		if (!leaf.parent) return undefined;
		return leaf.parent.branch.splitView.getViewCachedVisibleSize(leaf.parent.index);
	}

	resizeView(location: GridLocation, dimension: Partial<IDimension>): void {
		const leaf = this.leafAt(location);
		if (dimension.width !== undefined) {
			assertDimension(dimension.width, "view width");
			this.resizeOnAxis(leaf, "horizontal", dimension.width);
		}
		if (dimension.height !== undefined) {
			assertDimension(dimension.height, "view height");
			this.resizeOnAxis(leaf, "vertical", dimension.height);
		}
	}

	isViewVisible(location: GridLocation): boolean {
		return this.leafAt(location).visible;
	}

	setViewVisible(location: GridLocation, visible: boolean): void {
		const leaf = this.leafAt(location);
		if (leaf.visible === visible) return;
		leaf.visible = visible;
		let node: GridNode = leaf;
		while (node.parent) {
			const { branch, index } = node.parent;
			branch.splitView.setViewVisible(index, node.isVisible());
			node = branch;
		}
		if (this.didLayout) this.layout(this.layoutWidth, this.layoutHeight);
		this._onDidChange.fire();
	}

	serialize(): SerializedGridViewDescriptor {
		return serializeGridNode(this.root, this.didLayout);
	}

	private rebuild(descriptor: GridViewDescriptor<IView>): void {
		validateDescriptor(descriptor, new Set(), undefined);
		this.treeResources.clear();
		this.leaves.clear();
		const host: GridNodeHost = {
			container: this.element,
			sashPresentation: this._sashPresentation,
			ownSplitView: (splitView) => this.treeResources.add(splitView),
			registerEvent: (disposable) => {
				this.treeResources.add(disposable);
			},
			createNode: (nodeDescriptor) => this.createNode(nodeDescriptor, host),
			handleSplitViewChange: () => {
				if (!this.layingOut) this._onDidChange.fire();
			},
		};
		const root = this.createNode(descriptor, host);
		if (!(root instanceof BranchNode)) {
			throw new TypeError("GridView root must be a branch");
		}
		this.root = root;
		this.root.setEdgeSnapping(this._edgeSnapping);
		this.element.append(root.element);
		for (const [view, leaf] of this.leaves) {
			leaf.setDisplayed(leaf.visible);
			if (view.onDidChange) {
				this.treeResources.add(view.onDidChange(() => {
					if (this.didLayout) this.layout(this.layoutWidth, this.layoutHeight);
				}));
			}
		}
		if (this.didLayout) this.layout(this.layoutWidth, this.layoutHeight);
	}

	private createNode(
		descriptor: GridViewDescriptor<IView>,
		host: GridNodeHost,
	): GridNode {
		if (descriptor.type === "leaf") {
			const leaf = new LeafNode(descriptor.view, descriptor.visible !== false, descriptor.size);
			leaf.priority = descriptor.priority ?? "normal";
			this.leaves.set(descriptor.view, leaf);
			return leaf;
		}
		return new BranchNode(
			descriptor.orientation,
			descriptor.children,
			descriptor.priority ?? "normal",
			descriptor.size,
			host,
		);
	}

	private resizeOnAxis(
		leaf: LeafNode,
		orientation: SplitViewOrientation,
		size: number,
	): void {
		let node: GridNode = leaf;
		while (node.parent) {
			const { branch, index } = node.parent;
			if (branch.orientation === orientation) {
				branch.splitView.resizeView(index, size);
				return;
			}
			node = branch;
		}
	}

	private node(location: GridLocation): GridNode {
		let node: GridNode = this.root;
		for (const index of location) {
			if (!(node instanceof BranchNode)) {
				throw new Error("GridView location traverses through a leaf");
			}
			assertChildIndex(index, node.children.length);
			node = node.children[index]!;
		}
		return node;
	}

	private leafAt(location: GridLocation): LeafNode {
		const node = this.node(location);
		if (!(node instanceof LeafNode)) {
			throw new Error("GridView location does not identify a leaf");
		}
		return node;
	}

	private leaf(view: IView): LeafNode {
		const leaf = this.leaves.get(view);
		if (!leaf) throw new Error("Grid view is not registered");
		return leaf;
	}

	private snapshot(): GridViewDescriptor<IView> {
		return snapshotGridNode(this.root, this.didLayout);
	}
}

function snapshotGridNode(node: GridNode, didLayout: boolean): GridViewDescriptor<IView> {
	const size = gridNodeSize(node, didLayout);
	if (node instanceof LeafNode) {
		return {
			type: "leaf",
			view: node.view,
			size,
			visible: node.visible,
			priority: node.priority,
		};
	}
	if (!(node instanceof BranchNode)) {
		throw new TypeError("GridView contains an unsupported node");
	}
	return {
		type: "branch",
		orientation: node.orientation,
		size,
		children: node.children.map((child) => snapshotGridNode(child, didLayout)),
		priority: node.priority,
	};
}

function serializeGridNode(node: GridNode, didLayout: boolean): SerializedGridViewDescriptor {
	const size = gridNodeSize(node, didLayout);
	if (node instanceof LeafNode) {
		if (!isSerializableView(node.view)) {
			throw new TypeError("SerializableGrid contains a non-serializable view");
		}
		return {
			type: "leaf",
			data: node.view.toJSON(),
			size,
			visible: node.visible,
			priority: node.priority,
		};
	}
	if (!(node instanceof BranchNode)) {
		throw new TypeError("SerializableGrid contains an unsupported node");
	}
	return {
		type: "branch",
		orientation: node.orientation,
		size,
		children: node.children.map((child) => serializeGridNode(child, didLayout)),
		priority: node.priority,
	};
}

function gridNodeSize(node: GridNode, didLayout: boolean): number {
	if (node.parent) {
		const { branch, index } = node.parent;
		return branch.splitView.getViewCachedVisibleSize(index) ?? branch.splitView.getViewSize(index);
	}
	if (!didLayout) return node.initialSize;
	return node instanceof BranchNode && node.orientation === "vertical" ? node.height : node.width;
}

function sameBoundarySashes(left: BoundarySashes, right: BoundarySashes): boolean {
	return left.start === right.start && left.end === right.end && left.orthogonalStart === right.orthogonalStart && left.orthogonalEnd === right.orthogonalEnd;
}

function createAddedLeaf(
	view: IView,
	sizing: GridViewSizing,
	parent: GridNode,
): {
	type: "leaf";
	view: IView;
	size: number;
	visible: boolean;
	priority: SplitViewLayoutPriority;
} {
	if (typeof sizing === "number") {
		assertDimension(sizing, "added view size");
		return { type: "leaf", view, size: sizing, visible: true, priority: "normal" };
	}
	if (sizing.type === "invisible") {
		assertDimension(sizing.cachedVisibleSize, "added view cached visible size");
		return {
			type: "leaf",
			view,
			size: sizing.cachedVisibleSize,
			visible: false,
			priority: "normal",
		};
	}
	const primarySize = parent instanceof BranchNode
		? (parent.orientation === "horizontal" ? parent.width : parent.height)
		: Math.max(parent.width, parent.height);
	const divisor = parent instanceof BranchNode ? parent.children.length + 1 : 2;
	return {
		type: "leaf",
		view,
		size: primarySize > 0 ? primarySize / divisor : parent.initialSize / divisor,
		visible: true,
		priority: "normal",
	};
}
