import { Dimension, type IDimension } from "../../dom.js";
import { observeElementSize } from "../../observer.js";
import { type Event, Emitter } from "../../../common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import { clamp, isFiniteNumber } from "../../../common/numbers.js";
import { Sash, SashState } from "../sash/sash.js";
import { h } from "../../dom.js";

/** A control whose geometry is driven by an external container layout. */
export interface IResizable {
	/** Applies the current container dimension to the control. */
	layout(dimension: IDimension): void;
}

/** Connects a container dimension event to a generic resizable control. */
export function bindResizableLayout(event: Event<IDimension>, resizable: IResizable): IDisposable {
	return event((dimension) => resizable.layout(dimension));
}

export interface IResizeEvent {
	readonly dimension: Dimension;
	readonly done: boolean;
	readonly north?: boolean;
	readonly east?: boolean;
	readonly south?: boolean;
	readonly west?: boolean;
}

/** A four-edge resize surface for floating or otherwise independently sized UI. */
export class ResizableHTMLElement extends Disposable {
	readonly domNode: HTMLDivElement;

	private readonly _onDidWillResize = this._register(new Emitter<void>());
	readonly onDidWillResize: Event<void> = this._onDidWillResize.event;
	private readonly _onDidResize = this._register(new Emitter<IResizeEvent>());
	readonly onDidResize: Event<IResizeEvent> = this._onDidResize.event;

	private readonly northSash: Sash;
	private readonly eastSash: Sash;
	private readonly southSash: Sash;
	private readonly westSash: Sash;

	private _size = Dimension.Zero;
	private _minSize = Dimension.Zero;
	private _maxSize = new Dimension(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
	private _preferredSize: Dimension | undefined;
	private resizeStart: Dimension | undefined;
	private deltaX = 0;
	private deltaY = 0;

	constructor(container: HTMLElement) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, "div");
		this.domNode.className = "ash-resizable";
		this._register(toDisposable(() => this.domNode.remove()));

		container.append(this.domNode);
		this.northSash = this._register(new Sash(this.domNode, "horizontal"));
		this.eastSash = this._register(new Sash(this.domNode, "vertical"));
		this.southSash = this._register(new Sash(this.domNode, "horizontal"));
		this.westSash = this._register(new Sash(this.domNode, "vertical"));

