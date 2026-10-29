import { Dimension, getClientArea, h, type IDimension } from '../../base/browser/dom.js';
import type { IPositionedRectangle } from '../../base/browser/geometry.js';
import { SerializableGrid, type SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../base/common/event.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { BrowserLayoutService, type ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import { DEFAULT_EMPTY_WINDOW_SIZE } from '../../platform/window/common/window.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { IFileSystemProvider } from '../../platform/files/common/files.js';
import type { LogService } from '../../platform/log/common/logServiceImpl.js';
import type { Part } from '../../workbench/browser/part.js';
import { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';
import type { ExtensionColorThemeService } from '../../workbench/services/extensions/browser/extensionColorThemeService.js';
import type { EditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import type { SessionsLayoutStyle } from '../common/configuration.js';
import { sessionsPartIds, type SessionsPartId } from '../common/layoutConstants.js';
import { Workbench, type IWorkbenchOptions, type IAgentWorkbenchLayoutService, type SessionsPartVisibilityChangeEvent } from './workbench.js';
import { SessionsLayoutPolicy } from './layoutPolicy.js';
import { DockedAuxiliaryBarController } from './dockedAuxiliaryBarController.js';
import { EDITOR_PART_DEFAULT_WIDTH, EDITOR_PART_MINIMUM_WIDTH } from './parts/editorPartSizing.js';
import { Position, isHorizontal, positionToString } from '../../workbench/services/layout/browser/layoutService.js';

/** Selects the desktop layout while the shared Workbench owns window services and Parts. */
export class DesktopWorkbench extends Workbench {
	constructor(options: IWorkbenchOptions, themes: ExtensionColorThemeService, storage: IStorageService & IDisposable, logger: LogService, userDataFiles: IFileSystemProvider & IDisposable) {
		super(DesktopWorkbenchLayout, options, themes, storage, logger, userDataFiles);
	}
}

/** Persisted, Sessions-owned dimensions and visibility for the dedicated window. */
export interface SessionsWorkbenchLayoutState {
	readonly version: 1;
	readonly sidebar: { readonly width: number; readonly visible: boolean };
	readonly auxiliarybar: { readonly width: number; readonly visible: boolean };
	readonly editor: { readonly width: number; readonly visible: boolean };
	readonly panel: {
		readonly position: Position;
		readonly width: number;
		readonly height: number;
		readonly visible: boolean;
	};
}

function createDefaultSessionsWorkbenchLayoutState(policy: SessionsLayoutPolicy, dimension: IDimension): SessionsWorkbenchLayoutState {
	const sizes = policy.getPartSizes(dimension.width, dimension.height);
	const visibility = policy.getPartVisibilityDefaults();
	return {
		version: 1,
		sidebar: { width: sizes.sideBarSize, visible: visibility.sidebar },
		auxiliarybar: { width: sizes.auxiliaryBarSize, visible: visibility.auxiliaryBar },
		editor: { width: EDITOR_PART_DEFAULT_WIDTH, visible: visibility.editor },
		panel: {
			position: Position.BOTTOM,
			width: sizes.panelSize,
			height: sizes.panelSize,
			visible: visibility.panel,
		},
	};
}

/** Bridges the Sessions layout schema to the generic scoped storage service. */
class SessionsWorkbenchLayoutStateModel {
	constructor(
		private readonly storageService: IStorageService,
		private readonly defaults: SessionsWorkbenchLayoutState,
	) {}

	get state(): SessionsWorkbenchLayoutState {
		const storage = this.storageService;
		return {
			version: 1,
			sidebar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.scope), this.defaults.sidebar.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.scope, this.defaults.sidebar.visible),
			},
			auxiliarybar: {
				width: storedDimension(
					storage.getNumber(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.scope),
					this.defaults.auxiliarybar.width,
				),
				visible: storage.getBoolean(
					SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.key,
					SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.scope,
					this.defaults.auxiliarybar.visible,
				),
			},
			editor: {
				width: storedEditorWidth(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.scope), this.defaults.editor.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.scope, this.defaults.editor.visible),
			},
			panel: {
				position: storedPanelPosition(
					storage.get(SessionsWorkbenchLayoutStorageKeys.PANEL_POSITION.key, SessionsWorkbenchLayoutStorageKeys.PANEL_POSITION.scope),
					this.defaults.panel.position,
				),
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.PANEL_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.PANEL_WIDTH.scope), this.defaults.panel.width),
				height: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT.key, SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT.scope), this.defaults.panel.height),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE.scope, this.defaults.panel.visible),
			},
		};
	}

	save(state: SessionsWorkbenchLayoutState): void {
		const storage = this.storageService;
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH, state.sidebar.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE, state.sidebar.visible);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH, state.auxiliarybar.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE, state.auxiliarybar.visible);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH, state.editor.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE, state.editor.visible);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT, state.panel.height);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_WIDTH, state.panel.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_POSITION, positionToString(state.panel.position));
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE, state.panel.visible);
	}
}

interface SessionsWorkbenchLayoutStorageKey {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
}

