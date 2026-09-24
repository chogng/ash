import { Emitter, type Event } from "../../base/common/event.js";
import {
	type IDisposable,
	toDisposable,
} from "../../base/common/lifecycle.js";
import type {
	ContextKeyExpression,
} from "../../platform/contextkey/common/contextkey.js";
import type {
	ServiceConstructionDescriptor,
} from "../../platform/instantiation/common/instantiation.js";
import type { Icon } from "../../base/common/icon.js";
import type { LocalizationKey } from "../../nls.js";

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
	readonly ctorDescriptor: ServiceConstructionDescriptor<IView>;
	readonly when?: ContextKeyExpression;
	readonly order?: number;
	readonly collapsed?: boolean;
	readonly hideByDefault?: boolean;
	readonly canToggleVisibility?: boolean;
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
export class WorkbenchViewRegistry {
	private readonly containers =
		new Map<string, IRegisteredViewContainer>();
	private readonly views = new Map<string, IRegisteredView>();
	private readonly _onDidRegisterViewContainer =
		new Emitter<IViewContainerDescriptor>();
	private readonly _onDidDeregisterViewContainer =
		new Emitter<IViewContainerDescriptor>();
	private readonly _onDidRegisterViews = new Emitter<IViewsChangeEvent>();
	private readonly _onDidDeregisterViews = new Emitter<IViewsChangeEvent>();
	private nextOrder = 1;

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
				`Default view container is already registered for ${
          descriptor.location
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
		this._onDidDeregisterViews.fire({
			container,
			views: sortViews(removed),
		});
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
