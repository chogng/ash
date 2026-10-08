import { Emitter, type Event } from "../../base/common/event.js";
import {
	Disposable, DisposableMap, DisposableStore,
	type IDisposable,
	toDisposable,
} from "../../base/common/lifecycle.js";
import {
	ContextKeyExpr, type ContextKeyExpression,
} from "../../platform/contextkey/common/contextkey.js";
import type { SyncDescriptor } from "../../platform/instantiation/common/descriptors.js";
import type { Icon } from "../../base/common/icon.js";
import { createServiceIdentifier } from "../../platform/instantiation/common/instantiation.js";
import { localize2, type LocalizationKey } from "../../nls.js";
import { Action2, MenuId, registerAction2 } from '../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ActiveViewletContext, getVisibleViewContextKey } from './contextkeys.js';

/** Workbench region capable of hosting registered view containers. */
export enum ViewContainerLocation {
	Sidebar = "sidebar",
	Panel = "panel",
	AuxiliaryBar = "auxiliarybar",
	AgentSidebar = "agentSidebar",
}

/** Static declaration of a named workbench view container. */
export interface IViewContainerDescriptor {
	readonly id: string;
	readonly title: string;
	readonly localizationKey?: LocalizationKey;
	readonly location: ViewContainerLocation;
	/** Browser host constructed for this container when it opens. */
	readonly ctorDescriptor?: SyncDescriptor<IViewPaneContainer>;
	/** Merge the one visible pane into its hosting Part title, restoring headers when further panes appear. */
	readonly mergeViewWithContainerWhenSingleView?: boolean;
	readonly icon?: Icon;
	readonly order?: number;
	readonly isDefault?: boolean;
}

/** Static declaration of one view contributed to a container. */
export interface IViewDescriptor {
	readonly id: string;
	readonly title: string;
	readonly localizationKey?: LocalizationKey;
	/**
	 * Construction owned by the contribution.
	 *
	 * Browser hosts append their runtime pane options after descriptor static
	 * arguments. The instantiation service appends declared services last.
	 */
	readonly ctorDescriptor: SyncDescriptor<IView>;
	readonly when?: ContextKeyExpression;
	readonly order?: number;
	readonly collapsed?: boolean;
	readonly hideByDefault?: boolean;
	readonly canToggleVisibility?: boolean;
}

/** Text and command links contributed to a view's welcome state. */
export interface IViewContentDescriptor {
	readonly content: string;
	readonly when?: ContextKeyExpression | 'default';
	readonly group?: string;
	readonly order?: number;
	readonly precondition?: ContextKeyExpression;
}

/** Batch of views associated with one registered container. */
export interface IViewsChangeEvent {
	readonly container: IViewContainerDescriptor;
	readonly views: readonly IViewDescriptor[];
}

/** Difference between two ordered view descriptor snapshots. */
export interface IViewDescriptorsChangeEvent {
	readonly added: readonly IViewDescriptor[];
	readonly removed: readonly IViewDescriptor[];
}

/** Runtime behavior shared by browser views and non-DOM view consumers. */
export interface IView {
	readonly id: string;
	readonly paneTitle: string;

	focus(): void;
	hasFocus(): boolean;
	isBodyVisible(): boolean;
	setExpanded(expanded: boolean): boolean;
	isVisible(): boolean;
	setVisible(visible: boolean): void;
}

/** Runtime operations available without depending on the browser implementation. */
export interface IViewPaneContainer {
	readonly id: string;
	readonly panes: readonly IView[];
	readonly onDidAddViews: Event<readonly IView[]>;
	readonly onDidRemoveViews: Event<readonly IView[]>;
	readonly onDidChangeViewVisibility: Event<{ readonly view: IView; readonly visible: boolean; }>;
	readonly onDidFocusView: Event<IView>;
	readonly onDidBlurView: Event<IView>;
	getView(id: string): IView | undefined;
	openView(id: string, focus?: boolean): IView | undefined;
	focus(): void;
	isVisible(): boolean;
	setVisible(visible: boolean): void;
}

/**
 * Window-scoped projection of the views registered in one container.
 *
 * Implementations evaluate context conditions and own user visibility state.
 * Browser containers consume `visibleViewDescriptors` to create actual panes.
 */
export interface IViewContainerModel {
	readonly viewContainer: IViewContainerDescriptor;
	readonly allViewDescriptors: readonly IViewDescriptor[];
	readonly activeViewDescriptors: readonly IViewDescriptor[];
	readonly visibleViewDescriptors: readonly IViewDescriptor[];
	readonly onDidChangeAllViewDescriptors:
	Event<IViewDescriptorsChangeEvent>;
	readonly onDidChangeActiveViewDescriptors:
	Event<IViewDescriptorsChangeEvent>;
	readonly onDidChangeVisibleViewDescriptors:
	Event<IViewDescriptorsChangeEvent>;