const SessionsWorkbenchLayoutStorageKeys = {
	PANEL_POSITION: {
		key: 'sessions.layout.panel.position',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	PANEL_WIDTH: {
		key: 'sessions.layout.panel.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	PANEL_HEIGHT: {
		key: 'sessions.layout.panel.height',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	PANEL_VISIBLE: {
		key: 'sessions.layout.panel.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	EDITOR_WIDTH: {
		key: 'sessions.layout.editor.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	EDITOR_VISIBLE: {
		key: 'sessions.layout.editor.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	SIDEBAR_WIDTH: {
		key: 'sessions.layout.sidebar.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	SIDEBAR_VISIBLE: {
		key: 'sessions.layout.sidebar.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_WIDTH: {
		key: 'sessions.layout.auxiliarybar.width',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_VISIBLE: {
		key: 'sessions.layout.auxiliarybar.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
} as const satisfies Record<string, SessionsWorkbenchLayoutStorageKey>;

function storeLayoutValue(storage: IStorageService, key: SessionsWorkbenchLayoutStorageKey, value: number | boolean | string): void {
	storage.store(key.key, value, key.scope, key.target);
}

function storedDimension(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function storedEditorWidth(value: number | undefined, fallback: number): number {
	// Widths captured while the editor was hidden are not a usable restore size.
	return value !== undefined && Number.isFinite(value) && value >= EDITOR_PART_MINIMUM_WIDTH ? value : fallback;
}

function storedPanelPosition(value: string | undefined, fallback: Position): Position {
	switch (value) {
		case 'left':
			return Position.LEFT;
		case 'right':
			return Position.RIGHT;
		case 'bottom':
			return Position.BOTTOM;
		case 'top':
			return Position.TOP;
		default:
			return fallback;
	}
}

const SESSIONS_LAYOUT_PRIORITY = 'high' as const;

function createSessionsWorkbenchGridDescriptor(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	dimension: IDimension,
	state: SessionsWorkbenchLayoutState,
	primaryPart: 'sessions' | 'editor' = 'sessions',
	bannerVisible = false,
): SerializedGridDescriptor {
	const leaf = (partId: SessionsPartId, size: number, visible = true, priority: 'normal' | 'high' = 'normal'): SerializedGridDescriptor => ({
		type: 'leaf',
		data: partId,
		size,
		visible,
		priority,
	});
	const titlebarHeight = requiredView(views, 'titlebar').minimumHeight;
	const bannerHeight = requiredView(views, 'banner').minimumHeight;
	const bodyHeight = Math.max(0, dimension.height - titlebarHeight - (bannerVisible ? bannerHeight : 0));
	const mainWidth = Math.max(0, dimension.width - (state.sidebar.visible ? state.sidebar.width : 0));
	const editorPrimary = primaryPart === 'editor';
	const horizontalPanel = isHorizontal(state.panel.position);
	const panelSize = horizontalPanel ? state.panel.height : state.panel.width;
	const contentWidth = Math.max(0, mainWidth - (!horizontalPanel && state.panel.visible ? panelSize : 0));
	const contentHeight = Math.max(0, bodyHeight - (horizontalPanel && state.panel.visible ? panelSize : 0));
	const sidePaneWidth = editorPrimary
		? state.auxiliarybar.visible
			? state.auxiliarybar.width
			: 0
		: state.editor.visible
			? state.editor.width
			: state.auxiliarybar.visible
				? state.auxiliarybar.width
				: 0;
	const sessionsWidth = Math.max(0, contentWidth - sidePaneWidth);
	const content: SerializedGridDescriptor = {
		type: 'branch',
		orientation: 'horizontal',
		size: horizontalPanel ? contentHeight : contentWidth,
		priority: SESSIONS_LAYOUT_PRIORITY,
		children: [
			leaf('sessions', sessionsWidth, !editorPrimary, editorPrimary ? 'normal' : SESSIONS_LAYOUT_PRIORITY),
			...(views.has('customview') ? [leaf('customview', sessionsWidth, false, SESSIONS_LAYOUT_PRIORITY)] : []),
			leaf(
				'editor',
				editorPrimary ? sessionsWidth : state.editor.visible ? state.editor.width : state.auxiliarybar.width,
				state.editor.visible || state.auxiliarybar.visible,
				editorPrimary ? SESSIONS_LAYOUT_PRIORITY : 'normal',
			),
			leaf('auxiliarybar', state.auxiliarybar.width, editorPrimary && state.auxiliarybar.visible),
		],
	};
	const panel = leaf('panel', panelSize, state.panel.visible);
	const leadingPanel = state.panel.position === Position.TOP || state.panel.position === Position.LEFT;
	const mainChildren: SerializedGridDescriptor[] = horizontalPanel
		? [
				{
					type: 'branch',
					orientation: 'vertical',
					size: mainWidth,
					priority: SESSIONS_LAYOUT_PRIORITY,
					children: leadingPanel ? [panel, content] : [content, panel],
				},
			]
		: leadingPanel
			? [panel, ...content.children]
			: [...content.children, panel];
	return {
		type: 'branch',
		orientation: 'vertical',
		size: dimension.height,
		priority: 'normal',
		children: [
			leaf('titlebar', titlebarHeight),
			leaf('banner', bannerHeight, bannerVisible),
			{
				type: 'branch',
				orientation: 'horizontal',
				size: bodyHeight,
				priority: SESSIONS_LAYOUT_PRIORITY,
				children: [leaf('sidebar', state.sidebar.width, state.sidebar.visible), ...mainChildren],
			},
		],
	};
}

function resolveSessionsInitialDimension(container: HTMLElement, dimension: IDimension | undefined): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) return new Dimension(dimension.width, dimension.height);
	}
	return new Dimension(container.clientWidth > 0 ? container.clientWidth : DEFAULT_EMPTY_WINDOW_SIZE.width, container.clientHeight > 0 ? container.clientHeight : DEFAULT_EMPTY_WINDOW_SIZE.height);
}

function parseSessionsPartId(value: unknown): SessionsPartId {
	if (value === 'customview') return value;
	if (value === 'titlebar' || value === 'banner' || value === 'sidebar' || value === 'sessions' || value === 'editor' || value === 'auxiliarybar' || value === 'panel') return value;
	throw new TypeError('Sessions Grid contains an unknown Part');
}

function requiredView(views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>, partId: SessionsPartId): WorkbenchPartView<SessionsPartId> {
	const view = views.get(partId);
	if (!view) throw new Error(`Sessions Part view is not registered: ${partId}`);
	return view;
}

function assertDimension(dimension: IDimension): void {
	if (!Number.isFinite(dimension.width) || dimension.width < 0 || !Number.isFinite(dimension.height) || dimension.height < 0) {
		throw new RangeError('Sessions layout dimensions must be non-negative and finite');
	}
}

export interface SessionsWorkbenchLayoutOptions {
	readonly initialDimension?: IDimension;
	readonly initialState?: SessionsWorkbenchLayoutState;
	readonly focus?: () => void;
	readonly layoutStyle?: SessionsLayoutStyle;
	readonly activityBarLocation?: ActivityBarPosition;
}

/** Owns the fixed Part topology and mutable geometry of one dedicated Sessions window. */
class SessionsWorkbenchPartView extends WorkbenchPartView<SessionsPartId> {
	constructor(
		partId: SessionsPartId,
		part: Part,
		private readonly isEditorPrimary: () => boolean,
		private readonly isLayoutDeferred: () => boolean,
		private readonly dockedMinimumWidth: () => number,
		private readonly compositionChanged: Event<void>,
		private readonly isPanelMaximized: () => boolean,
		private readonly titlebar: Part & { readonly minimumSidebarWidth?: number },
	) {
		super(partId, part, { snap: partId === 'sidebar' });
	}
	public override get minimumWidth(): number {
		if (this.partId === 'sidebar') return Math.max(super.minimumWidth, this.titlebar.minimumSidebarWidth ?? 0);
		if (this.partId !== 'editor') {
			return super.minimumWidth;
		}
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, super.minimumWidth, this.isEditorPrimary() ? 0 : this.dockedMinimumWidth());
	}
	public override get onDidChange(): Event<void> {
		if (this.partId === 'sidebar') return Event.any(super.onDidChange, this.titlebar.onDidChangeConstraints);
		return this.partId === 'editor' ? this.compositionChanged : super.onDidChange;
	}
	public override get preferredWidth(): number | undefined {
		// Side-panel defaults and stored widths include the window frame insets.
		return this.partId === 'sidebar' || this.partId === 'auxiliarybar' ? this.part.preferredWidth : super.preferredWidth;
	}
	public get priority(): 'high' | 'normal' {
		return this.partId === 'customview' ||
			(this.partId === 'sessions' && !this.isEditorPrimary()) ||
			(this.partId === 'editor' && this.isEditorPrimary()) ||
			(this.partId === 'panel' && this.isPanelMaximized())
			? 'high'
			: 'normal';
	}

	public override layout(bounds: IPositionedRectangle): void {
		// Page changes resize the Grid several times; sash drags still lay out Parts immediately.
		if (!this.isLayoutDeferred()) super.layout(bounds);
	}
}

export class DesktopWorkbenchLayout extends BrowserLayoutService implements IAgentWorkbenchLayoutService {
	private readonly views = new Map<SessionsPartId, SessionsWorkbenchPartView>();
	private grid!: SerializableGrid<SessionsWorkbenchPartView>;
	private readonly gridHandle = this._register(new MutableDisposable<SerializableGrid<SessionsWorkbenchPartView>>());
	private readonly gridChangeHandle = this._register(new MutableDisposable<IDisposable>());
	private readonly dockedHandle = this._register(new MutableDisposable<DockedAuxiliaryBarController>());
	private partUpdateDepth = 0;
	private readonly unavailableParts = new Set<SessionsPartId>();
	private readonly desiredVisibility: {
		banner: boolean;
		sessions: boolean;
		sidebar: boolean;
		auxiliarybar: boolean;
		editor: boolean;
		panel: boolean;
	};
	private get titlebarHeight(): number {
		return this.views.get('titlebar')?.minimumHeight ?? 0;
	}
	private readonly initialDimension: Dimension;
	private readonly stateModel: SessionsWorkbenchLayoutStateModel;
	private readonly partVisibility = new Map<SessionsPartId, boolean>();
	private readonly _onDidChangePartVisibility = this._register(new Emitter<SessionsPartVisibilityChangeEvent>());
	private readonly compositionChanged = this._register(new Emitter<void>());
	private layoutStyle: SessionsLayoutStyle;
	private activityBarLocation: ActivityBarPosition;
	private readonly layoutPolicy = new SessionsLayoutPolicy();
	private readonly cardDomNode: HTMLDivElement;
	private dockedAuxiliaryBar!: DockedAuxiliaryBarController;
	private sidePaneWidth: number;
	private detailsWidth: number;
	private conversationWidth: number;
	private panelPosition: Position;
	private panelWidth: number;
	private panelHeight: number;
	private panelMaximized = false;
	private readonly panelPositionChanged = this._register(new Emitter<string>());
	readonly onDidChangePanelPosition = this.panelPositionChanged.event;
	private primaryPart: 'sessions' | 'editor' = 'sessions';
	private customViewVisible = false;
	private get isDocked(): boolean {
		return this.primaryPart === 'sessions';
	}

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly domNode: HTMLDivElement;

	constructor(
		container: HTMLElement,
		options: SessionsWorkbenchLayoutOptions,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super({ root: container, focus: options.focus });
		this.initialDimension = resolveSessionsInitialDimension(container, options.initialDimension);
		this.layoutStyle = options.layoutStyle ?? 'modern';
		this.activityBarLocation = options.activityBarLocation ?? ActivityBarPosition.DEFAULT;
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-sessions-workbench-layout';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.cardDomNode = h(container.ownerDocument, 'div');
		this.cardDomNode.className = 'ash-sessions-content-card';
		this.cardDomNode.setAttribute('aria-hidden', 'true');
		this.domNode.append(this.cardDomNode);
		this.stateModel = new SessionsWorkbenchLayoutStateModel(storageService, options.initialState ?? createDefaultSessionsWorkbenchLayoutState(this.layoutPolicy, this.initialDimension));
		const state = this.stateModel.state;
		this.panelPosition = state.panel.position;
		this.panelWidth = state.panel.width;
		this.panelHeight = state.panel.height;
		this.domNode.dataset.panelPosition = positionToString(this.panelPosition);
		this.sidePaneWidth = state.editor.width;
		this.detailsWidth = state.auxiliarybar.width;
		this.conversationWidth = storageService.getNumber('sessions.layout.conversation.width', StorageScope.PROFILE, 420);
		const primaryPart = storageService.get('sessions.layout.primaryPart', StorageScope.PROFILE, 'sessions');
		if (primaryPart !== 'sessions' && primaryPart !== 'editor') {
			throw new TypeError('Saved primary Part is invalid.');
		}
		this.primaryPart = primaryPart;
		if (primaryPart === 'editor') {
			this.unavailableParts.add('sessions');
		}
		this.desiredVisibility = {
			banner: false,
			sessions: true,
			sidebar: state.sidebar.visible,
			auxiliarybar: state.auxiliarybar.visible,
			editor: state.editor.visible,
			panel: state.panel.visible,
		};
		this._register(storageService.onWillSaveState(() => this.saveState()));
	}

	public createWorkbenchLayout(parts: ReadonlyMap<SessionsPartId, Part>): void {
		validateParts(parts);
		if (this.grid) {
			throw new Error('Sessions Parts are already attached');
		}
		for (const partId of parts.keys()) {
			this.views.set(
				partId,
				new SessionsWorkbenchPartView(
					partId,
					requiredPart(parts, partId),
					() => this.primaryPart === 'editor',
					() => this.partUpdateDepth > 0,
					() => {
						const editorWidth = this.desiredVisibility.editor && !this.unavailableParts.has('editor') ? requiredPart(parts, 'editor').minimumWidth : 0;
						const detailsWidth = this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar') ? requiredPart(parts, 'auxiliarybar').minimumWidth : 0;
						return editorWidth + detailsWidth + this.layoutPolicy.getFrameMetrics(this.layoutStyle).rightEdge;
					},
					this.compositionChanged.event,
					() => this.panelMaximized,
					requiredPart(parts, 'titlebar'),
				),
			);
		}
		this._register(requiredPart(parts, 'editor').onDidChangeConstraints(() => this.compositionChanged.fire()));
		const state = this.stateModel.state;
		this.projectFrameInsets(state.auxiliarybar.visible);
		this.rebuildGrid(state, this.initialDimension);
		this._register(
			this.view('titlebar').part.onDidChangeConstraints(() => {
				// Grid follows Part constraints; overlays and the decorative frame need the same new offset.
				this.projectFrameInsets();
				if (this.grid.width > 0 && this.grid.height > 0) this.layout(new Dimension(this.grid.width, this.grid.height));
			}),
		);
		// Save before the Grid is disposed; hidden views retain their cached user sizes.
		this._register(toDisposable(() => this.saveState()));
	}

	override get mainContainerOffset(): ILayoutOffsetInfo {
		return {
			top: this.titlebarHeight + (this.grid && this.isPartVisible('banner') ? this.getPartSize('banner').height : 0),
			quickInputTop: 0,
		};
	}

	get state(): SessionsWorkbenchLayoutState {
		return {
			version: 1,
			sidebar: { width: this.getPartSize('sidebar').width, visible: this.desiredVisibility.sidebar },
			auxiliarybar: {
				// The same user width survives independent and docked hosts, including hidden Grid caches.
				width: this.detailsWidth,
				visible: this.desiredVisibility.auxiliarybar,
			},
			editor: {
				width: this.sidePaneWidth,
				visible: this.desiredVisibility.editor,
			},
			panel: {
				position: this.panelPosition,
				width: this.panelWidth,
				height: this.panelHeight,
				visible: this.desiredVisibility.panel,
			},
		};
	}

	getPanelPosition(): Position {
		return this.panelPosition;
	}

	getSideBarPosition(): Position {
		return Position.LEFT;
	}

	setPanelPosition(position: Position): void {
		if (position === this.panelPosition) return;
		const state = this.state;
		const dimension = new Dimension(this.grid.width, this.grid.height);
		this.panelPosition = position;
		this.domNode.dataset.panelPosition = positionToString(position);
		this.rebuildGrid({ ...state, panel: { ...state.panel, position } }, dimension);
		this.layout(dimension);
		this.panelPositionChanged.fire(positionToString(position));
	}

	isPanelMaximized(): boolean {
		return this.panelMaximized && this.isPartVisible('panel');
	}

	toggleMaximizedPanel(): void {
		if (this.customViewVisible || this.unavailableParts.has('panel')) return;
		this.panelMaximized = !this.panelMaximized;
		this.desiredVisibility.panel = true;
		this.restorePartVisibility();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private rebuildGrid(state: SessionsWorkbenchLayoutState, dimension: IDimension): void {
		const focused = this.mainContainer.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.mainContainer.contains(focused);
		// The details controller retains a Grid parent. Release that mount before
		// replacing the topology, then bind it to the new parent of the same Part.
		this.dockedHandle.clear();
		this.gridChangeHandle.clear();
		this.gridHandle.clear();
		this.grid = SerializableGrid.deserialize(
			this.domNode,
			createSessionsWorkbenchGridDescriptor(this.views, dimension, state, this.primaryPart, this.desiredVisibility.banner),
			{ fromJSON: data => this.view(parseSessionsPartId(data)) },
			{ edgeSnapping: true },
		);
		this.gridHandle.value = this.grid;
		this.dockedAuxiliaryBar = new DockedAuxiliaryBarController(
			this.view('editor').part as EditorPart,
			this.view('auxiliarybar'),
			() => this.detailsWidth,
			width => {
				const details = this.view('auxiliarybar');
				const constrainedWidth = Math.min(details.maximumWidth, Math.max(details.minimumWidth, width));
				this.resizePart('auxiliarybar', new Dimension(constrainedWidth, this.getPartSize('auxiliarybar').height));
			},
		);
		this.dockedHandle.value = this.dockedAuxiliaryBar;
		this.restorePartVisibility();
		this.gridChangeHandle.value = this.grid.onDidChange(() => {
			if (this.partUpdateDepth === 0) {
				// Sash snapping changes Grid visibility directly; retain it across page changes and reloads.
				if (!this.unavailableParts.has('sidebar')) this.desiredVisibility.sidebar = this.grid.isViewVisible(this.view('sidebar'));
				if (!this.isDocked && this.grid.isViewVisible(this.view('auxiliarybar'))) this.detailsWidth = this.grid.getViewSize(this.view('auxiliarybar')).width;
				if (!this.isDocked && this.grid.isViewVisible(this.view('sessions')) && this.grid.isViewVisible(this.view('editor')))
					this.conversationWidth = this.grid.getViewSize(this.view('sessions')).width;
				this.capturePanelSize();
				this.projectFrameInsets();
				this.updateTitlebarSurface();
				this.publishPartVisibility();
				this.saveState();
			}
		});
		if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
	}

	private restorePartVisibility(): void {
		this.partUpdateDepth++;
		try {
			for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) {
				this.grid.setViewVisible(this.view(id), this.desiredVisibility[id] && !this.unavailableParts.has(id));
			}
			if (this.isDocked) this.updateDockedVisibility();
			if (this.customViewVisible) this.applyCustomViewVisibility();
			else if (this.panelMaximized) {
				for (const id of ['sessions', 'editor', 'auxiliarybar'] as const) this.grid.setViewVisible(this.view(id), false);
			}
			const size = this.grid.getViewSize(this.view('panel'));
			if (!this.panelMaximized)
				this.grid.resizeView(this.view('panel'), isHorizontal(this.panelPosition) ? new Dimension(size.width, this.panelHeight) : new Dimension(this.panelWidth, size.height));
		} finally {
			this.partUpdateDepth--;
		}
	}

	private capturePanelSize(): void {
		if (!this.grid.isViewVisible(this.view('panel')) || this.panelMaximized || this.customViewVisible) return;
		const size = this.grid.getViewSize(this.view('panel'));
		if (isHorizontal(this.panelPosition)) this.panelHeight = size.height;
		else this.panelWidth = size.width;
	}

	setLayoutStyle(style: SessionsLayoutStyle): void {
		if (this.layoutStyle === style) return;
		this.layoutStyle = style;
		this.projectFrameInsets();
		if (this.grid.width > 0 && this.grid.height > 0) {
			this.layout(new Dimension(this.grid.width, this.grid.height));
		}
	}

	setActivityBarLocation(location: ActivityBarPosition): void {
		if (this.activityBarLocation === location) return;
		this.activityBarLocation = location;
		this.projectFrameInsets();
		if (this.grid.width > 0 && this.grid.height > 0) this.layout(new Dimension(this.grid.width, this.grid.height));
		else this.publishPartVisibility();
	}

	override layout(dimension: IDimension = getClientArea(this.mainContainer)): void {
		assertDimension(dimension);
		if (this.customViewVisible) this.applyCustomViewVisibility();
		else if (this.panelMaximized) {
			for (const id of ['sessions', 'editor', 'auxiliarybar'] as const) this.grid.setViewVisible(this.view(id), false);
		}
		this.projectFrameInsets();
		this.grid.layout(dimension.width, dimension.height);
		this.updateTitlebarSurface();
		if (this.partUpdateDepth > 0) return;
		if (this.isDocked && this.desiredVisibility.editor && this.grid.isViewVisible(this.view('editor'))) {
			this.sidePaneWidth = this.grid.getViewSize(this.view('editor')).width;
		}
		if (!this.isDocked && this.grid.isViewVisible(this.view('sessions')) && this.grid.isViewVisible(this.view('editor'))) {
			this.conversationWidth = this.grid.getViewSize(this.view('sessions')).width;
		}
		const editorSize = this.grid.getViewSize(this.view('editor'));
		this.dockedAuxiliaryBar.layout(
			this.view('editor').getContentSize(editorSize),
			this.isDocked,
			this.desiredVisibility.editor && !this.unavailableParts.has('editor'),
			this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar'),
		);
		this.publishPartVisibility();
		this.capturePanelSize();
		// Overlay consumers observe completed Part and nested Chat geometry.
		super.layout(dimension);
		// Reload can precede the periodic storage save; commit only the completed Part arrangement.
		this.saveState();
	}

	/** Editor and panel changes share one geometry commit when several Parts change together. */
	public updateParts(update: () => void): void {
		const sidebarSize = this.getPartSize('sidebar');
		this.partUpdateDepth++;
		try {
			update();
		} finally {
			try {
				if (this.partUpdateDepth === 1) {
					// Restore the supporting width after all centers are visible; an isolated visible leaf must fill its branch.
					if (!this.isDocked && this.grid.isViewVisible(this.view('sessions')) && this.grid.isViewVisible(this.view('editor'))) {
						this.grid.resizeView(this.view('sessions'), new Dimension(this.conversationWidth, this.grid.getViewSize(this.view('sessions')).height));
					}
					// Replacing the only center temporarily lets navigation absorb its space.
					// Keep the user's width, including its hidden cache, until the composition is complete.
					this.grid.resizeView(this.view('sidebar'), sidebarSize);
				}
			} finally {
				this.partUpdateDepth--;
				if (this.partUpdateDepth === 0) {
					this.layout(new Dimension(this.grid.width, this.grid.height));
				}
			}
		}
	}

	public setPrimaryPart(partId: 'sessions' | 'editor'): void {
		if (partId === this.primaryPart) {
			return;
		}
		this.primaryPart = partId;
		this.compositionChanged.fire();
		if (this.isDocked) {
			this.updateDockedVisibility();
		} else {
			// Product editors keep their own side views even when the shared conversation is present.
			this.grid.setViewVisible(this.view('editor'), this.desiredVisibility.editor && !this.unavailableParts.has('editor'));
			this.grid.setViewVisible(this.view('auxiliarybar'), this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar'));
			this.grid.resizeView(this.view('auxiliarybar'), new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('auxiliarybar')).height));
			this.grid.resizeView(this.view('sessions'), new Dimension(this.conversationWidth, this.grid.getViewSize(this.view('sessions')).height));
		}
		this.projectFrameInsets();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	isPartVisible(partId: SessionsPartId): boolean {
		if (this.isDocked && (partId === 'editor' || partId === 'auxiliarybar')) {
			return this.desiredVisibility[partId] && !this.unavailableParts.has(partId) && this.grid.isViewVisible(this.view('editor'));
		}
		return this.grid.isViewVisible(this.view(partId));
	}
	isPartAvailable(partId: SessionsPartId): boolean {
		return !this.unavailableParts.has(partId);
	}
	showPart(partId: SessionsPartId): void {
		this.updatePartVisibility(partId, true);
	}
	hidePart(partId: SessionsPartId): void {
		this.updatePartVisibility(partId, false);
	}
	getPartSize(partId: SessionsPartId): Dimension {
		if (this.isDocked && partId === 'auxiliarybar') {
			return new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('editor')).height);
		}
		const size = this.grid.getViewSize(this.view(partId));
		return new Dimension(size.width, size.height);
	}
	resizePart(partId: SessionsPartId, dimension: IDimension): void {
		assertDimension(dimension);
		if (partId === 'panel' && !this.panelMaximized) {
			if (isHorizontal(this.panelPosition)) this.panelHeight = dimension.height;
			else this.panelWidth = dimension.width;
		}
		if (partId === 'auxiliarybar') {
			this.detailsWidth = dimension.width;
		}
		if (this.isDocked && partId === 'auxiliarybar') {
			if (!this.desiredVisibility.editor) this.grid.resizeView(this.view('editor'), new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('editor')).height));
			this.layout(new Dimension(this.grid.width, this.grid.height));
			return;
		}
		if (this.isDocked && partId === 'editor') this.sidePaneWidth = dimension.width;
		this.grid.resizeView(this.view(partId), dimension);
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private updatePartVisibility(partId: SessionsPartId, visible: boolean): void {
		if (partId === 'customview') {
			this.setCustomViewVisible(visible);
			return;
		}
		if (partId === 'titlebar' || partId === 'sessions') throw new Error(`Required Sessions Part cannot be hidden: ${partId}`);
		this.desiredVisibility[partId] = visible;
		if (partId === 'panel' && !visible && this.panelMaximized) {
			this.panelMaximized = false;
			this.restorePartVisibility();
		}
		if (this.isDocked && (partId === 'editor' || partId === 'auxiliarybar')) {
			this.updateDockedVisibility();
		} else {
			this.grid.setViewVisible(this.view(partId), visible && !this.unavailableParts.has(partId));
		}
		this.projectFrameInsets();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	public setPartAvailable(partId: 'sessions' | 'sidebar' | 'auxiliarybar' | 'editor' | 'panel', available: boolean): void {
		if (available === !this.unavailableParts.has(partId)) {
			return;
		}
		if (partId === 'sessions') {
			if (available) this.unavailableParts.delete(partId);
			else this.unavailableParts.add(partId);
			this.grid.setViewVisible(this.view('sessions'), available);
			if (available && !this.isDocked) {
				this.grid.resizeView(this.view('sessions'), new Dimension(this.conversationWidth, this.grid.getViewSize(this.view('sessions')).height));
			}
			if (this.isDocked) {
				this.updateDockedVisibility();
			} else {
				this.grid.setViewVisible(this.view('editor'), this.desiredVisibility.editor && !this.unavailableParts.has('editor'));
				this.grid.setViewVisible(this.view('auxiliarybar'), this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar'));
				this.grid.resizeView(this.view('auxiliarybar'), new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('auxiliarybar')).height));
			}
		} else if (this.isDocked && (partId === 'editor' || partId === 'auxiliarybar')) {
			if (available) this.unavailableParts.delete(partId);
			else this.unavailableParts.add(partId);
			this.updateDockedVisibility();
		} else if (available) {
			// The outgoing center absorbs the restored center's cached width before priorities switch.
			this.grid.setViewVisible(this.view(partId), this.desiredVisibility[partId]);
			this.unavailableParts.delete(partId);
		} else {
			this.unavailableParts.add(partId);
			this.grid.setViewVisible(this.view(partId), false);
		}
		if (partId === 'panel' && !available && this.panelMaximized) {
			this.panelMaximized = false;
			this.restorePartVisibility();
		}
		this.projectFrameInsets();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private updateDockedVisibility(): void {
		const editorVisible = this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const detailsVisible = this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar');
		this.compositionChanged.fire();
		this.grid.setViewVisible(this.view('auxiliarybar'), false);
		this.grid.setViewVisible(this.view('editor'), editorVisible || detailsVisible);
		if (editorVisible || detailsVisible) {
			this.grid.resizeView(this.view('editor'), new Dimension(editorVisible ? this.sidePaneWidth : this.detailsWidth, this.grid.getViewSize(this.view('editor')).height));
		}
	}

	/** Independent pages retain their underlying layout and may keep its workspace navigation visible. */
	public setCustomViewVisible(visible: boolean): void {
		if (visible === this.customViewVisible) return;
		this.customViewVisible = visible;
		if (visible) this.applyCustomViewVisibility();
		else {
			this.grid.setViewVisible(this.view('customview'), false);
			for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) {
				this.grid.setViewVisible(this.view(id), this.desiredVisibility[id] && !this.unavailableParts.has(id));
			}
			if (this.isDocked) this.updateDockedVisibility();
		}
		this.projectFrameInsets();
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}
	private applyCustomViewVisibility(): void {
		this.grid.setViewVisible(this.view('customview'), true);
		for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) {
			this.grid.setViewVisible(this.view(id), id === 'sidebar' && this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar'));
		}
	}

	private saveState(): void {
		this.stateModel.save(this.state);
		this.storageService.store('sessions.layout.conversation.width', this.conversationWidth, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.storageService.store('sessions.layout.primaryPart', this.primaryPart, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private projectFrameInsets(auxiliarybarVisible = this.isPartVisible('auxiliarybar')): void {
		const { leftEdge, rightEdge } = this.layoutPolicy.getFrameMetrics(this.layoutStyle);
		const panelVisible = !this.customViewVisible && this.desiredVisibility.panel && !this.unavailableParts.has('panel');
		this.domNode.dataset.panelVisible = String(panelVisible);
		this.domNode.dataset.panelMaximized = String(this.panelMaximized);
		const contentBottom = panelVisible && this.panelPosition === Position.BOTTOM ? 0 : rightEdge;
		const contentRight = panelVisible && this.panelPosition === Position.RIGHT ? 0 : rightEdge;
		this.view('titlebar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		const sidebarVisible = this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar');
		const editorVisible = !this.customViewVisible && this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const sessionsVisible = !this.customViewVisible && !this.unavailableParts.has('sessions');
		const contentLeftEdge = this.activityBarLocation === ActivityBarPosition.DEFAULT ? 0 : leftEdge;
		const panelLeftEdge = sidebarVisible ? 0 : contentLeftEdge;
		this.view('panel').setFrameInsets({
			top: 0,
			right: !this.panelMaximized && this.panelPosition === Position.LEFT ? 0 : rightEdge,
			bottom: !this.panelMaximized && this.panelPosition === Position.TOP ? 0 : rightEdge,
			left: !this.panelMaximized && this.panelPosition === Position.RIGHT ? 0 : panelLeftEdge,
		});
		const contentLeft = sidebarVisible || (panelVisible && this.panelPosition === Position.LEFT) ? 0 : contentLeftEdge;
		this.view('sidebar').setFrameInsets({ top: 0, right: 0, bottom: rightEdge, left: contentLeftEdge });
		this.view('sessions').setFrameInsets({
			top: 0,
			right: auxiliarybarVisible || editorVisible ? 0 : contentRight,
			bottom: contentBottom,
			left: contentLeft,
		});
		this.view('auxiliarybar').setFrameInsets({ top: 0, right: contentRight, bottom: contentBottom, left: 0 });
		this.view('editor').setFrameInsets({
			top: 0,
			right: this.isDocked || !auxiliarybarVisible ? contentRight : 0,
			bottom: contentBottom,
			left: !sessionsVisible ? contentLeft : 0,
		});
		if (this.views.has('customview'))
			this.view('customview').setFrameInsets({
				top: 0,
				right: rightEdge,
				bottom: rightEdge,
				left: sidebarVisible ? 0 : contentLeftEdge,
			});
		const mainPart: SessionsPartId = this.customViewVisible ? 'customview' : sessionsVisible ? 'sessions' : 'editor';
		const firstPart = sidebarVisible ? 'sidebar' : panelVisible && (this.panelMaximized || this.panelPosition === Position.LEFT) ? 'panel' : mainPart;
		let lastPart: SessionsPartId = mainPart;
		if (editorVisible) lastPart = 'editor';
		if (auxiliarybarVisible) lastPart = this.isDocked ? 'editor' : 'auxiliarybar';
		if (panelVisible && (this.panelMaximized || this.panelPosition === Position.RIGHT)) lastPart = 'panel';
		for (const partId of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel', ...(this.views.has('customview') ? ['customview' as const] : [])] as const) {
			const horizontalPanel = partId === 'panel' && panelVisible && isHorizontal(this.panelPosition);
			this.view(partId).part.domNode.classList.toggle('ash-sessions-frame-start', partId === firstPart || (horizontalPanel && !sidebarVisible));
			this.view(partId).part.domNode.classList.toggle('ash-sessions-frame-end', partId === lastPart || horizontalPanel);
		}
		// One decorative outline spans the retained Parts; it never intercepts their input or sashes.
		this.cardDomNode.style.top = `${this.mainContainerOffset.top}px`;
		this.cardDomNode.style.left = `${contentLeftEdge}px`;
		this.cardDomNode.style.right = `${rightEdge}px`;
		this.cardDomNode.style.bottom = `${rightEdge}px`;
	}

	private updateTitlebarSurface(): void {
		const width = this.grid.isViewVisible(this.view('sidebar')) ? this.grid.getViewSize(this.view('sidebar')).width : 0;
		this.view('titlebar').part.domNode.style.setProperty('--ash-sessions-titlebar-sidebar-width', `${width}px`);
	}

	private publishPartVisibility(): void {
		for (const partId of this.views.keys()) {
			const visible = this.isPartVisible(partId);
			if (this.partVisibility.get(partId) === visible) continue;
			this.partVisibility.set(partId, visible);
			this._onDidChangePartVisibility.fire({ partId, visible });
		}
	}

	private view(partId: SessionsPartId): SessionsWorkbenchPartView {
		const view = this.views.get(partId);
		if (!view) throw new Error(`Unknown Sessions Part: ${partId}`);
		return view;
	}
}

function validateParts(parts: ReadonlyMap<SessionsPartId, Part>): void {
	const missing = sessionsPartIds.filter(partId => !parts.has(partId));
	if (missing.length > 0) throw new TypeError(`Sessions layout is missing Parts: ${missing.join(', ')}`);
}

function requiredPart(parts: ReadonlyMap<SessionsPartId, Part>, partId: SessionsPartId): Part {
	const part = parts.get(partId);
	if (!part) throw new Error(`Sessions Part is not registered: ${partId}`);
	return part;
}
