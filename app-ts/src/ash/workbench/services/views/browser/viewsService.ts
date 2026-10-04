import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import type { PaneComposite } from '../../../browser/parts/views/paneComposite.js';
import { IViewDescriptorService, type IView, type IViewContainerDescriptor, type IViewDescriptor, type ViewContainerLocation } from '../../../common/views.js';
import { IPaneCompositePartService } from '../../panecomposite/browser/panecomposite.js';
import { IViewsService } from '../common/viewsService.js';

/** Descriptors own view identity, Parts own instances, and this service observes their runtime visibility and focus. */
export class ViewsService extends Disposable implements IViewsService {
	private readonly containers = new Map<string, PaneComposite>();
	private readonly containerListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly visibleViews = new Set<string>();
	private focusedViewId: string | undefined;
	private readonly focusedViewContext: IContextKey<string>;
	private readonly containerVisibility = this._register(new Emitter<{ id: string; visible: boolean; location: ViewContainerLocation }>());
	private readonly viewVisibility = this._register(new Emitter<{ id: string; visible: boolean }>());
	private readonly focusedView = this._register(new Emitter<void>());
	public readonly onDidChangeViewContainerVisibility = this.containerVisibility.event;
	public readonly onDidChangeViewVisibility = this.viewVisibility.event;
	public readonly onDidChangeFocusedView = this.focusedView.event;

