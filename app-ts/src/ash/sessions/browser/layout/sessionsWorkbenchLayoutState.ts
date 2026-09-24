import { isRecord } from "../../../base/common/types.js";
import type { IStorageService } from "../../../platform/storage/common/storage.js";
import { StorageScope, StorageTarget } from "../../../platform/storage/common/storage.js";

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
		typeof value.auxiliarybar.visible !== "boolean"
	) {
		throw new TypeError("Sessions Workbench layout state is invalid or unsupported");
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
		key: "sessions.layout.sidebar.width",
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_WIDTH: {
		key: "sessions.layout.auxiliarybar.width",
		scope: StorageScope.PROFILE,
		target: StorageTarget.MACHINE,
	},
	AUXILIARYBAR_VISIBLE: {
		key: "sessions.layout.auxiliarybar.visible",
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
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
