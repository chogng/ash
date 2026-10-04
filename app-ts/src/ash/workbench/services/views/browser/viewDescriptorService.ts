import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IViewDescriptorService, ViewsRegistry, type IViewContainerDescriptor, type IViewContainerModel, type IViewDescriptor, type IViewContainersChangeEvent, type ViewContainerLocation, type WorkbenchViewRegistry } from '../../../common/views.js';
import { ViewContainerModel } from '../common/viewContainerModel.js';

interface ViewDescriptorServiceOptions {
	readonly registry?: WorkbenchViewRegistry;
}

/**
 * Owns the runtime models for all view containers in one workbench window.
 */
export class ViewDescriptorService extends Disposable implements IViewDescriptorService {
	private readonly registry: WorkbenchViewRegistry;
	private readonly models = this._register(new DisposableMap<string, ViewContainerModel>());
	private readonly containerOrders = new Map<ViewContainerLocation, string[]>();
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
	}

	public getViewContainers(
		location: ViewContainerLocation,
	): readonly IViewContainerDescriptor[] {
		const registered = this.registry.getViewContainers(location);
		const registeredById = new Map(registered.map((container) => [container.id, container]));
		const order = (this.containerOrders.get(location) ?? []).filter((id) => registeredById.has(id));
		for (const container of registered) {
			if (!order.includes(container.id)) { order.push(container.id); }
		}
		this.containerOrders.set(location, order);
		return order.map((id) => registeredById.get(id)!);
	}

	public get viewContainers(): readonly IViewContainerDescriptor[] {
		return this.registry.getViewContainers();
	}

	public getViewContainerById(id: string): IViewContainerDescriptor | null {
		return this.registry.getViewContainer(id) ?? null;
	}

	public getViewDescriptorById(id: string): IViewDescriptor | null {
		return this.registry.getView(id) ?? null;
	}

	public getDefaultViewContainer(
		location: ViewContainerLocation,
	): IViewContainerDescriptor | undefined {
		return this.registry.getDefaultViewContainer(location);
	}

	public getViewContainerForView(
		viewId: string,
	): IViewContainerDescriptor | undefined {
		return this.registry.getViewContainerForView(viewId);
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
		const registered = this.registry.getViewContainers(location).map(container => container.id);
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
