import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import type { IWorkspaceFolder } from '../../workspace/common/workspace.js';
import { Registry } from '../../registry/common/platform.js';
import {
	ConfigurationTarget,
	isConfigurationOverrides,
	isConfigurationUpdateOverrides,
	type IConfigurationChange,
	type IConfigurationChangeEvent,
	type IConfigurationData,
	type IConfigurationModel,
	type IConfigurationOverrides,
	type IConfigurationService,
	type IConfigurationUpdateOptions,
	type IConfigurationUpdateOverrides,
	type IConfigurationValue,
} from './configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from './configurationRegistry.js';

interface ConfigurationState {
	readonly values: ReadonlyMap<string, unknown>;
	readonly overrides: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
}

interface OverrideBlock {
	readonly identifiers: readonly string[];
	readonly values: Map<string, unknown>;
}

/** Mutable, process-local configuration used by standalone compositions without persisted settings. */
export class InMemoryConfigurationService extends Disposable implements IConfigurationService {
	public readonly _serviceBrand = undefined;

	private readonly values = new Map<string, unknown>();
	private readonly overrideValues = new Map<string, Map<string, unknown>>();
	private readonly overrideBlocks = new Map<string, OverrideBlock>();
	private readonly changeEmitter = this._register(new Emitter<IConfigurationChangeEvent>());
	public readonly onDidChangeConfiguration = this.changeEmitter.event;