	isVisible(viewId: string): boolean;
	setVisible(viewId: string, visible: boolean): void;
}

/** Stable identifiers for the containers supplied by the core workbench. */
export const WorkbenchViewContainerId = Object.freeze({
	Sidebar: "ash.sidebar",
	Search: "ash.search",
	Git: "ash.git",
	Problems: "ash.panel.problems",
	Output: "ash.panel.output",
	BulkEdit: "ash.panel.bulkEdit",
	DebugConsole: "ash.panel.debugConsole",
	Tasks: "ash.panel.tasks",
	Terminal: "ash.panel.terminal",
	Ports: "ash.panel.ports",
	Testing: "ash.testing",
	Debug: "ash.debug",
});

/**
 * Registry used by static contributions to declare view containers and views.
 *
 * Registrations are atomic: duplicate or invalid batches do not modify the
 * previous registry state. Disposing a container also removes its views.
 */
export class WorkbenchViewRegistry extends Disposable {
	private readonly welcomeContents = new Map<string, Set<IViewContentDescriptor>>();
	private readonly welcomeContentChanged = this._register(new Emitter<string>());
	readonly onDidChangeViewWelcomeContent = this.welcomeContentChanged.event;

	registerViewWelcomeContent(id: string, content: IViewContentDescriptor): IDisposable {
		this.assertNotDisposed();
		validateId(id, 'view');
		if (typeof content.content !== 'string' || !content.content.trim()) {
			throw new TypeError('View welcome content must not be empty');
		}
		const descriptor = Object.freeze({ ...content });
		const contents = this.welcomeContents.get(id) ?? new Set<IViewContentDescriptor>();
		contents.add(descriptor);
		this.welcomeContents.set(id, contents);
		this.welcomeContentChanged.fire(id);
		return toDisposable(() => {
			contents.delete(descriptor);
			if (contents.size === 0) this.welcomeContents.delete(id);
			this.welcomeContentChanged.fire(id);
		});
	}

	getViewWelcomeContent(id: string): IViewContentDescriptor[] {
		return [...(this.welcomeContents.get(id) ?? [])].sort((left, right) =>
			(left.group ?? '9_more').localeCompare(right.group ?? '9_more') || (left.order ?? 5) - (right.order ?? 5));
	}

	private readonly containers =
		new Map<string, IRegisteredViewContainer>();
	private readonly views = new Map<string, IRegisteredView>();
	private readonly _onDidRegisterViewContainer =
		this._register(new Emitter<IViewContainerDescriptor>());
	private readonly _onDidDeregisterViewContainer =
		this._register(new Emitter<IViewContainerDescriptor>());
	private readonly _onDidRegisterViews = this._register(new Emitter<IViewsChangeEvent>());
	private readonly _onDidDeregisterViews = this._register(new Emitter<IViewsChangeEvent>());
	private nextOrder = 1;
	private readonly viewActions = this._register(new DisposableMap<string, DisposableStore>());

	readonly onDidRegisterViewContainer:
		Event<IViewContainerDescriptor> =
		this._onDidRegisterViewContainer.event;
	readonly onDidDeregisterViewContainer:
		Event<IViewContainerDescriptor> =
		this._onDidDeregisterViewContainer.event;
	readonly onDidRegisterViews: Event<IViewsChangeEvent> =
		this._onDidRegisterViews.event;
	readonly onDidDeregisterViews: Event<IViewsChangeEvent> =
		this._onDidDeregisterViews.event;

	registerViewContainer(
		descriptor: IViewContainerDescriptor,
	): IDisposable {
		const registered = this.addViewContainer(descriptor);
		return toDisposable(() => this.removeViewContainer(registered));
	}

	/** Registers a process-lifetime container contribution. */
	registerStaticViewContainer(
		descriptor: IViewContainerDescriptor,
	): void {
		this.addViewContainer(descriptor);
	}

	private addViewContainer(
		descriptor: IViewContainerDescriptor,
	): IRegisteredViewContainer {
		this.assertNotDisposed();
		validateId(descriptor.id, "view container");
		validateTitle(descriptor.title, "View container");
		if (this.containers.has(descriptor.id)) {
			throw new Error(
				`View container is already registered: ${descriptor.id}`,
			);
		}
		if (
			descriptor.isDefault &&
			this.getViewContainers(descriptor.location).some(
				(container) => container.isDefault,
			)
		) {
			throw new Error(
				`Default view container is already registered for ${descriptor.location
				}`,
			);
		}
		const registered: IRegisteredViewContainer = {
			descriptor: Object.freeze({ ...descriptor }),
			registrationOrder: this.nextOrder++,
		};
		this.containers.set(descriptor.id, registered);
		this._onDidRegisterViewContainer.fire(registered.descriptor);
		return registered;
	}

