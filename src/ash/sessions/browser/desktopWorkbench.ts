import { Dimension, getClientArea, h, type IDimension } from '../../base/browser/dom.js';
import type { IPositionedRectangle } from '../../base/browser/geometry.js';
import { SerializableGrid, type SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import { Emitter, type Event } from '../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { BrowserLayoutService, type ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { IFileSystemProvider } from '../../platform/files/common/fileSystemProviderService.js';
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
import { EDITOR_PART_MINIMUM_WIDTH } from './parts/editor/editorPartSizing.js';

/** Selects the desktop layout while the shared Workbench owns window services and Parts. */
export class DesktopWorkbench extends Workbench {
	constructor(options: IWorkbenchOptions, themes: ExtensionColorThemeService, storage: IStorageService & IDisposable, logger: LogService, userDataFiles: IFileSystemProvider & IDisposable) {
		super(DesktopWorkbenchLayout, options, themes, storage, logger, userDataFiles);
	}
}

/** Persisted, Sessions-owned dimensions and visibility for the dedicated window. */
export interface SessionsWorkbenchLayoutState {
	readonly version: 1;
	readonly sidebar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly auxiliarybar: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly editor: {
		readonly width: number;
		readonly visible: boolean;
	};
	readonly panel: {
		readonly height: number;
		readonly visible: boolean;
	};
}

function createDefaultSessionsWorkbenchLayoutState(policy: SessionsLayoutPolicy): SessionsWorkbenchLayoutState {
	const sizes = policy.getPartSizes();
	return {
		version: 1,
		sidebar: { width: sizes.sideBarSize, visible: true },
		auxiliarybar: { width: sizes.auxiliaryBarSize, visible: false },
		editor: { width: sizes.editorSize, visible: false },
		panel: { height: sizes.panelSize, visible: false },
	};
}

/** Bridges the Sessions layout schema to the generic scoped storage service. */
class SessionsWorkbenchLayoutStateModel {
	constructor(
		private readonly storageService: IStorageService,
		private readonly defaults: SessionsWorkbenchLayoutState,
	) { }

	get state(): SessionsWorkbenchLayoutState {
		const storage = this.storageService;
		return {
			version: 1,
			sidebar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.scope), this.defaults.sidebar.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.scope, this.defaults.sidebar.visible),
			},
			auxiliarybar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.scope), this.defaults.auxiliarybar.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.scope, this.defaults.auxiliarybar.visible),
			},
			editor: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.scope), this.defaults.editor.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.scope, this.defaults.editor.visible),
			},
			panel: {
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
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE, state.panel.visible);
	}
}

interface SessionsWorkbenchLayoutStorageKey {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
}

