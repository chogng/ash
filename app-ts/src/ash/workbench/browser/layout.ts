import { h } from "../../base/browser/dom.js";
import { Dimension, getClientArea, type IDimension } from "../../base/browser/dom.js";
import { SerializableGrid, type SerializedGridDescriptor } from "../../base/browser/ui/grid/grid.js";
import type { IResizable } from "../../base/browser/ui/resizable/resizable.js";
import { Emitter } from "../../base/common/event.js";
import { Disposable, MutableDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { isRecord } from "../../base/common/types.js";
import type { ILayoutOffsetInfo } from "../../platform/layout/browser/layoutService.js";
import { type IStorageService, StorageScope, StorageTarget } from "../../platform/storage/common/storage.js";
import { WorkbenchState } from "../../platform/workspace/common/workspace.js";
import type { ActivityBarLocation, SideBarLocation, WorkbenchLayoutStyle } from "../common/configuration.js";
import { type IWorkbenchLayoutService, type WorkbenchPartId, type WorkbenchPartVisibilityChangeEvent, workbenchPartIds } from "../services/layout/common/workbenchLayoutService.js";
import type { IWorkbenchLayoutStyleService } from "../services/layout/browser/workbenchLayoutStyleService.js";
import type { WorkbenchPart } from "./part.js";
import { WorkbenchPartView } from "./workbenchPartView.js";

const WINDOW_LEFT_EDGE_INSET = 6;
const WINDOW_RIGHT_EDGE_INSET = 8;
const PART_GUTTER_HALF = 3;
const PART_GUTTER_SIZE = PART_GUTTER_HALF * 2;
const DEFAULT_LAYOUT_WIDTH = 1_024;
const DEFAULT_LAYOUT_HEIGHT = 768;
const DEFAULT_SIDEBAR_WIDTH = 220;
const DEFAULT_AUXILIARYBAR_WIDTH = 380;
const DEFAULT_AGENT_SIDEBAR_WIDTH = 280;
const DEFAULT_PANEL_HEIGHT = 200;
const EDITOR_LAYOUT_PRIORITY = "high" as const;

interface WorkbenchLayoutStyleMetrics {
	readonly windowLeftEdgeInset: number;
	readonly windowRightEdgeInset: number;
	readonly partGutterHalf: number;
}

const modernWorkbenchLayoutMetrics: WorkbenchLayoutStyleMetrics = {
	windowLeftEdgeInset: WINDOW_LEFT_EDGE_INSET,
	windowRightEdgeInset: WINDOW_RIGHT_EDGE_INSET,
	partGutterHalf: PART_GUTTER_HALF,
};

const flatWorkbenchLayoutMetrics: WorkbenchLayoutStyleMetrics = {
	windowLeftEdgeInset: 0,
	windowRightEdgeInset: 0,
	partGutterHalf: 0,
};

/** Host initial layout for a new workspace, or explicit visibility overrides when forced. */
export interface WorkbenchDefaultLayout {
	readonly parts?: {
		readonly sidebar?: boolean;
		readonly auxiliarybar?: boolean;
		readonly agentSidebar?: boolean;
		readonly panel?: boolean;
	};
	/** Applies explicitly supplied Part visibility even when workspace state exists. */
	readonly force?: boolean;
}

/** The durable, mutable portion of Workbench layout state. */
export interface WorkbenchLayoutState {
	readonly version: 3;
	readonly sidebar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly auxiliarybar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly agentSidebar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly panel: {
		readonly height: number;
		readonly visible: boolean;
	};
}

export interface WorkbenchLayoutOptions {
	readonly initialDimension?: IDimension;
	readonly workbenchState: WorkbenchState;
	readonly showChatOnFirstLaunch: boolean;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly storageService?: IStorageService;
	readonly layoutStyle?: WorkbenchLayoutStyle;
	readonly activityBarLocation?: ActivityBarLocation;
	readonly sideBarLocation?: SideBarLocation;
}

/**
 * Owns the Workbench's fixed Part topology and mutable pixel layout state.
 *
 * Container geometry is supplied through the generic `IResizable` contract; this
 * class only translates those dimensions into Grid bounds and Part layout calls.
 */
export class WorkbenchLayout
	extends Disposable
	implements IResizable, IWorkbenchLayoutService, IWorkbenchLayoutStyleService {
	readonly container: HTMLElement;
	private readonly views = new Map<WorkbenchPartId, WorkbenchPartView>();
	private grid: SerializableGrid<WorkbenchPartView>;
	private readonly gridHandle = this._register(new MutableDisposable<SerializableGrid<WorkbenchPartView>>());
	private readonly gridChangeHandle = this._register(new MutableDisposable());
	private readonly stateModel: WorkbenchLayoutStateModel;
	private readonly partVisibility = new Map<WorkbenchPartId, boolean>();
	private readonly _onDidChangePartVisibility = this._register(
		new Emitter<WorkbenchPartVisibilityChangeEvent>(),
	);
	private layoutStyle: WorkbenchLayoutStyle;
	private activityBarLocation: ActivityBarLocation;
	private sideBarLocation: SideBarLocation;

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly domNode: HTMLDivElement;

	constructor(
		container: HTMLElement,
		parts: ReadonlyMap<WorkbenchPartId, WorkbenchPart>,
		options: WorkbenchLayoutOptions,
	) {
		super();
		this.container = container;
		this.layoutStyle = options.layoutStyle ?? "modern";
		this.activityBarLocation = options.activityBarLocation ?? 'default';
		this.sideBarLocation = options.sideBarLocation ?? 'left';
		validateParts(parts);
		this.domNode = h(container.ownerDocument, "div");
		this.domNode.className = "ash-workbench-layout";
		this.domNode.classList.toggle('activitybar-absent', this.activityBarLocation !== 'default');
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));

		for (const partId of workbenchPartIds) {
			this.views.set(
				partId,
				new WorkbenchPartView(partId, requiredPart(parts, partId), {
					snap: isSnappableWorkbenchPart(partId),
				}),
			);
		}
		const initialDimension = resolveInitialDimension(
			this.domNode,
			options.initialDimension,
		);
		validateWorkbenchDefaultLayout(options.defaultLayout);
		this.stateModel = new WorkbenchLayoutStateModel(
			options.storageService,
			options.workbenchState,
			options.showChatOnFirstLaunch,
			options.defaultLayout,
		);
		const initialState = this.stateModel.state;
		this.projectPartFrameInsets(
			initialState.sidebar.visible,
			initialState.auxiliarybar.visible,
			initialState.agentSidebar.visible,
			initialState.panel.visible,
		);
		this.grid = SerializableGrid.deserialize(
			this.domNode,
			createWorkbenchGridDescriptor(this.views, initialDimension, initialState, this.activityBarLocation, this.sideBarLocation),
			{ fromJSON: (data) => this.view(parseWorkbenchPartId(data)) },
			{
				sashPresentation: this.layoutStyle === "modern" ? { type: "inset", gap: PART_GUTTER_SIZE } : undefined,
				edgeSnapping: true,
			},
		);
		this.gridHandle.value = this.grid;
		this.gridChangeHandle.value = this.grid.onDidChange(() => {
			this.projectPartFrameInsets();
			this.publishPartVisibility();
		});
		this.stateModel.markFirstLaunchComplete();
		if (options.storageService) {
			this._register(options.storageService.onWillSaveState(() => {
				this.saveState();
			}));
		}
	}

	setLayoutStyle(style: WorkbenchLayoutStyle): void {
		if (this.layoutStyle === style) return;
		this.layoutStyle = style;
		this.grid.sashPresentation = style === "modern" ? { type: "inset", gap: PART_GUTTER_SIZE } : undefined;
		this.projectPartFrameInsets();
		if (this.grid.width > 0 && this.grid.height > 0) {
			this.layout(new Dimension(this.grid.width, this.grid.height));
		}
	}

	setActivityBarLocation(location: ActivityBarLocation): void {
		if (this.activityBarLocation === location) return;
		this.activityBarLocation = location;
		this.domNode.classList.toggle('activitybar-absent', location !== 'default');
		this.rebuildGrid();
	}

	setSideBarLocation(location: SideBarLocation): void {
		if (this.sideBarLocation === location) return;
		this.sideBarLocation = location;
		this.rebuildGrid();
	}

	private rebuildGrid(): void {
		const state = this.state;
		const dimension = new Dimension(this.grid.width || getClientArea(this.domNode).width, this.grid.height || getClientArea(this.domNode).height);
		this.gridChangeHandle.clear();
		this.gridHandle.clear();
		this.grid = SerializableGrid.deserialize(
			this.domNode,
			createWorkbenchGridDescriptor(this.views, dimension, state, this.activityBarLocation, this.sideBarLocation),
			{ fromJSON: data => this.view(parseWorkbenchPartId(data)) },
			{ sashPresentation: this.layoutStyle === 'modern' ? { type: 'inset', gap: PART_GUTTER_SIZE } : undefined, edgeSnapping: true },
		);
		this.gridHandle.value = this.grid;
		this.gridChangeHandle.value = this.grid.onDidChange(() => {
			this.projectPartFrameInsets();
			this.publishPartVisibility();
		});
		this.layout(dimension);
	}

	/** Offset information consumed by the platform layout service for overlays. */
	get mainContainerOffset(): ILayoutOffsetInfo {
		const titlebar = this.getPartSize("titlebar");
		return {
			top: this.isPartVisible("titlebar") ? titlebar.height : 0,
			quickInputTop: 0,
		};
	}

	layout(dimension: IDimension = getClientArea(this.domNode)): void {
		assertDimension(dimension);
		this.projectPartFrameInsets();
		this.grid.layout(dimension.width, dimension.height);
		this.publishPartVisibility();
	}

	get state(): WorkbenchLayoutState {
		const sidebar = this.getPartSize("sidebar");
		const auxiliarybar = this.getPartSize("auxiliarybar");
		const agentSidebar = this.getPartSize("agentSidebar");
		const panel = this.getPartSize("panel");
		return {
			version: 3,
			sidebar: {
				width: sidebar.width,
				visible: this.isPartVisible("sidebar"),
			},
			auxiliarybar: {
				width: auxiliarybar.width,
				visible: this.isPartVisible("auxiliarybar"),
			},
			agentSidebar: {
				width: agentSidebar.width,
				visible: this.isPartVisible("agentSidebar"),
			},
			panel: {
				height: panel.height,
				visible: this.isPartVisible("panel"),
			},
		};
	}

	restoreState(value: unknown): void {
		const state = parseWorkbenchLayoutState(value);
		this.applyState(state);
		this.saveState();
	}

	/** Re-applies the layout state from the currently selected storage workspace. */
	restoreWorkspaceState(workbenchState: WorkbenchState = this.stateModel.workbenchState): void {
		this.stateModel.workbenchState = workbenchState;
		this.applyState(this.stateModel.state);
		this.saveState();
	}

	isPartVisible(partId: WorkbenchPartId): boolean {
		return this.grid.isViewVisible(this.view(partId));
	}

	isPanelMaximized(): boolean {
		return this.isPartVisible('panel') && !this.isPartVisible('editor');
	}

	showPart(partId: WorkbenchPartId): void {
		this.showParts([partId]);
	}

	showParts(partIds: readonly WorkbenchPartId[]): void {
		this.updatePartsVisibility(partIds, true);
	}

	hidePart(partId: WorkbenchPartId): void {
		this.hideParts([partId]);
	}

	hideParts(partIds: readonly WorkbenchPartId[]): void {
		this.updatePartsVisibility(partIds, false);
	}

	getPartSize(partId: WorkbenchPartId): Dimension {
		const size = this.grid.getViewSize(this.view(partId));
		return new Dimension(size.width, size.height);
	}

	resizePart(partId: WorkbenchPartId, dimension: IDimension): void {
		assertDimension(dimension);
		this.grid.resizeView(this.view(partId), dimension);
	}

	private saveState(): void {
		this.stateModel.save(this.state);
	}

	private applyState(state: WorkbenchLayoutState): void {
		this.resizePart("sidebar", this.getPartSize("sidebar").with(state.sidebar.width));
		this.resizePart("auxiliarybar", this.getPartSize("auxiliarybar").with(state.auxiliarybar.width));
		this.resizePart("agentSidebar", this.getPartSize("agentSidebar").with(state.agentSidebar.width));
		this.resizePart("panel", new Dimension(this.getPartSize("panel").width, state.panel.height));
		this.updatePartsVisibility(["sidebar"], state.sidebar.visible);
		this.updatePartsVisibility(["auxiliarybar"], state.auxiliarybar.visible);
		this.updatePartsVisibility(["agentSidebar"], state.agentSidebar.visible);
		this.updatePartsVisibility(["panel"], state.panel.visible);
	}

	private updatePartsVisibility(
		partIds: readonly WorkbenchPartId[],
		visible: boolean,
	): void {
		const uniquePartIds = [...new Set(partIds)];
		for (const partId of uniquePartIds) this.view(partId);
		this.projectPartFrameInsets(
			uniquePartIds.includes("sidebar") ? visible : this.isPartVisible("sidebar"),
			uniquePartIds.includes("auxiliarybar") ? visible : this.isPartVisible("auxiliarybar"),
			uniquePartIds.includes("agentSidebar") ? visible : this.isPartVisible("agentSidebar"),
			uniquePartIds.includes("panel") ? visible : this.isPartVisible("panel"),
		);
		const changed = uniquePartIds.filter(
			(partId) => this.isPartVisible(partId) !== visible,
		);
		for (const partId of changed) {
			this.grid.setViewVisible(this.view(partId), visible);
		}
		this.publishPartVisibility();
	}

	private projectPartFrameInsets(
		sidebarVisible = this.isPartVisible("sidebar"),
		auxiliarybarVisible = this.isPartVisible("auxiliarybar"),
		agentSidebarVisible = this.isPartVisible("agentSidebar"),
		panelVisible = this.isPartVisible("panel"),
	): void {
		const metrics = this.layoutStyle === "modern"
			? modernWorkbenchLayoutMetrics
			: flatWorkbenchLayoutMetrics;
		// The sidebar owns the outer window inset whenever the vertical Activity Bar is hidden.
		const activityBarBesideSidebar = this.activityBarLocation === 'default';
		const secondaryVisible = auxiliarybarVisible || agentSidebarVisible;
		const centralInsets = this.sideBarLocation === 'left'
			? { left: sidebarVisible ? metrics.partGutterHalf : metrics.partGutterHalf * 2, right: secondaryVisible ? metrics.partGutterHalf : metrics.windowRightEdgeInset }
			: { left: secondaryVisible ? metrics.partGutterHalf : metrics.windowLeftEdgeInset, right: sidebarVisible ? metrics.partGutterHalf : metrics.windowRightEdgeInset };
		this.view("sidebar").setFrameInsets({
			top: 0,
			right: this.sideBarLocation === 'left' ? metrics.partGutterHalf : (activityBarBesideSidebar ? 0 : metrics.windowRightEdgeInset),
			bottom: 0,
			left: this.sideBarLocation === 'right' ? metrics.partGutterHalf : (activityBarBesideSidebar ? 0 : metrics.windowLeftEdgeInset),
		});
		this.view("activitybar").setFrameInsets({
			top: 0,
			right: this.sideBarLocation === 'right' ? metrics.windowRightEdgeInset : 0,
			bottom: 0,
			left: this.sideBarLocation === 'left' ? metrics.windowLeftEdgeInset : 0,
		});
		this.view("auxiliarybar").setFrameInsets({
			top: 0,
			right: this.sideBarLocation === 'left' ? (agentSidebarVisible ? metrics.partGutterHalf : metrics.windowRightEdgeInset) : metrics.partGutterHalf,
			bottom: 0,
			left: this.sideBarLocation === 'right' && !agentSidebarVisible ? metrics.windowLeftEdgeInset : metrics.partGutterHalf,
		});
		this.view("agentSidebar").setFrameInsets({
			top: 0,
			right: this.sideBarLocation === 'left' ? metrics.windowRightEdgeInset : metrics.partGutterHalf,
			bottom: 0,
			left: this.sideBarLocation === 'right' ? metrics.windowLeftEdgeInset : metrics.partGutterHalf,
		});
		this.view("editor").setFrameInsets({
			top: 0,
			right: centralInsets.right,
			bottom: panelVisible ? metrics.partGutterHalf : 0,
			left: centralInsets.left,
		});
		this.view("panel").setFrameInsets({
			top: panelVisible ? metrics.partGutterHalf : 0,
			right: centralInsets.right,
			bottom: 0,
			left: centralInsets.left,
		});
	}

	private publishPartVisibility(): void {
		for (const partId of workbenchPartIds) {
			const visible = this.isPartVisible(partId);
			if (this.partVisibility.get(partId) === visible) continue;
			this.partVisibility.set(partId, visible);
			this._onDidChangePartVisibility.fire({ partId, visible });
		}
	}

	private view(partId: WorkbenchPartId): WorkbenchPartView {
		const view = this.views.get(partId);
		if (!view) throw new Error(`Unknown Workbench Part: ${partId}`);
		return view;
	}
}

