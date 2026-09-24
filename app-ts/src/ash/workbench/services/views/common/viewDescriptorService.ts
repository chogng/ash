import { Emitter, type Event } from "../../../../base/common/event.js";
import {
	Disposable,
	type IDisposable,

	toDisposable,
} from "../../../../base/common/lifecycle.js";
import {
	type ContextKeyChangeEvent,
	type IContextKey,
	type IContextKeyService,
} from "../../../../platform/contextkey/common/contextkey.js";
import {
	createServiceIdentifier,
} from "../../../../platform/instantiation/common/instantiation.js";
import {
	getVisibleViewContextKey,
} from "../../../common/contextkeys.js";
import {
	type IViewContainerDescriptor,
	type IViewContainerModel,
	type IViewDescriptor,
	type IViewDescriptorsChangeEvent,
	ViewContainerLocation,
	type WorkbenchViewRegistry,
	ViewsRegistry,
} from "../../../common/views.js";

/** Change to the containers available in one workbench window. */
export interface IViewContainersChangeEvent {
	readonly added: readonly IViewContainerDescriptor[];
	readonly removed: readonly IViewContainerDescriptor[];
}

/**
 * Window-scoped access to context-aware view container models.
 *
 * Implementations project realm-wide static declarations into independent
 * per-window visibility state.
 */
export interface IViewDescriptorService {
	readonly onDidChangeViewContainers: Event<IViewContainersChangeEvent>;
	readonly onDidChangeViewContainerOrder: Event<ViewContainerLocation>;

	getViewContainers(
		location: ViewContainerLocation,
	): readonly IViewContainerDescriptor[];
	getDefaultViewContainer(
		location: ViewContainerLocation,
	): IViewContainerDescriptor | undefined;
	getViewContainerForView(
		viewId: string,
	): IViewContainerDescriptor | undefined;
	getViewContainerModel(
		containerId: string,
	): IViewContainerModel;
	moveViewContainer(location: ViewContainerLocation, containerId: string, targetContainerId: string | undefined, position: "before" | "after"): void;
}

export const IViewDescriptorService =
	createServiceIdentifier<IViewDescriptorService>(
		"viewDescriptorService",
	);

export interface ViewDescriptorServiceOptions {
	readonly contextKeyService: IContextKeyService;
	readonly registry?: WorkbenchViewRegistry;
}

/**
 * Owns the runtime models for all view containers in one workbench window.
 */
