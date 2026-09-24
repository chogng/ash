import { Emitter } from '../../../../base/common/event.js';
import { editJsonObjectProperty } from '../../../../base/common/json.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { ConfigurationTarget, isConfigurationOverrides, isConfigurationUpdateOverrides, type IConfigurationChange, type IConfigurationChangeEvent, type IConfigurationData, type IConfigurationModel, type IConfigurationOverrides, type IConfigurationService, type IConfigurationUpdateOptions, type IConfigurationUpdateOverrides, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { configurationOverrideValues, configurationValues, emptyConfigurationDocument, overrideKeyFromIdentifiers, type IConfigurationApi, type IConfigurationDocument, type IConfigurationSnapshot, validateConfigurationDocument, validateConfigurationSnapshot } from '../../../../platform/configuration/common/configurationIpc.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationResourceRevisionConflictError, type IConfigurationResourceService, type IConfigurationResourceSnapshot } from '../../../../platform/configuration/common/configurationResourceService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

export interface WorkbenchConfigurationServiceOptions {
	readonly api?: IConfigurationApi;
	readonly registry?: IConfigurationRegistry;
	readonly onError?: (error: unknown) => void;
}

interface ConfigurationState {
	readonly values: ReadonlyMap<string, unknown>;
	readonly overrides: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
}

interface ConfigurationOverrideBlock {
	readonly key: string;
	readonly identifiers: readonly string[];
	readonly values: ReadonlyMap<string, unknown>;
}

export class WorkbenchConfigurationService extends Disposable implements IConfigurationService, IConfigurationResourceService {
	readonly _serviceBrand = undefined;

	private readonly api: IConfigurationApi | undefined;
	private readonly registry: IConfigurationRegistry;
	private readonly onError: (error: unknown) => void;
	private readonly changeEmitter = this._register(new Emitter<IConfigurationChangeEvent>());
	private readonly resourceChangeEmitter = this._register(new Emitter<IConfigurationResourceSnapshot>());
	private readonly values = new Map<string, unknown>();
	private readonly configuredValues = new Map<string, unknown>();
	private readonly overrideValues = new Map<string, Map<string, unknown>>();
	private readonly overrideBlocks: ConfigurationOverrideBlock[] = [];
	private revision = 0;
	private document = emptyConfigurationDocument();
	private hasAuthoritativeSnapshot: boolean;
	private initialLoad: Promise<void> | undefined;

	readonly onDidChangeConfiguration = this.changeEmitter.event;
	readonly onDidChangeResource = this.resourceChangeEmitter.event;

	constructor(options: WorkbenchConfigurationServiceOptions = {}) {
		super();
		this.api = options.api;
		this.registry = options.registry ?? Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		this.onError = options.onError ?? (error => console.error('Failed to apply configuration', error));
		this.hasAuthoritativeSnapshot = this.api === undefined;
		this.rebuildValues();
		if (this.api) {
			const subscription = this.api.onDidChange(candidate => {
				try {
					this.acceptSnapshot(validateConfigurationSnapshot(candidate));
				} catch (error) {
					this.onError(error);
				}
			});
			this._register(toDisposable(() => subscription.dispose()));
		}
	}