const SessionsWorkbenchLayoutStorageKeys = {
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

function storeLayoutValue(storage: IStorageService, key: SessionsWorkbenchLayoutStorageKey, value: number | boolean): void {
	storage.store(key.key, value, key.scope, key.target);
}

function storedDimension(value: number | undefined, fallback: number): number {
	return value !== undefined && value >= 0 ? value : fallback;
}

const SESSIONS_LAYOUT_PRIORITY = 'high' as const;
const DEFAULT_LAYOUT_WIDTH = 1_024;
const DEFAULT_LAYOUT_HEIGHT = 768;

function createSessionsWorkbenchGridDescriptor(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	dimension: IDimension,
	state: SessionsWorkbenchLayoutState,
	activityBarLocation: ActivityBarPosition = ActivityBarPosition.DEFAULT,
	primaryPart: 'sessions' | 'editor' = 'sessions',
): SerializedGridDescriptor {
	const leaf = (partId: SessionsPartId, size: number, visible = true, priority: 'normal' | 'high' = 'normal'): SerializedGridDescriptor => ({
		type: 'leaf',
		data: partId,
		size,
		visible,
		priority,
	});
	const titlebarHeight = requiredView(views, 'titlebar').minimumHeight;
	const bodyHeight = Math.max(0, dimension.height - titlebarHeight);
	const activityBarWidth = requiredView(views, 'activitybar').minimumWidth;
	const mainWidth = Math.max(0, dimension.width - (activityBarLocation === ActivityBarPosition.DEFAULT ? activityBarWidth : 0) - (state.sidebar.visible ? state.sidebar.width : 0));
	const editorPrimary = primaryPart === 'editor';
	const sidePaneWidth = editorPrimary ? (state.auxiliarybar.visible ? state.auxiliarybar.width : 0) : state.editor.visible ? state.editor.width : state.auxiliarybar.visible ? state.auxiliarybar.width : 0;
	const sessionsWidth = Math.max(0, mainWidth - sidePaneWidth);
	return {
		type: 'branch',
		orientation: 'vertical',
		size: dimension.height,
		priority: 'normal',
		children: [
			leaf('titlebar', titlebarHeight),
			{
				type: 'branch',
				orientation: 'horizontal',
				size: bodyHeight,
				priority: SESSIONS_LAYOUT_PRIORITY,
				children: [
					leaf('activitybar', activityBarWidth, activityBarLocation === ActivityBarPosition.DEFAULT),
					leaf('sidebar', state.sidebar.width, state.sidebar.visible),
					{
						type: 'branch',
						orientation: 'vertical',
						size: mainWidth,
						priority: SESSIONS_LAYOUT_PRIORITY,
						children: [
							{
								type: 'branch',
								orientation: 'horizontal',
								size: Math.max(0, bodyHeight - (state.panel.visible ? state.panel.height : 0)),
								priority: SESSIONS_LAYOUT_PRIORITY,
								children: [
									leaf('sessions', sessionsWidth, !editorPrimary, editorPrimary ? 'normal' : SESSIONS_LAYOUT_PRIORITY),
									leaf('editor', editorPrimary ? sessionsWidth : state.editor.visible ? state.editor.width : state.auxiliarybar.width, state.editor.visible || state.auxiliarybar.visible, editorPrimary ? SESSIONS_LAYOUT_PRIORITY : 'normal'),
									leaf('auxiliarybar', state.auxiliarybar.width, editorPrimary && state.auxiliarybar.visible),
								],
							},
							leaf('panel', state.panel.height, state.panel.visible),
						],
					},
				],
			},
		],
	};
}

function resolveSessionsInitialDimension(container: HTMLElement, dimension: IDimension | undefined): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) return new Dimension(dimension.width, dimension.height);
	}
	return new Dimension(container.clientWidth > 0 ? container.clientWidth : DEFAULT_LAYOUT_WIDTH, container.clientHeight > 0 ? container.clientHeight : DEFAULT_LAYOUT_HEIGHT);
}

function parseSessionsPartId(value: unknown): SessionsPartId {
	if (value === 'titlebar' || value === 'activitybar' || value === 'sidebar' || value === 'sessions' || value === 'editor' || value === 'auxiliarybar' || value === 'panel') return value;
	throw new TypeError('Sessions Grid contains an unknown Part');
}

function requiredView(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	partId: SessionsPartId,
): WorkbenchPartView<SessionsPartId> {
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
	constructor(partId: SessionsPartId, part: Part, private readonly isEditorPrimary: () => boolean, private readonly isLayoutDeferred: () => boolean, private readonly dockedMinimumWidth: () => number, private readonly compositionChanged: Event<void>) { super(partId, part); }
	public override get minimumWidth(): number {
		if (this.partId !== 'editor') { return super.minimumWidth; }
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, super.minimumWidth, this.isEditorPrimary() ? 0 : this.dockedMinimumWidth());
	}
	public override get onDidChange(): Event<void> { return this.partId === 'editor' ? this.compositionChanged : super.onDidChange; }
	public override get preferredWidth(): number | undefined {
		// Side-panel defaults and stored widths include the window frame insets.
		return this.partId === 'sidebar' || this.partId === 'auxiliarybar' ? this.part.preferredWidth : super.preferredWidth;
	}
	public get priority(): 'high' | 'normal' {
		return (this.partId === 'sessions' && !this.isEditorPrimary()) || (this.partId === 'editor' && this.isEditorPrimary()) ? 'high' : 'normal';
	}

	public override layout(bounds: IPositionedRectangle): void {
		// Page changes resize the Grid several times; sash drags still lay out Parts immediately.
		if (!this.isLayoutDeferred()) super.layout(bounds);
	}
}

