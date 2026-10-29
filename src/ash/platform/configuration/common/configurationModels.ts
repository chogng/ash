import type { IStringDictionary } from '../../../base/common/collections.js';
import type { ILogService } from '../../log/common/log.js';
import { getConfigurationValue, type IConfigurationModel, type IOverrides } from './configuration.js';
import { parseJsonDocument, type JsonParseError } from '../../../base/common/json.js';
import { validateJsonValue } from '../../../base/common/jsonValue.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { toValuesTree } from './configuration.js';
import { Extensions, ConfigurationScope, overrideIdentifiersFromKey, type IConfigurationRegistry } from './configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../files/common/files.js';
import type { IExtUri } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';

export interface ConfigurationParseOptions {
	skipUnregistered?: boolean;
	scopes?: ConfigurationScope[];
	include?: string[];
	exclude?: string[];
}

/** Converts the plain JSONC resource into a model without importing any transport contract. */
export class ConfigurationModelParser {
	private model: ConfigurationModel;
	private raw: IStringDictionary<unknown> = {};
	private parseErrors: readonly JsonParseError[] = [];

	constructor(private readonly name: string, private readonly logService: ILogService) {
		this.model = ConfigurationModel.createEmptyModel(logService);
	}

	get configurationModel(): ConfigurationModel { return this.model; }
	get errors(): readonly JsonParseError[] { return this.parseErrors; }

	parse(content: string | null | undefined, options: ConfigurationParseOptions = {}): void {
		if (content === null || content === undefined) return;
		if (content.length > 4 * 1024 * 1024) throw new TypeError('configuration source is too large');
		const parsed = parseJsonDocument(content.trim() ? content : '{}', { allowComments: true, allowTrailingComma: true });
		this.parseErrors = parsed.errors;
		if (this.parseErrors.length) return;
		const value = parsed.value;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError('configuration source must be an object');
		}
		const validated: IStringDictionary<unknown> = {};
		for (const [key, candidate] of Object.entries(value)) {
			const identifiers = overrideIdentifiersFromKey(key);
			const values = identifiers.length ? candidate : { [key]: candidate };
			if (values === null || typeof values !== 'object' || Array.isArray(values)) {
				throw new TypeError(`configuration source.${key} must be an object`);
			}
			const properties: IStringDictionary<unknown> = {};
			for (const [setting, entry] of Object.entries(values)) {
				if (!/^[A-Za-z][A-Za-z0-9./-]{0,127}$/u.test(setting)) throw new TypeError(`invalid configuration key: ${setting}`);
				properties[setting] = validateJsonValue(entry, { path: `${this.name}.${key}.${setting}` });
			}
			validated[key] = identifiers.length ? properties : properties[key];
		}
		this.parseRaw(validated, options);
	}

	parseRaw(raw: IStringDictionary<unknown>, options: ConfigurationParseOptions = {}): void {
		this.raw = raw;
		this.parseErrors = [];
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const include = (key: string): boolean => {
			if (options.exclude?.includes(key)) return false;
			if (options.include?.includes(key)) return true;
			const property = registry.getConfiguration(key);
			return (!options.skipUnregistered || property !== undefined) &&
				(!options.scopes || property?.scope === undefined || options.scopes.includes(property.scope));
		};
		const selected: IStringDictionary<unknown> = {};
		const overrides: IOverrides[] = [];
		const report = (message: string) => this.logService.warn(this.name, message);
		for (const [key, value] of Object.entries(raw)) {
			const identifiers = overrideIdentifiersFromKey(key);
			if (identifiers.length) {
				const properties = Object.fromEntries(Object.entries(value as IStringDictionary<unknown>).filter(([setting]) => include(setting)));
				selected[key] = properties;
				overrides.push({ identifiers, keys: Object.keys(properties), contents: toValuesTree(properties, report) });
			} else if (include(key)) {
				selected[key] = value;
			}
		}
		const base = Object.fromEntries(Object.entries(selected).filter(([key]) => !key.startsWith('[')));
		const contents = toValuesTree(base, report);
		for (const [key, value] of Object.entries(selected)) {
			if (key.startsWith('[')) contents[key] = value;
		}
		this.model = new ConfigurationModel(contents, Object.keys(selected), overrides, undefined, this.logService);
	}

	reparse(options: ConfigurationParseOptions): void {
		this.parseRaw(this.raw, options);
	}
}

/** Watches and parses one file-service resource. Storage and revision checks belong to its provider. */
export class UserSettings extends Disposable {
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;
	private parser: ConfigurationModelParser;
	private loading: Promise<ConfigurationModel> | undefined;
	private generation = 0;

	constructor(
		private readonly resource: URI,
		private parseOptions: ConfigurationParseOptions,
		extUri: IExtUri,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();
		this.parser = new ConfigurationModelParser(resource.toString(), logService);
		this._register(fileService.watch(extUri.dirname(resource)));
		// Keep an exact-file watch as well: some hosts report content changes only on the file.
		this._register(fileService.watch(resource));
		this._register(fileService.onDidChangeFiles(event => {
			if (event.resources && !event.resources.some(candidate => extUri.isEqualOrParent(resource, candidate))) return;
			this.generation++;
			void this.loadConfiguration().then(() => {
				if (!this.isDisposed) this.changes.fire();
			}, error => logService.error('Could not reload user settings', error));
		}));
	}

	loadConfiguration(): Promise<ConfigurationModel> {
		this.assertNotDisposed();
		return this.loading ??= this.load().finally(() => { this.loading = undefined; });
	}

