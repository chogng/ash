import { addDisposableListener, getWindow, h } from "../../base/browser/dom.js";
import { Dimension, getClientArea, type IDimension } from "../../base/browser/dom.js";
import { SerializableGrid, type SerializedGridDescriptor, type Direction } from "../../base/browser/ui/grid/grid.js";
import { isAncestorOfActiveElement } from '../../base/browser/focus.js';
import { Emitter } from "../../base/common/event.js";
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { isRecord } from "../../base/common/types.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { BrowserLayoutService, type ILayoutOffsetInfo } from "../../platform/layout/browser/layoutService.js";
import { IStorageService, StorageScope, StorageTarget } from "../../platform/storage/common/storage.js";
import { WorkbenchState } from "../../platform/workspace/common/workspace.js";
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation, type WorkbenchLayoutStyle } from "../common/configuration.js";
import { Position, isHorizontal, positionFromString, positionToString, type IWorkbenchLayoutService, type WorkbenchPartId, type WorkbenchPartVisibilityChangeEvent, workbenchPartIds } from "../services/layout/browser/layoutService.js";
import type { Part } from "./part.js";
import { WorkbenchPartView } from "./workbenchPartView.js";
import { IAuxiliaryWindowService, type IAuxiliaryWindow } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';

const WINDOW_LEFT_EDGE_INSET = 4;
const WINDOW_RIGHT_EDGE_INSET = 4;
// Adjacent frames share the gutter; the resize sash uses its full width.
const PART_GUTTER_HALF = 2;
const PART_GUTTER_SIZE = PART_GUTTER_HALF * 2;
const DEFAULT_LAYOUT_WIDTH = 1_024;
const DEFAULT_LAYOUT_HEIGHT = 768;
const DEFAULT_SIDEBAR_WIDTH = 220;
const DEFAULT_AUXILIARYBAR_WIDTH = 380;
const DEFAULT_AGENT_SIDEBAR_WIDTH = 280;
const DEFAULT_PANEL_HEIGHT = 200;
const DEFAULT_PANEL_WIDTH = 300;
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
		readonly position: Position;
		readonly width: number;
		readonly height: number;
		readonly visible: boolean;
	};
}

export interface WorkbenchLayoutOptions {
	readonly initialDimension?: IDimension;
	readonly workbenchState: WorkbenchState;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly focus?: () => void;
}

/**
 * Owns the Workbench's fixed Part topology and mutable pixel layout state.
 *
 * Registered before Parts are created so overlays resolve the same container
 * owner throughout startup. Layout completion events follow Grid and Part layout.
 */