function validateParts(
	parts: ReadonlyMap<WorkbenchPartId, WorkbenchPart>,
): void {
	const missing = workbenchPartIds.filter((partId) => !parts.has(partId));
	if (missing.length > 0) {
		throw new TypeError(
			`Workbench layout is missing Parts: ${missing.join(", ")}`,
		);
	}
}

function requiredPart(
	parts: ReadonlyMap<WorkbenchPartId, WorkbenchPart>,
	partId: WorkbenchPartId,
): WorkbenchPart {
	const part = parts.get(partId);
	if (!part) throw new Error(`Workbench Part is not registered: ${partId}`);
	return part;
}

function isSnappableWorkbenchPart(partId: WorkbenchPartId): boolean {
	return partId === "sidebar" ||
		partId === "auxiliarybar" ||
		partId === "agentSidebar" ||
		partId === "panel";
}

function createWorkbenchGridDescriptor(
	views: ReadonlyMap<WorkbenchPartId, WorkbenchPartView>,
	dimension: IDimension,
	state: WorkbenchLayoutState,
	activityBarLocation: ActivityBarLocation,
	sideBarLocation: SideBarLocation,
): SerializedGridDescriptor {
	const leaf = (
		partId: WorkbenchPartId,
		size: number,
		visible = true,
		priority: "normal" | "high" = "normal",
	): SerializedGridDescriptor => ({
		type: "leaf",
		data: partId,
		size,
		visible,
		priority,
	});
	const titlebarHeight = requiredView(views, "titlebar").minimumHeight;
	const statusbarHeight = requiredView(views, "statusbar").minimumHeight;
	const activitybarWidth = requiredView(views, "activitybar").minimumWidth;
	const bodyHeight = Math.max(
		0,
		dimension.height - titlebarHeight - statusbarHeight,
	);
	const panelHeight = state.panel.height;
	const editorHeight = Math.max(
		0,
		bodyHeight - (state.panel.visible ? panelHeight : 0),
	);
	const editorWidth = Math.max(
		0,
		dimension.width -
			(activityBarLocation === 'default' ? activitybarWidth : 0) -
			(state.sidebar.visible ? state.sidebar.width : 0) -
			(state.auxiliarybar.visible ? state.auxiliarybar.width : 0) -
			(state.agentSidebar.visible ? state.agentSidebar.width : 0),
	);
	const primary: SerializedGridDescriptor[] = sideBarLocation === 'left'
		? [leaf('activitybar', activitybarWidth, activityBarLocation === 'default'), leaf('sidebar', state.sidebar.width, state.sidebar.visible)]
		: [leaf('sidebar', state.sidebar.width, state.sidebar.visible), leaf('activitybar', activitybarWidth, activityBarLocation === 'default')];
	const secondary: SerializedGridDescriptor[] = [
		leaf('auxiliarybar', state.auxiliarybar.width, state.auxiliarybar.visible),
		leaf('agentSidebar', state.agentSidebar.width, state.agentSidebar.visible),
	];
	const center: SerializedGridDescriptor = {
		type: 'branch', orientation: 'vertical', size: editorWidth, priority: EDITOR_LAYOUT_PRIORITY,
		children: [leaf('editor', editorHeight, true, EDITOR_LAYOUT_PRIORITY), leaf('panel', panelHeight, state.panel.visible)],
	};
	return {
		type: "branch",
		orientation: "vertical",
		size: dimension.height,
		priority: "normal",
		children: [
			leaf("titlebar", titlebarHeight),
			{
				type: "branch",
				orientation: "horizontal",
				size: bodyHeight,
				priority: EDITOR_LAYOUT_PRIORITY,
				children: sideBarLocation === 'left' ? [...primary, center, ...secondary] : [...secondary.slice().reverse(), center, ...primary],
			},
			leaf("statusbar", statusbarHeight),
		],
	};
}

