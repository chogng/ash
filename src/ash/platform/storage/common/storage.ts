import { type Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export const enum StorageScope {
	APPLICATION = "application",
	PROFILE = "profile",
	WORKSPACE = "workspace",
}

export const enum StorageTarget {
	USER = "user",
	MACHINE = "machine",
}

export const enum WillSaveStateReason {
	PERIODIC = "periodic",
	WORKSPACE_CHANGE = "workspaceChange",
	SHUTDOWN = "shutdown",
}

export type StorageValue = string | number | boolean | null | undefined;

export interface IStorageValueChangeEvent {
	readonly key: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget | undefined;
	readonly external: boolean;
}

export interface IWillSaveStateEvent {
	readonly reason: WillSaveStateReason;
}

/**
 * Window-facing storage for small durable application state.
 *
 * Callers own key schemas and validation. Scope controls identity boundaries;
 * target records whether a value is machine-local or eligible for user sync.
 */
export interface IStorageService {
	readonly onDidChangeValue: Event<IStorageValueChangeEvent>;
	readonly onWillSaveState: Event<IWillSaveStateEvent>;
	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope): string | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope): boolean | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope): number | undefined;
	store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void;
	remove(key: string, scope: StorageScope): void;
	keys(scope: StorageScope, target: StorageTarget): readonly string[];
	/** Whether the current scope did not exist before this service session. */
	isNew(scope: StorageScope): boolean;
	flush(reason?: WillSaveStateReason): Promise<void>;
}

export const IStorageService = createServiceIdentifier<IStorageService>("storageService");