export class DesktopWorkbenchLayout extends BrowserLayoutService implements IAgentWorkbenchLayoutService {
	private readonly views = new Map<SessionsPartId, SessionsWorkbenchPartView>();
	private grid!: SerializableGrid<SessionsWorkbenchPartView>;
	private partUpdateDepth = 0;
	private readonly unavailableParts = new Set<SessionsPartId>();
	private readonly desiredVisibility: { sessions: boolean; sidebar: boolean; auxiliarybar: boolean; editor: boolean; panel: boolean; };
	private titlebarHeight = 0;
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
	private primaryPart: 'sessions' | 'editor' = 'sessions';
	private get isDocked(): boolean { return this.primaryPart === 'sessions'; }

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly domNode: HTMLDivElement;

	constructor(container: HTMLElement, options: SessionsWorkbenchLayoutOptions, @IStorageService private readonly storageService: IStorageService) {
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
		this.stateModel = new SessionsWorkbenchLayoutStateModel(storageService, options.initialState ?? createDefaultSessionsWorkbenchLayoutState(this.layoutPolicy));
		const state = this.stateModel.state;
		this.sidePaneWidth = state.editor.width;
		this.detailsWidth = state.auxiliarybar.width;
		this.conversationWidth = storageService.getNumber('sessions.layout.conversation.width', StorageScope.PROFILE, 420);
		const primaryPart = storageService.get('sessions.layout.primaryPart', StorageScope.PROFILE, 'sessions');
		if (primaryPart !== 'sessions' && primaryPart !== 'editor') { throw new TypeError('Saved primary Part is invalid.'); }
		this.primaryPart = primaryPart;
		if (primaryPart === 'editor') { this.unavailableParts.add('sessions'); }
		this.desiredVisibility = { sessions: true, sidebar: state.sidebar.visible, auxiliarybar: state.auxiliarybar.visible, editor: state.editor.visible, panel: state.panel.visible };
		this._register(storageService.onWillSaveState(() => this.saveState()));
	}

	public createWorkbenchLayout(parts: ReadonlyMap<SessionsPartId, Part>): void {
		validateParts(parts);
		if (this.grid) {
			throw new Error('Sessions Parts are already attached');
		}
		for (const partId of sessionsPartIds) {
			this.views.set(partId, new SessionsWorkbenchPartView(partId, requiredPart(parts, partId), () => this.primaryPart === 'editor', () => this.partUpdateDepth > 0, () => {
				const editorWidth = this.desiredVisibility.editor && !this.unavailableParts.has('editor') ? requiredPart(parts, 'editor').minimumWidth : 0;
				const detailsWidth = this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar') ? requiredPart(parts, 'auxiliarybar').minimumWidth : 0;
				return editorWidth + detailsWidth + this.layoutPolicy.getFrameMetrics(this.layoutStyle).rightEdge;
			}, this.compositionChanged.event));
		}
		this.titlebarHeight = this.view('titlebar').minimumHeight;
		this._register(requiredPart(parts, 'editor').onDidChangeConstraints(() => this.compositionChanged.fire()));
		this._register(this.view('activitybar').part.onDidChangeConstraints(() => this.projectFrameInsets()));
		const state = this.stateModel.state;
		this.projectFrameInsets(state.auxiliarybar.visible);
		this.grid = this._register(SerializableGrid.deserialize(
			this.domNode,
			createSessionsWorkbenchGridDescriptor(this.views, this.initialDimension, state, this.activityBarLocation, this.primaryPart),
			{ fromJSON: data => this.view(parseSessionsPartId(data)) },
		));
		this._register(this.grid.onDidChange(() => {
			if (this.partUpdateDepth === 0) {
				if (!this.isDocked && this.grid.isViewVisible(this.view('auxiliarybar'))) { this.detailsWidth = this.grid.getViewSize(this.view('auxiliarybar')).width; }
				if (!this.isDocked && this.grid.isViewVisible(this.view('sessions')) && this.grid.isViewVisible(this.view('editor'))) { this.conversationWidth = this.grid.getViewSize(this.view('sessions')).width; }
				this.saveState();
			}
		}));
		this.dockedAuxiliaryBar = this._register(new DockedAuxiliaryBarController(
			requiredPart(parts, 'editor') as EditorPart,
			this.view('auxiliarybar'),
			() => this.detailsWidth,
			width => this.resizePart('auxiliarybar', new Dimension(Math.min(460, Math.max(180, width)), this.getPartSize('auxiliarybar').height)),
		));
		// Save before the Grid is disposed; hidden views retain their cached user sizes.
		this._register(toDisposable(() => this.saveState()));
	}