export class WorkbenchLayout
	extends BrowserLayoutService
	implements IWorkbenchLayoutService {
	private readonly views = new Map<WorkbenchPartId, WorkbenchPartView>();
	private grid!: SerializableGrid<WorkbenchPartView>;
	private readonly gridHandle = this._register(new MutableDisposable<SerializableGrid<WorkbenchPartView>>());
	private readonly gridChangeHandle = this._register(new MutableDisposable());
	private readonly stateModel: WorkbenchLayoutStateModel;
	private readonly initialDimension: IDimension;
	private readonly partVisibility = new Map<WorkbenchPartId, boolean>();
	private readonly _onDidChangePartVisibility = this._register(
		new Emitter<WorkbenchPartVisibilityChangeEvent>(),
	);
	private layoutStyle: WorkbenchLayoutStyle;
	private activityBarLocation: ActivityBarPosition;
	private sideBarLocation: SideBarLocation;
	private panelPosition: Position;
	private panelRestoredWidth = DEFAULT_PANEL_WIDTH;
	private panelRestoredHeight = DEFAULT_PANEL_HEIGHT;
	private readonly panelPositionEmitter = this._register(new Emitter<string>());
	readonly onDidChangePanelPosition = this.panelPositionEmitter.event;
	// Maximization is transient; retain the restored size on the Panel's current axis.
	private panelSizeBeforeMaximize: number | undefined;
	// The ordinary layout remains the persistence source while maximization temporarily hides its Parts.
	private auxiliaryBarRestoreState: { readonly layout: WorkbenchLayoutState; readonly editorVisible: boolean; } | undefined;
	private readonly auxiliaryBarMaximizedEmitter = this._register(new Emitter<void>());
	private readonly auxiliaryContainers = this._register(new DisposableMap<Window, DisposableStore>());
	private readonly auxiliaryWindows = new Map<Window, IAuxiliaryWindow>();
	private focusedContainer: HTMLElement | undefined;

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly onDidChangeAuxiliaryBarMaximized = this.auxiliaryBarMaximizedEmitter.event;
	readonly domNode: HTMLDivElement;

	public hasFocus(partId: WorkbenchPartId): boolean {
		return this.isPartVisible(partId) && isAncestorOfActiveElement(this.view(partId).part.domNode);
	}

	public getVisibleNeighborPart(partId: WorkbenchPartId, direction: Direction): WorkbenchPartId | undefined {
		return this.grid.getNeighborViews(this.view(partId), direction)
			.find(view => view.partId === 'editor' || view.partId === 'sidebar' || view.partId === 'panel' || view.partId === 'auxiliarybar' || view.partId === 'agentSidebar')?.partId;
	}

	/** Editor restoration follows the Workbench setting; Ash has no startup-file or temporary-workspace launch path. */
	shouldRestoreEditors(): boolean {
		return this.configurationService.getValue<boolean>('workbench.editor.restoreEditors') !== false;
	}

	constructor(
		container: HTMLElement,
		options: WorkbenchLayoutOptions,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAuxiliaryWindowService auxiliaryWindowService: IAuxiliaryWindowService,
	) {
		super({ root: container, focus: options.focus });
		this.layoutStyle = configurationService.getValue(WorkbenchConfiguration.layoutStyle);
		this.activityBarLocation = configurationService.getValue(WorkbenchConfiguration.activityBarLocation);
		this.sideBarLocation = configurationService.getValue(WorkbenchConfiguration.sideBarLocation);
		this.domNode = h(container.ownerDocument, "div");
		this.domNode.className = "ash-workbench-layout";
		this.domNode.classList.toggle('activitybar-absent', this.activityBarLocation !== ActivityBarPosition.DEFAULT);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.initialDimension = resolveInitialDimension(container, options.initialDimension);
		validateWorkbenchDefaultLayout(options.defaultLayout);
		this.stateModel = new WorkbenchLayoutStateModel(storageService, options.workbenchState, options.defaultLayout, positionFromString(configurationService.getValue(WorkbenchConfiguration.panelDefaultLocation)));
		const panel = this.stateModel.state.panel;
		this.panelPosition = panel.position;
		this.panelRestoredWidth = panel.width;
		this.panelRestoredHeight = panel.height;
		// Input can arrive before Electron's document focus notification. Capture it
		// at the window boundary before keybindings or titlebar actions choose a host.
		for (const event of ['focus', 'keydown', 'pointerdown'] as const) {
			this._register(addDisposableListener(getWindow(container), event, () => this.activateContainer(container), true));
		}
		this._register(addDisposableListener(container, 'focusin', () => this.activateContainer(container)));
		this._register(auxiliaryWindowService.onDidOpenWindow(window => this.trackAuxiliaryWindow(window)));
		this._register(toDisposable(() => {
			this.auxiliaryWindows.clear();
			this.focusedContainer = undefined;
		}));
	}

	override get activeContainer(): HTMLElement { return this.focusedContainer ?? this.mainContainer; }
	override get activeContainerDimension(): IDimension {
		return this.activeContainer === this.mainContainer ? this.mainContainerDimension : getClientArea(this.activeContainer);
	}
	override get containers(): Iterable<HTMLElement> {
		return [this.mainContainer, ...[...this.auxiliaryWindows.values()].map(window => window.container)];
	}
	override get activeContainerOffset(): ILayoutOffsetInfo {
		if (this.activeContainer === this.mainContainer) return this.mainContainerOffset;
		return { top: this.activeContainer.querySelector('.ash-auxiliary-titlebar')?.getBoundingClientRect().height ?? 0, quickInputTop: 0 };
	}
	override getContainer(targetWindow: Window): HTMLElement {
		return this.auxiliaryWindows.get(targetWindow)?.container ?? super.getContainer(targetWindow);
	}
	override whenContainerStylesLoaded(targetWindow: Window): Promise<void> | undefined {
		return this.auxiliaryWindows.get(targetWindow)?.whenStylesHaveLoaded ?? super.whenContainerStylesLoaded(targetWindow);
	}

	private activateContainer(container: HTMLElement): void {
		if (this.activeContainer === container) return;
		this.focusedContainer = container;
		this._onDidChangeActiveContainer.fire();
		this._onDidLayoutActiveContainer.fire(this.activeContainerDimension);
	}

	private trackAuxiliaryWindow(window: IAuxiliaryWindow): void {
		const resources = new DisposableStore();
		this.auxiliaryWindows.set(window.window, window);
		this.auxiliaryContainers.set(window.window, resources);
		for (const event of ['focus', 'keydown', 'pointerdown'] as const) {
			resources.add(addDisposableListener(window.window, event, () => this.activateContainer(window.container), true));
		}
		resources.add(addDisposableListener(window.container, 'focusin', () => this.activateContainer(window.container)));
		resources.add(window.onDidLayout(dimension => {
			this._onDidLayoutContainer.fire({ container: window.container, dimension });
			if (this.activeContainer === window.container) this._onDidLayoutActiveContainer.fire(dimension);
		}));
		resources.add(window.onDidClose(() => {
			this.auxiliaryWindows.delete(window.window);
			this.auxiliaryContainers.deleteAndDispose(window.window);
			if (this.activeContainer === window.container) this.activateContainer(this.mainContainer);
		}));
		if (window.window.document.hasFocus()) this.activateContainer(window.container);
	}

	/** Parts are assembled once, after container services and their dependencies have been registered. */
	createParts(parts: ReadonlyMap<WorkbenchPartId, Part>): void {
		validateParts(parts);
		for (const partId of workbenchPartIds) {
			this.views.set(
				partId,
				new WorkbenchPartView(partId, requiredPart(parts, partId), {
					snap: isSnappableWorkbenchPart(partId),
				}),
			);
		}
		const initialState = this.stateModel.state;
		this.domNode.dataset.panelPosition = positionToString(this.panelPosition);
		this.projectPartFrameInsets(
			initialState.sidebar.visible,
			initialState.auxiliarybar.visible,
			initialState.agentSidebar.visible,
			initialState.panel.visible,
		);
		this.grid = SerializableGrid.deserialize(
			this.domNode,
			createWorkbenchGridDescriptor(this.views, this.initialDimension, initialState, this.activityBarLocation, this.sideBarLocation),
			{ fromJSON: (data) => this.view(parseWorkbenchPartId(data)) },
			{
				sashPresentation: this.layoutStyle === "modern" ? { type: "inset", gap: PART_GUTTER_SIZE } : undefined,
				edgeSnapping: true,
			},
		);
		this.gridHandle.value = this.grid;
		this.grid.setViewVisible(this.view('statusbar'), this.configurationService.getValue<boolean>(WorkbenchConfiguration.statusBarVisible) !== false);
		this.gridChangeHandle.value = this.grid.onDidChange(() => {
			this.projectPartFrameInsets();
			this.publishPartVisibility();
		});
		this._register(this.storageService.onWillSaveState(() => this.saveState()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.panelDefaultLocation)) {
				this.stateModel.defaultPanelPosition = positionFromString(this.configurationService.getValue(WorkbenchConfiguration.panelDefaultLocation));
			}
			if (event.affectsConfiguration(WorkbenchConfiguration.statusBarVisible)) {
				this.grid.setViewVisible(this.view('statusbar'), this.configurationService.getValue<boolean>(WorkbenchConfiguration.statusBarVisible) !== false);
			}
			if (event.affectsConfiguration(WorkbenchConfiguration.activityBarLocation)) {
				this.setActivityBarLocation(this.configurationService.getValue(WorkbenchConfiguration.activityBarLocation));
			}
			if (event.affectsConfiguration(WorkbenchConfiguration.sideBarLocation)) {
				this.setSideBarLocation(this.configurationService.getValue(WorkbenchConfiguration.sideBarLocation));
			}
		}));
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

	setActivityBarLocation(location: ActivityBarPosition): void {
		if (this.activityBarLocation === location) return;
		this.activityBarLocation = location;
		this.domNode.classList.toggle('activitybar-absent', location !== ActivityBarPosition.DEFAULT);
		this.rebuildGrid();
	}

	setSideBarLocation(location: SideBarLocation): void {
		if (this.sideBarLocation === location) return;
		this.sideBarLocation = location;
		this.rebuildGrid();
	}

	getSideBarPosition(): Position {
		return this.sideBarLocation === 'left' ? Position.LEFT : Position.RIGHT;
	}

	getPanelPosition(): Position { return this.panelPosition; }

	setPanelPosition(position: Position): void {
		this.showPart('panel');
		if (this.panelPosition === position) return;
		const state = this.state;
		this.panelPosition = position;
		this.domNode.dataset.panelPosition = positionToString(position);
		if (this.panelSizeBeforeMaximize !== undefined) this.panelSizeBeforeMaximize = isHorizontal(position) ? state.panel.height : state.panel.width;
		this.rebuildGrid({ ...state, panel: { ...state.panel, position } });
		this.saveState();
		this.panelPositionEmitter.fire(positionToString(position));
	}

	private panelDimension(size: number): Dimension {
		const current = this.getPartSize('panel');
		return isHorizontal(this.panelPosition) ? new Dimension(current.width, size) : new Dimension(size, current.height);
	}

	private rebuildGrid(restoredState?: WorkbenchLayoutState): void {
		const focusedElement = this.domNode.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focusedElement && this.domNode.contains(focusedElement);
		const auxiliaryBarMaximized = this.isAuxiliaryBarMaximized();
		if (auxiliaryBarMaximized) this.setAuxiliaryBarMaximized(false);
		const state = restoredState ?? this.state;
		const editorVisible = this.isPartVisible('editor');
		const dimension = new Dimension(this.grid.width || getClientArea(this.domNode).width, this.grid.height || getClientArea(this.domNode).height);
		this.gridChangeHandle.clear();
		this.gridHandle.clear();
		this.grid = SerializableGrid.deserialize(
			this.domNode,
			createWorkbenchGridDescriptor(this.views, dimension, state, this.activityBarLocation, this.sideBarLocation, editorVisible),
			{ fromJSON: data => this.view(parseWorkbenchPartId(data)) },
			{ sashPresentation: this.layoutStyle === 'modern' ? { type: 'inset', gap: PART_GUTTER_SIZE } : undefined, edgeSnapping: true },
		);
		this.gridHandle.value = this.grid;
		this.grid.setViewVisible(this.view('statusbar'), this.configurationService.getValue<boolean>(WorkbenchConfiguration.statusBarVisible) !== false);
		this.gridChangeHandle.value = this.grid.onDidChange(() => {
			this.projectPartFrameInsets();
			this.publishPartVisibility();
		});
		this.layout(dimension);
		if (auxiliaryBarMaximized) this.setAuxiliaryBarMaximized(true);
		// Rebuilding the topology reparents surviving Parts and otherwise blurs their inputs.
		if (restoreFocus && focusedElement.isConnected) focusedElement.focus({ preventScroll: true });
	}

	/** Overlays can read offsets before Parts exist; the mounted Grid then owns titlebar geometry. */
	override get mainContainerOffset(): ILayoutOffsetInfo {
		if (!this.gridHandle.value) return { top: 0, quickInputTop: 0 };
		const titlebar = this.getPartSize("titlebar");
		return {
			top: this.isPartVisible("titlebar") ? titlebar.height : 0,
			quickInputTop: 0,
		};
	}

	override layout(dimension: IDimension = getClientArea(this.mainContainer)): void {
		assertDimension(dimension);
		this.projectPartFrameInsets();
		this.grid.layout(dimension.width, dimension.height);
		this.publishPartVisibility();
		super.layout(dimension);
	}

	get state(): WorkbenchLayoutState {
		if (this.auxiliaryBarRestoreState) return this.auxiliaryBarRestoreState.layout;
		const sidebar = this.getPartSize("sidebar");
		const auxiliarybar = this.getPartSize("auxiliarybar");
		const agentSidebar = this.getPartSize("agentSidebar");
		const panel = this.getPartSize("panel");
		if (isHorizontal(this.panelPosition)) this.panelRestoredHeight = this.panelSizeBeforeMaximize ?? panel.height;
		else this.panelRestoredWidth = this.panelSizeBeforeMaximize ?? panel.width;
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
				position: this.panelPosition,
				width: this.panelRestoredWidth,
				height: this.panelRestoredHeight,
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
		return !this.isAuxiliaryBarMaximized() && this.isPartVisible('panel') && !this.isPartVisible('editor');
	}

	public isAuxiliaryBarMaximized(): boolean {
		return this.auxiliaryBarRestoreState !== undefined;
	}

	public toggleMaximizedAuxiliaryBar(): void {
		this.setAuxiliaryBarMaximized(!this.isAuxiliaryBarMaximized());
	}

	public setAuxiliaryBarMaximized(maximized: boolean): boolean {
		if (maximized === this.isAuxiliaryBarMaximized()) return false;
		if (maximized) {
			const layout = this.state;
			const editorVisible = this.isPartVisible('editor');
			this.updatePartsVisibility(['auxiliarybar'], true);
			this.auxiliaryBarRestoreState = { layout, editorVisible };
			// Bypass Panel close/reopen policy: this is a temporary layout, not a user closing the Panel.
			this.updatePartsVisibility(['sidebar', 'agentSidebar', 'panel', 'editor'], false);
		} else {
			const restore = this.auxiliaryBarRestoreState!;
			this.auxiliaryBarRestoreState = undefined;
			for (const partId of ['editor', 'panel', 'sidebar', 'agentSidebar'] as const) {
				this.updatePartsVisibility([partId], partId === 'editor' ? restore.editorVisible : restore.layout[partId].visible);
			}
			for (const partId of ['sidebar', 'agentSidebar', 'auxiliarybar'] as const) {
				this.resizePart(partId, this.getPartSize(partId).with(restore.layout[partId].width));
			}
			if (restore.editorVisible) {
				this.resizePart('panel', this.panelDimension(isHorizontal(this.panelPosition) ? restore.layout.panel.height : restore.layout.panel.width));
			}
		}
		this.auxiliaryBarMaximizedEmitter.fire();
		return true;
	}

	toggleMaximizedPanel(): void {
		if (this.isPanelMaximized()) {
			this.showPart('editor');
		} else {
			this.showPart('panel');
			this.hidePart('editor');
		}
	}

	showPart(partId: WorkbenchPartId): void {
		this.showParts([partId]);
	}

	showParts(partIds: readonly WorkbenchPartId[]): void {
		if (partIds.some(partId => partId === 'editor' || partId === 'panel' || partId === 'sidebar' || partId === 'agentSidebar')) {
			this.setAuxiliaryBarMaximized(false);
		}
		const reopenMaximizedPanel = partIds.includes('panel') && !partIds.includes('editor') &&
			!this.isPartVisible('panel') && this.stateModel.panelWasLastMaximized;
		const panelSize = partIds.includes('editor') ? this.panelSizeBeforeMaximize : undefined;
		this.updatePartsVisibility(partIds, true);
		if (panelSize !== undefined) {
			this.resizePart('panel', this.panelDimension(panelSize));
			this.panelSizeBeforeMaximize = undefined;
		}
		if (reopenMaximizedPanel) {
			this.hidePart('editor');
		}
	}

	hidePart(partId: WorkbenchPartId): void {
		this.hideParts([partId]);
	}

	hideParts(partIds: readonly WorkbenchPartId[]): void {
		if (partIds.includes('auxiliarybar')) this.setAuxiliaryBarMaximized(false);
		if (partIds.includes('panel') && this.isPartVisible('panel')) {
			// Capture the closing state before restoring the editor and the ordinary Panel height.
			this.stateModel.panelWasLastMaximized = this.isPanelMaximized();
			if (this.isPanelMaximized()) {
				this.showPart('editor');
			}
		}
		if (partIds.includes('editor') && this.isPartVisible('editor') && this.isPartVisible('panel')) {
			const size = this.getPartSize('panel');
			this.panelSizeBeforeMaximize = isHorizontal(this.panelPosition) ? size.height : size.width;
		}
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
		this.setAuxiliaryBarMaximized(false);
		if (this.isPanelMaximized()) {
			this.toggleMaximizedPanel();
		}
		this.panelRestoredWidth = state.panel.width;
		this.panelRestoredHeight = state.panel.height;
		if (this.panelPosition !== state.panel.position) {
			this.panelPosition = state.panel.position;
			this.domNode.dataset.panelPosition = positionToString(this.panelPosition);
			this.rebuildGrid(state);
			this.panelPositionEmitter.fire(positionToString(this.panelPosition));
		}
		this.resizePart("sidebar", this.getPartSize("sidebar").with(state.sidebar.width));
		this.resizePart("auxiliarybar", this.getPartSize("auxiliarybar").with(state.auxiliarybar.width));
		this.resizePart("agentSidebar", this.getPartSize("agentSidebar").with(state.agentSidebar.width));
		this.resizePart("panel", this.panelDimension(isHorizontal(this.panelPosition) ? state.panel.height : state.panel.width));
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
		const activityBarBesideSidebar = this.activityBarLocation === ActivityBarPosition.DEFAULT;
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
		const panelLeft = panelVisible && this.panelPosition === Position.LEFT;
		const panelRight = panelVisible && this.panelPosition === Position.RIGHT;
		const panelTop = panelVisible && this.panelPosition === Position.TOP;
		const panelBottom = panelVisible && this.panelPosition === Position.BOTTOM;
		this.view("editor").setFrameInsets({
			top: panelTop ? metrics.partGutterHalf : 0,
			right: panelRight ? metrics.partGutterHalf : centralInsets.right,
			bottom: panelBottom ? metrics.partGutterHalf : 0,
			left: panelLeft ? metrics.partGutterHalf : centralInsets.left,
		});
		this.view("panel").setFrameInsets({
			top: panelBottom ? metrics.partGutterHalf : 0,
			right: panelLeft ? metrics.partGutterHalf : centralInsets.right,
			bottom: panelTop ? metrics.partGutterHalf : 0,
			left: panelRight ? metrics.partGutterHalf : centralInsets.left,
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
	parts: ReadonlyMap<WorkbenchPartId, Part>,
): void {
	const missing = workbenchPartIds.filter((partId) => !parts.has(partId));
	if (missing.length > 0) {
		throw new TypeError(
			`Workbench layout is missing Parts: ${missing.join(", ")}`,
		);
	}
}

function requiredPart(
	parts: ReadonlyMap<WorkbenchPartId, Part>,
	partId: WorkbenchPartId,
): Part {
	const part = parts.get(partId);
	if (!part) throw new Error(`Workbench Part is not registered: ${partId}`);
	return part;
}

function isSnappableWorkbenchPart(partId: WorkbenchPartId): boolean {
	// Auxiliary Bar resizing stops at its content minimum; explicit toggles own hiding it.
	return partId === "sidebar" ||
		partId === "agentSidebar" ||
		partId === "panel";
}

function createWorkbenchGridDescriptor(
	views: ReadonlyMap<WorkbenchPartId, WorkbenchPartView>,
	dimension: IDimension,
	state: WorkbenchLayoutState,
	activityBarLocation: ActivityBarPosition,
	sideBarLocation: SideBarLocation,
	editorVisible = true,
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
		bodyHeight - (state.panel.visible && isHorizontal(state.panel.position) ? panelHeight : 0),
	);
	const editorWidth = Math.max(
		0,
		dimension.width -
		(activityBarLocation === ActivityBarPosition.DEFAULT ? activitybarWidth : 0) -
		(state.sidebar.visible ? state.sidebar.width : 0) -
		(state.auxiliarybar.visible ? state.auxiliarybar.width : 0) -
		(state.agentSidebar.visible ? state.agentSidebar.width : 0),
	);
	const primary: SerializedGridDescriptor[] = sideBarLocation === 'left'
		? [leaf('activitybar', activitybarWidth, activityBarLocation === ActivityBarPosition.DEFAULT), leaf('sidebar', state.sidebar.width, state.sidebar.visible)]
		: [leaf('sidebar', state.sidebar.width, state.sidebar.visible), leaf('activitybar', activitybarWidth, activityBarLocation === ActivityBarPosition.DEFAULT)];
	const secondary: SerializedGridDescriptor[] = [
		leaf('auxiliarybar', state.auxiliarybar.width, state.auxiliarybar.visible),
		leaf('agentSidebar', state.agentSidebar.width, state.agentSidebar.visible),
	];
	const horizontalPanel = isHorizontal(state.panel.position);
	const editor = leaf('editor', horizontalPanel ? editorHeight : Math.max(0, editorWidth - (state.panel.visible ? state.panel.width : 0)), editorVisible, EDITOR_LAYOUT_PRIORITY);
	const panel = leaf('panel', horizontalPanel ? panelHeight : state.panel.width, state.panel.visible);
	const centralParts = state.panel.position === Position.TOP || state.panel.position === Position.LEFT ? [panel, editor] : [editor, panel];
	// Side panels are siblings in the horizontal body. Nesting another horizontal
	// branch would violate Grid's alternating-axis contract.
	const center: SerializedGridDescriptor[] = horizontalPanel ? [{
		type: 'branch', orientation: 'vertical', size: editorWidth, priority: EDITOR_LAYOUT_PRIORITY,
		children: centralParts,
	}] : centralParts;
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
				children: sideBarLocation === 'left' ? [...primary, ...center, ...secondary] : [...secondary.slice().reverse(), ...center, ...primary],
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
			position: Position.BOTTOM,
			width: DEFAULT_PANEL_WIDTH,
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
	if (isRecord(value.panel) && (
		(value.panel.position !== undefined && !isPanelPosition(value.panel.position)) ||
		(value.panel.width !== undefined && !isLayoutDimension(value.panel.width))
	)) {
		throw new TypeError("Workbench layout state is invalid or unsupported");
	}
	let panel: { readonly height: number; readonly visible: boolean; };
	let agentSidebar: { readonly width: number; readonly visible: boolean; };
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
			position: readPanelPosition(isRecord(value.panel) ? value.panel.position : undefined),
			width: isRecord(value.panel) && isLayoutDimension(value.panel.width) ? value.panel.width : DEFAULT_PANEL_WIDTH,
			height: panel.height,
			visible: panel.visible,
		},
	};
}

