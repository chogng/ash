import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IViewDescriptorService, type IViewContainerDescriptor } from '../../../common/views.js';
import type { IActivity, IActivityService } from '../common/activity.js';

type ActivityTarget = { readonly viewId: string } | { readonly containerId: string };

/** Window-owned activities; presentation and badge visibility belong to their consumers. */
export class ActivityService extends Disposable implements IActivityService {
	private readonly containerListeners = this._register(new DisposableMap<string, IDisposable>());
	private readonly activities = new Map<symbol, { readonly target: ActivityTarget; readonly activity: IActivity }>();
	private readonly activityChanged = this._register(new Emitter<string | IViewContainerDescriptor>());
	readonly onDidChangeActivity = this.activityChanged.event;

	constructor(@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService) {
		super();
		for (const container of viewDescriptorService.viewContainers) this.observeContainer(container);
		this._register(
			viewDescriptorService.onDidChangeViewContainers(event => {
				for (const container of event.removed) {
					this.containerListeners.deleteAndDispose(container.id);
					this.activityChanged.fire(container);
				}
				for (const container of event.added) {
					this.observeContainer(container);
					this.activityChanged.fire(container);
				}
			}),
		);
	}

	private observeContainer(container: IViewContainerDescriptor): void {
		const model = this.viewDescriptorService.getViewContainerModel(container.id);
		this.containerListeners.set(
			container.id,
			model.onDidChangeAllViewDescriptors(() => this.activityChanged.fire(container)),
		);
	}

	showViewContainerActivity(viewContainerId: string, activity: IActivity): IDisposable {
		return this.add({ containerId: viewContainerId }, activity);
	}

	showViewActivity(viewId: string, activity: IActivity): IDisposable {
		return this.add({ viewId }, activity);
	}

	getViewContainerActivities(viewContainerId: string): IActivity[] {
		return [...this.activities.values()]
			.filter(entry => this.container(entry.target)?.id === viewContainerId)
			.map(entry => entry.activity);
	}

	private container(target: ActivityTarget): IViewContainerDescriptor | undefined {
		return 'viewId' in target
			? this.viewDescriptorService.getViewContainerForView(target.viewId)
			: (this.viewDescriptorService.getViewContainerById(target.containerId) ?? undefined);
	}

	private add(target: ActivityTarget, activity: IActivity): IDisposable {
		this.assertNotDisposed();
		const token = Symbol();
		this.activities.set(token, { target, activity });
		this.notify(target);
		return toDisposable(() => {
			if (this.activities.delete(token)) this.notify(target);
		});
	}

	private notify(target: ActivityTarget): void {
		const container = this.container(target);
		if (container) this.activityChanged.fire(container);
	}

	protected override disposeCore(): void {
		const containers = new Set([...this.activities.values()].map(entry => this.container(entry.target)));
		this.activities.clear();
		for (const container of containers) {
			if (container) this.activityChanged.fire(container);
		}
		super.disposeCore();
	}
}
