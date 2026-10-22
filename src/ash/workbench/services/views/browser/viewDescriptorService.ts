import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService, ViewsRegistry, type IViewContainerDescriptor, type IViewContainerModel, type IViewDescriptor, type IViewContainersChangeEvent, type ViewContainerLocation, type WorkbenchViewRegistry } from '../../../common/views.js';
import { ViewContainerModel } from '../common/viewContainerModel.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';

const viewCustomizationsKey = 'views.customizations';
const generatedContainerPrefix = 'workbench.views.service.';

interface ViewCustomizations {
	readonly viewLocations: Record<string, string>;
	readonly generatedViewContainerLocations: Record<string, ViewContainerLocation>;
}

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
	private readonly viewLocations = new Map<string, string>();
	private readonly generatedLocations = new Map<string, ViewContainerLocation>();
	private readonly generatedContainers = new Map<string, IViewContainerDescriptor>();
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

	constructor(options: ViewDescriptorServiceOptions, @IInstantiationService private readonly instantiation: IInstantiationService, @IStorageService private readonly storage: IStorageService) {
		super();
		this.registry = options.registry ?? ViewsRegistry;
		this.locations = new Map(Object.entries(options.viewContainerLocations ?? {}));
		try {
			this.restoreCustomizations();
			for (const container of this.registry.getViewContainers()) this.addContainer(container);
			this.syncViewModels();
		} catch (error) {
			this.dispose();
			throw error;
		}
		this._register(this.registry.onDidRegisterViewContainer((container) => {
			this.addContainer(container);
			this._onDidChangeViewContainers.fire({
				added: [this.getViewContainerById(container.id)!],
				removed: [],
			});
			this.syncViewModels();
		}));
		this._register(this.registry.onDidRegisterViews(() => this.syncViewModels()));
		this._register(this.registry.onDidDeregisterViews(() => this.syncViewModels()));
		this._register(storage.onDidChangeValue(event => {
			if (!event.external || event.scope !== StorageScope.PROFILE || event.key !== viewCustomizationsKey) return;
			try {
				this.restoreCustomizations();
				this.syncViewModels();
			} catch (error) { onUnexpectedError(error); }
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
		return [...this.registry.getViewContainers(), ...this.generatedContainers.values()].map(container => this.projectContainer(container));
	}

	public getViewContainerById(id: string): IViewContainerDescriptor | null {
		const container = this.registry.getViewContainer(id) ?? this.generatedContainers.get(id);
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
		const custom = this.viewLocations.get(viewId);
		const container = custom && this.registry.getView(viewId)?.canMoveView ? this.getViewContainerById(custom) : undefined;
		if (container && !container.rejectAddedViews) return container;
		return this.getDefaultContainerById(viewId) ?? undefined;
	}

	public getDefaultContainerById(viewId: string): IViewContainerDescriptor | null {
		const container = this.registry.getViewContainerForView(viewId);
		return container ? this.getViewContainerById(container.id) : null;
	}

	public getDefaultViewContainerLocation(container: IViewContainerDescriptor): ViewContainerLocation | null {
		return this.registry.getViewContainer(container.id)?.location ?? this.generatedLocations.get(container.id) ?? null;
	}

	public getViewContainerLocation(container: IViewContainerDescriptor): ViewContainerLocation | null {
		return this.getViewContainerById(container.id)?.location ?? null;
	}

	public moveViewContainerToLocation(container: IViewContainerDescriptor, location: ViewContainerLocation, requestedIndex?: number, _reason?: string): void {
		const current = this.getViewContainerById(container.id);
		if (!current || current.location === location) return;
		if (this.generatedContainers.has(current.id)) {
			this.generatedLocations.set(current.id, location);
			this.generatedContainers.set(current.id, { ...current, location });
			this.locations.delete(current.id);
			this.saveCustomizations();
		}
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

	public moveViewToLocation(view: IViewDescriptor, location: ViewContainerLocation): void {
		if (!view.canMoveView || this.registry.getView(view.id) !== view) return;
		const id = generatedContainerPrefix + generateUuid();
		this.generatedLocations.set(id, location);
		this.setViewLocation(view.id, id);
		this.finishMove([view]);
	}

	public moveViewsToContainer(views: readonly IViewDescriptor[], container: IViewContainerDescriptor): void {
		const target = this.getViewContainerById(container.id);
		if (!target || target.rejectAddedViews || views.some(view => !view.canMoveView || this.registry.getView(view.id) !== view)) return;
		for (const view of views) this.setViewLocation(view.id, target.id);
		this.finishMove(views);
	}

	private setViewLocation(viewId: string, containerId: string): void {
		if (this.registry.getViewContainerForView(viewId)?.id === containerId) this.viewLocations.delete(viewId);
		else this.viewLocations.set(viewId, containerId);
	}

	private finishMove(views: readonly IViewDescriptor[]): void {
		const targets = new Set(this.viewLocations.values());
		for (const id of this.generatedLocations.keys()) {
			if (!targets.has(id)) this.generatedLocations.delete(id);
		}
		this.syncViewModels();
		for (const view of views) {
			const container = this.getViewContainerForView(view.id);
			if (container && view.canToggleVisibility !== false) this.models.get(container.id)!.setVisible(view.id, true);
		}
		this.saveCustomizations();
	}

	public reset(): void {
		this.viewLocations.clear();
		this.generatedLocations.clear();
		this.syncViewModels();
		for (const container of this.registry.getViewContainers()) this.moveViewContainerToLocation(container, container.location);
		for (const location of this.containerOrders.keys()) {
			this.setViewContainerOrder(location, this.registry.getViewContainers(location).map(container => container.id));
		}
		this.storage.remove(viewCustomizationsKey, StorageScope.PROFILE);
	}

	private syncViewModels(): void {
		const all = this.registry.getViewContainers().flatMap(container => this.registry.getViews(container.id));
		for (const [id, location] of this.generatedLocations) {
			if (this.generatedContainers.has(id)) continue;
			const primary = [...this.viewLocations].find(([viewId, target]) => target === id && this.registry.getView(viewId)?.canMoveView);
			const view = primary && this.registry.getView(primary[0]);
			if (!view) continue;
			const original = this.registry.getViewContainerForView(view.id)!;
			const container: IViewContainerDescriptor = { id, title: view.title, localizationKey: view.localizationKey, icon: view.containerIcon ?? original.icon, location, hideIfEmpty: true, mergeViewWithContainerWhenSingleView: true };
			this.generatedContainers.set(id, container);
			this.addContainer(container);
			this._onDidChangeViewContainers.fire({ added: [container], removed: [] });
		}
		// Remove old ownership before adding the destination so visibility context keys have one writer.
		for (const [id, model] of this.models) {
			model.remove(model.allViewDescriptors.filter(view => this.getViewContainerForView(view.id)?.id !== id || this.registry.getView(view.id) !== view));
		}
		for (const view of all) {
			const container = this.getViewContainerForView(view.id);
			const model = container && this.models.get(container.id);
			if (model && !model.allViewDescriptors.some(item => item.id === view.id)) model.add([view]);
		}
		for (const [id, container] of this.generatedContainers) {
			if (this.generatedLocations.has(id) && this.models.get(id)!.allViewDescriptors.length) continue;
			this.generatedContainers.delete(id);
			this.removeContainer(container);
			this._onDidChangeViewContainers.fire({ removed: [container], added: [] });
		}
	}

	private restoreCustomizations(): void {
		const raw = this.storage.get(viewCustomizationsKey, StorageScope.PROFILE);
		const state = parseCustomizations(raw);
		this.viewLocations.clear();
		this.generatedLocations.clear();
		for (const [id, container] of Object.entries(state.viewLocations)) this.viewLocations.set(id, container);
		for (const [id, location] of Object.entries(state.generatedViewContainerLocations)) this.generatedLocations.set(id, location);
		for (const [id, container] of this.generatedContainers) {
			const location = this.generatedLocations.get(id);
			if (location && location !== container.location) {
				this.generatedContainers.set(id, { ...container, location });
				this._onDidChangeViewContainers.fire({ removed: [container], added: [this.generatedContainers.get(id)!] });
			}
		}
	}

	private saveCustomizations(): void {
		this.storage.store(viewCustomizationsKey, JSON.stringify({ viewLocations: Object.fromEntries(this.viewLocations), generatedViewContainerLocations: Object.fromEntries(this.generatedLocations) }), StorageScope.PROFILE, StorageTarget.USER);
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
			this.instantiation.createInstance(ViewContainerModel, container, []),
		);
	}

	private removeContainer(container: IViewContainerDescriptor): void {
		this.models.deleteAndDispose(container.id);
	}
}

function parseCustomizations(raw: string | undefined): ViewCustomizations {
	if (raw === undefined) return { viewLocations: {}, generatedViewContainerLocations: {} };
	const invalid = () => new TypeError(localize('views.invalidCustomizations', 'Saved view locations are invalid.'));
	if (raw.length > 1048576) throw invalid();
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw invalid(); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
	const state = value as Record<string, unknown>;
	const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id);
	for (const field of ['viewLocations', 'generatedViewContainerLocations']) {
		const entries = state[field];
		if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 10000) throw invalid();
		for (const [id, entry] of Object.entries(entries)) {
			if (!validId(id) || !validId(entry)) throw invalid();
			if (field === 'generatedViewContainerLocations' && (!id.startsWith(generatedContainerPrefix) || !['sidebar', 'panel', 'auxiliarybar'].includes(entry))) throw invalid();
		}
	}
	return state as unknown as ViewCustomizations;
}

function sameContainerOrder(first: readonly string[], second: readonly string[]): boolean {
	return first.length === second.length && first.every((id, index) => id === second[index]);
}