		this.connectSash(this.northSash, "north");
		this.connectSash(this.eastSash, "east");
		this.connectSash(this.southSash, "south");
		this.connectSash(this.westSash, "west");
		this.enableSashes(true, true, true, true);
		this.layoutSashes();
	}

	enableSashes(north: boolean, east: boolean, south: boolean, west: boolean): void {
		this.setSashEnabled(this.northSash, north);
		this.setSashEnabled(this.eastSash, east);
		this.setSashEnabled(this.southSash, south);
		this.setSashEnabled(this.westSash, west);
	}

	layout(height: number = this.size.height, width: number = this.size.width): void {
		assertNonNegativeFinite(height, "height");
		assertNonNegativeFinite(width, "width");
		const nextHeight = clamp(height, this.minSize.height, this.maxSize.height);
		const nextWidth = clamp(width, this.minSize.width, this.maxSize.width);
		const nextSize = new Dimension(nextWidth, nextHeight);
		if (Dimension.equals(nextSize, this._size)) return;

		this.domNode.style.height = `${nextHeight}px`;
		this.domNode.style.width = `${nextWidth}px`;
		this._size = nextSize;
		this.layoutSashes();
	}

	clearSashHoverState(): void {
		this.northSash.clearSashHoverState();
		this.eastSash.clearSashHoverState();
		this.southSash.clearSashHoverState();
		this.westSash.clearSashHoverState();
	}

	get size(): Dimension {
		return this._size;
	}

	set maxSize(value: Dimension) {
		assertSize(value, "maximum size", true);
		if (value.width < this.minSize.width || value.height < this.minSize.height) {
			throw new RangeError("Resizable maximum size must not be smaller than its minimum size");
		}
		this._maxSize = value;
	}

	get maxSize(): Dimension {
		return this._maxSize;
	}

	set minSize(value: Dimension) {
		assertSize(value, "minimum size");
		if (value.width > this.maxSize.width || value.height > this.maxSize.height) {
			throw new RangeError("Resizable minimum size must not exceed its maximum size");
		}
		this._minSize = value;
	}

	get minSize(): Dimension {
		return this._minSize;
	}

	set preferredSize(value: Dimension | undefined) {
		if (value) assertSize(value, "preferred size");
		this._preferredSize = value;
	}

	get preferredSize(): Dimension | undefined {
		return this._preferredSize;
	}

	private connectSash(sash: Sash, edge: "north" | "east" | "south" | "west"): void {
		this._register(sash.onDidStart(() => {
			if (this.resizeStart !== undefined) return;
			this._onDidWillResize.fire();
			this.resizeStart = this._size;
			this.deltaX = 0;
			this.deltaY = 0;
		}));
		this._register(sash.onDidChange((event) => {
			if (this.resizeStart === undefined) return;
			if (edge === "east") this.deltaX = event.delta;
			if (edge === "west") this.deltaX = -event.delta;
			if (edge === "south") this.deltaY = event.delta;
			if (edge === "north") this.deltaY = -event.delta;
			this.layout(
				this.resizeStart.height + this.deltaY,
				this.resizeStart.width + this.deltaX,
			);
			this._onDidResize.fire({
				dimension: this._size,
				done: false,
				[edge]: true,
			});
		}));
		this._register(sash.onDidReset(() => {
			if (this.preferredSize === undefined) return;
			const height = edge === "north" || edge === "south"
				? this.preferredSize.height
				: this.size.height;
			const width = edge === "east" || edge === "west"
				? this.preferredSize.width
				: this.size.width;
			this.layout(height, width);
			this._onDidResize.fire({ dimension: this._size, done: true });
		}));
		this._register(sash.onDidEnd(() => {
			if (this.resizeStart === undefined) return;
			this.resizeStart = undefined;
			this.deltaX = 0;
			this.deltaY = 0;
			this._onDidResize.fire({ dimension: this._size, done: true });
		}));
	}

	private setSashEnabled(sash: Sash, enabled: boolean): void {
		sash.state = enabled ? SashState.Enabled : SashState.Disabled;
	}

	private layoutSashes(): void {
		setSashBounds(this.northSash, 0, 0, this.size.width, 1);
		setSashBounds(this.eastSash, this.size.width, 0, 1, this.size.height);
		setSashBounds(this.southSash, 0, this.size.height, this.size.width, 1);
		setSashBounds(this.westSash, 0, 0, 1, this.size.height);
	}
}

/** Compatibility wrapper for callers that use the browser-native resize surface. */
export class Resizable extends Disposable {
	readonly element: HTMLDivElement;

	constructor(container: HTMLElement, onResize?: (size: IDimension) => void) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-resizable";
		this.element.style.resize = "both";
		this.element.style.overflow = "auto";
		this._register(toDisposable(() => this.element.remove()));
		container.append(this.element);
		this._register(observeElementSize(this.element, (size) => onResize?.(size)));
	}
}

function setSashBounds(sash: Sash, left: number, top: number, width: number, height: number): void {
	sash.element.style.left = `${left}px`;
	sash.element.style.top = `${top}px`;
	sash.element.style.width = `${width}px`;
	sash.element.style.height = `${height}px`;
}

function assertSize(value: IDimension, name: string, allowInfinity = false): void {
	const validWidth = value.width >= 0 && (allowInfinity || Number.isFinite(value.width));
	const validHeight = value.height >= 0 && (allowInfinity || Number.isFinite(value.height));
	if (!validWidth || !validHeight) {
		throw new RangeError(`Resizable ${name} must be non-negative${allowInfinity ? "" : " and finite"}`);
	}
}

function assertNonNegativeFinite(value: number, name: string): void {
	if (!isFiniteNumber(value) || value < 0) {
		throw new RangeError(`Resizable ${name} must be non-negative and finite`);
	}
}