	private removeViewContainer(registered: IRegisteredViewContainer): void {
		const { descriptor } = registered;
		if (this.containers.get(descriptor.id) !== registered) return;
		const views = this.getViews(descriptor.id);
		for (const view of views) this.views.delete(view.id);
		this.viewActions.deleteAndDispose(descriptor.id);
		if (views.length > 0) {
			this._onDidDeregisterViews.fire({
				container: descriptor,
				views,
			});
		}
		this.containers.delete(descriptor.id);
		this._onDidDeregisterViewContainer.fire(descriptor);
	}

	registerViews(
		containerId: string,
		descriptors: readonly IViewDescriptor[],
	): IDisposable {
		const registrations = this.addViews(containerId, descriptors);
		return toDisposable(() => this.removeViews(registrations));
	}

	/** Registers process-lifetime view contributions. */
	registerStaticViews(
		containerId: string,
		descriptors: readonly IViewDescriptor[],
	): void {
		this.addViews(containerId, descriptors);
	}

	private addViews(
		containerId: string,
		descriptors: readonly IViewDescriptor[],
	): readonly IRegisteredView[] {
		this.assertNotDisposed();
		const container = this.containers.get(containerId)?.descriptor;
		if (!container) {
			throw new Error(`Unknown view container: ${containerId}`);
		}

		const batchIds = new Set<string>();
		for (const descriptor of descriptors) {
			validateId(descriptor.id, "view");
			validateTitle(descriptor.title, "View");
			if (
				batchIds.has(descriptor.id) ||
				this.views.has(descriptor.id)
			) {
				throw new Error(`View is already registered: ${descriptor.id}`);
			}
			batchIds.add(descriptor.id);
		}

		const registrations = descriptors.map(
			(descriptor): IRegisteredView => ({
				descriptor: Object.freeze({ ...descriptor }),
				containerId,
				registrationOrder: this.nextOrder++,
			}),
		);
		for (const registration of registrations) {
			this.views.set(registration.descriptor.id, registration);
		}
		this.registerViewActions(container);
		const views = sortViews(registrations);
		if (views.length > 0) {
			this._onDidRegisterViews.fire({ container, views });
		}
		return registrations;
	}

	private removeViews(registrations: readonly IRegisteredView[]): void {
		const removed: IRegisteredView[] = [];
		for (const registration of registrations) {
			if (
				this.views.get(registration.descriptor.id) === registration
			) {
				this.views.delete(registration.descriptor.id);
				removed.push(registration);
			}
		}
		if (removed.length === 0) return;
		const containerId = removed[0].containerId;
		const container = this.containers.get(containerId)?.descriptor;
		if (!container) return;
		this.registerViewActions(container);
		this._onDidDeregisterViews.fire({
			container,
			views: sortViews(removed),
		});
	}