function resolveInitialDimension(
	container: HTMLElement,
	dimension: IDimension | undefined,
): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) {
			return new Dimension(dimension.width, dimension.height);
		}
	}
	const measured = {
		width: container.clientWidth,
		height: container.clientHeight,
	};
	return new Dimension(
		measured.width > 0 ? measured.width : DEFAULT_LAYOUT_WIDTH,
		measured.height > 0 ? measured.height : DEFAULT_LAYOUT_HEIGHT,
	);
}

function parseWorkbenchPartId(value: unknown): WorkbenchPartId {
	if (
		typeof value === "string" &&
		workbenchPartIds.includes(value as WorkbenchPartId)
	) {
		return value as WorkbenchPartId;
	}
	throw new TypeError("Workbench Grid contains an unknown Part");
}

function requiredView(
	views: ReadonlyMap<WorkbenchPartId, WorkbenchPartView>,
	partId: WorkbenchPartId,
): WorkbenchPartView {
	const view = views.get(partId);
	if (!view) throw new Error(`Workbench Part view is not registered: ${partId}`);
	return view;
}

function assertDimension(dimension: IDimension): void {
	if (
		!Number.isFinite(dimension.width) ||
		dimension.width < 0 ||
		!Number.isFinite(dimension.height) ||
		dimension.height < 0
	) {
		throw new RangeError(
			"Workbench layout dimensions must be non-negative and finite",
		);
	}
}

