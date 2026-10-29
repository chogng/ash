import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../common/views.js';

/** Counts containers with active views, independently of selection or user-hidden panes. */
export class VisibleViewContainersTracker extends Disposable {
	private readonly listeners = this._register(new DisposableMap<string>());
	private readonly changed = this._register(new Emitter<{ before: number; after: number }>());
	public readonly onDidChange = this.changed.event;
	private count = 0;

	constructor(
		private readonly location: ViewContainerLocation,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
	) {
		super();
		this._register(descriptors.onDidChangeViewContainers(() => this.refresh()));
		this._register(descriptors.onDidChangeContainerLocation(() => this.refresh()));
		this.refresh();
	}

	public get visibleCount(): number {
		return this.count;
	}

	private refresh(): void {
		const containers = this.descriptors.getViewContainers(this.location);
		const ids = new Set(containers.map(container => container.id));
		for (const id of this.listeners.keys()) {
			if (!ids.has(id)) {
				this.listeners.deleteAndDispose(id);
			}
		}
		let after = 0;
		for (const container of containers) {
			const model = this.descriptors.getViewContainerModel(container.id);
			if (!this.listeners.has(container.id)) {
				this.listeners.set(
					container.id,
					model.onDidChangeActiveViewDescriptors(() => this.refresh()),
				);
			}
			if (model.activeViewDescriptors.length > 0) {
				after++;
			}
		}
		if (after !== this.count) {
			const before = this.count;
			this.count = after;
			this.changed.fire({ before, after });
		}
	}
}
