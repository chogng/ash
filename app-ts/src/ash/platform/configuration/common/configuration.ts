import { assertNever } from '../../../base/common/assert.js';
import type { IStringDictionary } from '../../../base/common/collections.js';
import type { Event } from '../../../base/common/event.js';
import * as types from '../../../base/common/types.js';
import type { UriComponents } from '../../../base/common/uri.js';
import { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IWorkspaceFolder } from '../../workspace/common/workspace.js';

export interface IConfigurationOverrides {
	readonly overrideIdentifier?: string | null;
	readonly resource?: URI | null;
}

export type IConfigurationUpdateOverrides = Omit<IConfigurationOverrides, 'overrideIdentifier'> & { readonly overrideIdentifiers?: string[] | null };

export const enum ConfigurationTarget {
	APPLICATION = 1,
	USER,
	USER_LOCAL,
	USER_REMOTE,
	WORKSPACE,
	WORKSPACE_FOLDER,
	DEFAULT,
	MEMORY,
}

export function ConfigurationTargetToString(target: ConfigurationTarget): string {
	switch (target) {
		case ConfigurationTarget.APPLICATION: return 'APPLICATION';
		case ConfigurationTarget.USER: return 'USER';
		case ConfigurationTarget.USER_LOCAL: return 'USER_LOCAL';
		case ConfigurationTarget.USER_REMOTE: return 'USER_REMOTE';
		case ConfigurationTarget.WORKSPACE: return 'WORKSPACE';
		case ConfigurationTarget.WORKSPACE_FOLDER: return 'WORKSPACE_FOLDER';
		case ConfigurationTarget.DEFAULT: return 'DEFAULT';
		case ConfigurationTarget.MEMORY: return 'MEMORY';
	}
}

export interface IConfigurationChange {
	readonly keys: string[];
	readonly overrides: [string, string[]][];
}

export interface IConfigurationChangeEvent {
	readonly source: ConfigurationTarget;
	readonly affectedKeys: ReadonlySet<string>;
	readonly change: IConfigurationChange;
	affectsConfiguration(configuration: string, overrides?: IConfigurationOverrides): boolean;
}

export interface IInspectValue<T> {
	readonly value?: T;
	readonly override?: T;
	readonly overrides?: { readonly identifiers: string[]; readonly value: T }[];
}

export interface IConfigurationValue<T> {
	readonly defaultValue?: T;
	readonly applicationValue?: T;
	readonly userValue?: T;
	readonly userLocalValue?: T;
	readonly userRemoteValue?: T;
	readonly workspaceValue?: T;
	readonly workspaceFolderValue?: T;
	readonly memoryValue?: T;
	readonly policyValue?: T;
	readonly value?: T;
	readonly default?: IInspectValue<T>;
	readonly application?: IInspectValue<T>;
	readonly user?: IInspectValue<T>;
	readonly userLocal?: IInspectValue<T>;
	readonly userRemote?: IInspectValue<T>;
	readonly workspace?: IInspectValue<T>;
	readonly workspaceFolder?: IInspectValue<T>;
	readonly memory?: IInspectValue<T>;
	readonly policy?: { readonly value?: T };
	readonly overrideIdentifiers?: string[];
}

export interface IConfigurationModel {
	readonly contents: IStringDictionary<unknown>;
	readonly keys: string[];
	readonly overrides: IOverrides[];
	readonly raw?: ReadonlyArray<IStringDictionary<unknown>> | IStringDictionary<unknown>;
}

export interface IOverrides {
	readonly keys: string[];
	readonly contents: IStringDictionary<unknown>;
	readonly identifiers: string[];
}

export interface IConfigurationData {
	readonly defaults: IConfigurationModel;
	readonly policy: IConfigurationModel;
	readonly application: IConfigurationModel;
	readonly userLocal: IConfigurationModel;
	readonly userRemote: IConfigurationModel;
	readonly workspace: IConfigurationModel;
	readonly folders: readonly [UriComponents, IConfigurationModel][];
}

export interface IConfigurationCompareResult {
	readonly added: string[];
	readonly removed: string[];
	readonly updated: string[];
	readonly overrides: [string, string[]][];
}

export function getConfigValueInTarget<T>(value: IConfigurationValue<T>, target: ConfigurationTarget): T | undefined {
	switch (target) {
		case ConfigurationTarget.APPLICATION: return value.applicationValue;
		case ConfigurationTarget.USER: return value.userValue;
		case ConfigurationTarget.USER_LOCAL: return value.userLocalValue;
		case ConfigurationTarget.USER_REMOTE: return value.userRemoteValue;
		case ConfigurationTarget.WORKSPACE: return value.workspaceValue;
		case ConfigurationTarget.WORKSPACE_FOLDER: return value.workspaceFolderValue;
		case ConfigurationTarget.DEFAULT: return value.defaultValue;
		case ConfigurationTarget.MEMORY: return value.memoryValue;
		default: return assertNever(target);
	}
}

