import './media/paneviewlet.css';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from "../../../../base/common/event.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { localize, type ILocalizationService } from "../../../services/localization/common/localizationService.js";
import type { IViewContainerDescriptor, IViewContainerModel, IViewDescriptor } from "../../../common/views.js";
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { ViewPane } from "./viewPane.js";
import { h } from "../../../../base/browser/dom.js";
import { PaneView } from "../../../../base/browser/ui/splitview/paneview.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { Composite } from '../../composite.js';
import { IMenuService, MenuId, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ViewMenuActions } from './viewMenuActions.js';
import type { IAction } from '../../../../base/common/actions.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';

/** Construction inputs for one browser view container. */
export interface IViewPaneContainerOptions {
	readonly viewContainer: IViewContainerDescriptor;
	readonly localizationService?: ILocalizationService;
	readonly model: IViewContainerModel;
	readonly paneHeaders?: "visible" | "hidden";
	/** Content layout uses each pane's minimum size in one scrolling viewport; other layouts retain resizable allocations. */
	readonly paneLayout?: "stack" | "fill" | "content";
	/** Layout state follows the workspace unless the contribution explicitly chooses another UI state scope. */
	readonly stateScope?: StorageScope;
	readonly onDidFailCreateView?: (
		error: unknown,
		viewId: string,
	) => void;
}

/**
 * Owns registered pane instances and scoped layout state. The model owns
 * visibility; hiding a pane detaches it without discarding contribution state.
 */
export class ViewPaneContainer extends Composite {
	readonly element: HTMLElement;
	readonly id: string;
	readonly viewContainer: IViewContainerDescriptor;
	private readonly model: IViewContainerModel;
	private readonly localizationService: ILocalizationService | undefined;
	private readonly onDidFailCreateView: (
		error: unknown,
		viewId: string,
	) => void;
	private readonly _panes = this._register(new DisposableMap<string, ViewPaneItem>());
	private readonly paneView: PaneView;
	protected readonly scrollable: ScrollableElement | undefined;
	protected readonly scopedContextKeyService: IContextKeyService;
	private readonly contentSized: boolean;
	private readonly stateScope: StorageScope;
	private dimension: IDimension | undefined;
	private readonly headersVisible: boolean;
	private mountedPanes: ViewPane[] = [];
	private readonly viewContextIds = new Set<string>();
	private syncing = false;
	private didLayout = false;
	private readonly menuActions: ViewMenuActions;
	private readonly viewsAdded = this._register(new Emitter<readonly ViewPane[]>());
	private readonly viewsRemoved = this._register(new Emitter<readonly ViewPane[]>());
	private readonly viewVisibility = this._register(new Emitter<{ view: ViewPane; visible: boolean; }>());
	private readonly viewFocus = this._register(new Emitter<ViewPane>());
	private readonly viewBlur = this._register(new Emitter<ViewPane>());
	public readonly onDidAddViews = this.viewsAdded.event;
	public readonly onDidRemoveViews = this.viewsRemoved.event;
	public readonly onDidChangeViewVisibility = this.viewVisibility.event;
	public readonly onDidFocusView = this.viewFocus.event;
	public readonly onDidBlurView = this.viewBlur.event;

