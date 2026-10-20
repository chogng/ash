import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IViewDescriptorService, ViewsRegistry, type IViewContainerDescriptor, type IViewContainerModel, type IViewDescriptor, type IViewContainersChangeEvent, type ViewContainerLocation, type WorkbenchViewRegistry } from '../../../common/views.js';
import { ViewContainerModel } from '../common/viewContainerModel.js';

interface ViewDescriptorServiceOptions {
	readonly registry?: WorkbenchViewRegistry;
	/** Initial window state, decoded by the host's persistence boundary. */
	readonly viewContainerLocations?: Readonly<Record<string, ViewContainerLocation>>;
}

/**
 * Owns the runtime models for all view containers in one workbench window.
 */
export class ViewDescriptorService extends Disposable implements IViewDescriptorService {
	private readonly registry: WorkbenchViewRegistry;
	private readonly models = this._register(new DisposableMap<string, ViewContainerModel>());
	private readonly containerOrders = new Map<ViewContainerLocation, string[]>();
	private readonly locations: Map<string, ViewContainerLocation>;
	private readonly locationChanged = this._register(new Emitter<{ viewContainer: IViewContainerDescriptor; from: ViewContainerLocation; to: ViewContainerLocation; }>());
	public readonly onDidChangeContainerLocation = this.locationChanged.event;
	private readonly _onDidChangeViewContainers =
		this._register(new Emitter<IViewContainersChangeEvent>());
	private readonly _onDidChangeViewContainerOrder =
		this._register(new Emitter<ViewContainerLocation>());

	public readonly onDidChangeViewContainers =
		this._onDidChangeViewContainers.event;
	public readonly onDidChangeViewContainerOrder =
		this._onDidChangeViewContainerOrder.event;

	constructor(options: ViewDescriptorServiceOptions, @IContextKeyService private readonly contextKeyService: IContextKeyService) {
		super();
		this.registry = options.registry ?? ViewsRegistry;
		this.locations = new Map(Object.entries(options.viewContainerLocations ?? {}));
		for (const container of this.registry.getViewContainers()) {
			this.addContainer(container);
		}
		this._register(this.registry.onDidRegisterViewContainer((container) => {
			this.addContainer(container);
			this._onDidChangeViewContainers.fire({
				added: [this.getViewContainerById(container.id)!],
				removed: [],
			});
		}));
		this._register(this.registry.onDidDeregisterViewContainer((container) => {
			const removed = this.getViewContainerById(container.id) ?? this.projectContainer(container);
			this.removeContainer(container);
			this._onDidChangeViewContainers.fire({
				added: [],
				removed: [removed],
			});
		}));
	}

	public getViewContainers(
		location: ViewContainerLocation,
	): readonly IViewContainerDescriptor[] {
		const registered = this.viewContainers.filter(container => container.location === location);
		const registeredById = new Map(registered.map((container) => [container.id, container]));
		const order = (this.containerOrders.get(location) ?? []).filter((id) => registeredById.has(id));
		for (const container of registered) {
			if (!order.includes(container.id)) { order.push(container.id); }
		}
		this.containerOrders.set(location, order);
		return order.map((id) => registeredById.get(id)!);
	}

	public get viewContainers(): readonly IViewContainerDescriptor[] {
		return this.registry.getViewContainers().map(container => this.projectContainer(container));
	}

	public getViewContainerById(id: string): IViewContainerDescriptor | null {
		const container = this.registry.getViewContainer(id);
		return container ? this.projectContainer(container) : null;
	}

	public getViewDescriptorById(id: string): IViewDescriptor | null {
		return this.registry.getView(id) ?? null;
	}

	public getDefaultViewContainer(
		location: ViewContainerLocation,
	): IViewContainerDescriptor | undefined {
		const containers = this.getViewContainers(location);
		const defaultId = this.registry.getDefaultViewContainer(location)?.id;
		return containers.find(container => container.id === defaultId) ?? containers[0];
	}

	public getViewContainerForView(
		viewId: string,
	): IViewContainerDescriptor | undefined {
		const container = this.registry.getViewContainerForView(viewId);
		return container ? this.getViewContainerById(container.id) ?? undefined : undefined;
	}