function createDefaultWorkbenchLayoutState(
	parts: WorkbenchDefaultLayout["parts"] | undefined,
): WorkbenchLayoutState {
	if (parts !== undefined && !isRecord(parts)) {
		throw new TypeError("Workbench default layout Parts must be an object");
	}
	return {
		version: 3,
		sidebar: {
			width: DEFAULT_SIDEBAR_WIDTH,
			visible: defaultPartVisibility(parts, "sidebar", true),
		},
		auxiliarybar: {
			width: DEFAULT_AUXILIARYBAR_WIDTH,
			visible: defaultPartVisibility(parts, "auxiliarybar", true),
		},
		agentSidebar: {
			width: DEFAULT_AGENT_SIDEBAR_WIDTH,
			visible: defaultPartVisibility(parts, "agentSidebar", false),
		},
		panel: {
			height: DEFAULT_PANEL_HEIGHT,
			visible: defaultPartVisibility(parts, "panel", true),
		},
	};
}

function validateWorkbenchDefaultLayout(
	defaultLayout: WorkbenchDefaultLayout | undefined,
): void {
	if (defaultLayout === undefined) return;
	if (!isRecord(defaultLayout)) {
		throw new TypeError("Workbench default layout must be an object");
	}
	if (defaultLayout.parts !== undefined && !isRecord(defaultLayout.parts)) {
		throw new TypeError("Workbench default layout Parts must be an object");
	}
	if (defaultLayout.force !== undefined && typeof defaultLayout.force !== "boolean") {
		throw new TypeError("Workbench default layout force must be boolean");
	}
}