	constructor(private readonly registry: IConfigurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)) {
		super();
	}

	public getValue<T>(): T;
	public getValue<T>(section: string): T;
	public getValue<T>(overrides: IConfigurationOverrides): T;
	public getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	public getValue<T>(arg1?: string | IConfigurationOverrides, arg2?: IConfigurationOverrides): T {
		this.assertNotDisposed();
		const section = typeof arg1 === 'string' ? arg1 : undefined;
		const overrides = typeof arg1 === 'string' ? arg2 : arg1;
		if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
		assertNoResourceOverride(overrides, 'In-memory configuration');
		return this.getSectionValue(this.currentState(), section, overrides?.overrideIdentifier) as T;
	}

	public updateValue(key: string, value: unknown): Promise<void>;
	public updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	public updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	public updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	public async updateValue(
		key: string,
		value: unknown,
		arg3?: unknown,
		arg4?: unknown,
		_options?: IConfigurationUpdateOptions,
	): Promise<void> {
		this.assertNotDisposed();
		const configuration = this.getRegisteredConfiguration(key);
		const { identifiers, overrides, target } = parseUpdateArguments(arg3, arg4);
		assertNoResourceOverride(overrides, 'In-memory configuration');
		if (target !== undefined && target !== ConfigurationTarget.MEMORY) throw new Error(`Unable to write ${key} to target ${target}.`);

		const normalizedValue = value === undefined ? undefined : normalizeValue(configuration, value);
		const previous = this.snapshot();
		const changedBaseKeys: string[] = [];
		const changedOverrides: [string, string[]][] = [];

		if (identifiers.length === 0) {
			if (this.updateMapValue(this.values, key, normalizedValue)) changedBaseKeys.push(key);
		} else {
			const blockKey = JSON.stringify(identifiers);
			let block = this.overrideBlocks.get(blockKey);
			if (!block && normalizedValue !== undefined) {
				block = { identifiers, values: new Map<string, unknown>() };
				this.overrideBlocks.set(blockKey, block);
			}
			if (block && this.updateMapValue(block.values, key, normalizedValue)) {
				if (block.values.size === 0) this.overrideBlocks.delete(blockKey);
				this.rebuildOverrideValues();
				for (const identifier of identifiers) changedOverrides.push([identifier, [key]]);
			}
		}

		if (changedBaseKeys.length === 0 && changedOverrides.length === 0) return;
		this.fireChange({ keys: changedBaseKeys, overrides: changedOverrides }, previous, this.snapshot());
	}

	public inspect<T>(key: string, overrides: IConfigurationOverrides = {}): IConfigurationValue<Readonly<T>> {
		this.assertNotDisposed();
		if (!isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
		assertNoResourceOverride(overrides, 'In-memory configuration');
		const configuration = this.getRegisteredConfiguration(key);
		const identifier = overrides.overrideIdentifier;
		const hasBaseValue = this.values.has(key);
		const baseValue = this.values.get(key) as Readonly<T> | undefined;
		const matchingOverride = identifier == null ? undefined : this.overrideValues.get(identifier);
		const hasOverrideValue = matchingOverride?.has(key) === true;
		const overrideValue = matchingOverride?.get(key) as Readonly<T> | undefined;
		const overrideEntries = this.getOverrideEntries<T>(key);
		const memoryValue = hasOverrideValue ? overrideValue : hasBaseValue ? baseValue : undefined;
		const value = memoryValue === undefined ? configuration.defaultValue as Readonly<T> : memoryValue;
		const memory = hasBaseValue || overrideEntries.length > 0
			? {
				...(hasBaseValue ? { value: baseValue } : {}),
				...(hasOverrideValue ? { override: overrideValue } : {}),
				...(overrideEntries.length > 0 ? { overrides: overrideEntries } : {}),
			}
			: undefined;

		return {
			defaultValue: configuration.defaultValue as Readonly<T>,
			value,
			default: { value: configuration.defaultValue as Readonly<T> },
			...(memoryValue === undefined ? {} : { memoryValue }),
			...(memory === undefined ? {} : { memory }),
			...(overrideEntries.length === 0 ? {} : { overrideIdentifiers: [...new Set(overrideEntries.flatMap(entry => entry.identifiers))] }),
		};
	}

	public async reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> {
		this.assertNotDisposed();
		if (target === undefined || target === ConfigurationTarget.MEMORY) return;
		if (typeof target === 'number' && !isConfigurationTarget(target)) throw new TypeError(`Configuration target is invalid: ${target}`);
		throw new Error(`Unable to reload in-memory configuration target ${typeof target === 'number' ? target : 'workspace folder'}.`);
	}

	public keys(): { default: string[]; policy: string[]; user: string[]; workspace: string[]; workspaceFolder: string[]; memory: string[] } {
		this.assertNotDisposed();
		const memory = new Set(this.values.keys());
		for (const values of this.overrideValues.values()) {
			for (const key of values.keys()) memory.add(key);
		}
		return {
			default: [...this.registry.getConfigurations()],
			policy: [],
			user: [],
			workspace: [],
			workspaceFolder: [],
			memory: [...memory],
		};
	}

	public getConfigurationData(): IConfigurationData {
		this.assertNotDisposed();
		const defaultKeys = [...this.registry.getConfigurations()];
		const defaults: IConfigurationModel = {
			contents: createConfigurationObject(defaultKeys, key => this.getRegisteredConfiguration(key).defaultValue),
			keys: defaultKeys,
			overrides: [],
		};
		const empty = (): IConfigurationModel => ({ contents: {}, keys: [], overrides: [] });
		return {
			defaults,
			policy: empty(),
			application: empty(),
			userLocal: empty(),
			userRemote: empty(),
			workspace: empty(),
			folders: [],
		};
	}

	protected override disposeCore(): void {
		this.values.clear();
		this.overrideValues.clear();
		this.overrideBlocks.clear();
		super.disposeCore();
	}

	private getRegisteredConfiguration(key: string): IRegisteredConfiguration {
		if (typeof key !== 'string' || key.length === 0) throw new TypeError('Configuration key must be a non-empty string');
		const configuration = this.registry.getConfiguration(key);
		if (!configuration) throw new ReferenceError(`Configuration key is not registered: ${key}`);
		return configuration;
	}

	private getSectionValue(state: ConfigurationState, section: string | undefined, identifier: string | null | undefined): unknown {
		if (section !== undefined && this.registry.owns(section)) return this.getRegisteredValue(state, section, identifier);
		const prefix = section === undefined ? '' : `${section}.`;
		const keys = this.registry.getConfigurations().filter(key => key.startsWith(prefix));
		if (keys.length === 0) return undefined;
		return createConfigurationObject(keys, key => this.getRegisteredValue(state, key, identifier), prefix);
	}

	private getRegisteredValue(state: ConfigurationState, key: string, identifier: string | null | undefined): unknown {
		if (identifier != null) {
			const values = state.overrides.get(identifier);
			if (values?.has(key)) return values.get(key);
		}
		if (state.values.has(key)) return state.values.get(key);
		return this.getRegisteredConfiguration(key).defaultValue;
	}

	private getOverrideEntries<T>(key: string): { identifiers: string[]; value: Readonly<T> }[] {
		const result: { identifiers: string[]; value: Readonly<T> }[] = [];
		for (const block of this.overrideBlocks.values()) {
			if (!block.values.has(key)) continue;
			result.push({ identifiers: [...block.identifiers], value: block.values.get(key) as Readonly<T> });
		}
		return result;
	}

	private rebuildOverrideValues(): void {
		this.overrideValues.clear();
		for (const block of this.overrideBlocks.values()) {
			for (const identifier of block.identifiers) {
				let values = this.overrideValues.get(identifier);
				if (!values) {
					values = new Map<string, unknown>();
					this.overrideValues.set(identifier, values);
				}
				for (const [key, value] of block.values) values.set(key, value);
			}
		}
	}

	private updateMapValue(values: Map<string, unknown>, key: string, value: unknown): boolean {
		if (value === undefined) return values.delete(key);
		if (values.has(key) && equals(values.get(key), value)) return false;
		values.set(key, value);
		return true;
	}

	private currentState(): ConfigurationState {
		return { values: this.values, overrides: this.overrideValues };
	}

	private snapshot(): ConfigurationState {
		return {
			values: new Map(this.values),
			overrides: new Map([...this.overrideValues].map(([identifier, values]) => [identifier, new Map(values)])),
		};
	}

	private fireChange(change: IConfigurationChange, previous: ConfigurationState, current: ConfigurationState): void {
		const affectedKeys = new Set(change.keys);
		for (const [, keys] of change.overrides) {
			for (const key of keys) affectedKeys.add(key);
		}
		const event: IConfigurationChangeEvent = {
			source: ConfigurationTarget.MEMORY,
			affectedKeys,
			change,
			affectsConfiguration: (section, overrides) => {
				if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
				assertNoResourceOverride(overrides, 'In-memory configuration');
				if (![...affectedKeys].some(key => key === section || key.startsWith(`${section}.`))) return false;
				if (!overrides) return true;
				const before = this.getSectionValue(previous, section, overrides.overrideIdentifier);
				const after = this.getSectionValue(current, section, overrides.overrideIdentifier);
				return !equals(before, after);
			},
		};
		this.changeEmitter.fire(event);
	}
}