	private async load(): Promise<ConfigurationModel> {
		for (; ;) {
			const generation = this.generation;
			let content: string;
			try { content = (await this.fileService.readFile(this.resource)).content; }
			catch (error) {
				if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
				content = '{}';
			}
			const parser = new ConfigurationModelParser(this.resource.toString(), this.logService);
			parser.parse(content, this.parseOptions);
			if (generation !== this.generation) continue;
			if (parser.errors.length) throw new TypeError(`Settings JSONC is invalid: ${parser.errors[0]!.message}`);
			this.assertNotDisposed();
			this.parser = parser;
			return parser.configurationModel;
		}
	}

	reparse(parseOptions?: ConfigurationParseOptions): ConfigurationModel {
		if (parseOptions) {
			this.parseOptions = parseOptions;
			this.parser.reparse(parseOptions);
		}
		return this.parser.configurationModel;
	}
}

/** A normalized configuration snapshot. Combining models never changes an input snapshot. */
export class ConfigurationModel implements IConfigurationModel {

	private readonly data: IConfigurationModel;

	constructor(
		contents: IStringDictionary<unknown>,
		keys: string[],
		overrides: IOverrides[],
		raw: IStringDictionary<unknown> | ReadonlyArray<IStringDictionary<unknown> | ConfigurationModel> | undefined,
		private readonly logService: ILogService,
	) {
		const rawValues = raw === undefined ? undefined : Array.isArray(raw) ? raw : [raw];
		this.data = {
			contents: copyValue(contents) as IStringDictionary<unknown>,
			keys: [...keys],
			overrides: overrides.map(block => ({
				identifiers: [...block.identifiers],
				keys: [...block.keys],
				contents: copyValue(block.contents) as IStringDictionary<unknown>,
			})),
			...(rawValues === undefined ? {} : {
				raw: rawValues.flatMap(value => value instanceof ConfigurationModel
					? value.data.raw ?? value.contents
					: copyValue(value) as IStringDictionary<unknown>),
			}),
		};
	}

	static createEmptyModel(logService: ILogService): ConfigurationModel {
		return new ConfigurationModel({}, [], [], undefined, logService);
	}

	get contents(): IStringDictionary<unknown> {
		return this.data.contents;
	}

	get keys(): string[] {
		return [...this.data.keys];
	}

	get overrides(): IOverrides[] {
		return this.data.overrides.map(block => ({
			identifiers: [...block.identifiers],
			keys: [...block.keys],
			contents: block.contents,
		}));
	}

	getValue<V>(section: string | undefined): V | undefined {
		return section ? getConfigurationValue<V>(this.data.contents, section) : this.data.contents as V;
	}

	getOverrideValue<V>(section: string | undefined, overrideIdentifier: string): V | undefined {
		const matching = this.data.overrides.filter(block => block.identifiers.includes(overrideIdentifier));
		if (matching.length === 0) {
			return undefined;
		}
		// A language's own block wins over combined blocks, regardless of document order.
		const ordered = [
			...matching.filter(block => block.identifiers.length > 1),
			...matching.filter(block => block.identifiers.length === 1),
		];
		const contents = ordered.reduce<IStringDictionary<unknown>>((result, block) => combineValues(result, block.contents), {});
		return copyValue(section ? getConfigurationValue<V>(contents, section) : contents) as V | undefined;
	}

	override(identifier: string): ConfigurationModel {
		const contents = this.getOverrideValue<IStringDictionary<unknown>>(undefined, identifier);
		return contents === undefined ? this : new ConfigurationModel(
			combineValues(this.data.contents, contents),
			this.data.keys,
			this.data.overrides,
			this.data.raw,
			this.logService,
		);
	}

	merge(...others: ConfigurationModel[]): ConfigurationModel {
		let contents = this.data.contents;
		const keys = new Set(this.data.keys);
		const blocks = new Map(this.data.overrides.map(block => [JSON.stringify(block.identifiers), block]));
		for (const model of others) {
			contents = combineValues(contents, model.contents);
			for (const key of model.data.keys) {
				keys.add(key);
			}
			for (const block of model.data.overrides) {
				const identity = JSON.stringify(block.identifiers);
				const previous = blocks.get(identity);
				blocks.set(identity, previous ? {
					identifiers: block.identifiers,
					keys: [...new Set([...previous.keys, ...block.keys])],
					contents: combineValues(previous.contents, block.contents),
				} : block);
			}
		}
		const models = [this, ...others];
		const raw = models.some(model => model.data.raw !== undefined)
			? models.flatMap<IStringDictionary<unknown> | ConfigurationModel>(model => {
				const source = model.data.raw;
				return source === undefined ? [model] : Array.isArray(source) ? source : [source as IStringDictionary<unknown>];
			}) : undefined;
		return new ConfigurationModel(contents, [...keys], [...blocks.values()], raw, this.logService);
	}

	toJSON(): IConfigurationModel {
		return { contents: this.contents, keys: this.keys, overrides: this.overrides };
	}
}

function isDictionary(value: unknown): value is IStringDictionary<unknown> {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

function combineValues(base: IStringDictionary<unknown>, update: IStringDictionary<unknown>): IStringDictionary<unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(update)) {
		const previous = Object.hasOwn(result, key) ? result[key] : undefined;
		Object.defineProperty(result, key, {
			value: isDictionary(previous) && isDictionary(value) ? combineValues(previous, value) : value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return result;
}

// Only snapshots created here are known to be deeply immutable. An externally
// frozen container may still contain mutable children and must be copied.
const copiedValues = new WeakSet<object>();

function copyValue(value: unknown): unknown {
	if (value !== null && typeof value === 'object' && copiedValues.has(value)) return value;
	if (Array.isArray(value)) {
		const copy = Object.freeze(value.map(copyValue));
		copiedValues.add(copy);
		return copy;
	}
	if (isDictionary(value)) {
		const copy = Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyValue(entry)])));
		copiedValues.add(copy);
		return copy;
	}
	return value;
}