function defaultPartVisibility(
	parts: WorkbenchDefaultLayout["parts"] | undefined,
	partId: keyof NonNullable<WorkbenchDefaultLayout["parts"]>,
	fallback: boolean,
): boolean {
	const value = parts?.[partId];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		throw new TypeError(`Workbench default layout ${partId} visibility must be boolean`);
	}
	return value;
}

function parseWorkbenchLayoutState(value: unknown): WorkbenchLayoutState {
	if (
		!isRecord(value) ||
		!isHorizontalLayoutRegionState(value.sidebar) ||
		!isHorizontalLayoutRegionState(value.auxiliarybar)
	) {
		throw new TypeError("Workbench layout state is invalid or unsupported");
	}
	let panel: { readonly height: number; readonly visible: boolean };
	let agentSidebar: { readonly width: number; readonly visible: boolean };
	if (value.version === 1) {
		panel = { height: DEFAULT_PANEL_HEIGHT, visible: true };
		agentSidebar = { width: DEFAULT_AGENT_SIDEBAR_WIDTH, visible: false };
	} else if (value.version === 2 && isVerticalLayoutRegionState(value.panel)) {
		panel = value.panel;
		agentSidebar = { width: DEFAULT_AGENT_SIDEBAR_WIDTH, visible: false };
	} else if (
		value.version === 3 &&
		isVerticalLayoutRegionState(value.panel) &&
		isHorizontalLayoutRegionState(value.agentSidebar)
	) {
		panel = value.panel;
		agentSidebar = value.agentSidebar;
	} else {
		throw new TypeError("Workbench layout state is invalid or unsupported");
	}
	return {
		version: 3,
		sidebar: {
			width: value.sidebar.width,
			visible: value.sidebar.visible,
		},
		auxiliarybar: {
			width: value.auxiliarybar.width,
			visible: value.auxiliarybar.visible,
		},
		agentSidebar,
		panel: {
			height: panel.height,
			visible: panel.visible,
		},
	};
}