	constructor(
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IPaneCompositePartService private readonly panes: IPaneCompositePartService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.focusedViewContext = FocusedViewContext.bindTo(contextKeys);
		this._register(toDisposable(() => {
			this.containerListeners.clearAndDisposeAll();
			this.focusedViewId = undefined;
			this.focusedViewContext.reset();
			this.containers.clear();
			this.visibleViews.clear();
		}));
		this._register(this.panes.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
			this.observeContainer(composite);
			this.containerVisibility.fire({ id: composite.id, visible: true, location: viewContainerLocation });
		}));
		this._register(this.panes.onDidPaneCompositeClose(({ composite, viewContainerLocation }) => {
			this.containerVisibility.fire({ id: composite.id, visible: false, location: viewContainerLocation });
		}));
		this._register(this.descriptors.onDidChangeViewContainers(({ removed }) => {
			for (const container of removed) {
				this.containerListeners.deleteAndDispose(container.id);
				this.containers.delete(container.id);
			}
		}));
		for (const location of new Set(this.descriptors.viewContainers.map(container => container.location))) {
			const composite = this.panes.getActivePaneComposite(location);
			if (composite) { this.observeContainer(composite); }
		}
	}

	public isViewContainerVisible(id: string): boolean {
		const container = this.descriptors.getViewContainerById(id);
		return container !== null && this.panes.getActivePaneComposite(container.location)?.id === id;
	}

	public isViewContainerActive(id: string): boolean {
		return this.descriptors.getViewContainerById(id) !== null;
	}

	public async openViewContainer(id: string, focus = false): Promise<PaneComposite | null> {
		const container = this.descriptors.getViewContainerById(id);
		if (!container) { return null; }
		return await this.panes.openPaneComposite(id, container.location, focus) ?? null;
	}

	public closeViewContainer(id: string): void {
		const container = this.descriptors.getViewContainerById(id);
		if (container && this.isViewContainerVisible(id)) {
			this.panes.hideActivePaneComposite(container.location);
		}
	}

	public getVisibleViewContainer(location: ViewContainerLocation): IViewContainerDescriptor | null {
		const composite = this.panes.getActivePaneComposite(location);
		return composite ? this.descriptors.getViewContainerById(composite.id) : null;
	}

	public getActiveViewPaneContainerWithId(id: string): PaneComposite | null {
		const container = this.descriptors.getViewContainerById(id);
		const composite = container && this.panes.getActivePaneComposite(container.location);
		return composite?.id === id ? composite : null;
	}

	public getFocusedView(): IViewDescriptor | null {
		return this.focusedViewId ? this.descriptors.getViewDescriptorById(this.focusedViewId) : null;
	}

	public getFocusedViewName(): string {
		const view = this.focusedViewId && this.getViewWithId(this.focusedViewId);
		const container = view && this.descriptors.getViewContainerForView(view.id);
		return container ? this.containers.get(container.id)?.getView(view.id)?.paneTitle ?? '' : '';
	}

	public isViewVisible(id: string): boolean {
		const container = this.descriptors.getViewContainerForView(id);
		return container !== undefined && this.getActiveViewPaneContainerWithId(container.id)?.getView(id)?.isBodyVisible() === true;
	}

	public async openView<T extends IView>(id: string, focus = false): Promise<T | null> {
		const container = this.descriptors.getViewContainerForView(id);
		if (!container || !this.descriptors.getViewContainerModel(container.id).activeViewDescriptors.some(view => view.id === id)) {
			return null;
		}
		const composite = await this.openViewContainer(container.id);
		const view = composite?.openView(id, focus);
		if (focus && view?.element.contains(view.element.ownerDocument.activeElement)) {
			this.setFocus(id);
		}
		return view as T | undefined ?? null;
	}

	public closeView(id: string): void {
		const container = this.descriptors.getViewContainerForView(id);
		const composite = container && this.getActiveViewPaneContainerWithId(container.id);
		const view = composite?.getView(id);
		if (!view) { return; }
		if (composite!.panes.length === 1) {
			this.closeViewContainer(container!.id);
		} else {
			view.setExpanded(false);
		}
	}

	public async focusView(id: string): Promise<boolean> {
		return await this.openView(id, true) !== null;
	}

	public getActiveViewWithId<T extends IView>(id: string): T | null {
		const container = this.descriptors.getViewContainerForView(id);
		return (container && this.getActiveViewPaneContainerWithId(container.id)?.getView(id)) as T | undefined ?? null;
	}

	public getViewWithId<T extends IView>(id: string): T | null {
		const container = this.descriptors.getViewContainerForView(id);
		return (container && this.containers.get(container.id)?.getView(id)) as T | undefined ?? null;
	}

	private observeContainer(composite: PaneComposite): void {
		if (this.containers.get(composite.id) === composite) { return; }
		this.containers.set(composite.id, composite);
		const listeners = this.containerListeners.set(composite.id, new DisposableStore());
		const updateVisibility = (id: string, visible: boolean): void => {
			if (this.visibleViews.has(id) === visible) { return; }
			if (visible) { this.visibleViews.add(id); } else { this.visibleViews.delete(id); }
			this.viewVisibility.fire({ id, visible });
		};
		listeners.add(composite.onDidChangeViewVisibility(({ view, visible }) => updateVisibility(view.id, visible)));
		listeners.add(composite.onDidAddViews(views => {
			for (const view of views) { updateVisibility(view.id, view.isBodyVisible()); }
		}));
		listeners.add(composite.onDidRemoveViews(views => {
			for (const view of views) {
				updateVisibility(view.id, false);
				this.clearFocus(view.id);
			}
		}));
		listeners.add(composite.onDidFocusView(view => {
			this.setFocus(view.id);
		}));
		listeners.add(composite.onDidBlurView(view => this.clearFocus(view.id)));
		for (const view of composite.panes) {
			updateVisibility(view.id, view.isBodyVisible());
			if (view.element.contains(view.element.ownerDocument.activeElement)) { this.setFocus(view.id); }
		}
	}

	private setFocus(id: string): void {
		if (this.focusedViewId === id) { return; }
		this.focusedViewId = id;
		this.focusedViewContext.set(id);
		this.focusedView.fire();
	}

	private clearFocus(id: string): void {
		if (this.focusedViewId !== id) { return; }
		this.focusedViewId = undefined;
		this.focusedViewContext.reset();
		this.focusedView.fire();
	}
}