export function isConfigured<T>(value: IConfigurationValue<T>): value is IConfigurationValue<T> & { value: T } {
	return value.applicationValue !== undefined
		|| value.userValue !== undefined
		|| value.userLocalValue !== undefined
		|| value.userRemoteValue !== undefined
		|| value.workspaceValue !== undefined
		|| value.workspaceFolderValue !== undefined;
}

export function isConfigurationOverrides(value: unknown): value is IConfigurationOverrides {
	if (!value || typeof value !== "object") return false;
	const candidate = value as IConfigurationOverrides;
	return (candidate.overrideIdentifier == null || typeof candidate.overrideIdentifier === "string")
		&& (candidate.resource == null || candidate.resource instanceof URI);
}

export function isConfigurationUpdateOverrides(value: unknown): value is IConfigurationUpdateOverrides {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as IConfigurationUpdateOverrides & IConfigurationOverrides;
	return (candidate.overrideIdentifiers == null || Array.isArray(candidate.overrideIdentifiers) && candidate.overrideIdentifiers.every(identifier => typeof identifier === 'string'))
		&& candidate.overrideIdentifier == null
		&& (candidate.resource == null || candidate.resource instanceof URI);
}

export interface IConfigurationUpdateOptions {
	readonly donotNotifyError?: boolean;
	readonly handleDirtyFile?: 'save' | 'revert';
}

export interface IConfigurationService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent>;
	getConfigurationData(): IConfigurationData | null;
	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>>;
	reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void>;
	keys(): { readonly default: string[]; readonly policy: string[]; readonly user: string[]; readonly workspace: string[]; readonly workspaceFolder: string[]; readonly memory?: string[] };
}

export function toValuesTree(properties: IStringDictionary<unknown>, conflictReporter: (message: string) => void): IStringDictionary<unknown> {
	const root = Object.create(null) as IStringDictionary<unknown>;
	for (const key in properties) addToValueTree(root, key, properties[key], conflictReporter);
	return root;
}

export function addToValueTree(settingsTreeRoot: IStringDictionary<unknown>, key: string, value: unknown, conflictReporter: (message: string) => void): void {
	const segments = key.split('.');
	const last = segments.pop()!;
	let current = settingsTreeRoot;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]!;
		let entry = current[segment];
		switch (typeof entry) {
			case 'undefined':
				entry = Object.create(null) as IStringDictionary<unknown>;
				current[segment] = entry;
				break;
			case 'object':
				if (entry === null) {
					conflictReporter(`Ignoring ${key} as ${segments.slice(0, index + 1).join('.')} is null`);
					return;
				}
				break;
			default:
				conflictReporter(`Ignoring ${key} as ${segments.slice(0, index + 1).join('.')} is ${JSON.stringify(entry)}`);
				return;
		}
		current = entry as IStringDictionary<unknown>;
	}
	try {
		current[last] = value;
	} catch {
		conflictReporter(`Ignoring ${key} as ${segments.join('.')} is ${JSON.stringify(current)}`);
	}
}

export function removeFromValueTree(valueTree: IStringDictionary<unknown>, key: string): void {
	removeValue(valueTree, key.split('.'));
}

function removeValue(valueTree: IStringDictionary<unknown> | unknown, segments: string[]): void {
	if (!valueTree) return;
	const valueTreeRecord = valueTree as IStringDictionary<unknown>;
	const first = segments.shift()!;
	if (segments.length === 0) {
		delete valueTreeRecord[first];
		return;
	}
	if (!Object.keys(valueTreeRecord).includes(first)) return;
	const value = valueTreeRecord[first];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
	removeValue(value, segments);
	if (Object.keys(value).length === 0) delete valueTreeRecord[first];
}

export function getConfigurationValue<T>(config: IStringDictionary<unknown>, settingPath: string): T | undefined;
export function getConfigurationValue<T>(config: IStringDictionary<unknown>, settingPath: string, defaultValue: T): T;
export function getConfigurationValue<T>(config: IStringDictionary<unknown>, settingPath: string, defaultValue?: T): T | undefined {
	let current: unknown = config;
	for (const component of settingPath.split('.')) {
		if (typeof current !== 'object' || current === null) return defaultValue;
		current = (current as IStringDictionary<unknown>)[component];
	}
	return current === undefined ? defaultValue : current as T;
}

export function merge(base: IStringDictionary<unknown>, add: IStringDictionary<unknown>, overwrite: boolean): void {
	for (const key of Object.keys(add)) {
		if (key === '__proto__') continue;
		if (!(key in base)) {
			base[key] = add[key];
			continue;
		}
		if (types.isObject(base[key]) && types.isObject(add[key])) {
			merge(base[key] as IStringDictionary<unknown>, add[key] as IStringDictionary<unknown>, overwrite);
		} else if (overwrite) {
			base[key] = add[key];
		}
	}
}

export function getLanguageTagSettingPlainKey(settingKey: string): string {
	return settingKey.replace(/^\[/, '').replace(/]$/g, '').replace(/]\[/g, ', ');
}

export const IConfigurationService = createServiceIdentifier<IConfigurationService>('configurationService');
