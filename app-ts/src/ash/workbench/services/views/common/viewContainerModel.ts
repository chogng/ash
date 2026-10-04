import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ContextKeyChangeEvent, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { getVisibleViewContextKey } from '../../../common/contextkeys.js';
import type { IViewContainerDescriptor, IViewContainerModel, IViewDescriptor, IViewDescriptorsChangeEvent, WorkbenchViewRegistry } from '../../../common/views.js';

export class ViewContainerModel extends Disposable implements IViewContainerModel {
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

	public readonly onDidChangeAllViewDescriptors =
		this._onDidChangeAllViewDescriptors.event;
	public readonly onDidChangeActiveViewDescriptors =
		this._onDidChangeActiveViewDescriptors.event;
	public readonly onDidChangeVisibleViewDescriptors =
		this._onDidChangeVisibleViewDescriptors.event;

	constructor(
		public readonly viewContainer: IViewContainerDescriptor,
		registry: WorkbenchViewRegistry,
		contextKeyService: IContextKeyService,
	) {
		super();
		this.registry = registry;
		this.contextKeyService = contextKeyService;
		this._register(this.registry.onDidRegisterViews((event) => {
			if (event.container.id === this.viewContainer.id) { this.recompute(); }
		}));
		this._register(this.registry.onDidDeregisterViews((event) => {
			if (event.container.id === this.viewContainer.id) { this.recompute(); }
		}));
		this._register(this.contextKeyService.onDidChangeContext((event) => {
			if (this.affectsActiveViews(event)) { this.recompute(); }
		}));
		this._register(toDisposable(() => {
			for (const key of this.visibilityContextKeys.values()) { key.reset(); }
			this.visibilityContextKeys.clear();
			this.visibility.clear();
		}));
		this.recompute();
	}

	public get allViewDescriptors(): readonly IViewDescriptor[] {
		return this._allViewDescriptors;
	}

	public get activeViewDescriptors(): readonly IViewDescriptor[] {
		return this._activeViewDescriptors;
	}

	public get visibleViewDescriptors(): readonly IViewDescriptor[] {
		return this._visibleViewDescriptors;
	}

	public isVisible(viewId: string): boolean {
		return this._visibleViewDescriptors.some((view) => view.id === viewId);
	}

	public setVisible(viewId: string, visible: boolean): void {
		const descriptor = this._allViewDescriptors.find(
			(view) => view.id === viewId,
		);
		if (!descriptor) { throw new Error(`Unknown view: ${viewId}`); }
		if (descriptor.canToggleVisibility === false) {
			throw new Error(`View visibility cannot be changed: ${viewId}`);
		}
		if (this.preferredVisibility(descriptor) === visible) { return; }
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
			if (allIds.has(viewId)) { continue; }
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
	if (added.length === 0 && removed.length === 0) { return; }
	emitter.fire({ added, removed });
}