	constructor(
		container: HTMLElement,
		options: IViewPaneContainerOptions,
		@IStorageService private readonly storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(options.viewContainer.id, themeService, storageService);
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-view-pane-container";
		// One inherited presentation policy covers retained and newly created views.
		const updateHeaderActions = (): void => {
			element.classList.toggle('always-show-header-actions', configurationService.getValue<boolean>(WorkbenchConfiguration.alwaysShowHeaderActions));
		};
		updateHeaderActions();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.alwaysShowHeaderActions)) { updateHeaderActions(); }
		}));
		element.dataset.viewContainerId = options.viewContainer.id;
		container.append(element);
		super.create(element);
		this.id = options.viewContainer.id;
		this.viewContainer = options.viewContainer;
		const menuContext = this.scopedContextKeyService = this._register(contextKeyService.createScoped(element));
		menuContext.setContext('viewContainer', this.id);
		menuContext.setContext('viewContainerLocation', this.viewContainer.location);
		const menuServices = this._register(instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, menuContext],
			[IMenuService, menuService],
		)));
		this.menuActions = this._register(menuServices.createInstance(ViewMenuActions, MenuId.ViewContainerTitle, MenuId.ViewContainerTitleContext, { arg: this.id }, undefined));
		this._register(this.menuActions.onDidChange(() => this.updateTitleArea()));
		this.headersVisible = options.paneHeaders !== "hidden";
		this.contentSized = options.paneLayout === 'content';
		this.stateScope = options.stateScope ?? StorageScope.WORKSPACE;
		element.classList.toggle('content-sized', this.contentSized);
		if (this.contentSized) {
			this.scrollable = this._register(new ScrollableElement(element, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
			this.scrollable.element.classList.add('ash-view-pane-scrollable');
		}
		this.paneView = this._register(new PaneView(this.scrollable?.contentElement ?? element));
		this.model = options.model;
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
		if (this.contentSized) {
			// Content insets can change the pane width without resizing the outer container.
			this._register(observeElementSize(this.paneView.element, size => {
				if (size.width > 0 && this.dimension) this.layout(this.dimension);
			}));
		}
	}

	layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (this.contentSized) {
			const height = this.mountedPanes.reduce((total, pane) => total + pane.minimumSize, 0);
			this.paneView.element.style.height = `${height}px`;
			this.paneView.layout(height, this.paneView.element.clientWidth || dimension.width);
			this.scrollable!.layout();
		} else { this.paneView.layout(dimension.height, dimension.width); }
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

	getOptimalWidth(): number {
		return this.panes.reduce((width, pane) => Math.max(width, pane.getOptimalWidth()), 0) + 16;
	}

	override get minimumWidth(): number {
		return Math.max(0, ...this.mountedPanes.filter(pane => pane.isExpanded()).map(pane => pane.minimumWidth));
	}

	getView(id: string): ViewPane | undefined {
		return this.model.isVisible(id) ? this._panes.get(id)?.pane : undefined;
	}

	public override setVisible(visible: boolean): void {
		if (this.isVisible() === visible) return;
		super.setVisible(visible);
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

	public override focus(): void {
		this.panes[0]?.focus();
	}

	public override getActions(): readonly IAction[] {
		return this.menuActions.getPrimaryActions();
	}

	public override getSecondaryActions(): readonly IAction[] {
		return this.menuActions.getSecondaryActions().filter(action =>
			!(action instanceof SubmenuItemAction && action.item.submenu === MenuId.for('ViewsSubMenu') && !action.actions.some(item => item.enabled)),
		);
	}

	public override getContextMenuActions(): readonly IAction[] {
		return this.menuActions.getContextMenuActions();
	}

	private syncPanes(): void {
		this.syncing = true;
		try {
			const desired = this.model.visibleViewDescriptors;
			const owned = new Set(this.model.allViewDescriptors.map(view => view.id));
			for (const id of this.viewContextIds) {
				if (!owned.has(id)) this.scopedContextKeyService.removeContext(`viewContainer.${id}`);
			}
			this.viewContextIds.clear();
			for (const id of owned) {
				this.viewContextIds.add(id);
				this.scopedContextKeyService.setContext(`viewContainer.${id}`, true);
			}
			this.scopedContextKeyService.setContext('viewContainer.visibleViewCount', desired.length);
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
				pane.setVisible(this.isVisible());
				const item = new ViewPaneItem(pane, this.readSize(descriptor.id) ?? 200);
				this._panes.set(descriptor.id, item);
				item.listenToTitle(() => this.updateTitleArea());
				item.listenToViewEvents(
					visible => this.viewVisibility.fire({ view: pane, visible }),
					() => this.viewFocus.fire(pane),
					() => this.viewBlur.fire(pane),
				);
				this.viewsAdded.fire([pane]);
				item.listenToLayout(() => {
					if (this.contentSized && this.dimension && !this.syncing) this.layout(this.dimension);
					this.saveState();
					this.notifyConstraintsChanged();
				}, this.contentSized);
				item.listenToConstraints(() => {
					if (this.mountedPanes.includes(pane) && pane.isExpanded()) this.notifyConstraintsChanged();
				});
			}
			let index = 0;
			for (const descriptor of desired) {
				const pane = this._panes.get(descriptor.id)?.pane;
				if (!pane) continue;
				// Fill hosts hide a single title; grouped views need their own drag and collapse handles.
				if (!this.headersVisible) {
					pane.setHeaderVisible(desired.length > 1);
					if (desired.length === 1) pane.setExpanded(true);
				}
				const currentIndex = this.mountedPanes.indexOf(pane);
				if (currentIndex < 0) {
					this.paneView.addPane(pane, this._panes.get(pane.id)!.size, index);
					this.mountedPanes.splice(index, 0, pane);
				} else if (currentIndex !== index) {
					this.paneView.movePane(pane, this.mountedPanes[index]!);
					this.mountedPanes.splice(currentIndex, 1);
					this.mountedPanes.splice(index, 0, pane);
				}
				pane.setVisible(this.isVisible());
				index += 1;
			}
			if (focusRemoved && this.isVisible()) this.focus();
		} finally {
			this.syncing = false;
		}
		if (this.contentSized && this.dimension) this.layout(this.dimension);
		this.saveState();
		this.updateTitleArea();
		this.notifyConstraintsChanged();
	}

	protected stateKey(viewId: string, field: "size" | "collapsed"): string {
		return `workbench.viewContainer.${this.id}.${viewId}.${field}`;
	}

	private readSize(viewId: string): number | undefined {
		const size = this.storageService.getNumber(this.stateKey(viewId, "size"), this.stateScope);
		return size !== undefined && size >= 0 ? size : undefined;
	}

	protected override saveState(): void {
		if (this.syncing || !this.didLayout) return;
		for (const pane of this.mountedPanes) {
			// A merged header is presentation only and must not overwrite the user's collapse choice.
			if (pane.isHeaderVisible()) this.storageService.store(this.stateKey(pane.id, "collapsed"), pane.isCollapsed(), this.stateScope, StorageTarget.MACHINE);
			if (!this.contentSized && !pane.isCollapsed()) {
				const size = this.getViewSize(pane);
				this._panes.get(pane.id)!.size = size;
				this.storageService.store(this.stateKey(pane.id, "size"), size, this.stateScope, StorageTarget.MACHINE);
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
				canMoveView: descriptor.canMoveView,
				title: localize(this.localizationService, descriptor.localizationKey, descriptor.title),
				collapsed: this.storageService.getBoolean(this.stateKey(descriptor.id, "collapsed"), this.stateScope) ?? descriptor.collapsed,
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
	listenToConstraints(listener: () => void): void {
		this._register(this.pane.onDidChangeConstraints(listener));
	}

	public listenToTitle(listener: () => void): void {
		this._register(this.pane.onDidChangeTitleArea(listener));
	}
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

	listenToLayout(listener: () => void, contentSized: boolean): void {
		this._register(contentSized ? this.pane.onDidChange(listener) : this.pane.onDidChangeExpansionState(listener));
	}

	constructor(readonly pane: ViewPane, public size: number) {
		super();
		this._register(pane);
	}
}
