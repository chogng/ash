import { Orientation, type IBoundarySashes } from '../../base/browser/ui/sash/sash.js';
import { LayoutPriority } from '../../base/browser/ui/splitview/splitview.js';
import { Dimension, h, type IDimension } from '../../base/browser/dom.js';
import type { IPositionedRectangle } from '../../base/browser/geometry.js';
import {
	SerializableGrid,
	type ISerializableView,
	type SerializedGridDescriptor,
} from '../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../base/common/event.js';
import { combinedDisposable, MutableDisposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import {
	BrowserLayoutService,
	getContainerDimension,
	type ILayoutOffsetInfo,
} from '../../platform/layout/browser/layoutService.js';
import { DEFAULT_EMPTY_WINDOW_SIZE } from '../../platform/window/common/window.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { IFileSystemProvider } from '../../platform/files/common/files.js';
import type { LogService } from '../../platform/log/common/logServiceImpl.js';
import type { Part } from '../../workbench/browser/part.js';
import { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';
import { ActivityBarPosition } from '../../workbench/common/configuration.js';
import type { ExtensionColorThemeService } from '../../workbench/services/extensions/browser/extensionColorThemeService.js';
import type { SessionsLayoutStyle } from '../common/configuration.js';
import { sessionsPartIds, type SessionsPartId } from '../common/layoutConstants.js';
import {
	Workbench,
	type IWorkbenchOptions,
	type IAgentWorkbenchLayoutService,
	type SessionsPartVisibilityChangeEvent,
} from './workbench.js';
import { SessionsLayoutPolicy } from './layoutPolicy.js';
import { EDITOR_PART_DEFAULT_WIDTH, EDITOR_PART_MINIMUM_WIDTH } from './parts/editorPartSizing.js';
import { Position } from '../../workbench/services/layout/browser/layoutService.js';

/** Selects the desktop layout while the shared Workbench owns window services and Parts. */
export class DesktopWorkbench extends Workbench {
	constructor(
		options: IWorkbenchOptions,
		themes: ExtensionColorThemeService,
		storage: IStorageService & IDisposable,
		logger: LogService,
		userDataFiles: IFileSystemProvider & IDisposable,
	) {
		super(DesktopWorkbenchLayout, options, themes, storage, logger, userDataFiles);
	}
}

/** Persisted, Sessions-owned dimensions and visibility for the dedicated window. */
export interface SessionsWorkbenchLayoutState {
	readonly version: 1;
	readonly sidebar: { readonly width: number; readonly visible: boolean; };
	readonly auxiliarybar: { readonly width: number; readonly visible: boolean; };
	readonly editor: { readonly width: number; readonly visible: boolean; };

}

function createDefaultSessionsWorkbenchLayoutState(
	policy: SessionsLayoutPolicy,
	dimension: IDimension,
): SessionsWorkbenchLayoutState {
	const sizes = policy.getPartSizes(dimension.width, dimension.height);
	const visibility = policy.getPartVisibilityDefaults();
	return {
		version: 1,
		sidebar: { width: sizes.sideBarSize, visible: visibility.sidebar },
		auxiliarybar: { width: sizes.auxiliaryBarSize, visible: visibility.auxiliaryBar },
		editor: { width: EDITOR_PART_DEFAULT_WIDTH, visible: visibility.editor },
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
				width: storedDimension(
					storage.getNumber(
						SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.key,
						SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.scope,
					),
					this.defaults.sidebar.width,
				),
				visible: storage.getBoolean(
					SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.key,
					SessionsWorkbenchLayoutStorageKeys.SIDEBAR_VISIBLE.scope,
					this.defaults.sidebar.visible,
				),
			},
			auxiliarybar: {
				width: storedDimension(
					storage.getNumber(
						SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.key,
						SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.scope,
					),
					this.defaults.auxiliarybar.width,
				),
				visible: storage.getBoolean(
					SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.key,
					SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.scope,
					this.defaults.auxiliarybar.visible,
				),
			},
			editor: {
				width: storedEditorWidth(
					storage.getNumber(
						SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.key,
						SessionsWorkbenchLayoutStorageKeys.EDITOR_WIDTH.scope,
					),
					this.defaults.editor.width,
				),
				visible: storage.getBoolean(
					SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.key,
					SessionsWorkbenchLayoutStorageKeys.EDITOR_VISIBLE.scope,
					this.defaults.editor.visible,
				),
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
	}
}

interface SessionsWorkbenchLayoutStorageKey {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
}

const SessionsWorkbenchLayoutStorageKeys = {
	EDITOR_WIDTH: { key: 'sessions.layout.editor.width', scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
	EDITOR_VISIBLE: {
		key: 'sessions.layout.editor.visible',
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	SIDEBAR_WIDTH: { key: 'sessions.layout.sidebar.width', scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
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

function storeLayoutValue(
	storage: IStorageService,
	key: SessionsWorkbenchLayoutStorageKey,
	value: number | boolean | string,
): void {
	storage.store(key.key, value, key.scope, key.target);
}

function storedDimension(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function storedEditorWidth(value: number | undefined, fallback: number): number {
	// Widths captured while the editor was hidden are not a usable restore size.
	return value !== undefined && Number.isFinite(value) && value >= EDITOR_PART_MINIMUM_WIDTH ? value : fallback;
}

const SESSIONS_LAYOUT_PRIORITY = LayoutPriority.High;

function createSessionsWorkbenchGridDescriptor(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	dimension: IDimension,
	state: SessionsWorkbenchLayoutState,
	primaryPart: 'sessions' | 'editor' = 'sessions',
): SerializedGridDescriptor {
	const leaf = (
		partId: SessionsPartId,
		size: number,
		visible = true,
		priority: LayoutPriority = LayoutPriority.Normal,
	): SerializedGridDescriptor => ({ type: 'leaf', data: partId, size, visible, priority });
	const titlebarHeight = requiredView(views, 'titlebar').minimumHeight;
	const bodyHeight = Math.max(0, dimension.height - titlebarHeight);
	const mainWidth = Math.max(0, dimension.width - (state.sidebar.visible ? state.sidebar.width : 0));
	const editorPrimary = primaryPart === 'editor';
	const contentWidth = mainWidth;
	const contentHeight = bodyHeight;
	const sidePaneWidth =
		(state.editor.visible && !editorPrimary ? state.editor.width : 0) +
		(state.auxiliarybar.visible ? state.auxiliarybar.width : 0);
	const sessionsWidth = Math.max(0, contentWidth - sidePaneWidth);
	const content: SerializedGridDescriptor = {
		type: 'branch',
		orientation: Orientation.HORIZONTAL,
		size: contentHeight,
		priority: SESSIONS_LAYOUT_PRIORITY,
		children: [
			leaf('sessions', sessionsWidth, !editorPrimary, editorPrimary ? LayoutPriority.Normal : SESSIONS_LAYOUT_PRIORITY),
			...(views.has('customview') ? [leaf('customview', sessionsWidth, false, SESSIONS_LAYOUT_PRIORITY)] : []),
			leaf(
				'editor',
				editorPrimary ? sessionsWidth : state.editor.width,
				state.editor.visible,
				editorPrimary ? SESSIONS_LAYOUT_PRIORITY : LayoutPriority.Normal,
			),
			leaf('auxiliarybar', state.auxiliarybar.width, state.auxiliarybar.visible),
		],
	};
	return {
		type: 'branch',
		orientation: Orientation.VERTICAL,
		size: dimension.height,
		priority: LayoutPriority.Normal,
		children: [
			leaf('titlebar', titlebarHeight),
			{
				type: 'branch',
				orientation: Orientation.HORIZONTAL,
				size: bodyHeight,
				priority: SESSIONS_LAYOUT_PRIORITY,
				children: [leaf('sidebar', state.sidebar.width, state.sidebar.visible), ...content.children],
			},
		],
	};
}

function resolveSessionsInitialDimension(container: HTMLElement, dimension: IDimension | undefined): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) return new Dimension(dimension.width, dimension.height);
	}
	const measured = getContainerDimension(container);
	return new Dimension(
		measured.width > 0 ? measured.width : DEFAULT_EMPTY_WINDOW_SIZE.width,
		measured.height > 0 ? measured.height : DEFAULT_EMPTY_WINDOW_SIZE.height,
	);
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
	if (
		!Number.isFinite(dimension.width) ||
		dimension.width < 0 ||
		!Number.isFinite(dimension.height) ||
		dimension.height < 0
	) {
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

/** Adapts retained Workbench Parts to the window Grid. */
class SessionsWorkbenchPartView extends WorkbenchPartView<SessionsPartId> {
	private boundarySashes: IBoundarySashes = {};
	constructor(
		partId: SessionsPartId,
		part: Part,
		private readonly isEditorPrimary: () => boolean,
		private readonly isLayoutDeferred: () => boolean,
		private readonly compositionChanged: Event<void>,
		private readonly titlebar: Part & { readonly minimumSidebarWidth?: number; },
	) {
		super(partId, part, { snap: partId === 'sidebar' });
	}
	public override get minimumWidth(): number {
		if (this.partId === 'sidebar') return Math.max(super.minimumWidth, this.titlebar.minimumSidebarWidth ?? 0);
		if (this.partId !== 'editor') {
			return super.minimumWidth;
		}
		return Math.max(EDITOR_PART_MINIMUM_WIDTH, super.minimumWidth);
	}
	public override get onDidChange(): Event<void> {
		if (this.partId === 'sidebar') return Event.any(super.onDidChange, this.titlebar.onDidChangeConstraints);
		return this.partId === 'editor' ? this.compositionChanged : super.onDidChange;
	}
	public override get preferredWidth(): number | undefined {
		// Side-panel defaults and stored widths include the window frame insets.
		return this.partId === 'sidebar' || this.partId === 'auxiliarybar'
			? this.part.preferredWidth
			: super.preferredWidth;
	}
	public get priority(): LayoutPriority {
		return this.partId === 'customview' ||
			(this.partId === 'sessions' && !this.isEditorPrimary()) ||
			(this.partId === 'editor' && this.isEditorPrimary())
			? LayoutPriority.High
			: LayoutPriority.Normal;
	}

	public override layout(bounds: IPositionedRectangle): void {
		// Page changes resize the Grid several times; sash drags still lay out Parts immediately.
		if (!this.isLayoutDeferred()) super.layout(bounds);
		this.updateFeedbackOffsets();
	}

	public override setBoundarySashes(sashes: IBoundarySashes): void {
		super.setBoundarySashes(sashes);
		this.boundarySashes = sashes;
		this.updateFeedbackOffsets();
	}

	private updateFeedbackOffsets(): void {
		// Outer boundaries continue through the titlebar, above the body Grid's drag area.
		const offset = -this.titlebar.minimumHeight / 2;
		this.boundarySashes.left?.setFeedbackOffset(offset);
		this.boundarySashes.right?.setFeedbackOffset(offset);
	}
}

export class DesktopWorkbenchLayout
	extends BrowserLayoutService
	implements IAgentWorkbenchLayoutService {
	private readonly views = new Map<SessionsPartId, SessionsWorkbenchPartView>();
	private grid!: SerializableGrid<ISerializableView>;
	private readonly gridHandle = this._register(new MutableDisposable<SerializableGrid<ISerializableView>>());
	private readonly gridChangeHandle = this._register(new MutableDisposable<IDisposable>());
	private partUpdateDepth = 0;
	private readonly unavailableParts = new Set<SessionsPartId>();
	private readonly desiredVisibility: {
		sessions: boolean;
		sidebar: boolean;
		auxiliarybar: boolean;
		editor: boolean;

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
	private readonly frameDomNode: HTMLDivElement;
	private sidePaneWidth: number;
	private detailsWidth: number;
	private conversationWidth: number;

	private primaryPart: 'sessions' | 'editor' = 'sessions';
	private customViewVisible = false;

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
		this.frameDomNode = h(container.ownerDocument, 'div');
		this.frameDomNode.className = 'ash-sessions-content-frame';
		this.frameDomNode.setAttribute('aria-hidden', 'true');
		this.domNode.append(this.frameDomNode);
		this.stateModel = new SessionsWorkbenchLayoutStateModel(
			storageService,
			options.initialState ?? createDefaultSessionsWorkbenchLayoutState(this.layoutPolicy, this.initialDimension),
		);
		const state = this.stateModel.state;
		for (const suffix of ['position', 'width', 'height', 'visible']) storageService.remove(`sessions.layout.panel.${suffix}`, StorageScope.PROFILE);
		this.sidePaneWidth = state.editor.width;
		this.detailsWidth = state.auxiliarybar.width;
		this.conversationWidth = storageService.getNumber(
			'sessions.layout.conversation.width',
			StorageScope.PROFILE,
			420,
		);
		const primaryPart = storageService.get('sessions.layout.primaryPart', StorageScope.PROFILE, 'sessions');
		if (primaryPart !== 'sessions' && primaryPart !== 'editor') {
			throw new TypeError('Saved primary Part is invalid.');
		}
		this.primaryPart = primaryPart;
		if (primaryPart === 'editor') {
			this.unavailableParts.add('sessions');
		}
		this.desiredVisibility = {
			sessions: true,
			sidebar: state.sidebar.visible,
			auxiliarybar: state.auxiliarybar.visible,
			editor: state.editor.visible,
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
					this.compositionChanged.event,
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
				if (this.grid.width > 0 && this.grid.height > 0)
					this.layout(new Dimension(this.grid.width, this.grid.height));
			}),
		);
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
				// Hidden tools retain their last user width.
				width: this.detailsWidth,
				visible: this.desiredVisibility.auxiliarybar,
			},
			editor: { width: this.sidePaneWidth, visible: this.desiredVisibility.editor },
		};
	}

	// Shared Workbench commands may address an absent region; no Panel state or host exists.
	getPanelPosition(): Position { return Position.BOTTOM; }
	setPanelPosition(_position: Position): void { }
	readonly onDidChangePanelPosition = Event.None;
	toggleMaximizedPanel(): void { }

	getSideBarPosition(): Position {
		return Position.LEFT;
	}

	isPanelMaximized(): boolean { return false; }

	private rebuildGrid(
		state: SessionsWorkbenchLayoutState,
		dimension: IDimension,
	): void {
		const focused = this.mainContainer.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.mainContainer.contains(focused);
		this.gridChangeHandle.clear();
		this.gridHandle.clear();
		this.grid = SerializableGrid.deserialize(this.domNode,
			createSessionsWorkbenchGridDescriptor(this.views, dimension, state, this.primaryPart),
			{ fromJSON: data => this.view(data as SessionsPartId) }, { edgeSnapping: true });
		this.gridHandle.value = this.grid;
		this.grid.layout(dimension.width, dimension.height);
		this.restorePartVisibility();
		this.gridChangeHandle.value = combinedDisposable(this.grid.onDidSashChange(() => this.saveState()), this.grid.onDidChange(() => {
			if (this.partUpdateDepth === 0) {
				// Sash snapping changes Grid visibility directly; retain it across page changes and reloads.
				if (!this.unavailableParts.has('sidebar'))
					this.desiredVisibility.sidebar = this.isViewVisible(this.view('sidebar'));
				if (!this.grid.hasMaximizedView() && this.isViewVisible(this.view('auxiliarybar')))
					this.detailsWidth = this.getViewSize(this.view('auxiliarybar')).width;
				if (
					this.primaryPart === 'editor' &&
					this.isViewVisible(this.view('sessions')) &&
					this.isViewVisible(this.view('editor'))
				)
					this.conversationWidth = this.getViewSize(this.view('sessions')).width;

				this.projectFrameInsets();
				this.updateTitlebarSurface();
				this.publishPartVisibility();
				this.saveState();
				// Publish completed sash geometry to overlays and the shared startup cache.
				super.layout(new Dimension(this.grid.width, this.grid.height));
			}
		}));
		if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
	}

	private restorePartVisibility(): void {
		this.partUpdateDepth++;
		try {
			for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar'] as const) {
				this.setViewVisible(this.view(id), this.desiredViewVisible(id) && !this.unavailableParts.has(id));
			}
			if (this.customViewVisible) this.applyCustomViewVisibility();
		} finally { this.partUpdateDepth--; }
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

	override layout(dimension: IDimension = getContainerDimension(this.mainContainer)): void {
		assertDimension(dimension);
		if (this.customViewVisible) this.applyCustomViewVisibility();
		this.projectFrameInsets();
		this.grid.layout(dimension.width, dimension.height);
		this.updateTitlebarSurface();
		if (this.partUpdateDepth > 0) return;
		if (
			this.primaryPart === 'sessions' &&
			!this.grid.hasMaximizedView() &&
			this.desiredVisibility.editor &&
			this.isViewVisible(this.view('editor'))
		) {
			this.sidePaneWidth = this.getViewSize(this.view('editor')).width;
		}
		if (
			this.primaryPart === 'editor' &&
			this.isViewVisible(this.view('sessions')) &&
			this.isViewVisible(this.view('editor'))
		) {
			this.conversationWidth = this.getViewSize(this.view('sessions')).width;
		}
		this.publishPartVisibility();

		// Overlay consumers observe completed Part and nested Chat geometry.
		super.layout(dimension);
		// Reload can precede the periodic storage save; commit only the completed Part arrangement.
		this.saveState();
	}

	/** Part changes share one geometry commit when several Parts change together. */
	public updateParts(update: () => void): void {
		const sidebarSize = this.getPartSize('sidebar');
		const wasMaximized = this.grid.hasMaximizedView();
		this.partUpdateDepth++;
		try {
			update();
		} finally {
			try {
				if (this.partUpdateDepth === 1) {
					this.projectFrameInsets();
					if (!wasMaximized && !this.grid.hasMaximizedView() && this.isViewVisible(this.view('auxiliarybar')))
						this.resizeView(
							this.view('auxiliarybar'),
							new Dimension(this.detailsWidth, this.getViewSize(this.view('auxiliarybar')).height),
						);
					// Restore the supporting width after all centers are visible; an isolated visible leaf must fill its branch.
					if (
						this.primaryPart === 'editor' &&
						this.isViewVisible(this.view('sessions')) &&
						this.isViewVisible(this.view('editor'))
					) {
						this.resizeView(
							this.view('sessions'),
							new Dimension(this.conversationWidth, this.getViewSize(this.view('sessions')).height),
						);
					}
					// Replacing the only center temporarily lets navigation absorb its space.
					// Keep the user's width, including its hidden cache, until the composition is complete.
					if (!wasMaximized && !this.grid.hasMaximizedView()) this.resizeView(this.view('sidebar'), sidebarSize);
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
		if (partId === this.primaryPart) return;
		const state = this.state;
		const dimension = new Dimension(this.grid.width, this.grid.height);
		this.primaryPart = partId;
		this.projectFrameInsets(state.auxiliarybar.visible);
		this.compositionChanged.fire();
		// View priorities already follow the composition. Retain the Grid so titlebar
		// transitions and focus survive switching between Chat and Code.
		this.restorePartVisibility();
		if (partId === 'sessions' && this.isViewVisible(this.view('auxiliarybar')))
			this.resizeView(
				this.view('auxiliarybar'),
				new Dimension(this.detailsWidth, this.getViewSize(this.view('auxiliarybar')).height),
			);
		this.layout(dimension);
	}

	isPartVisible(partId: string): boolean {
		if (!this.views.has(partId as SessionsPartId)) return false;

		return this.isViewVisible(this.view(partId as SessionsPartId));
	}
	isPartAvailable(partId: string): boolean {
		if (!this.views.has(partId as SessionsPartId)) return false;

		return !this.unavailableParts.has(partId as SessionsPartId);
	}
	showPart(partId: string): void {
		if (!this.views.has(partId as SessionsPartId)) return;

		this.updatePartVisibility(partId as SessionsPartId, true);
	}
	hidePart(partId: string): void {
		if (!this.views.has(partId as SessionsPartId)) return;

		this.updatePartVisibility(partId as SessionsPartId, false);
	}
	getPartSize(partId: string): Dimension {
		const view = this.views.get(partId as SessionsPartId);
		if (!view) return new Dimension(0, 0);
		const size = this.getViewSize(view);
		const width = partId === 'auxiliarybar' && !this.isPartVisible(partId) ? this.detailsWidth : size.width;
		return new Dimension(width, size.height);
	}

	resizePart(partId: string, dimension: IDimension): void {
		if (!this.views.has(partId as SessionsPartId)) return;

		assertDimension(dimension);

		if (partId === 'auxiliarybar') {
			this.detailsWidth = dimension.width;
		}
		if (this.primaryPart === 'sessions' && partId === 'editor') this.sidePaneWidth = dimension.width;
		this.resizeView(this.view(partId as SessionsPartId), dimension);
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private updatePartVisibility(partId: SessionsPartId, visible: boolean): void {
		if (partId === 'customview') {
			this.setCustomViewVisible(visible);
			return;
		}
		if (partId === 'titlebar' || partId === 'sessions')
			throw new Error('Required Sessions Part cannot be hidden: ' + partId);
		this.updateParts(() => {
			this.desiredVisibility[partId] = visible;

			this.setViewVisible(this.view(partId), this.desiredViewVisible(partId) && !this.unavailableParts.has(partId));

		});
	}

	public setPartAvailable(
		partId: string,
		available: boolean,
	): void {
		if (!this.views.has(partId as SessionsPartId)) return;

		if (available === !this.unavailableParts.has(partId as SessionsPartId)) return;
		this.updateParts(() => {
			if (available) this.unavailableParts.delete(partId as SessionsPartId);
			else this.unavailableParts.add(partId as SessionsPartId);
			this.setViewVisible(this.view(partId as SessionsPartId), available && this.desiredViewVisible(partId as 'sidebar' | 'sessions' | 'editor' | 'auxiliarybar'));

		});
	}

	/** Independent pages retain their underlying layout and may keep its workspace navigation visible. */
	public setCustomViewVisible(visible: boolean): void {
		if (visible === this.customViewVisible) return;
		// Covering several leaves is one composition change; intermediate Grid
		// constraints must not replace the retained user widths.
		this.updateParts(() => {
			this.customViewVisible = visible;
			if (visible) this.applyCustomViewVisibility();
			else {
				this.setViewVisible(this.view('customview'), false);
				for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar'] as const) {
					this.setViewVisible(
						this.view(id),
						this.desiredViewVisible(id) && !this.unavailableParts.has(id),
					);
				}
			}
		});
	}
	private applyCustomViewVisibility(): void {
		this.setViewVisible(this.view('customview'), true);
		for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar'] as const) {
			this.setViewVisible(
				this.view(id),
				id === 'sidebar' && this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar'),
			);
		}
	}

	private saveState(): void {
		this.stateModel.save(this.state);
		this.storageService.store(
			'sessions.layout.conversation.width',
			this.conversationWidth,
			StorageScope.PROFILE,
			StorageTarget.MACHINE,
		);
		this.storageService.store(
			'sessions.layout.primaryPart',
			this.primaryPart,
			StorageScope.PROFILE,
			StorageTarget.MACHINE,
		);
	}

	private projectFrameInsets(auxiliarybarVisible = this.isPartVisible('auxiliarybar')): void {
		const { leftEdge, rightEdge } = this.layoutPolicy.getFrameMetrics(this.layoutStyle);
		const contentBottom = rightEdge;
		const contentRight = rightEdge;
		this.view('titlebar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		const sidebarVisible = this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar');
		const editorVisible =
			!this.customViewVisible && this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const sessionsVisible = !this.customViewVisible && !this.unavailableParts.has('sessions');
		const contentLeftEdge = this.activityBarLocation === ActivityBarPosition.DEFAULT ? 0 : leftEdge;
		const contentLeft = sidebarVisible ? 0 : contentLeftEdge;
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
			right: !auxiliarybarVisible ? contentRight : 0,
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
		const mainPart: SessionsPartId = this.customViewVisible
			? 'customview'
			: sessionsVisible
				? 'sessions'
				: 'editor';
		const firstPart = sidebarVisible ? 'sidebar' : mainPart;
		let lastPart: SessionsPartId = mainPart;
		if (editorVisible) lastPart = 'editor';
		if (auxiliarybarVisible) lastPart = 'auxiliarybar';

		for (const partId of [
			'sidebar',
			'sessions',
			'editor',
			'auxiliarybar',
			...(this.views.has('customview') ? ['customview' as const] : []),
		] as const) {
			this.view(partId).part.domNode.classList.toggle(
				'ash-sessions-frame-start',
				partId === firstPart,
			);
			this.view(partId).part.domNode.classList.toggle(
				'ash-sessions-frame-end',
				partId === lastPart,
			);
		}
		// One decorative outline spans the retained Parts; it never intercepts their input or sashes.
		this.frameDomNode.style.top = `${this.mainContainerOffset.top}px`;
		this.frameDomNode.style.left = `${contentLeftEdge}px`;
		this.frameDomNode.style.right = `${rightEdge}px`;
		this.frameDomNode.style.bottom = `${rightEdge}px`;
	}

	private updateTitlebarSurface(): void {
		const width = this.isViewVisible(this.view('sidebar'))
			? this.getViewSize(this.view('sidebar')).width
			: 0;
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

	private desiredViewVisible(id: 'sidebar' | 'sessions' | 'editor' | 'auxiliarybar'): boolean {
		return this.desiredVisibility[id];
	}

	private isViewVisible(view: ISerializableView): boolean { return this.grid.isViewVisible(view); }
	private setViewVisible(view: ISerializableView, visible: boolean): void { this.grid.setViewVisible(view, visible); }
	private getViewSize(view: ISerializableView): IDimension { return this.grid.getViewSize(view); }
	private resizeView(view: ISerializableView, dimension: IDimension): void { this.grid.resizeView(view, dimension); }

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
