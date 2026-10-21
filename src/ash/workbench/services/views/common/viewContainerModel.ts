import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ContextKeyChangeEvent, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { getVisibleViewContextKey } from '../../../common/contextkeys.js';
import type { IViewContainerDescriptor, IViewContainerModel, IViewDescriptor, IViewDescriptorsChangeEvent, WorkbenchViewRegistry } from '../../../common/views.js';

export class ViewContainerModel extends Disposable implements IViewContainerModel {
	private readonly registry: WorkbenchViewRegistry;
	private readonly stateKey: string;
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
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.registry = registry;
		this.stateKey = `${viewContainer.id}.state.hidden`;
		this.restoreVisibility();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === this.stateKey) {
				if (this.restoreVisibility()) this.recompute();
			}
		}));
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
		this.restoreVisibility();
		if (this.preferredVisibility(descriptor) === visible) { this.recompute(); return; }
		// Read the current stored table before changing one preference, preserving
		// views registered later and updates written by another window.
		this.visibility.set(viewId, visible);
		this.storage.store(this.stateKey, JSON.stringify([...this.visibility].map(([id, preferred]) => ({ id, isHidden: !preferred }))), StorageScope.PROFILE, StorageTarget.MACHINE);
		this.recompute();
	}

	private restoreVisibility(): boolean {
		const raw = this.storage.get(this.stateKey, StorageScope.PROFILE);
		if (raw !== undefined && raw.length > 1048576) return false;
		let entries: unknown;
		try { entries = raw === undefined ? [] : JSON.parse(raw); }
		catch { return false; }
		if (!Array.isArray(entries) || entries.length > 10000) return false;
		const restored = new Map<string, boolean>();
		for (const entry of entries) {
			if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string'
				|| !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(entry.id) || typeof entry.isHidden !== 'boolean'
				|| restored.has(entry.id)) return false;
			restored.set(entry.id, !entry.isHidden);
		}
		this.visibility.clear();
		for (const [id, visible] of restored) this.visibility.set(id, visible);
		return true;
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
		if (descriptor.canToggleVisibility === false) return true;
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
