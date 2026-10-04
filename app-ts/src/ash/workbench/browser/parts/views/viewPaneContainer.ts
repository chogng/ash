import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from "../../../../base/common/event.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { localize, type ILocalizationService } from "../../../services/localization/common/localizationService.js";
import type { IViewContainerDescriptor, IViewContainerModel, IViewDescriptor } from "../../../common/views.js";
import { ViewPane } from "./viewPane.js";
import { h } from "../../../../base/browser/dom.js";
import { PaneView } from "../../../../base/browser/ui/splitview/paneview.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";

/** Construction inputs for one browser view container. */
export interface ViewPaneContainerOptions {
	readonly viewContainer: IViewContainerDescriptor;
	readonly localizationService?: ILocalizationService;
	readonly model: IViewContainerModel;
	readonly instantiationService: IInstantiationService;
	readonly contextKeyService: IContextKeyService;
	readonly paneHeaders?: "visible" | "hidden";
	readonly onDidFailCreateView?: (
		error: unknown,
		viewId: string,
	) => void;
}

/**
 * Owns registered pane instances and workspace layout state. The model owns
 * visibility; hiding a pane detaches it without discarding contribution state.
 */
export class ViewPaneContainer extends Disposable {
	readonly element: HTMLElement;
	readonly id: string;
	readonly viewContainer: IViewContainerDescriptor;
	private readonly model: IViewContainerModel;
	private readonly instantiationService: IInstantiationService;
	private readonly localizationService: ILocalizationService | undefined;
	private readonly onDidFailCreateView: (
		error: unknown,
		viewId: string,
	) => void;
	private readonly _panes = this._register(new DisposableMap<string, ViewPaneItem>());
	private readonly paneView: PaneView;
	private readonly headersVisible: boolean;
	private mountedPanes: ViewPane[] = [];
	private syncing = false;
	private didLayout = false;
	private visible = true;
	private readonly viewsAdded = this._register(new Emitter<readonly ViewPane[]>());
	private readonly viewsRemoved = this._register(new Emitter<readonly ViewPane[]>());
	private readonly viewVisibility = this._register(new Emitter<{ view: ViewPane; visible: boolean }>());
	private readonly viewFocus = this._register(new Emitter<ViewPane>());
	private readonly viewBlur = this._register(new Emitter<ViewPane>());
	public readonly onDidAddViews = this.viewsAdded.event;
	public readonly onDidRemoveViews = this.viewsRemoved.event;
	public readonly onDidChangeViewVisibility = this.viewVisibility.event;
	public readonly onDidFocusView = this.viewFocus.event;
	public readonly onDidBlurView = this.viewBlur.event;

