import { Dimension, getClientArea, type IDimension } from "../../../base/browser/dom.js";
import { SerializableGrid } from "../../../base/browser/ui/grid/grid.js";
import type { IResizable } from "../../../base/browser/ui/resizable/resizable.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { ILayoutOffsetInfo } from "../../../platform/layout/browser/layoutService.js";
import type { IStorageService } from "../../../platform/storage/common/storage.js";
import { WorkbenchPartView } from "../../../workbench/browser/workbenchPartView.js";
import type { WorkbenchPart } from "../../../workbench/browser/part.js";
import { type ISessionsLayoutService, type SessionsPartId, type SessionsPartVisibilityChangeEvent, sessionsPartIds } from "../../services/layout/common/sessionsLayoutService.js";
import { createDefaultSessionsWorkbenchLayoutState, type SessionsWorkbenchLayoutState, SessionsWorkbenchLayoutStateModel } from "./sessionsWorkbenchLayoutState.js";
import { assertDimension, createSessionsWorkbenchGridDescriptor, parseSessionsPartId, resolveSessionsInitialDimension } from "./sessionsWorkbenchLayoutTopology.js";
import { h } from "../../../base/browser/dom.js";

const PART_GUTTER = 6;

export interface SessionsWorkbenchLayoutOptions {
	readonly initialDimension?: IDimension;
	readonly initialState?: SessionsWorkbenchLayoutState;
	readonly storageService?: IStorageService;
}

/** Owns the fixed Part topology and mutable geometry of one dedicated Sessions window. */
export class SessionsWorkbenchLayout extends Disposable implements IResizable, ISessionsLayoutService {
	private readonly views = new Map<SessionsPartId, WorkbenchPartView<SessionsPartId>>();
	private readonly grid: SerializableGrid<WorkbenchPartView<SessionsPartId>>;
	private readonly stateModel: SessionsWorkbenchLayoutStateModel;
	private readonly partVisibility = new Map<SessionsPartId, boolean>();
	private readonly _onDidChangePartVisibility = this._register(new Emitter<SessionsPartVisibilityChangeEvent>());

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly domNode: HTMLDivElement;

	constructor(container: Element, parts: ReadonlyMap<SessionsPartId, WorkbenchPart>, options: SessionsWorkbenchLayoutOptions = {}) {
		super();
		validateParts(parts);
		this.domNode = h(container.ownerDocument, "div");
		this.domNode.className = "ash-sessions-workbench-layout";
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		for (const partId of sessionsPartIds) this.views.set(partId, new WorkbenchPartView(partId, requiredPart(parts, partId)));
		const initialDimension = resolveSessionsInitialDimension(this.domNode, options.initialDimension);
		this.stateModel = new SessionsWorkbenchLayoutStateModel(options.storageService, options.initialState ?? createDefaultSessionsWorkbenchLayoutState());
		const state = this.stateModel.state;
		this.projectFrameInsets(state.auxiliarybar.visible);
		this.grid = this._register(SerializableGrid.deserialize(
			this.domNode,
			createSessionsWorkbenchGridDescriptor(this.views, initialDimension, state),
			{ fromJSON: data => this.view(parseSessionsPartId(data)) },
			{ sashPresentation: { type: "inset", gap: PART_GUTTER } },
		));
		if (options.storageService) this._register(options.storageService.onWillSaveState(() => this.saveState()));
		this._register(toDisposable(() => this.saveState()));
	}

	get mainContainerOffset(): ILayoutOffsetInfo {
		const titlebar = this.getPartSize("titlebar");
		return { top: this.isPartVisible("titlebar") ? titlebar.height : 0, quickInputTop: 0 };
	}

	get state(): SessionsWorkbenchLayoutState {
		return {
			version: 1,
			sidebar: { width: this.getPartSize("sidebar").width },
			auxiliarybar: {
				width: this.getPartSize("auxiliarybar").width,
				visible: this.isPartVisible("auxiliarybar"),
			},
		};
	}

	layout(dimension: IDimension = getClientArea(this.domNode)): void {
		assertDimension(dimension);
		this.projectFrameInsets();
		this.grid.layout(dimension.width, dimension.height);
		this.publishPartVisibility();
	}

	isPartVisible(partId: SessionsPartId): boolean { return this.grid.isViewVisible(this.view(partId)); }
	showPart(partId: SessionsPartId): void { this.updatePartVisibility(partId, true); }
	hidePart(partId: SessionsPartId): void { this.updatePartVisibility(partId, false); }
	getPartSize(partId: SessionsPartId): Dimension {
		const size = this.grid.getViewSize(this.view(partId));
		return new Dimension(size.width, size.height);
	}
	resizePart(partId: SessionsPartId, dimension: IDimension): void {
		assertDimension(dimension);
		this.grid.resizeView(this.view(partId), dimension);
	}

	private updatePartVisibility(partId: SessionsPartId, visible: boolean): void {
		if (partId === "titlebar" || partId === "sidebar" || partId === "sessions") throw new Error(`Required Sessions Part cannot be hidden: ${partId}`);
		if (this.isPartVisible(partId) === visible) return;
		this.projectFrameInsets(visible);
		this.grid.setViewVisible(this.view(partId), visible);
		this.publishPartVisibility();
	}

	private saveState(): void { this.stateModel.save(this.state); }

	private projectFrameInsets(auxiliarybarVisible = this.isPartVisible("auxiliarybar")): void {
		this.view("titlebar").setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		this.view("sidebar").setFrameInsets({ top: 0, right: PART_GUTTER / 2, bottom: 0, left: 0 });
		this.view("sessions").setFrameInsets({ top: 0, right: auxiliarybarVisible ? PART_GUTTER / 2 : 0, bottom: 0, left: PART_GUTTER / 2 });
		this.view("auxiliarybar").setFrameInsets({ top: 0, right: 0, bottom: 0, left: PART_GUTTER / 2 });
	}

	private publishPartVisibility(): void {
		for (const partId of sessionsPartIds) {
			const visible = this.isPartVisible(partId);
			if (this.partVisibility.get(partId) === visible) continue;
			this.partVisibility.set(partId, visible);
			this._onDidChangePartVisibility.fire({ partId, visible });
		}
	}

	private view(partId: SessionsPartId): WorkbenchPartView<SessionsPartId> {
		const view = this.views.get(partId);
		if (!view) throw new Error(`Unknown Sessions Part: ${partId}`);
		return view;
	}
}

function validateParts(parts: ReadonlyMap<SessionsPartId, WorkbenchPart>): void {
	const missing = sessionsPartIds.filter(partId => !parts.has(partId));
	if (missing.length > 0) throw new TypeError(`Sessions layout is missing Parts: ${missing.join(", ")}`);
}

function requiredPart(parts: ReadonlyMap<SessionsPartId, WorkbenchPart>, partId: SessionsPartId): WorkbenchPart {
	const part = parts.get(partId);
	if (!part) throw new Error(`Sessions Part is not registered: ${partId}`);
	return part;
}