	public getDefaultViewContainerLocation(container: IViewContainerDescriptor): ViewContainerLocation | null {
		return this.registry.getViewContainer(container.id)?.location ?? null;
	}

	public getViewContainerLocation(container: IViewContainerDescriptor): ViewContainerLocation | null {
		return this.getViewContainerById(container.id)?.location ?? null;
	}

	public moveViewContainerToLocation(container: IViewContainerDescriptor, location: ViewContainerLocation, requestedIndex?: number, _reason?: string): void {
		const current = this.getViewContainerById(container.id);
		if (!current || current.location === location) return;
		if (location === this.getDefaultViewContainerLocation(current)) this.locations.delete(current.id);
		else this.locations.set(current.id, location);
		this.containerOrders.set(current.location, (this.containerOrders.get(current.location) ?? []).filter(id => id !== current.id));
		const order = this.getViewContainers(location).map(item => item.id).filter(id => id !== current.id);
		let index = requestedIndex ?? order.length;
		if (requestedIndex === undefined && location === this.getDefaultViewContainerLocation(current)) {
			const defaults = this.registry.getViewContainers(location).map(item => item.id);
			const next = defaults.slice(defaults.indexOf(current.id) + 1).find(id => order.includes(id));
			if (next) index = order.indexOf(next);
		}
		order.splice(index, 0, current.id);
		this.containerOrders.set(location, order);
		const moved = this.getViewContainerById(current.id)!;
		// Hosts discard the old presentation, while the view model and visibility choices survive.
		this._onDidChangeViewContainers.fire({ removed: [current], added: [moved] });
		this.locationChanged.fire({ viewContainer: moved, from: current.location, to: location });
	}

	private projectContainer(container: IViewContainerDescriptor): IViewContainerDescriptor {
		const location = this.locations.get(container.id) ?? container.location;
		return location === container.location ? container : { ...container, location };
	}

	public getViewContainerModel(containerId: string): IViewContainerModel {
		const model = this.models.get(containerId);
		if (!model) { throw new Error(`Unknown view container: ${containerId}`); }
		return model;
	}

	public moveViewContainer(location: ViewContainerLocation, containerId: string, targetContainerId: string | undefined, position: 'before' | 'after'): void {
		if (containerId === targetContainerId) { return; }
		const current = this.getViewContainers(location).map((container) => container.id);
		const sourceIndex = current.indexOf(containerId);
		if (sourceIndex < 0) { throw new RangeError(`View container is not available at ${location}: ${containerId}`); }
		current.splice(sourceIndex, 1);
		let targetIndex = targetContainerId === undefined ? current.length : current.indexOf(targetContainerId);
		if (targetIndex < 0) { throw new RangeError(`Target view container is not available at ${location}: ${targetContainerId}`); }
		if (targetContainerId !== undefined && position === 'after') { targetIndex += 1; }
		current.splice(targetIndex, 0, containerId);
		const previous = this.containerOrders.get(location);
		if (previous && sameContainerOrder(previous, current)) { return; }
		this.containerOrders.set(location, current);
		this._onDidChangeViewContainerOrder.fire(location);
	}

	public setViewContainerOrder(location: ViewContainerLocation, containerIds: readonly string[]): void {
		const registered = this.getViewContainers(location).map(container => container.id);
		const order = [...containerIds.filter(id => registered.includes(id)), ...registered.filter(id => !containerIds.includes(id))];
		if (sameContainerOrder(this.getViewContainers(location).map(container => container.id), order)) { return; }
		this.containerOrders.set(location, order);
		this._onDidChangeViewContainerOrder.fire(location);
	}

	private addContainer(container: IViewContainerDescriptor): void {
		if (this.models.has(container.id)) { return; }
		this.models.set(
			container.id,
			new ViewContainerModel(
				container,
				this.registry,
				this.contextKeyService,
			),
		);
	}

	private removeContainer(container: IViewContainerDescriptor): void {
		this.models.deleteAndDispose(container.id);
	}
}

function sameContainerOrder(first: readonly string[], second: readonly string[]): boolean {
	return first.length === second.length && first.every((id, index) => id === second[index]);
}