interface ParsedUpdateArguments {
	readonly identifiers: string[];
	readonly overrides: IConfigurationUpdateOverrides | undefined;
	readonly target: ConfigurationTarget | undefined;
}

function parseUpdateArguments(arg3: unknown, arg4: unknown): ParsedUpdateArguments {
	let overrides: IConfigurationUpdateOverrides | undefined;
	if (arg3 !== undefined && typeof arg3 !== 'number') {
		if (Array.isArray(arg3)) throw new TypeError('Configuration update overrides are invalid');
		if (isConfigurationUpdateOverrides(arg3)) {
			overrides = { resource: arg3.resource, overrideIdentifiers: arg3.overrideIdentifiers };
		} else if (isConfigurationOverrides(arg3)) {
			overrides = { resource: arg3.resource, overrideIdentifiers: arg3.overrideIdentifier ? [arg3.overrideIdentifier] : undefined };
		} else {
			throw new TypeError('Configuration update overrides are invalid');
		}
	}
	if (overrides === undefined && arg4 !== undefined) throw new TypeError('Configuration target cannot be passed without configuration overrides');
	const target = (overrides === undefined ? arg3 : arg4) as unknown;
	if (target !== undefined && (typeof target !== 'number' || !isConfigurationTarget(target))) throw new TypeError(`Configuration target is invalid: ${String(target)}`);
	const identifiers = [...new Set(overrides?.overrideIdentifiers ?? [])].sort();
	return { identifiers, overrides, target };
}

function normalizeValue(configuration: IRegisteredConfiguration, value: unknown): unknown {
	const serialized = configuration.serialize(value);
	if (serialized === undefined) throw new TypeError(`Configuration key '${configuration.key}' did not serialize to a value`);
	return configuration.parse(serialized);
}

function isConfigurationTarget(value: number): value is ConfigurationTarget {
	return Number.isInteger(value) && value >= ConfigurationTarget.APPLICATION && value <= ConfigurationTarget.MEMORY;
}

function assertNoResourceOverride(overrides: IConfigurationOverrides | IConfigurationUpdateOverrides | undefined, owner: string): void {
	if (overrides?.resource != null) throw new Error(`${owner} does not support resource overrides.`);
}

function createConfigurationObject(keys: readonly string[], getValue: (key: string) => unknown, prefix = ''): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of keys) setConfigurationValue(result, key.slice(prefix.length), getValue(key));
	return result;
}

function setConfigurationValue(target: Record<string, unknown>, key: string, value: unknown): void {
	const segments = key.split('.');
	let current = target;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index]!;
		const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
		if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
			current = existing as Record<string, unknown>;
			continue;
		}
		const next: Record<string, unknown> = {};
		Object.defineProperty(current, segment, { configurable: true, enumerable: true, writable: true, value: next });
		current = next;
	}
	Object.defineProperty(current, segments.at(-1)!, { configurable: true, enumerable: true, writable: true, value });
}
