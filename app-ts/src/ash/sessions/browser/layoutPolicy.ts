import { Dimension, getClientArea, h, type IDimension } from '../../base/browser/dom.js';
import { SerializableGrid, type SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import type { IResizable } from '../../base/browser/ui/resizable/resizable.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { isRecord } from '../../base/common/types.js';
import type { ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import type { IStorageService } from '../../platform/storage/common/storage.js';
import { StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { WorkbenchPart } from '../../workbench/browser/part.js';
import { WorkbenchPartView } from '../../workbench/browser/workbenchPartView.js';

export const sessionsPartIds = ['titlebar', 'sidebar', 'sessions', 'auxiliarybar'] as const;
export type SessionsPartId = typeof sessionsPartIds[number];

export interface SessionsPartVisibilityChangeEvent {
	readonly partId: SessionsPartId;
	readonly visible: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 260;
const DEFAULT_AUXILIARYBAR_WIDTH = 292;

/** Persisted, Sessions-owned dimensions and visibility for the dedicated window. */
export interface SessionsWorkbenchLayoutState {
	readonly version: 1;
	readonly sidebar: {
		readonly width: number;
	};
	readonly auxiliarybar: {
		readonly width: number;
		readonly visible: boolean;
	};
}

export function createDefaultSessionsWorkbenchLayoutState(): SessionsWorkbenchLayoutState {
	return {
		version: 1,
		sidebar: { width: DEFAULT_SIDEBAR_WIDTH },
		auxiliarybar: { width: DEFAULT_AUXILIARYBAR_WIDTH, visible: true },
	};
}

export function parseSessionsWorkbenchLayoutState(value: unknown): SessionsWorkbenchLayoutState {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isRecord(value.sidebar) ||
		!isDimension(value.sidebar.width) ||
		!isRecord(value.auxiliarybar) ||
		!isDimension(value.auxiliarybar.width) ||
		typeof value.auxiliarybar.visible !== 'boolean'
	) {
		throw new TypeError('Sessions Workbench layout state is invalid or unsupported');
	}
	return {
		version: 1,
		sidebar: { width: value.sidebar.width },
		auxiliarybar: {
			width: value.auxiliarybar.width,
			visible: value.auxiliarybar.visible,
		},
	};
}

/** Bridges the Sessions layout schema to the generic scoped storage service. */
export class SessionsWorkbenchLayoutStateModel {
	constructor(
		private readonly storageService: IStorageService | undefined,
		private readonly defaults: SessionsWorkbenchLayoutState,
	) {}

	get state(): SessionsWorkbenchLayoutState {
		const storage = this.storageService;
		if (!storage) return this.defaults;
		return {
			version: 1,
			sidebar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH.scope), this.defaults.sidebar.width),
			},
			auxiliarybar: {
				width: storedDimension(storage.getNumber(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH.scope), this.defaults.auxiliarybar.width),
				visible: storage.getBoolean(SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.key, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE.scope, this.defaults.auxiliarybar.visible),
			},
		};
	}

	save(state: SessionsWorkbenchLayoutState): void {
		const storage = this.storageService;
		if (!storage) return;
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.SIDEBAR_WIDTH, state.sidebar.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_WIDTH, state.auxiliarybar.width);
		storeLayoutValue(storage, SessionsWorkbenchLayoutStorageKeys.AUXILIARYBAR_VISIBLE, state.auxiliarybar.visible);
	}
}

interface SessionsWorkbenchLayoutStorageKey {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
}

const SessionsWorkbenchLayoutStorageKeys = {
	SIDEBAR_WIDTH: {
		key: 'sessions.layout.sidebar.width',
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

function isDimension(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const SESSIONS_LAYOUT_PRIORITY = 'high' as const;
const DEFAULT_LAYOUT_WIDTH = 1_024;
const DEFAULT_LAYOUT_HEIGHT = 768;

export function createSessionsWorkbenchGridDescriptor(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	dimension: IDimension,
	state: SessionsWorkbenchLayoutState,
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
	const sessionsWidth = Math.max(0, dimension.width - state.sidebar.width - (state.auxiliarybar.visible ? state.auxiliarybar.width : 0));
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
					leaf('sidebar', state.sidebar.width),
					leaf('sessions', sessionsWidth, true, SESSIONS_LAYOUT_PRIORITY),
					leaf('auxiliarybar', state.auxiliarybar.width, state.auxiliarybar.visible),
				],
			},
		],
	};
}