export class ViewDescriptorService
	extends Disposable
	implements IViewDescriptorService {
	private readonly contextKeyService: IContextKeyService;
	private readonly registry: WorkbenchViewRegistry;
	private readonly models = new Map<string, ViewContainerModel>();
	private readonly containerOrders = new Map<ViewContainerLocation, string[]>();
	private readonly _onDidChangeViewContainers =
		this._register(new Emitter<IViewContainersChangeEvent>());
	private readonly _onDidChangeViewContainerOrder =
		this._register(new Emitter<ViewContainerLocation>());

	readonly onDidChangeViewContainers =
		this._onDidChangeViewContainers.event;
	readonly onDidChangeViewContainerOrder =
		this._onDidChangeViewContainerOrder.event;

	constructor(options: ViewDescriptorServiceOptions) {
		super();
		this.contextKeyService = options.contextKeyService;
		this.registry = options.registry ?? ViewsRegistry;
		for (const container of this.registry.getViewContainers()) {
			this.addContainer(container);
		}
		this._register(this.registry.onDidRegisterViewContainer((container) => {
			this.addContainer(container);
			this._onDidChangeViewContainers.fire({
				added: [container],
				removed: [],
			});
		}));
		this._register(this.registry.onDidDeregisterViewContainer((container) => {
			this.removeContainer(container);
			this._onDidChangeViewContainers.fire({
				added: [],
				removed: [container],
			});
		}));
		this._register(toDisposable(() => this.models.clear()));
	}

	getViewContainers(
		location: ViewContainerLocation,
	): readonly IViewContainerDescriptor[] {
		const registered = this.registry.getViewContainers(location);
		const registeredById = new Map(registered.map((container) => [container.id, container]));
		const order = (this.containerOrders.get(location) ?? []).filter((id) => registeredById.has(id));
		for (const container of registered) {
			if (!order.includes(container.id)) order.push(container.id);
		}
		this.containerOrders.set(location, order);
		return order.map((id) => registeredById.get(id)!);
	}

	getDefaultViewContainer(
		location: ViewContainerLocation,
	): IViewContainerDescriptor | undefined {
		return this.registry.getDefaultViewContainer(location);
	}

	getViewContainerForView(
		viewId: string,
	): IViewContainerDescriptor | undefined {
		return this.registry.getViewContainerForView(viewId);
	}

	getViewContainerModel(containerId: string): IViewContainerModel {
		const model = this.models.get(containerId);
		if (!model) throw new Error(`Unknown view container: ${containerId}`);
		return model;
	}

	moveViewContainer(location: ViewContainerLocation, containerId: string, targetContainerId: string | undefined, position: "before" | "after"): void {
		if (containerId === targetContainerId) return;
		const current = this.getViewContainers(location).map((container) => container.id);
		const sourceIndex = current.indexOf(containerId);
		if (sourceIndex < 0) throw new RangeError(`View container is not available at ${location}: ${containerId}`);
		current.splice(sourceIndex, 1);
		let targetIndex = targetContainerId === undefined ? current.length : current.indexOf(targetContainerId);
		if (targetIndex < 0) throw new RangeError(`Target view container is not available at ${location}: ${targetContainerId}`);
		if (targetContainerId !== undefined && position === "after") targetIndex += 1;
		current.splice(targetIndex, 0, containerId);
		const previous = this.containerOrders.get(location);
		if (previous && sameContainerOrder(previous, current)) return;
		this.containerOrders.set(location, current);
		this._onDidChangeViewContainerOrder.fire(location);
	}

	private addContainer(container: IViewContainerDescriptor): void {
		if (this.models.has(container.id)) return;
		this.models.set(
			container.id,
			this._register(new ViewContainerModel(
				container,
				this.registry,
				this.contextKeyService,
			)),
		);
	}

	private removeContainer(container: IViewContainerDescriptor): void {
		const model = this.models.get(container.id);
		if (!model) return;
		this.models.delete(container.id);
		model.dispose();
	}
}

function sameContainerOrder(first: readonly string[], second: readonly string[]): boolean {
	return first.length === second.length && first.every((id, index) => id === second[index]);
}