/** Bridges Workbench layout semantics to the generic scoped storage service. */
class WorkbenchLayoutStateModel {
	private readonly isFirstApplicationRun: boolean;

	constructor(
		private readonly storageService: IStorageService | undefined,
		public workbenchState: WorkbenchState,
		private readonly showChatOnFirstLaunch: boolean,
		private readonly defaultLayout: WorkbenchDefaultLayout | undefined,
	) {
		this.isFirstApplicationRun = storageService?.isNew(StorageScope.APPLICATION) ?? false;
	}

	get state(): WorkbenchLayoutState {
		const storage = this.storageService;
		const fallbackParts = {
			sidebar: this.workbenchState !== WorkbenchState.EMPTY,
			auxiliarybar: this.workbenchState !== WorkbenchState.EMPTY || (this.isFirstApplicationRun && this.showChatOnFirstLaunch),
			agentSidebar: false,
			panel: false,
		} as const satisfies NonNullable<WorkbenchDefaultLayout["parts"]>;
		const defaults = this.shouldApplyDefaultLayout(storage)
			? createDefaultWorkbenchLayoutState({ ...fallbackParts, ...this.defaultLayout?.parts })
			: createDefaultWorkbenchLayoutState(fallbackParts);
		if (!storage) return defaults;
		return {
			version: 3,
			sidebar: {
				width: storedDimension(
					storage.getNumber(
						WorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.key,
						WorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.scope,
					),
					defaults.sidebar.width,
				),
				visible: this.storedVisibility(
					storage,
					WorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.key,
					WorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.scope,
					defaults.sidebar.visible,
					"sidebar",
				),
			},
			auxiliarybar: {
				width: storedDimension(
					storage.getNumber(
						WorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.key,
						WorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.scope,
					),
					defaults.auxiliarybar.width,
				),
				visible: this.storedVisibility(
					storage,
					WorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.key,
					WorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.scope,
					defaults.auxiliarybar.visible,
					"auxiliarybar",
				),
			},
			agentSidebar: {
				width: storedDimension(
					storage.getNumber(
						WorkbenchLayoutStorageKeys.AGENT_SIDEBAR_WIDTH.key,
						WorkbenchLayoutStorageKeys.AGENT_SIDEBAR_WIDTH.scope,
					),
					defaults.agentSidebar.width,
				),
				visible: this.storedVisibility(
					storage,
					WorkbenchLayoutStorageKeys.AGENT_SIDEBAR_VISIBLE.key,
					WorkbenchLayoutStorageKeys.AGENT_SIDEBAR_VISIBLE.scope,
					defaults.agentSidebar.visible,
					"agentSidebar",
				),
			},
			panel: {
				height: storedDimension(
					storage.getNumber(
						WorkbenchLayoutStorageKeys.PANEL_HEIGHT.key,
						WorkbenchLayoutStorageKeys.PANEL_HEIGHT.scope,
					),
					defaults.panel.height,
				),
				visible: this.storedVisibility(
					storage,
					WorkbenchLayoutStorageKeys.PANEL_VISIBLE.key,
					WorkbenchLayoutStorageKeys.PANEL_VISIBLE.scope,
					defaults.panel.visible,
					"panel",
				),
			},
		};
	}