export function resolveSessionsInitialDimension(container: HTMLElement, dimension: IDimension | undefined): Dimension {
	if (dimension) {
		assertDimension(dimension);
		if (dimension.width > 0 && dimension.height > 0) return new Dimension(dimension.width, dimension.height);
	}
	return new Dimension(container.clientWidth > 0 ? container.clientWidth : DEFAULT_LAYOUT_WIDTH, container.clientHeight > 0 ? container.clientHeight : DEFAULT_LAYOUT_HEIGHT);
}

export function parseSessionsPartId(value: unknown): SessionsPartId {
	if (value === 'titlebar' || value === 'sidebar' || value === 'sessions' || value === 'auxiliarybar') return value;
	throw new TypeError('Sessions Grid contains an unknown Part');
}

export function requiredView(
	views: ReadonlyMap<SessionsPartId, WorkbenchPartView<SessionsPartId>>,
	partId: SessionsPartId,
): WorkbenchPartView<SessionsPartId> {
	const view = views.get(partId);
	if (!view) throw new Error(`Sessions Part view is not registered: ${partId}`);
	return view;
}

export function assertDimension(dimension: IDimension): void {
	if (!Number.isFinite(dimension.width) || dimension.width < 0 || !Number.isFinite(dimension.height) || dimension.height < 0) {
		throw new RangeError('Sessions layout dimensions must be non-negative and finite');
	}
}

const PART_GUTTER = 6;

export interface SessionsWorkbenchLayoutOptions {
	readonly initialDimension?: IDimension;
	readonly initialState?: SessionsWorkbenchLayoutState;
	readonly storageService?: IStorageService;
}

/** Owns the fixed Part topology and mutable geometry of one dedicated Sessions window. */
export class SessionsWorkbenchLayout extends Disposable implements IResizable {
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
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-sessions-workbench-layout';
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
			{ sashPresentation: { type: 'inset', gap: PART_GUTTER } },
		));
		if (options.storageService) this._register(options.storageService.onWillSaveState(() => this.saveState()));
		this._register(toDisposable(() => this.saveState()));
	}

	get mainContainerOffset(): ILayoutOffsetInfo {
		const titlebar = this.getPartSize('titlebar');
		return { top: this.isPartVisible('titlebar') ? titlebar.height : 0, quickInputTop: 0 };
	}

	get state(): SessionsWorkbenchLayoutState {
		return {
			version: 1,
			sidebar: { width: this.getPartSize('sidebar').width },
			auxiliarybar: {
				width: this.getPartSize('auxiliarybar').width,
				visible: this.isPartVisible('auxiliarybar'),
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
		if (partId === 'titlebar' || partId === 'sidebar' || partId === 'sessions') throw new Error(`Required Sessions Part cannot be hidden: ${partId}`);
		if (this.isPartVisible(partId) === visible) return;
		this.projectFrameInsets(visible);
		this.grid.setViewVisible(this.view(partId), visible);
		this.publishPartVisibility();
	}

	private saveState(): void { this.stateModel.save(this.state); }

	private projectFrameInsets(auxiliarybarVisible = this.isPartVisible('auxiliarybar')): void {
		this.view('titlebar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: 0 });
		this.view('sidebar').setFrameInsets({ top: 0, right: PART_GUTTER / 2, bottom: 0, left: 0 });
		this.view('sessions').setFrameInsets({ top: 0, right: auxiliarybarVisible ? PART_GUTTER / 2 : 0, bottom: 0, left: PART_GUTTER / 2 });
		this.view('auxiliarybar').setFrameInsets({ top: 0, right: 0, bottom: 0, left: PART_GUTTER / 2 });
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
	if (missing.length > 0) throw new TypeError(`Sessions layout is missing Parts: ${missing.join(', ')}`);
}

function requiredPart(parts: ReadonlyMap<SessionsPartId, WorkbenchPart>, partId: SessionsPartId): WorkbenchPart {
	const part = parts.get(partId);
	if (!part) throw new Error(`Sessions Part is not registered: ${partId}`);
	return part;
}