	private registerViewActions(container: IViewContainerDescriptor): void {
		const actions = new DisposableStore();
		this.viewActions.set(container.id, actions);
		const views = this.getViews(container.id);
		for (const view of views) {
			const visible = ContextKeyExpr.has(getVisibleViewContextKey(view.id));
			// The declaration owns the command lifetime. Resolve the model from
			// the invoking window, rather than capturing a window in this registry.
			actions.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `${view.id}.toggleVisibility`,
						title: view.localizationKey ? localize2(view.localizationKey, view.title) : view.title,
						toggled: visible,
						precondition: view.canToggleVisibility === false ? ContextKeyExpr.false() : ContextKeyExpr.and(view.when, ContextKeyExpr.or(
							ContextKeyExpr.not(getVisibleViewContextKey(view.id)), ...views.filter(other => other.id !== view.id).map(other => ContextKeyExpr.has(getVisibleViewContextKey(other.id))),
						)),
						menu: container.location === ViewContainerLocation.Sidebar ? { id: MenuId.SidebarTitle, group: '1_views', order: view.order, when: ContextKeyExpr.and(ActiveViewletContext.isEqualTo(container.id), view.when) } : undefined,
					});
				}
				override run(accessor: ServicesAccessor): void {
					const service = accessor.get(IViewDescriptorService);
					if (service.getViewContainerForView(view.id)?.id !== container.id || view.canToggleVisibility === false) return;
					const model = service.getViewContainerModel(container.id);
					if (!model.activeViewDescriptors.some(active => active.id === view.id)) return;
					const isVisible = model.isVisible(view.id);
					if (isVisible && model.visibleViewDescriptors.length <= 1) return;
					model.setVisible(view.id, !isVisible);
				}
			}));
		}
	}

	protected override disposeCore(): void {
		// Static declarations live with their registry; window models observe
		// their removal before the registry releases its event emitters.
		for (const container of [...this.containers.values()]) this.removeViewContainer(container);
		this.welcomeContents.clear();
		super.disposeCore();
	}

	getViewContainers(
		location?: ViewContainerLocation,
	): readonly IViewContainerDescriptor[] {
		return [...this.containers.values()]
			.filter((registered) =>
				location === undefined ||
				registered.descriptor.location === location
			)
			.sort(compareRegistered)
			.map((registered) => registered.descriptor);
	}

	getViewContainer(
		id: string,
	): IViewContainerDescriptor | undefined {
		return this.containers.get(id)?.descriptor;
	}

	getDefaultViewContainer(
		location: ViewContainerLocation,
	): IViewContainerDescriptor | undefined {
		const containers = this.getViewContainers(location);
		return containers.find((container) => container.isDefault) ??
			containers[0];
	}

	getViews(containerId: string): readonly IViewDescriptor[] {
		return sortViews(
			[...this.views.values()].filter(
				(registered) => registered.containerId === containerId,
			),
		);
	}

	getView(id: string): IViewDescriptor | undefined {
		return this.views.get(id)?.descriptor;
	}

	getViewContainerForView(
		viewId: string,
	): IViewContainerDescriptor | undefined {
		const containerId = this.views.get(viewId)?.containerId;
		return containerId === undefined
			? undefined
			: this.containers.get(containerId)?.descriptor;
	}
}

interface IRegisteredViewContainer {
	readonly descriptor: IViewContainerDescriptor;
	readonly registrationOrder: number;
}

interface IRegisteredView {
	readonly descriptor: IViewDescriptor;
	readonly containerId: string;
	readonly registrationOrder: number;
}

/** Realm-wide view declarations populated by contribution modules. */
export const ViewsRegistry = new WorkbenchViewRegistry();

function sortViews(
	views: readonly IRegisteredView[],
): readonly IViewDescriptor[] {
	return [...views]
		.sort(compareRegistered)
		.map((registered) => registered.descriptor);
}

function compareRegistered(
	left: IRegisteredViewContainer | IRegisteredView,
	right: IRegisteredViewContainer | IRegisteredView,
): number {
	const leftOrder = left.descriptor.order ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = right.descriptor.order ?? Number.MAX_SAFE_INTEGER;
	return leftOrder - rightOrder ||
		left.registrationOrder - right.registrationOrder;
}

function validateId(id: string, kind: string): void {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id)) {
		throw new TypeError(`Invalid ${kind} ID: ${id}`);
	}
}

function validateTitle(title: string, kind: string): void {
	if (!title.trim()) throw new TypeError(`${kind} title must not be empty`);
}

/** Change to the containers available in one workbench window. */
export interface IViewContainersChangeEvent {
	readonly added: readonly IViewContainerDescriptor[];
	readonly removed: readonly IViewContainerDescriptor[];
}

/**
 * Window-scoped access to context-aware view container models.
 *
 * Implementations project realm-wide static declarations into independent
 * per-window visibility state.
 */
export interface IViewDescriptorService {
	readonly viewContainers: readonly IViewContainerDescriptor[];
	readonly onDidChangeViewContainers: Event<IViewContainersChangeEvent>;
	readonly onDidChangeViewContainerOrder: Event<ViewContainerLocation>;

	getViewContainers(
		location: ViewContainerLocation,
	): readonly IViewContainerDescriptor[];
	getDefaultViewContainer(
		location: ViewContainerLocation,
	): IViewContainerDescriptor | undefined;
	getViewContainerById(id: string): IViewContainerDescriptor | null;
	getViewDescriptorById(id: string): IViewDescriptor | null;
	getViewContainerForView(
		viewId: string,
	): IViewContainerDescriptor | undefined;
	getViewContainerModel(
		containerId: string,
	): IViewContainerModel;
	moveViewContainer(location: ViewContainerLocation, containerId: string, targetContainerId: string | undefined, position: "before" | "after"): void;
	setViewContainerOrder(location: ViewContainerLocation, containerIds: readonly string[]): void;
}

export const IViewDescriptorService =
	createServiceIdentifier<IViewDescriptorService>(
		"viewDescriptorService",
	);