	markFirstLaunchComplete(): void {
		if (!this.isFirstApplicationRun || !this.showChatOnFirstLaunch) return;
		// An empty application scope remains new across restarts until it contains a value.
		this.storageService?.store("workbench.layout.initialized", true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private shouldApplyDefaultLayout(storage: IStorageService | undefined): boolean {
		return this.defaultLayout !== undefined &&
			(this.defaultLayout.force === true || storage === undefined || storage.isNew(StorageScope.WORKSPACE));
	}

	private storedVisibility(
		storage: IStorageService,
		key: string,
		scope: StorageScope,
		fallback: boolean,
		partId: keyof NonNullable<WorkbenchDefaultLayout["parts"]>,
	): boolean {
		if (this.defaultLayout?.force === true) {
			const forced = this.defaultLayout.parts?.[partId];
			if (forced !== undefined) return forced;
		}
		return storage.getBoolean(key, scope, fallback);
	}

	save(state: WorkbenchLayoutState): void {
		const storage = this.storageService;
		if (!storage) return;
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.SIDEBAR_WIDTH,
			state.sidebar.width,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE,
			state.sidebar.visible,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH,
			state.auxiliarybar.width,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE,
			state.auxiliarybar.visible,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.AGENT_SIDEBAR_WIDTH,
			state.agentSidebar.width,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.AGENT_SIDEBAR_VISIBLE,
			state.agentSidebar.visible,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.PANEL_HEIGHT,
			state.panel.height,
		);
		storeLayoutValue(
			storage,
			WorkbenchLayoutStorageKeys.PANEL_VISIBLE,
			state.panel.visible,
		);
	}
}

interface WorkbenchLayoutStorageKey {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
}

const WorkbenchLayoutStorageKeys = {
	SIDEBAR_WIDTH: {
		key: "workbench.layout.sidebar.width",
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	SIDEBAR_VISIBLE: {
		key: "workbench.layout.sidebar.visible",
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_WIDTH: {
		key: "workbench.layout.auxiliarybar.width",
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_VISIBLE: {
		key: "workbench.layout.auxiliarybar.visible",
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.MACHINE,
	},
	AGENT_SIDEBAR_WIDTH: {
		key: "workbench.layout.agentSidebar.width",
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AGENT_SIDEBAR_VISIBLE: {
		key: "workbench.layout.agentSidebar.visible",
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.MACHINE,
	},
	PANEL_HEIGHT: {
		key: "workbench.layout.panel.height",
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	PANEL_VISIBLE: {
		key: "workbench.layout.panel.visible",
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.MACHINE,
	},
} as const satisfies Record<string, WorkbenchLayoutStorageKey>;

function storeLayoutValue(
	storage: IStorageService,
	key: WorkbenchLayoutStorageKey,
	value: number | boolean,
): void {
	storage.store(key.key, value, key.scope, key.target);
}

function storedDimension(value: number | undefined, fallback: number): number {
	return value !== undefined && value >= 0 ? value : fallback;
}

function isHorizontalLayoutRegionState(
	value: unknown,
): value is { readonly width: number; readonly visible: boolean } {
	return (
		isRecord(value) &&
		isLayoutDimension(value.width) &&
		typeof value.visible === "boolean"
	);
}

function isVerticalLayoutRegionState(
	value: unknown,
): value is { readonly height: number; readonly visible: boolean } {
	return (
		isRecord(value) &&
		isLayoutDimension(value.height) &&
		typeof value.visible === "boolean"
	);
}

function isLayoutDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