	getConfigurationData(): IConfigurationData {
		const defaults = new Map<string, unknown>();
		for (const configuration of this.registry.getRegisteredConfigurations()) defaults.set(configuration.key, configuration.defaultValue);
		return Object.freeze({
			defaults: configurationModel(defaults),
			policy: emptyConfigurationModel(),
			application: emptyConfigurationModel(),
			userLocal: configurationModel(this.configuredValues, this.overrideBlocks),
			userRemote: emptyConfigurationModel(),
			workspace: emptyConfigurationModel(),
			folders: Object.freeze([]),
		});
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue<T>(sectionOrOverrides?: unknown, overrides?: unknown): T {
		const section = typeof sectionOrOverrides === 'string' ? sectionOrOverrides : undefined;
		if (sectionOrOverrides === undefined && overrides !== undefined) throw new TypeError('Configuration overrides require a configuration section');
		const resolvedOverrides = section === undefined ? sectionOrOverrides : overrides;
		if (resolvedOverrides !== undefined && !isConfigurationOverrides(resolvedOverrides)) throw new TypeError('Configuration overrides are invalid');
		assertNoResourceOverride(resolvedOverrides, 'Workbench configuration');
		if (section !== undefined) return this.resolveSection(section, resolvedOverrides) as T;
		const result: Record<string, unknown> = {};
		for (const key of this.registry.getConfigurations()) setConfigurationValue(result, key, this.resolveSection(key, resolvedOverrides));
		return result as T;
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	async updateValue(key: string, value: unknown, arg3?: unknown, arg4?: unknown, _options?: IConfigurationUpdateOptions): Promise<void> {
		const configuration = this.requireConfiguration(key);
		const { identifiers, overrides, target } = parseUpdateArguments(arg3, arg4);
		assertNoResourceOverride(overrides, 'Workbench configuration');
		if (target !== undefined && target !== ConfigurationTarget.USER && target !== ConfigurationTarget.USER_LOCAL) throw new Error(`Unable to write ${key} to target ${target}.`);
		const parsed = value === undefined ? undefined : configuration.parse(value);
		let serialized = parsed === undefined ? undefined : configuration.serialize(parsed);
		if (serialized === undefined && value !== undefined) throw new TypeError(`Configuration key '${key}' did not serialize to JSON`);
		if (equals(parsed, configuration.defaultValue)) serialized = undefined;
		if (this.api && !this.hasAuthoritativeSnapshot) await this.reloadConfiguration();
		let source = this.document.source;
		if (identifiers.length === 0) {
			source = editJsonObjectProperty(source, key, serialized);
		} else {
			const entries = configurationOverrideValues(validateConfigurationDocument({ version: 1, source }));
			const existingBlock = entries.find(entry => equalIdentifierSets(entry.identifiers, identifiers));
			const overrideKey = existingBlock?.key ?? overrideKeyFromIdentifiers(identifiers);
			const next = { ...existingBlock?.values } as Record<string, unknown>;
			if (serialized === undefined) delete next[key];
			else next[key] = serialized;
			source = editJsonObjectProperty(source, overrideKey, Object.keys(next).length === 0 ? undefined : next);
		}
		await this.writeDocument(validateConfigurationDocument({ version: 1, source }));
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>> {
		if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
		assertNoResourceOverride(overrides, 'Workbench configuration');
		const configuration = this.requireConfiguration(key);
		const hasBase = this.configuredValues.has(key);
		const base = this.configuredValues.get(key) as Readonly<T> | undefined;
		const matchingOverrides = overrides?.overrideIdentifier ? this.overrideValues.get(overrides.overrideIdentifier) : undefined;
		const hasOverride = matchingOverrides?.has(key) === true;
		const override = matchingOverrides?.get(key) as Readonly<T> | undefined;
		const userLocalValue = hasOverride ? override : hasBase ? base : undefined;
		const overrideEntries = this.overrideBlocks
			.filter(block => block.values.has(key))
			.map(block => Object.freeze({ identifiers: [...block.identifiers], value: block.values.get(key) as Readonly<T> }));
		const overrideIdentifiers = [...new Set(overrideEntries.flatMap(entry => entry.identifiers))];
		const userLocal = hasBase || hasOverride || overrideEntries.length > 0
			? Object.freeze({
				...(hasBase ? { value: base } : {}),
				...(hasOverride ? { override } : {}),
				...(overrideEntries.length > 0 ? { overrides: overrideEntries } : {}),
			})
			: undefined;
		return Object.freeze({
			defaultValue: configuration.defaultValue as Readonly<T>,
			...(userLocalValue === undefined ? {} : { userValue: userLocalValue, userLocalValue }),
			value: this.resolveSection(key, overrides) as Readonly<T>,
			default: Object.freeze({ value: configuration.defaultValue as Readonly<T> }),
			...(userLocal === undefined ? {} : { user: userLocal, userLocal }),
			...(overrideIdentifiers.length === 0 ? {} : { overrideIdentifiers: Object.freeze(overrideIdentifiers) as string[] }),
		});
	}

	async reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> {
		if (target !== undefined && target !== ConfigurationTarget.USER && target !== ConfigurationTarget.USER_LOCAL) {
			if (typeof target === 'number' && !isConfigurationTarget(target)) throw new TypeError(`Configuration target is invalid: ${target}`);
			throw new Error(`Unable to reload workbench configuration target ${typeof target === 'number' ? target : 'workspace folder'}.`);
		}
		if (!this.api) return;
		if (!this.initialLoad) this.initialLoad = this.api.read().then(candidate => this.acceptSnapshot(validateConfigurationSnapshot(candidate))).finally(() => { this.initialLoad = undefined; });
		await this.initialLoad;
	}

	keys(): { default: string[]; policy: string[]; user: string[]; workspace: string[]; workspaceFolder: string[]; memory?: string[] } {
		return {
			default: [...this.registry.getConfigurations()],
			policy: [],
			user: [...this.configuredValues.keys(), ...this.overrideBlocks.map(block => block.key)],
			workspace: [],
			workspaceFolder: [],
			memory: [],
		};
	}

	async read(): Promise<IConfigurationResourceSnapshot> {
		if (this.api && !this.hasAuthoritativeSnapshot) await this.reloadConfiguration();
		return this.resourceSnapshot();
	}

	async write(source: string, expectedRevision: number): Promise<IConfigurationResourceSnapshot> {
		if (typeof source !== 'string') throw new TypeError('Configuration resource source must be text');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Configuration resource revision must be a non-negative safe integer');
		if (this.api && !this.hasAuthoritativeSnapshot) await this.reloadConfiguration();
		if (expectedRevision !== this.revision) throw new ConfigurationResourceRevisionConflictError(expectedRevision, this.revision);
		const document = this.parseResourceSource(source);
		try {
			await this.writeDocument(document, expectedRevision);
		} catch (error) {
			if (isRevisionConflict(error)) throw new ConfigurationResourceRevisionConflictError(expectedRevision, undefined);
			throw error;
		}
		return this.resourceSnapshot();
	}

	private resolveSection(section: string, overrides?: IConfigurationOverrides): unknown {
		const exact = this.registry.getConfiguration(section);
		if (exact) {
			const override = overrides?.overrideIdentifier ? this.overrideValues.get(overrides.overrideIdentifier) : undefined;
			return override?.has(section) ? override.get(section) : this.values.get(section);
		}
		const result: Record<string, unknown> = {};
		let found = false;
		for (const key of this.registry.getConfigurations()) {
			if (!key.startsWith(`${section}.`)) continue;
			setConfigurationValue(result, key.slice(section.length + 1), this.resolveSection(key, overrides));
			found = true;
		}
		return found ? result : undefined;
	}

	private async writeDocument(document: IConfigurationDocument, expectedRevision = this.revision): Promise<void> {
		if (!this.api) {
			if (expectedRevision !== this.revision) throw new ConfigurationResourceRevisionConflictError(expectedRevision, this.revision);
			this.acceptSnapshot({ revision: this.revision + 1, document });
			return;
		}
		const result = await this.api.update({ expectedRevision, document });
		this.acceptSnapshot(validateConfigurationSnapshot(result));
	}

	private acceptSnapshot(snapshot: IConfigurationSnapshot): void {
		if (!this.hasAuthoritativeSnapshot) {
			this.hasAuthoritativeSnapshot = true;
			this.applySnapshot(snapshot);
			return;
		}
		if (snapshot.revision < this.revision) return;
		if (snapshot.revision === this.revision && serializeDocument(snapshot.document) === serializeDocument(this.document)) return;
		if (snapshot.revision === this.revision) throw new Error('Configuration changed without advancing its revision');
		this.applySnapshot(snapshot);
	}

	private applySnapshot(snapshot: IConfigurationSnapshot): void {
		const previous = this.snapshot();
		const change = changedConfiguration(this.document, snapshot.document);
		this.revision = snapshot.revision;
		this.document = snapshot.document;
		this.rebuildValues();
		this.resourceChangeEmitter.fire(this.resourceSnapshot());
		if (change.keys.length === 0 && change.overrides.length === 0) return;
		this.changeEmitter.fire(configurationChangeEvent(change, previous, this.snapshot(), this.registry));
	}

	private rebuildValues(): void {
		this.values.clear();
		this.configuredValues.clear();
		this.overrideValues.clear();
		this.overrideBlocks.length = 0;
		const configured = configurationValues(this.document);
		for (const configuration of this.registry.getRegisteredConfigurations()) {
			const candidate = configured[configuration.key];
			if (candidate === undefined) {
				this.values.set(configuration.key, configuration.defaultValue);
				continue;
			}
			const value = this.parseConfigurationValue(configuration, candidate);
			this.configuredValues.set(configuration.key, value);
			this.values.set(configuration.key, value);
		}
		for (const entry of configurationOverrideValues(this.document)) {
			const blockValues = new Map<string, unknown>();
			for (const [key, candidate] of Object.entries(entry.values)) {
				const configuration = this.registry.getConfiguration(key);
				if (configuration) blockValues.set(key, this.parseConfigurationValue(configuration, candidate));
			}
			this.overrideBlocks.push({ key: entry.key, identifiers: [...entry.identifiers], values: blockValues });
			for (const identifier of entry.identifiers) {
				const values = this.overrideValues.get(identifier) ?? new Map<string, unknown>();
				for (const [key, candidate] of blockValues) values.set(key, candidate);
				this.overrideValues.set(identifier, values);
			}
		}
	}

	private snapshot(): ConfigurationState {
		return {
			values: new Map(this.values),
			overrides: new Map([...this.overrideValues].map(([identifier, values]) => [identifier, new Map(values)])),
		};
	}

	private parseConfigurationValue(configuration: IRegisteredConfiguration, value: unknown): unknown {
		try {
			return configuration.parse(value);
		} catch (error) {
			this.onError(new Error(`Invalid configuration value for '${configuration.key}'`, { cause: error }));
			return configuration.defaultValue;
		}
	}

	private requireConfiguration(key: string): IRegisteredConfiguration {
		const configuration = this.registry.getConfiguration(key);
		if (!configuration) throw new Error(`Unknown configuration key: ${key}`);
		return configuration;
	}

	private parseResourceSource(source: string): IConfigurationDocument {
		let document: IConfigurationDocument;
		try {
			document = validateConfigurationDocument({ version: 1, source });
		} catch (error) {
			throw new TypeError(`Settings JSONC is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const [key, value] of Object.entries(configurationValues(document))) this.validateRegisteredValue(key, value);
		for (const entry of configurationOverrideValues(document)) for (const [key, value] of Object.entries(entry.values)) this.validateRegisteredValue(key, value);
		return document;
	}

	private validateRegisteredValue(key: string, value: unknown): void {
		const configuration = this.registry.getConfiguration(key);
		if (!configuration) return;
		try {
			configuration.serialize(configuration.parse(value));
		} catch (error) {
			throw new TypeError(`Invalid configuration value for '${key}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private resourceSnapshot(): IConfigurationResourceSnapshot {
		return Object.freeze({ source: this.document.source, revision: this.revision });
	}
}

function configurationChangeEvent(
	change: IConfigurationChange,
	previous: ConfigurationState,
	current: ConfigurationState,
	registry: IConfigurationRegistry,
): IConfigurationChangeEvent {
	const affectedKeys = new Set([...change.keys, ...change.overrides.flatMap(([, keys]) => keys)]);
	return Object.freeze({
		source: ConfigurationTarget.USER_LOCAL,
		affectedKeys,
		change,
		affectsConfiguration(configuration: string, overrides?: IConfigurationOverrides): boolean {
			if (overrides !== undefined && !isConfigurationOverrides(overrides)) throw new TypeError('Configuration overrides are invalid');
			assertNoResourceOverride(overrides, 'Workbench configuration');
			if (![...affectedKeys].some(key => key === configuration || key.startsWith(`${configuration}.`))) return false;
			if (!overrides) return true;
			const before = resolveSection(previous, registry, configuration, overrides.overrideIdentifier);
			const after = resolveSection(current, registry, configuration, overrides.overrideIdentifier);
			return !equals(before, after);
		},
	});
}

function changedConfiguration(previous: IConfigurationDocument, next: IConfigurationDocument): IConfigurationChange {
	const keys = changedKeys(configurationValues(previous), configurationValues(next));
	const previousOverrides = overrideMap(previous);
	const nextOverrides = overrideMap(next);
	const identifiers = new Set([...previousOverrides.keys(), ...nextOverrides.keys()]);
	const overrides: [string, string[]][] = [];
	for (const identifier of identifiers) {
		const changed = changedKeys(previousOverrides.get(identifier) ?? {}, nextOverrides.get(identifier) ?? {});
		if (changed.length > 0) overrides.push([identifier, changed]);
	}
	return Object.freeze({ keys, overrides });
}

function overrideMap(document: IConfigurationDocument): Map<string, Readonly<Record<string, unknown>>> {
	const result = new Map<string, Record<string, unknown>>();
	for (const entry of configurationOverrideValues(document)) {
		for (const identifier of entry.identifiers) {
			let values = result.get(identifier);
			if (!values) {
				values = {};
				result.set(identifier, values);
			}
			Object.assign(values, entry.values);
		}
	}
	return result;
}

function changedKeys(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): string[] {
	const result: string[] = [];
	for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) if (!equals(previous[key], next[key])) result.push(key);
	return result.sort();
}

function configurationModel(values: ReadonlyMap<string, unknown>, overrideBlocks: readonly ConfigurationOverrideBlock[] = []): IConfigurationModel {
	const contents: Record<string, unknown> = {};
	for (const [key, value] of values) setConfigurationValue(contents, key, value);
	for (const block of overrideBlocks) contents[block.key] = Object.fromEntries(block.values);
	return Object.freeze({
		contents: Object.freeze(contents),
		keys: [...values.keys(), ...overrideBlocks.map(block => block.key)],
		overrides: overrideBlocks.map(block => {
			const overrideContents: Record<string, unknown> = {};
			for (const [key, value] of block.values) setConfigurationValue(overrideContents, key, value);
			return Object.freeze({ identifiers: [...block.identifiers], keys: [...block.values.keys()], contents: Object.freeze(overrideContents) });
		}),
	});
}

function emptyConfigurationModel(): IConfigurationModel {
	return Object.freeze({ contents: Object.freeze({}), keys: [], overrides: [] });
}

function setConfigurationValue(target: Record<string, unknown>, key: string, value: unknown): void {
	const segments = key.split('.');
	let node = target;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index]!;
		const existing = node[segment];
		if (!existing || typeof existing !== 'object' || Array.isArray(existing)) node[segment] = {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments.at(-1)!] = value;
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

function isConfigurationTarget(value: number): value is ConfigurationTarget {
	return Number.isInteger(value) && value >= ConfigurationTarget.APPLICATION && value <= ConfigurationTarget.MEMORY;
}

function assertNoResourceOverride(overrides: IConfigurationOverrides | IConfigurationUpdateOverrides | undefined, owner: string): void {
	if (overrides?.resource != null) throw new Error(`${owner} does not support resource overrides.`);
}

function equalIdentifierSets(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((identifier, index) => identifier === sortedRight[index]);
}

function resolveSection(
	state: ConfigurationState,
	registry: IConfigurationRegistry,
	section: string,
	overrideIdentifier: string | null | undefined,
): unknown {
	if (registry.owns(section)) return resolveRegisteredValue(state, section, overrideIdentifier);
	const result: Record<string, unknown> = {};
	let found = false;
	for (const key of registry.getConfigurations()) {
		if (!key.startsWith(`${section}.`)) continue;
		setConfigurationValue(result, key.slice(section.length + 1), resolveRegisteredValue(state, key, overrideIdentifier));
		found = true;
	}
	return found ? result : undefined;
}

function resolveRegisteredValue(state: ConfigurationState, key: string, overrideIdentifier: string | null | undefined): unknown {
	if (overrideIdentifier != null) {
		const overrides = state.overrides.get(overrideIdentifier);
		if (overrides?.has(key)) return overrides.get(key);
	}
	return state.values.get(key);
}

function isRevisionConflict(error: unknown): boolean {
	return error instanceof Error && /revision conflict/i.test(error.message);
}

function serializeDocument(document: IConfigurationDocument): string {
	return JSON.stringify(document);
}