	constructor(container: HTMLElement, options: ViewPaneContainerOptions, @IStorageService private readonly storageService: IStorageService) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-view-pane-container";
		element.dataset.viewContainerId = options.viewContainer.id;
		container.append(element);
		this.id = options.viewContainer.id;
		this.viewContainer = options.viewContainer;
		this.headersVisible = options.paneHeaders !== "hidden";
		this.paneView = this._register(new PaneView(element));
		this.model = options.model;
		this.instantiationService = options.instantiationService;
		this.localizationService = options.localizationService;
		this.onDidFailCreateView = options.onDidFailCreateView ??
			((error, viewId) => {
				console.error(`Unable to create view pane '${viewId}'`, error);
			});
		this._register(toDisposable(() => {
			this._panes.clearAndDisposeAll();
			this.mountedPanes.length = 0;
		}));
		this._register(this.paneView.onDidSashChange(() => this.saveState()));
		this._register(this.model.onDidChangeAllViewDescriptors(() => this.syncPanes()));
		this._register(this.model.onDidChangeVisibleViewDescriptors(() => {
			this.syncPanes();
		}));
		this.syncPanes();
		// The flex host resolves title slots and activity bars before publishing its content size.
		this._register(observeElementSize(element, size => {
			if (size.height > 0 && size.width > 0) this.layout(size);
		}));
	}

	layout(dimension: IDimension): void {
		this.paneView.layout(dimension.height, dimension.width);
		this.didLayout = true;
		this.saveState();
	}

	getViewSize(view: ViewPane): number {
		return this.paneView.getPaneSize(view);
	}

	resizeView(view: ViewPane, size: number): void {
		this.paneView.resizePane(view, size);
	}

	get panes(): readonly ViewPane[] {
		return this.model.visibleViewDescriptors
			.map((descriptor) => this._panes.get(descriptor.id)?.pane)
			.filter((pane): pane is ViewPane => pane !== undefined);
	}

	getView(id: string): ViewPane | undefined {
		return this.model.isVisible(id) ? this._panes.get(id)?.pane : undefined;
	}

	isVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.element.hidden = !visible;
		for (const [, item] of this._panes) {
			item.pane.setVisible(visible && this.model.isVisible(item.pane.id));
		}
	}

	openView(id: string, focus?: boolean): ViewPane | undefined {
		if (!this.model.isVisible(id)) this.model.setVisible(id, true);
		const pane = this._panes.get(id)?.pane;
		if (pane) {
			pane.setExpanded(true);
			if (focus) pane.focus();
		}
		return pane;
	}

	focusView(id: string): boolean {
		return this.openView(id, true) !== undefined;
	}

	focus(): void {
		this.panes[0]?.focus();
	}

	private syncPanes(): void {
		this.syncing = true;
		try {
			const desired = this.model.visibleViewDescriptors;
			const desiredIds = new Set(desired.map(view => view.id));
			const registeredIds = new Set(this.model.allViewDescriptors.map(view => view.id));
			let focusRemoved = false;
			for (const pane of this.mountedPanes) {
				if (desiredIds.has(pane.id)) continue;
				focusRemoved ||= pane.element.contains(this.element.ownerDocument.activeElement);
				this.paneView.removePane(pane);
				pane.setVisible(false);
			}
			this.mountedPanes = this.mountedPanes.filter(pane => desiredIds.has(pane.id));
			for (const [viewId, item] of this._panes) {
				if (registeredIds.has(viewId)) continue;
				this.viewsRemoved.fire([item.pane]);
				this._panes.deleteAndDispose(viewId);
			}
			for (const descriptor of desired) {
				if (this._panes.has(descriptor.id)) continue;
				let pane: ViewPane;
				try {
					pane = this.createView(descriptor);
				} catch (error) {
					this.onDidFailCreateView(error, descriptor.id);
					continue;
				}
				pane.setVisible(this.visible);
				const item = new ViewPaneItem(pane, this.readSize(descriptor.id) ?? 200);
				this._panes.set(descriptor.id, item);
				item.listenToViewEvents(
					visible => this.viewVisibility.fire({ view: pane, visible }),
					() => this.viewFocus.fire(pane),
					() => this.viewBlur.fire(pane),
				);
				this.viewsAdded.fire([pane]);
				item.listenToLayout(() => this.saveState());
			}
			let index = 0;
			for (const descriptor of desired) {
				const pane = this._panes.get(descriptor.id)?.pane;
				if (!pane) continue;
				const currentIndex = this.mountedPanes.indexOf(pane);
				if (currentIndex < 0) {
					this.paneView.addPane(pane, this._panes.get(pane.id)!.size, index);
					this.mountedPanes.splice(index, 0, pane);
				} else if (currentIndex !== index) {
					this.paneView.movePane(pane, this.mountedPanes[index]!);
					this.mountedPanes.splice(currentIndex, 1);
					this.mountedPanes.splice(index, 0, pane);
				}
				pane.setVisible(this.visible);
				index += 1;
			}
			if (focusRemoved && this.visible) this.focus();
		} finally {
			this.syncing = false;
		}
		this.saveState();
	}

	private stateKey(viewId: string, field: "size" | "collapsed"): string {
		return `workbench.viewContainer.${this.id}.${viewId}.${field}`;
	}

	private readSize(viewId: string): number | undefined {
		const size = this.storageService.getNumber(this.stateKey(viewId, "size"), StorageScope.WORKSPACE);
		return size !== undefined && size >= 0 ? size : undefined;
	}

	private saveState(): void {
		if (this.syncing || !this.didLayout) return;
		for (const pane of this.mountedPanes) {
			// A merged header is presentation only and must not overwrite the user's collapse choice.
			if (pane.isHeaderVisible()) this.storageService.store(this.stateKey(pane.id, "collapsed"), pane.isCollapsed(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			if (!pane.isCollapsed()) {
				const size = this.getViewSize(pane);
				this._panes.get(pane.id)!.size = size;
				this.storageService.store(this.stateKey(pane.id, "size"), size, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		}
	}

	private updateLocalizedTitles(): void {
		for (const descriptor of this.model.allViewDescriptors) {
			const pane = this._panes.get(descriptor.id)?.pane;
			if (pane) pane.setTitle(localize(this.localizationService, descriptor.localizationKey, descriptor.title));
		}
	}

	private createView(descriptor: IViewDescriptor): ViewPane {
		const view = this.instantiationService.createInstance(
			descriptor.ctorDescriptor,
			this.element,
			{
				id: descriptor.id,
				title: localize(this.localizationService, descriptor.localizationKey, descriptor.title),
				collapsed: this.storageService.getBoolean(this.stateKey(descriptor.id, "collapsed"), StorageScope.WORKSPACE) ?? descriptor.collapsed,
			},
		);
		if (!(view instanceof ViewPane)) {
			throw new TypeError(
				`View constructor did not create a ViewPane: ${descriptor.id}`,
			);
		}
		if (view.id !== descriptor.id) {
			view.dispose();
			throw new Error(
				`View constructor returned '${view.id}' for '${descriptor.id}'`,
			);
		}
		if (!this.headersVisible) {
			view.setHeaderVisible(false);
			view.setExpanded(true);
		}
		return view;
	}
}

class ViewPaneItem extends Disposable {
	public listenToViewEvents(visibility: (visible: boolean) => void, focus: () => void, blur: () => void): void {
		this._register(this.pane.onDidChangeBodyVisibility(visibility));
		this._register(this.pane.onDidFocus(focus));
		this._register(this.pane.onDidBlur(blur));
		this._register(this.pane.onDidChangeVisibility(visible => {
			// Hiding a focused pane does not consistently produce a DOM blur event.
			if (!visible) blur();
		}));
		this._register(toDisposable(blur));
	}

	listenToLayout(listener: () => void): void {
		this._register(this.pane.onDidChangeExpansionState(listener));
	}

	constructor(readonly pane: ViewPane, public size: number) {
		super();
		this._register(pane);
	}
}
