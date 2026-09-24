import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import { getWindow } from "../../../base/browser/dom.js";
import { Dimension, getClientArea, type IDimension } from "../../../base/browser/dom.js";
import { observeElementSize } from "../../../base/browser/observer.js";
import type { BrowserWindow } from "../../../base/browser/window.js";
import { type Event, Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";

/** The offsets required when positioning overlays inside a Workbench container. */
export interface ILayoutOffsetInfo {
	readonly top: number;
	readonly quickInputTop: number;
}

/** A generic browser-container layout event. */
export interface ILayoutContainerEvent {
	readonly container: HTMLElement;
	readonly dimension: IDimension;
}

/**
 * Owns the geometry and focus boundary of one or more application containers.
 *
 * Implementations observe container size changes and publish layout events after
 * the container's dimensions are known. Product-specific topology and
 * persistence remain above this contract.
 */
export interface ILayoutService {
	readonly onDidLayoutMainContainer: Event<IDimension>;
	readonly onDidLayoutContainer: Event<ILayoutContainerEvent>;
	readonly onDidLayoutActiveContainer: Event<IDimension>;
	readonly onDidChangeActiveContainer: Event<void>;

	readonly mainContainerDimension: IDimension;
	readonly activeContainerDimension: IDimension;
	readonly mainContainer: HTMLElement;
	readonly activeContainer: HTMLElement;
	readonly containers: Iterable<HTMLElement>;

	getContainer(targetWindow: Window): HTMLElement;
	whenContainerStylesLoaded(targetWindow: Window): Promise<void> | undefined;

	readonly mainContainerOffset: ILayoutOffsetInfo;
	readonly activeContainerOffset: ILayoutOffsetInfo;

	/** Focuses the primary component hosted by the active container. */
	focus(): void;
}

export const ILayoutService = createServiceIdentifier<ILayoutService>(
	"layoutService",
);

const NoLayoutOffset: ILayoutOffsetInfo = Object.freeze({
	top: 0,
	quickInputTop: 0,
});

export interface BrowserLayoutServiceOptions {
	readonly root: HTMLElement;
	readonly getContainerOffset?: () => ILayoutOffsetInfo;
	readonly focus?: () => void;
}

/**
 * Browser implementation of the platform layout contract for one container.
 *
 * The service owns the root container's ResizeObserver and geometry events. It
 * deliberately does not know about Sidebar, Panel, Editor, or Grid topology.
 */
export class BrowserLayoutService
	extends Disposable
	implements ILayoutService {
	private readonly root: HTMLElement;
	private readonly targetWindow: BrowserWindow;
	private readonly getOffset: () => ILayoutOffsetInfo;
	private readonly focusPrimary: () => void;
	private readonly _onDidLayoutMainContainer = this._register(new Emitter<IDimension>());
	private readonly _onDidLayoutContainer = this._register(new Emitter<ILayoutContainerEvent>());
	private readonly _onDidLayoutActiveContainer = this._register(new Emitter<IDimension>());
	private readonly _onDidChangeActiveContainer = this._register(new Emitter<void>());
	private dimension: Dimension;

	readonly onDidLayoutMainContainer: Event<IDimension> =
		this._onDidLayoutMainContainer.event;
	readonly onDidLayoutContainer: Event<ILayoutContainerEvent> =
		this._onDidLayoutContainer.event;
	readonly onDidLayoutActiveContainer: Event<IDimension> =
		this._onDidLayoutActiveContainer.event;
	readonly onDidChangeActiveContainer: Event<void> =
		this._onDidChangeActiveContainer.event;

	constructor(options: BrowserLayoutServiceOptions) {
		super();
		this.root = options.root;
		this.targetWindow = getWindow(this.root);
		this.getOffset = options.getContainerOffset ?? (() => NoLayoutOffset);
		this.focusPrimary = options.focus ?? (() => undefined);
		this.dimension = getClientArea(this.root);

		this._register(observeElementSize(this.root, size => this.layout(size)));
	}

	get mainContainerDimension(): IDimension {
		return this.dimension;
	}

	get activeContainerDimension(): IDimension {
		return this.dimension;
	}

	get mainContainer(): HTMLElement {
		return this.root;
	}

	get activeContainer(): HTMLElement {
		return this.root;
	}

	get containers(): Iterable<HTMLElement> {
		return [this.root];
	}

	get mainContainerOffset(): ILayoutOffsetInfo {
		return this.getOffset();
	}

	get activeContainerOffset(): ILayoutOffsetInfo {
		return this.getOffset();
	}

	getContainer(targetWindow: Window): HTMLElement {
		if (targetWindow !== this.targetWindow) {
			throw new Error("Layout container is not registered");
		}
		return this.root;
	}

	whenContainerStylesLoaded(targetWindow: Window): Promise<void> | undefined {
		if (targetWindow !== this.targetWindow) {
			throw new Error("Layout container is not registered");
		}
		return undefined;
	}

	/** Lays out the root and publishes the platform geometry events. */
	layout(dimension: IDimension = getClientArea(this.root)): void {
		assertDimension(dimension);
		this.dimension = new Dimension(dimension.width, dimension.height);
		this._onDidLayoutContainer.fire({
			container: this.root,
			dimension: this.dimension,
		});
		this._onDidLayoutMainContainer.fire(this.dimension);
		this._onDidLayoutActiveContainer.fire(this.dimension);
	}

	focus(): void {
		this.focusPrimary();
	}
}

function assertDimension(dimension: IDimension): void {
	if (
		!Number.isFinite(dimension.width) ||
		dimension.width < 0 ||
		!Number.isFinite(dimension.height) ||
		dimension.height < 0
	) {
		throw new RangeError(
			"Layout container dimensions must be non-negative and finite",
		);
	}
}