/** Bridges Workbench layout semantics to the generic scoped storage service. */
class WorkbenchLayoutStateModel {
	constructor(
		private readonly storageService: IStorageService,
		public workbenchState: WorkbenchState,
		private readonly defaultLayout: WorkbenchDefaultLayout | undefined,
		public defaultPanelPosition: Position,
	) { }

	get panelWasLastMaximized(): boolean {
		const key = WorkbenchLayoutStorageKeys.PANEL_WAS_LAST_MAXIMIZED;
		return this.storageService.getBoolean(key.key, key.scope, false);
	}

	set panelWasLastMaximized(maximized: boolean) {
		storeLayoutValue(this.storageService, WorkbenchLayoutStorageKeys.PANEL_WAS_LAST_MAXIMIZED, maximized);
	}

	get state(): WorkbenchLayoutState {
		const storage = this.storageService;
		const fallbackParts = {
			sidebar: this.workbenchState !== WorkbenchState.EMPTY,
			auxiliarybar: this.workbenchState !== WorkbenchState.EMPTY,
			agentSidebar: false,
			panel: false,
		} as const satisfies NonNullable<WorkbenchDefaultLayout["parts"]>;
		const defaults = this.shouldApplyDefaultLayout(storage)
			? createDefaultWorkbenchLayoutState({ ...fallbackParts, ...this.defaultLayout?.parts })
			: createDefaultWorkbenchLayoutState(fallbackParts);
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
				position: readPanelPosition(storage.getNumber(WorkbenchLayoutStorageKeys.PANEL_POSITION.key, WorkbenchLayoutStorageKeys.PANEL_POSITION.scope), this.defaultPanelPosition),
				width: storedDimension(storage.getNumber(WorkbenchLayoutStorageKeys.PANEL_WIDTH.key, WorkbenchLayoutStorageKeys.PANEL_WIDTH.scope), defaults.panel.width),
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

	private shouldApplyDefaultLayout(storage: IStorageService): boolean {
		return this.defaultLayout !== undefined &&
			(this.defaultLayout.force === true || storage.isNew(StorageScope.WORKSPACE));
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
		storeLayoutValue(storage, WorkbenchLayoutStorageKeys.PANEL_POSITION, state.panel.position);
		storeLayoutValue(storage, WorkbenchLayoutStorageKeys.PANEL_WIDTH, state.panel.width);
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
	PANEL_POSITION: { key: 'workbench.layout.panel.position', scope: StorageScope.WORKSPACE, target: StorageTarget.MACHINE },
	PANEL_WIDTH: { key: 'workbench.layout.panel.width', scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
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
	PANEL_WAS_LAST_MAXIMIZED: {
		key: 'workbench.layout.panel.wasLastMaximized',
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
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isHorizontalLayoutRegionState(
	value: unknown,
): value is { readonly width: number; readonly visible: boolean; } {
	return (
		isRecord(value) &&
		isLayoutDimension(value.width) &&
		typeof value.visible === "boolean"
	);
}

function isVerticalLayoutRegionState(
	value: unknown,
): value is { readonly height: number; readonly visible: boolean; } {
	return (
		isRecord(value) &&
		isLayoutDimension(value.height) &&
		typeof value.visible === "boolean"
	);
}

function isLayoutDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPanelPosition(value: unknown): value is Position {
	return value === Position.LEFT || value === Position.RIGHT || value === Position.BOTTOM || value === Position.TOP;
}

function readPanelPosition(value: unknown, fallback = Position.BOTTOM): Position {
	return isPanelPosition(value) ? value : fallback;
}
