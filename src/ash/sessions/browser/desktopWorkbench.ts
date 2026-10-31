import { Orientation } from '../../base/browser/ui/sash/sash.js';
import { LayoutPriority } from '../../base/browser/ui/splitview/splitview.js';
import {
	CodeInformationView,
	CodeChangesView,
	readCodeCardLayout,
	type ICodeCardLayout,
	type CodeCardId,
	type CodeCardTarget,
} from './codeCardLayout.js';
import { Dimension, h, type IDimension } from '../../base/browser/dom.js';
import type { IPositionedRectangle } from '../../base/browser/geometry.js';
import {
	SerializableGrid,
	Sizing,
	Direction,
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
import { AuxiliaryBarPart } from './parts/auxiliaryBarPart.js';
import { DesktopMainEditorPart } from './parts/desktopEditorPart.js';
import type { DockedAuxiliaryBarController } from './dockedAuxiliaryBarController.js';
import type { EditorPart as WorkbenchEditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
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
import { AGENTS_FLOATING_PANEL_GAP } from '../common/sizes.js';
import { EDITOR_PART_DEFAULT_WIDTH, EDITOR_PART_MINIMUM_WIDTH } from './parts/editorPartSizing.js';
import { Position, isHorizontal, positionToString } from '../../workbench/services/layout/browser/layoutService.js';

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
	readonly panel: {
		readonly position: Position;
		readonly width: number;
		readonly height: number;
		readonly visible: boolean;
	};
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
		panel: {
			position: Position.RIGHT,
			width: sizes.auxiliaryBarSize,
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
			panel: {
				position: storedPanelPosition(
					storage.get(
						SessionsWorkbenchLayoutStorageKeys.PANEL_POSITION.key,
						SessionsWorkbenchLayoutStorageKeys.PANEL_POSITION.scope,
					),
					this.defaults.panel.position,
				),
				width: storedDimension(
					storage.getNumber(
						SessionsWorkbenchLayoutStorageKeys.PANEL_WIDTH.key,
						SessionsWorkbenchLayoutStorageKeys.PANEL_WIDTH.scope,
					),
					this.defaults.panel.width,
				),
				height: storedDimension(
					storage.getNumber(
						SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT.key,
						SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT.scope,
					),
					this.defaults.panel.height,
				),
				visible: storage.getBoolean(
					SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE.key,
					SessionsWorkbenchLayoutStorageKeys.PANEL_VISIBLE.scope,
					this.defaults.panel.visible,
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
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_HEIGHT, state.panel.height);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.PANEL_WIDTH, state.panel.width);
		storeLayoutValue(
			storage,
			SessionsWorkbenchLayoutStorageKeys.PANEL_POSITION,
			positionToString(state.panel.position),
		);
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
	PANEL_WIDTH: { key: 'sessions.layout.panel.width', scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
	PANEL_HEIGHT: { key: 'sessions.layout.panel.height', scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
	PANEL_VISIBLE: { key: 'sessions.layout.panel.visible', scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
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
	const horizontalPanel = isHorizontal(state.panel.position);
	const panelSize = horizontalPanel ? state.panel.height : state.panel.width;
	const stackedTools = !editorPrimary && !horizontalPanel;
	const toolsWidth = stackedTools && !state.panel.visible ? state.auxiliarybar.width : state.panel.width;
	const toolsVisible = state.panel.visible || (stackedTools && state.auxiliarybar.visible);
	const contentWidth = Math.max(0, mainWidth - (!horizontalPanel && toolsVisible ? toolsWidth : 0));
	const contentHeight = Math.max(0, bodyHeight - (horizontalPanel && state.panel.visible ? panelSize : 0));
	const sidePaneWidth =
		(state.editor.visible && !editorPrimary ? state.editor.width : 0) +
		(!stackedTools && state.auxiliarybar.visible ? state.auxiliarybar.width : 0);
	const sessionsWidth = Math.max(0, contentWidth - sidePaneWidth);
	const content: SerializedGridDescriptor = {
		type: 'branch',
		orientation: Orientation.HORIZONTAL,
		size: horizontalPanel ? contentHeight : contentWidth,
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
			...(!stackedTools ? [leaf('auxiliarybar', state.auxiliarybar.width, state.auxiliarybar.visible)] : []),
		],
	};
	const panel = leaf('panel', panelSize, state.panel.visible);
	// Code tools share a resizable column, independent of document tabs. Retain
	// both leaves when hidden so toggles restore their sash positions and content.
	const tools: SerializedGridDescriptor = stackedTools
		? {
			type: 'branch',
			orientation: Orientation.VERTICAL,
			size: toolsWidth,
			priority: LayoutPriority.Normal,
			children: [
				leaf('panel', state.panel.height, state.panel.visible),
				leaf(
					'auxiliarybar',
					Math.max(0, bodyHeight - (state.panel.visible ? state.panel.height : 0)),
					state.auxiliarybar.visible,
				),
			],
		}
		: panel;
	const leadingPanel = state.panel.position === Position.TOP || state.panel.position === Position.LEFT;
	const mainChildren: SerializedGridDescriptor[] = horizontalPanel
		? [
			{
				type: 'branch',
				orientation: Orientation.VERTICAL,
				size: mainWidth,
				priority: SESSIONS_LAYOUT_PRIORITY,
				children: leadingPanel ? [panel, content] : [content, panel],
			},
		]
		: leadingPanel
			? [tools, ...content.children]
			: [...content.children, tools];
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
	const measured = getContainerDimension(container);
	return new Dimension(
		measured.width > 0 ? measured.width : DEFAULT_EMPTY_WINDOW_SIZE.width,
		measured.height > 0 ? measured.height : DEFAULT_EMPTY_WINDOW_SIZE.height,
	);
}

function parseSessionsPartId(value: unknown): SessionsPartId {
	if (value === 'customview') return value;
	if (
		value === 'titlebar' ||
		value === 'sidebar' ||
		value === 'sessions' ||
		value === 'editor' ||
		value === 'auxiliarybar' ||
		value === 'panel'
	)
		return value;
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

/** Adapts retained Parts; detached content is laid out by its auxiliary window. */
class SessionsWorkbenchPartView extends WorkbenchPartView<SessionsPartId> {
	constructor(
		partId: SessionsPartId,
		part: Part,
		private readonly isEditorPrimary: () => boolean,
		private readonly isLayoutDeferred: () => boolean,
		private readonly compositionChanged: Event<void>,
		private readonly isPanelMaximized: () => boolean,
		private readonly isDetached: () => boolean,
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
			(this.partId === 'editor' && this.isEditorPrimary()) ||
			(this.partId === 'panel' && this.isPanelMaximized())
			? LayoutPriority.High
			: LayoutPriority.Normal;
	}

	public override layout(bounds: IPositionedRectangle): void {
		// Page changes resize the Grid several times; sash drags still lay out Parts immediately.
		if (!this.isLayoutDeferred() && !this.isDetached()) super.layout(bounds);
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible || this.isDetached());
	}
}

export class DesktopWorkbenchLayout
	extends BrowserLayoutService
	implements IAgentWorkbenchLayoutService, ICodeCardLayout {
	private readonly views = new Map<SessionsPartId, SessionsWorkbenchPartView>();
	private grid!: SerializableGrid<SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView>;
	private readonly gridHandle = this._register(
		new MutableDisposable<SerializableGrid<SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView>>(),
	);
	private readonly gridChangeHandle = this._register(new MutableDisposable<IDisposable>());
	readonly codeCards: ICodeCardLayout = this;
	readonly information: CodeInformationView;
	private desktopEditor!: DesktopMainEditorPart;
	get files(): DockedAuxiliaryBarController { return this.desktopEditor.dockedAuxiliaryBar; }
	readonly changes: CodeChangesView;
	private changesVisible = false;
	private readonly cardsChanged = this._register(new Emitter<void>());
	readonly onDidChangeCards = this.cardsChanged.event;
	private informationElement: HTMLElement | undefined;
	private informationVisible: boolean;
	private codeDescriptor: SerializedGridDescriptor | undefined;
	private transientDescriptor: SerializedGridDescriptor | undefined;
	private readonly detachedCards = new Set<CodeCardId>();
	get expandedCard(): CodeCardId | undefined {
		if (!this.grid?.hasMaximizedView()) return undefined;
		return (['terminal', 'files', 'changes', 'info'] as const).find(id => this.grid.isViewMaximized(this.cardView(id)));
	}
	get active(): boolean {
		return this.primaryPart === 'sessions' && !this.unavailableParts.has('panel') && !this.customViewVisible;
	}
	private partUpdateDepth = 0;
	private readonly unavailableParts = new Set<SessionsPartId>();
	private readonly desiredVisibility: {
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
	private get stackedTools(): boolean {
		return this.primaryPart === 'sessions' && !isHorizontal(this.panelPosition);
	}

	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;
	readonly domNode: HTMLDivElement;

	constructor(
		container: HTMLElement,
		options: SessionsWorkbenchLayoutOptions,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super({ root: container, focus: options.focus });
		this.information = new CodeInformationView(container.ownerDocument);
		this.changes = new CodeChangesView(container.ownerDocument);
		this.informationVisible = storageService.getBoolean('sessions.code.infoPinned', StorageScope.PROFILE, false);
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
		this.stateModel = new SessionsWorkbenchLayoutStateModel(
			storageService,
			options.initialState ?? createDefaultSessionsWorkbenchLayoutState(this.layoutPolicy, this.initialDimension),
		);
		const state = this.stateModel.state;
		this.panelPosition = state.panel.position;
		this.panelWidth = state.panel.width;
		this.panelHeight = state.panel.height;
		this.domNode.dataset.panelPosition = positionToString(this.panelPosition);
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
					this.compositionChanged.event,
					() => this.panelMaximized,
					() => partId === 'panel' && this.detachedCards.has('terminal'),
					requiredPart(parts, 'titlebar'),
				),
			);
		}
		this._register(requiredPart(parts, 'editor').onDidChangeConstraints(() => this.compositionChanged.fire()));
		const editor = requiredPart(parts, 'editor');
		if (!(editor instanceof DesktopMainEditorPart)) { throw new Error('Desktop layout requires DesktopMainEditorPart'); }
		this.desktopEditor = editor;
		const savedCards = this.storageService.get('sessions.code.cardLayout', StorageScope.PROFILE);
		const cardIds = [...parts.keys()].filter(id => id !== 'editor' && id !== 'auxiliarybar');
		const groupedCards = readCodeCardLayout(savedCards, [...cardIds, 'files', 'changes', 'info'])
			?? readCodeCardLayout(savedCards, [...cardIds, 'files', 'info']);
		this.codeDescriptor = groupedCards ?? readCodeCardLayout(savedCards, [...parts.keys(), 'info']);
		// Older profiles could show a document while Files was closed. The combined card must reveal that document.
		if (!groupedCards && this.primaryPart === 'sessions' && this.desiredVisibility.editor) {
			this.desiredVisibility.auxiliarybar = true;
			this.detailsWidth = Math.max(this.detailsWidth, this.sidePaneWidth);
		}
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
		const expanded = this.expandedCard;
		if (expanded) this.expandCard(expanded);
		this.codeDescriptor = undefined;
		this.updateParts(() => {
			const state = this.state;
			const dimension = new Dimension(this.grid.width, this.grid.height);
			this.panelPosition = position;
			this.domNode.dataset.panelPosition = positionToString(position);
			this.rebuildGrid({ ...state, panel: { ...state.panel, position } }, dimension);
		});
		if (expanded) this.expandCard(expanded);
		this.panelPositionChanged.fire(positionToString(position));
	}

	isPanelMaximized(): boolean {
		return (this.panelMaximized || this.expandedCard === 'terminal') && this.isPartVisible('panel');
	}

	toggleMaximizedPanel(): void {
		if (this.active) {
			this.expandCard('terminal');
			return;
		}
		if (this.customViewVisible || this.unavailableParts.has('panel')) return;
		this.updateParts(() => {
			this.panelMaximized = !this.panelMaximized;
			this.desiredVisibility.panel = true;
			this.restorePartVisibility();
		});
	}

	private rebuildGrid(
		state: SessionsWorkbenchLayoutState,
		dimension: IDimension,
		descriptor?: SerializedGridDescriptor,
	): void {
		const focused = this.mainContainer.ownerDocument.activeElement as HTMLElement | null;
		const restoreFocus = focused && this.mainContainer.contains(focused);
		this.gridChangeHandle.clear();
		this.gridHandle.clear();
		const groupedFiles = this.primaryPart === 'sessions';
		if (groupedFiles) {
			this.files.mount(this.view('editor').frame, this.view('auxiliarybar'), this.desiredVisibility.editor, () => this.detachedCards.has('files'));
		} else {
			this.files.unmount();
		}
		const auxiliary = this.view('auxiliarybar').part;
		if (auxiliary instanceof AuxiliaryBarPart) { auxiliary.setDocked(groupedFiles); }
		const source = descriptor ?? (groupedFiles ? this.codeDescriptor : undefined)
			?? createSessionsWorkbenchGridDescriptor(this.views, dimension, state, this.primaryPart);
		this.grid = SerializableGrid.deserialize(
			this.domNode,
			groupedFiles ? groupFilesDescriptor(source) : source,
			{ fromJSON: data => data === 'info' ? this.information : data === 'files' ? this.files : data === 'changes' ? this.changes : this.view(parseSessionsPartId(data)) },
			{ edgeSnapping: true },
		);
		this.gridHandle.value = this.grid;
		if (!descriptor && !(this.primaryPart === 'sessions' && this.codeDescriptor))
			this.grid.addView(this.information, Sizing.Invisible(280), this.view('sessions'), Direction.Right);
		if (!containsChanges(this.grid.serialize())) {
			this.grid.addView(this.changes, Sizing.Invisible(600), this.view('sessions'), Direction.Right);
		}
		this.grid.layout(dimension.width, dimension.height);
		this.restorePartVisibility();
		this.gridChangeHandle.value = combinedDisposable(this.grid.onDidChangeViewMaximized(() => this.cardsChanged.fire()), this.grid.onDidChange(() => {
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
				this.capturePanelSize();
				this.rememberDetachedArrangement();
				this.projectFrameInsets();
				this.updateTitlebarSurface();
				this.publishPartVisibility();
				this.saveState();
			}
		}));
		if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
	}

	private restorePartVisibility(): void {
		this.partUpdateDepth++;
		try {
			for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) {
				this.setViewVisible(this.view(id), this.desiredVisibility[id] && !this.unavailableParts.has(id));
			}
			this.applyCardVisibility();
			if (this.customViewVisible) this.applyCustomViewVisibility();
			else if (this.panelMaximized) {
				for (const id of ['sessions', 'editor', 'auxiliarybar'] as const)
					this.setViewVisible(this.view(id), false);
			}
			const size = this.getViewSize(this.view('panel'));
			if (!this.active && !this.panelMaximized && this.isPartVisible('panel'))
				this.resizeView(
					this.view('panel'),
					isHorizontal(this.panelPosition)
						? new Dimension(size.width, this.panelHeight)
						: new Dimension(
							this.panelWidth,
							this.stackedTools && this.isPartVisible('auxiliarybar')
								? this.panelHeight
								: size.height,
						),
				);
		} finally {
			this.partUpdateDepth--;
		}
	}

	private capturePanelSize(): void {
		if (
			!this.isViewVisible(this.view('panel')) ||
			this.panelMaximized ||
			this.customViewVisible ||
			this.grid.hasMaximizedView() ||
			this.transientDescriptor
		)
			return;
		const size = this.getViewSize(this.view('panel'));
		if (isHorizontal(this.panelPosition)) this.panelHeight = size.height;
		else {
			this.panelWidth = size.width;
			if (this.stackedTools && this.isViewVisible(this.view('auxiliarybar'))) this.panelHeight = size.height;
		}
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
		this.applyCardVisibility();
		if (this.customViewVisible) this.applyCustomViewVisibility();
		else if (this.panelMaximized) {
			for (const id of ['sessions', 'editor', 'auxiliarybar'] as const)
				this.setViewVisible(this.view(id), false);
		}
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
		this.cardsChanged.fire();
		this.capturePanelSize();
		// Overlay consumers observe completed Part and nested Chat geometry.
		super.layout(dimension);
		// Reload can precede the periodic storage save; commit only the completed Part arrangement.
		this.saveState();
	}

	/** Editor and panel changes share one geometry commit when several Parts change together. */
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
					if (!wasMaximized && !this.transientDescriptor && !this.grid.hasMaximizedView() && this.isViewVisible(this.view('auxiliarybar')))
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
		if (this.expandedCard) this.expandCard(this.expandedCard);
		const state = this.state;
		const dimension = new Dimension(this.grid.width, this.grid.height);
		if (this.primaryPart === 'sessions' && !this.transientDescriptor) this.codeDescriptor = this.grid.serialize();
		this.primaryPart = partId;
		this.projectFrameInsets(state.auxiliarybar.visible);
		this.compositionChanged.fire();
		this.rebuildGrid(state, dimension);
		if (partId === 'sessions' && this.isViewVisible(this.view('auxiliarybar')))
			this.resizeView(
				this.view('auxiliarybar'),
				new Dimension(this.detailsWidth, this.getViewSize(this.view('auxiliarybar')).height),
			);
		this.layout(dimension);
	}

	isPartVisible(partId: SessionsPartId): boolean {
		return (
			(partId === 'panel' && this.detachedCards.has('terminal')) || (partId === 'auxiliarybar' && this.detachedCards.has('files')) ||
			this.isViewVisible(this.view(partId))
		);
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
		const size = this.getViewSize(this.view(partId));
		// A hidden column has no current width; its leaves still own their restore geometry.
		const width = !this.isPartVisible(partId)
			? partId === 'auxiliarybar'
				? this.detailsWidth
				: partId === 'panel' && !isHorizontal(this.panelPosition)
					? this.panelWidth
					: size.width
			: size.width;
		return new Dimension(width, size.height);
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
		if (this.primaryPart === 'sessions' && partId === 'editor') this.sidePaneWidth = dimension.width;
		this.resizeView(this.view(partId), dimension);
		if (this.primaryPart === 'sessions' && partId === 'editor') {
			this.files.rememberTreeWidth();
		}
		this.layout(new Dimension(this.grid.width, this.grid.height));
	}

	private updatePartVisibility(partId: SessionsPartId, visible: boolean): void {
		const card = partId === 'panel' ? 'terminal' : partId === 'auxiliarybar' || partId === 'editor' ? 'files' : undefined;
		if (this.expandedCard && (visible ? this.expandedCard !== card : this.expandedCard === card))
			this.expandCard(this.expandedCard);
		if (partId === 'customview') {
			this.setCustomViewVisible(visible);
			return;
		}
		if (partId === 'titlebar' || partId === 'sessions')
			throw new Error('Required Sessions Part cannot be hidden: ' + partId);
		this.updateParts(() => {
			if (partId === 'editor' && visible && !this.desiredVisibility.editor && this.files.isMounted) {
				this.detailsWidth = Math.max(this.detailsWidth, Math.min(800, this.mainContainerDimension.width * 0.6));
			}
			this.desiredVisibility[partId] = visible;
			if (partId === 'editor' && visible && this.files.isMounted) {
				this.desiredVisibility.auxiliarybar = true;
				this.setViewVisible(this.view('auxiliarybar'), !this.unavailableParts.has('auxiliarybar'));
			}
			if (partId === 'panel' && !visible && this.panelMaximized) {
				this.panelMaximized = false;
				this.restorePartVisibility();
			}
			this.setViewVisible(this.view(partId), visible && !this.unavailableParts.has(partId));
			if (visible && partId === 'panel' && !this.panelMaximized && !this.active) {
				const size = this.getViewSize(this.view('panel'));
				this.resizeView(
					this.view('panel'),
					new Dimension(
						isHorizontal(this.panelPosition) ? size.width : this.panelWidth,
						isHorizontal(this.panelPosition) || (this.stackedTools && this.isPartVisible('auxiliarybar'))
							? this.panelHeight
							: size.height,
					),
				);
				if (this.stackedTools && this.isPartVisible('auxiliarybar'))
					this.detailsWidth = this.getViewSize(this.view('panel')).width;
			}
		});
	}

	public setPartAvailable(
		partId: 'sessions' | 'sidebar' | 'auxiliarybar' | 'editor' | 'panel',
		available: boolean,
	): void {
		if (available === !this.unavailableParts.has(partId)) return;
		if (!available && partId === 'panel' && this.expandedCard) this.expandCard(this.expandedCard);
		this.updateParts(() => {
			if (available) this.unavailableParts.delete(partId);
			else this.unavailableParts.add(partId);
			this.setViewVisible(this.view(partId), available && this.desiredVisibility[partId]);
			if (partId === 'panel') {
				if (!available) this.panelMaximized = false;
				this.restorePartVisibility();
				if (!this.active && available && this.stackedTools && this.isPartVisible('panel'))
					this.detailsWidth = this.getViewSize(this.view('panel')).width;
			}
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
				for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) {
					this.setViewVisible(
						this.view(id),
						this.desiredVisibility[id] && !this.unavailableParts.has(id),
					);
				}
			}
		});
	}
	private applyCustomViewVisibility(): void {
		this.setViewVisible(this.view('customview'), true);
		for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) {
			this.setViewVisible(
				this.view(id),
				id === 'sidebar' && this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar'),
			);
		}
	}

	private saveState(): void {
		if (this.grid && this.active && !this.transientDescriptor && !this.grid.hasMaximizedView()) this.codeDescriptor = this.grid.serialize();
		if (this.codeDescriptor)
			this.storageService.store(
				'sessions.code.cardLayout',
				JSON.stringify(this.codeDescriptor),
				StorageScope.PROFILE,
				StorageTarget.MACHINE,
			);
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
		const toolCards = this.primaryPart === 'sessions' && this.isPartAvailable('panel') && !this.customViewVisible;
		this.domNode.classList.toggle('ash-sessions-code-tools', toolCards);
		const panelVisible =
			!this.customViewVisible && this.desiredVisibility.panel && !this.unavailableParts.has('panel');
		this.domNode.dataset.panelVisible = String(panelVisible);
		this.domNode.dataset.panelMaximized = String(this.panelMaximized);
		const contentBottom = panelVisible && this.panelPosition === Position.BOTTOM ? 0 : rightEdge;
		const contentRight = panelVisible && this.panelPosition === Position.RIGHT ? 0 : rightEdge;
		this.view('titlebar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		const sidebarVisible = this.desiredVisibility.sidebar && !this.unavailableParts.has('sidebar');
		const editorVisible =
			!this.customViewVisible && this.desiredVisibility.editor && !this.unavailableParts.has('editor');
		const sessionsVisible = !this.customViewVisible && !this.unavailableParts.has('sessions');
		const contentLeftEdge = this.activityBarLocation === ActivityBarPosition.DEFAULT ? 0 : leftEdge;
		const panelLeftEdge = sidebarVisible ? 0 : contentLeftEdge;
		this.view('panel').setFrameInsets({
			top: 0,
			right: !this.panelMaximized && this.panelPosition === Position.LEFT ? 0 : rightEdge,
			bottom: !this.panelMaximized && this.panelPosition === Position.TOP ? 0 : rightEdge,
			left: !this.panelMaximized && this.panelPosition === Position.RIGHT ? 0 : panelLeftEdge,
		});
		const contentLeft =
			sidebarVisible || (panelVisible && this.panelPosition === Position.LEFT) ? 0 : contentLeftEdge;
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
		for (const partId of ['panel', 'auxiliarybar', 'editor'] as const) {
			const nested = !!this.files.isMounted && partId !== 'panel';
			this.view(partId).part.domNode.classList.toggle('ash-sessions-tool-card', toolCards && !nested);
			if (nested) {
				this.view(partId).setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
				continue;
			}
			if (toolCards) {
				// Keep the sash in the space between cards; Grid still owns their real content bounds.
				const gap = AGENTS_FLOATING_PANEL_GAP;

				this.view(partId).setFrameInsets({ top: gap, right: gap, bottom: gap, left: gap });
			}
		}

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
		const firstPart = sidebarVisible
			? 'sidebar'
			: panelVisible && (this.panelMaximized || this.panelPosition === Position.LEFT)
				? 'panel'
				: mainPart;
		let lastPart: SessionsPartId = mainPart;
		if (editorVisible) lastPart = 'editor';
		if (auxiliarybarVisible) lastPart = 'auxiliarybar';
		if (panelVisible && (this.panelMaximized || this.panelPosition === Position.RIGHT)) lastPart = 'panel';
		for (const partId of [
			'sidebar',
			'sessions',
			'editor',
			'auxiliarybar',
			'panel',
			...(this.views.has('customview') ? ['customview' as const] : []),
		] as const) {
			const horizontalPanel = partId === 'panel' && panelVisible && isHorizontal(this.panelPosition);
			this.view(partId).part.domNode.classList.toggle(
				'ash-sessions-frame-start',
				partId === firstPart || (horizontalPanel && !sidebarVisible),
			);
			this.view(partId).part.domNode.classList.toggle(
				'ash-sessions-frame-end',
				partId === lastPart || horizontalPanel,
			);
		}
		// One decorative outline spans the retained Parts; it never intercepts their input or sashes.
		this.cardDomNode.style.top = `${this.mainContainerOffset.top}px`;
		this.cardDomNode.style.left = `${contentLeftEdge}px`;
		this.cardDomNode.style.right = `${rightEdge}px`;
		this.cardDomNode.style.bottom = `${rightEdge}px`;
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

	isCardVisible(id: CodeCardId): boolean {
		if (!this.active) { return false; }
		if (id === 'changes') { return this.changesVisible; }
		if (id === 'info') { return !!this.informationElement && this.informationVisible; }
		return this.desiredVisibility[id === 'files' ? 'auxiliarybar' : 'panel'];
	}

	setChangesPart(part: WorkbenchEditorPart): void {
		this.changes.mount(part);
	}

	setChangesVisible(visible: boolean): void {
		if (this.changesVisible === visible) { return; }
		if (!visible && this.expandedCard === 'changes') { this.expandCard('changes'); }
		this.changesVisible = visible;
		this.updateParts(() => this.applyCardVisibility());
	}

	setInformation(element: HTMLElement | undefined): void {
		if (this.informationElement === element) return;
		if (!element && this.expandedCard === 'info') this.expandCard('info');
		this.informationElement = element;
		this.information.body.replaceChildren(...(element ? [element] : []));
		if (this.grid) this.updateParts(() => this.applyCardVisibility());
	}

	toggleInformation(): void {
		if (this.expandedCard) this.expandCard(this.expandedCard);
		this.informationVisible = !this.informationVisible;
		this.storageService.store(
			'sessions.code.infoPinned',
			this.informationVisible,
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
		this.updateParts(() => this.applyCardVisibility());
		if (this.informationVisible) this.information.header.querySelector<HTMLElement>('button')?.focus();
	}

	closeCard(id: CodeCardId): void {
		if (this.expandedCard === id) this.expandCard(id);
		if (id === 'changes') {
			this.setChangesVisible(false);
		} else if (id === 'info') {
			if (this.informationVisible) this.toggleInformation();
		} else this.hidePart(id === 'files' ? 'auxiliarybar' : 'panel');
		this.mainContainer
			.querySelector<HTMLElement>(
				'[data-action-id="' +
				(id === 'changes' ? 'workbench.agentSessions.action.viewChanges' : id === 'info' ? 'ash.sessions.toggleInfo' : id === 'terminal' ? 'ash.sessions.togglePanel' : 'ash.sessions.toggleFiles') +
				'"] button',
			)
			?.focus();
	}

	private cardView(id: CodeCardTarget): SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView {
		switch (id) {
			case 'changes': return this.changes;
			case 'info': return this.information;
			case 'files': return this.files;
			case 'terminal': return this.view('panel');
			case 'sessions': return this.view('sessions');
		}
	}

	private applyCardVisibility(): void {
		if (!this.grid || this.grid.hasMaximizedView()) return;
		this.setViewVisible(this.changes, this.active && this.changesVisible && !this.detachedCards.has('changes'));
		this.changes.setVisible(this.active && this.changesVisible);
		this.setViewVisible(
			this.information,
			this.active &&
			!!this.informationElement &&
			this.informationVisible &&
			!this.detachedCards.has('info'),
		);
		for (const id of ['panel', 'auxiliarybar', 'sessions', 'editor'] as const) {
			const card = id === 'panel' ? 'terminal' : id === 'auxiliarybar' || id === 'editor' ? 'files' : undefined;
			if (card && this.detachedCards.has(card)) {
				// Files is one outer leaf. Its embedded editor keeps its visibility while the card is covered.
				if (id !== 'editor' || !this.files.isMounted) { this.setViewVisible(this.view(id), false); }
			}
		}
	}

	moveCard(id: CodeCardId, target: CodeCardTarget, direction: Direction): void {
		if (!this.active || id === target || this.detachedCards.has(id)) return;
		if (this.expandedCard) this.expandCard(this.expandedCard);
		this.updateParts(() => {
			this.grid.moveView(this.cardView(id), Sizing.Split, this.cardView(target), direction);
			if (this.isViewVisible(this.view('auxiliarybar')))
				this.detailsWidth = this.getViewSize(this.view('auxiliarybar')).width;
			this.rememberDetachedArrangement();
		});
	}

	expandCard(id: CodeCardId): void {
		if (!this.active || this.detachedCards.has(id)) return;
		if (id === 'changes' && !this.changesVisible) this.setChangesVisible(true);
		else if (id !== 'info' && !this.isCardVisible(id)) this.showPart(id === 'files' ? 'auxiliarybar' : 'panel');
		this.updateParts(() => {
			if (this.grid.isViewMaximized(this.cardView(id))) this.grid.exitMaximizedView();
			else {
				if (!this.grid.hasMaximizedView() && !this.transientDescriptor) this.codeDescriptor = this.grid.serialize();
				this.grid.maximizeView(this.cardView(id), [this.view('titlebar'), this.view('sidebar')]);
			}
		});
	}

	detachCard(id: CodeCardId, detached: boolean): void {
		if (detached === this.detachedCards.has(id)) return;
		this.updateParts(() => {
			this.grid.exitMaximizedView();
			this.transientDescriptor ??= this.grid.serialize();
			if (detached) this.detachedCards.add(id);
			else this.detachedCards.delete(id);
			this.restoreCardGeometry();
		});
	}

	/** A user can keep arranging the main window while another card is detached.
	 * Re-enable its retained slot in the saved tree, without moving its live DOM. */
	private rememberDetachedArrangement(): void {
		if (!this.active || this.expandedCard || this.detachedCards.size === 0) return;
		const normal = (node: SerializedGridDescriptor): SerializedGridDescriptor => {
			if (node.type === 'branch') return { ...node, children: node.children.map(normal) };
			const card = node.data === 'panel' ? 'terminal' : node.data === 'files' ? 'files' : node.data === 'changes' ? 'changes' : node.data === 'info' ? 'info' : undefined;
			return card && this.detachedCards.has(card) ? { ...node, visible: this.isCardVisible(card) } : node;
		};
		this.codeDescriptor = this.transientDescriptor = normal(this.grid.serialize());
	}

	private restoreCardGeometry(): void {
		const base = this.transientDescriptor;
		if (base)
			this.rebuildGrid(
				this.state,
				new Dimension(this.grid.width, this.grid.height),
				this.primaryPart === 'sessions' ? base : undefined,
			);
		if (this.detachedCards.size === 0) this.transientDescriptor = undefined;
	}

	private isViewVisible(view: SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView): boolean {
		if (this.files.isMounted && view === this.view('editor')) {
			return (this.detachedCards.has('files') || this.grid.isViewVisible(this.files)) && this.files.editorVisible;
		}
		return this.grid.isViewVisible(this.files.isMounted && view === this.view('auxiliarybar') ? this.files : view);
	}

	private setViewVisible(view: SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView, visible: boolean): void {
		if (this.files.isMounted && view === this.view('editor')) {
			this.files.setEditorVisible(visible);
		} else {
			this.grid.setViewVisible(this.files.isMounted && view === this.view('auxiliarybar') ? this.files : view, visible);
		}
	}

	private getViewSize(view: SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView): IDimension {
		if (this.files.isMounted && view === this.view('editor')) { return this.files.editorSize; }
		return this.grid.getViewSize(this.files.isMounted && view === this.view('auxiliarybar') ? this.files : view);
	}

	private resizeView(view: SessionsWorkbenchPartView | CodeInformationView | DockedAuxiliaryBarController | CodeChangesView, dimension: IDimension): void {
		if (this.files.isMounted && view === this.view('editor')) { this.files.resizeEditor(dimension); }
		else { this.grid.resizeView(this.files.isMounted && view === this.view('auxiliarybar') ? this.files : view, dimension); }
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

/** Files changes presentation topology only; its child Parts keep their existing services and inputs. */
function groupFilesDescriptor(descriptor: SerializedGridDescriptor): SerializedGridDescriptor {
	const visit = (node: SerializedGridDescriptor): SerializedGridDescriptor | undefined => {
		if (node.type === 'leaf') {
			if (node.data === 'editor') { return undefined; }
			return node.data === 'auxiliarybar' ? { ...node, data: 'files' } : node;
		}
		const children = node.children.map(visit).filter((child): child is SerializedGridDescriptor => child !== undefined);
		return children.length ? { ...node, children } : undefined;
	};
	return visit(descriptor)!;
}

function containsChanges(descriptor: SerializedGridDescriptor): boolean {
	return descriptor.type === 'leaf' ? descriptor.data === 'changes' : descriptor.children.some(containsChanges);
}