	override get mainContainerOffset(): ILayoutOffsetInfo {
		return { top: this.titlebarHeight, quickInputTop: 0 };
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
				height: this.getPartSize('panel').height,
				visible: this.desiredVisibility.panel,
			},
		};
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
		this.grid.setViewVisible(this.view('activitybar'), location === ActivityBarPosition.DEFAULT);
		if (this.grid.width > 0 && this.grid.height > 0) this.layout(new Dimension(this.grid.width, this.grid.height));
		else this.publishPartVisibility();
	}

	override layout(dimension: IDimension = getClientArea(this.mainContainer)): void {
		assertDimension(dimension);
		this.grid.layout(dimension.width, dimension.height);
		if (this.partUpdateDepth > 0) return;
		if (this.isDocked && this.desiredVisibility.editor && this.grid.isViewVisible(this.view('editor'))) {
			this.sidePaneWidth = this.grid.getViewSize(this.view('editor')).width;
		}
		if (!this.isDocked && this.grid.isViewVisible(this.view('sessions')) && this.grid.isViewVisible(this.view('editor'))) {
			this.conversationWidth = this.grid.getViewSize(this.view('sessions')).width;
		}
		const editorSize = this.grid.getViewSize(this.view('editor'));
		this.dockedAuxiliaryBar.layout(this.view('editor').getContentSize(editorSize), this.isDocked, this.desiredVisibility.editor && !this.unavailableParts.has('editor'), this.desiredVisibility.auxiliarybar && !this.unavailableParts.has('auxiliarybar'));
		this.publishPartVisibility();
		// Overlay consumers observe completed Part and nested Chat geometry.
		super.layout(dimension);
		// Reload can precede the periodic storage save; commit only the completed Part arrangement.
		this.saveState();
	}

	/** Editor and panel changes share one geometry commit when several Parts change together. */
	public updateParts(update: () => void): void {
		this.partUpdateDepth++;
		try {
			update();
		} finally {
			this.partUpdateDepth--;
			if (this.partUpdateDepth === 0) {
				// Restore the supporting width after all centers are visible; an isolated visible leaf must fill its branch.
				if (!this.isDocked && this.grid.isViewVisible(this.view('sessions')) && this.grid.isViewVisible(this.view('editor'))) {
					this.grid.resizeView(this.view('sessions'), new Dimension(this.conversationWidth, this.grid.getViewSize(this.view('sessions')).height));
				}
				this.layout(new Dimension(this.grid.width, this.grid.height));
			}
		}
	}

	public setPrimaryPart(partId: 'sessions' | 'editor'): void {
		if (partId === this.primaryPart) { return; }
		this.primaryPart = partId;
		this.compositionChanged.fire();
		if (this.isDocked) { this.updateDockedVisibility(); }
		else {
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
	isPartAvailable(partId: SessionsPartId): boolean { return !this.unavailableParts.has(partId); }
	showPart(partId: SessionsPartId): void { this.updatePartVisibility(partId, true); }
	hidePart(partId: SessionsPartId): void { this.updatePartVisibility(partId, false); }
	getPartSize(partId: SessionsPartId): Dimension {
		if (this.isDocked && partId === 'auxiliarybar') {
			return new Dimension(this.detailsWidth, this.grid.getViewSize(this.view('editor')).height);
		}
		const size = this.grid.getViewSize(this.view(partId));
		return new Dimension(size.width, size.height);
	}
	resizePart(partId: SessionsPartId, dimension: IDimension): void {
		assertDimension(dimension);
		if (partId === 'auxiliarybar') { this.detailsWidth = dimension.width; }
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
		if (partId === 'titlebar' || partId === 'activitybar' || partId === 'sessions') throw new Error(`Required Sessions Part cannot be hidden: ${partId}`);
		this.desiredVisibility[partId] = visible;
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
			if (available && !this.isDocked) { this.grid.resizeView(this.view('sessions'), new Dimension(this.conversationWidth, this.grid.getViewSize(this.view('sessions')).height)); }
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

	private saveState(): void {
		this.stateModel.save(this.state);
		this.storageService.store('sessions.layout.conversation.width', this.conversationWidth, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.storageService.store('sessions.layout.primaryPart', this.primaryPart, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private projectFrameInsets(auxiliarybarVisible = this.isPartVisible('auxiliarybar')): void {
		const { leftEdge, rightEdge } = this.layoutPolicy.getFrameMetrics(this.layoutStyle);
		this.view('titlebar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		// The leading menu and side navigation share a center line in both density modes.
		this.view('titlebar').part.domNode.style.setProperty('--ash-sessions-titlebar-leading-width', `${this.view('activitybar').part.minimumWidth}px`);
		this.view('activitybar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		this.view('panel').setFrameInsets({ top: 0, right: rightEdge, bottom: rightEdge, left: 0 });
		const sidebarVisible = this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar');
		const editorVisible = this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const sessionsVisible = !this.unavailableParts.has('sessions');
		const contentLeftEdge = this.activityBarLocation === ActivityBarPosition.DEFAULT ? 0 : leftEdge;
		this.view('sidebar').setFrameInsets({ top: 0, right: 0, bottom: rightEdge, left: contentLeftEdge });
		this.view('sessions').setFrameInsets({ top: 0, right: auxiliarybarVisible || editorVisible ? 0 : rightEdge, bottom: rightEdge, left: sidebarVisible ? 0 : contentLeftEdge });
		this.view('auxiliarybar').setFrameInsets({ top: 0, right: rightEdge, bottom: rightEdge, left: 0 });
		this.view('editor').setFrameInsets({ top: 0, right: this.isDocked || !auxiliarybarVisible ? rightEdge : 0, bottom: rightEdge, left: !sidebarVisible && !sessionsVisible ? contentLeftEdge : 0 });
		const mainPart: SessionsPartId = sessionsVisible ? 'sessions' : 'editor';
		const firstPart = sidebarVisible ? 'sidebar' : mainPart;
		let lastPart: SessionsPartId = mainPart;
		if (editorVisible) lastPart = 'editor';
		if (auxiliarybarVisible) lastPart = this.isDocked ? 'editor' : 'auxiliarybar';
		for (const partId of ['sidebar', 'sessions', 'editor', 'auxiliarybar'] as const) {
			this.view(partId).part.domNode.classList.toggle('ash-sessions-frame-start', partId === firstPart);
			this.view(partId).part.domNode.classList.toggle('ash-sessions-frame-end', partId === lastPart);
		}
		// One decorative outline spans the retained Parts; it never intercepts their input or sashes.
		const activityBarWidth = this.activityBarLocation === ActivityBarPosition.DEFAULT ? this.view('activitybar').minimumWidth : 0;
		this.cardDomNode.style.top = `${this.titlebarHeight}px`;
		this.cardDomNode.style.left = `${activityBarWidth + contentLeftEdge}px`;
		this.cardDomNode.style.right = `${rightEdge}px`;
		this.cardDomNode.style.bottom = `${rightEdge}px`;
	}

	private publishPartVisibility(): void {
		for (const partId of sessionsPartIds) {
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