class ViewContainerModel
	extends Disposable
	implements IViewContainerModel {
	private readonly registry: WorkbenchViewRegistry;
	private readonly contextKeyService: IContextKeyService;
	private readonly visibility = new Map<string, boolean>();
	private readonly visibilityContextKeys =
		new Map<string, IContextKey<boolean>>();
	private readonly _onDidChangeAllViewDescriptors =
		this._register(new Emitter<IViewDescriptorsChangeEvent>());
	private readonly _onDidChangeActiveViewDescriptors =
		this._register(new Emitter<IViewDescriptorsChangeEvent>());
	private readonly _onDidChangeVisibleViewDescriptors =
		this._register(new Emitter<IViewDescriptorsChangeEvent>());
	private _allViewDescriptors: readonly IViewDescriptor[] = [];
	private _activeViewDescriptors: readonly IViewDescriptor[] = [];
	private _visibleViewDescriptors: readonly IViewDescriptor[] = [];

	readonly onDidChangeAllViewDescriptors =
		this._onDidChangeAllViewDescriptors.event;
	readonly onDidChangeActiveViewDescriptors =
		this._onDidChangeActiveViewDescriptors.event;
	readonly onDidChangeVisibleViewDescriptors =
		this._onDidChangeVisibleViewDescriptors.event;

	constructor(
		readonly viewContainer: IViewContainerDescriptor,
		registry: WorkbenchViewRegistry,
		contextKeyService: IContextKeyService,
	) {
		super();
		this.registry = registry;
		this.contextKeyService = contextKeyService;
		this._register(this.registry.onDidRegisterViews((event) => {
			if (event.container.id === this.viewContainer.id) this.recompute();
		}));
		this._register(this.registry.onDidDeregisterViews((event) => {
			if (event.container.id === this.viewContainer.id) this.recompute();
		}));
		this._register(this.contextKeyService.onDidChangeContext((event) => {
			if (this.affectsActiveViews(event)) this.recompute();
		}));
		this._register(toDisposable(() => {
			for (const key of this.visibilityContextKeys.values()) key.reset();
			this.visibilityContextKeys.clear();
			this.visibility.clear();
		}));
		this.recompute();
	}

	get allViewDescriptors(): readonly IViewDescriptor[] {
		return this._allViewDescriptors;
	}

	get activeViewDescriptors(): readonly IViewDescriptor[] {
		return this._activeViewDescriptors;
	}

	get visibleViewDescriptors(): readonly IViewDescriptor[] {
		return this._visibleViewDescriptors;
	}

	isVisible(viewId: string): boolean {
		return this._visibleViewDescriptors.some((view) => view.id === viewId);
	}

	setVisible(viewId: string, visible: boolean): void {
		const descriptor = this._allViewDescriptors.find(
			(view) => view.id === viewId,
		);
		if (!descriptor) throw new Error(`Unknown view: ${viewId}`);
		if (descriptor.canToggleVisibility === false) {
			throw new Error(`View visibility cannot be changed: ${viewId}`);
		}
		if (this.preferredVisibility(descriptor) === visible) return;
		this.visibility.set(viewId, visible);
		this.recompute();
	}

	private affectsActiveViews(event: ContextKeyChangeEvent): boolean {
		return this._allViewDescriptors.some((view) =>
			view.when !== undefined && event.affectsSome(view.when.keys())
		);
	}

	private recompute(): void {
		const previousAll = this._allViewDescriptors;
		const previousActive = this._activeViewDescriptors;
		const previousVisible = this._visibleViewDescriptors;
		const all = this.registry.getViews(this.viewContainer.id);
		const active = all.filter((view) =>
			this.contextKeyService.contextMatchesRules(view.when)
		);
		const visible = active.filter((view) =>
			this.preferredVisibility(view)
		);

		this._allViewDescriptors = all;
		this._activeViewDescriptors = active;
		this._visibleViewDescriptors = visible;
		this.updateVisibilityContextKeys(all, visible);
		fireDescriptorChanges(
			this._onDidChangeAllViewDescriptors,
			previousAll,
			all,
		);
		fireDescriptorChanges(
			this._onDidChangeActiveViewDescriptors,
			previousActive,
			active,
		);
		fireDescriptorChanges(
			this._onDidChangeVisibleViewDescriptors,
			previousVisible,
			visible,
		);
	}

	private preferredVisibility(descriptor: IViewDescriptor): boolean {
		return this.visibility.get(descriptor.id) ??
			descriptor.hideByDefault !== true;
	}

	private updateVisibilityContextKeys(
		all: readonly IViewDescriptor[],
		visible: readonly IViewDescriptor[],
	): void {
		const allIds = new Set(all.map((view) => view.id));
		const visibleIds = new Set(visible.map((view) => view.id));
		for (const [viewId, key] of this.visibilityContextKeys) {
			if (allIds.has(viewId)) continue;
			key.reset();
			this.visibilityContextKeys.delete(viewId);
			this.visibility.delete(viewId);
		}
		for (const descriptor of all) {
			let key = this.visibilityContextKeys.get(descriptor.id);
			if (!key) {
				key = this.contextKeyService.createKey(
					getVisibleViewContextKey(descriptor.id),
					false,
				);
				this.visibilityContextKeys.set(descriptor.id, key);
			}
			key.set(visibleIds.has(descriptor.id));
		}
	}
}

function fireDescriptorChanges(
	emitter: Emitter<IViewDescriptorsChangeEvent>,
	previous: readonly IViewDescriptor[],
	next: readonly IViewDescriptor[],
): void {
	const previousIds = new Set(previous.map((view) => view.id));
	const nextIds = new Set(next.map((view) => view.id));
	const added = next.filter((view) => !previousIds.has(view.id));
	const removed = previous.filter((view) => !nextIds.has(view.id));
	if (added.length === 0 && removed.length === 0) return;
	emitter.fire({ added, removed });
}
