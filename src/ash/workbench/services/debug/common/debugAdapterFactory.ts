import type { IDebugAdapterProcessReadResult } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import type { DebugAdapterConnection } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import type { IDebugConfiguration, IDebugSession } from './debugService.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** Session-owned inline IO. DAP state and request pairing remain in DebugAdapterSession. */
export interface InlineDebugAdapter {
	send(message: unknown): Promise<void>;
	read(afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult>;
	close(): Promise<void>;
}

export type DebugAdapterDescriptor = DebugAdapterExecutable | {
	readonly inline: InlineDebugAdapter;
	readonly arguments: readonly string[];
	readonly connection?: never;
	readonly program?: never;
	readonly cwd?: never;
	readonly env?: never;
} | {
	readonly inline?: never;
	readonly connection: DebugAdapterConnection;
	readonly arguments: readonly string[];
	readonly program?: never;
	readonly cwd?: never;
	readonly env?: never;
};

export interface DebugAdapterExecutable {
	readonly inline?: never;
	readonly connection?: never;
	readonly program: string;
	readonly arguments: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | null>>;
}

/** One Debug domain factory contributed by a declarative package or executable Extension Host. */
export interface DebugAdapterFactory {
	readonly type: string;
	readonly label: string;
	readonly sourceId: string;
	createDebugAdapter?(): DebugAdapterDescriptor;
	/** Resolves invocation-dependent descriptors at dispatch, never during discovery. */
	createDebugAdapterDescriptor?(configuration: IDebugConfiguration, signal: AbortSignal, session: IDebugSession): PromiseLike<DebugAdapterDescriptor | undefined | null>;
}

export interface DebugAdapterFactorySource {
	readonly factories: readonly DebugAdapterFactory[];
	readonly onDidChange: Event<readonly DebugAdapterFactory[]>;
	get(type: string): DebugAdapterFactory | undefined;
}

export const IDebugAdapterFactorySource = createServiceIdentifier<DebugAdapterFactorySource>("debugAdapterFactorySource");

/** One caller-owned factory set that can be atomically replaced. */
export interface DebugAdapterFactoryRegistration extends IDisposable {
	replace(factories: readonly DebugAdapterFactory[]): void;
}

interface OwnedDebugAdapterFactory {
	readonly owner: object;
	readonly source: DebugAdapterFactory;
	readonly factory: DebugAdapterFactory;
}

/** Canonical multi-producer Debug Adapter factory registry. */
export class DebugAdapterFactoryRegistry extends Disposable implements DebugAdapterFactorySource {
	private readonly changeEmitter = this._register(new Emitter<readonly DebugAdapterFactory[]>());
	private readonly entries = new Map<string, readonly OwnedDebugAdapterFactory[]>();
	private factoriesValue: readonly DebugAdapterFactory[] = Object.freeze([]);

	readonly onDidChange: Event<readonly DebugAdapterFactory[]> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.entries.clear();
			this.factoriesValue = Object.freeze([]);
		}));
	}

	get factories(): readonly DebugAdapterFactory[] {
		this.assertNotDisposed();
		return this.factoriesValue;
	}

	get(type: string): DebugAdapterFactory | undefined {
		this.assertNotDisposed();
		const id = normalizeIdentifier(type, "Debug Adapter type");
		return this.factoriesValue.find(factory => factory.type === id);
	}

	registerFactories(factories: readonly DebugAdapterFactory[]): DebugAdapterFactoryRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replace(owner, factories);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			if (this.deleteOwner(owner) && !this.isDisposed) this.updateFactories();
		}) as DebugAdapterFactoryRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Debug Adapter factory registration is already disposed");
			this.assertNotDisposed();
			this.replace(owner, replacement);
		};
		return registration;
	}

	private replace(owner: object, factories: readonly DebugAdapterFactory[]): void {
		if (!Array.isArray(factories)) throw new TypeError("Debug Adapter factories must be an array");
		const normalized = factories.map(factory => {
			const existing = this.entries.get(factory.type)?.find(entry => entry.owner === owner && entry.source === factory);
			return existing?.owner === owner && existing.source === factory ? existing.factory : normalizeFactory(factory);
		});
		const roles = new Set<string>();
		for (const factory of normalized) {
			const dynamic = factory.createDebugAdapterDescriptor !== undefined;
			const role = JSON.stringify([factory.type, dynamic]);
			const conflicting = this.entries.get(factory.type)?.find(entry =>
				entry.owner !== owner && (entry.factory.createDebugAdapterDescriptor !== undefined) === dynamic);
			if (roles.has(role) || conflicting) {
				throw new Error(`Debug Adapter type '${factory.type}' is already registered by '${conflicting?.factory.sourceId ?? factory.sourceId}'`);
			}
			roles.add(role);
		}
		const previous = [...this.entries.values()].flat().filter(entry => entry.owner === owner);
		if (previous.length === normalized.length && normalized.every(factory => previous.some(entry => entry.factory === factory))) return;
		this.deleteOwner(owner);
		for (const [index, factory] of normalized.entries()) {
			this.entries.set(factory.type, [...(this.entries.get(factory.type) ?? []), { owner, source: factories[index]!, factory }]);
		}
		this.updateFactories();
	}

	private deleteOwner(owner: object): boolean {
		let changed = false;
		for (const [type, entries] of this.entries) {
			const retained = entries.filter(entry => entry.owner !== owner);
			if (retained.length === entries.length) continue;
			if (retained.length) this.entries.set(type, retained);
			else this.entries.delete(type);
			changed = true;
		}
		return changed;
	}

	private updateFactories(): void {
		const previous = this.factoriesValue;
		this.factoriesValue = Object.freeze([...this.entries].map(([type, entries]) => {
			const dynamic = entries.find(entry => entry.factory.createDebugAdapterDescriptor)?.factory;
			const fallback = entries.find(entry => !entry.factory.createDebugAdapterDescriptor)?.factory;
			if (!dynamic || !fallback) return (dynamic ?? fallback)!;
			// The registry is the sole owner of defaults and callbacks. A derived
			// descriptor lookup cannot make a default registration shadow its factory.
			const retained = previous.find(factory => factory.type === type
				&& factory.createDebugAdapter === fallback.createDebugAdapter
				&& factory.createDebugAdapterDescriptor === dynamic.createDebugAdapterDescriptor);
			return retained ?? Object.freeze({
				...dynamic, label: fallback.label, createDebugAdapter: fallback.createDebugAdapter,
			});
		}).sort((left, right) => left.type.localeCompare(right.type)));
		this.changeEmitter.fire(this.factoriesValue);
	}

}

export const DebugAdapterFactoriesRegistry = new DebugAdapterFactoryRegistry();

export function createStaticDebugAdapterFactory(type: string, label: string, sourceId: string, executable: DebugAdapterExecutable): DebugAdapterFactory {
	const normalizedExecutable = normalizeExecutable(executable, `Debug Adapter '${type}'`);
	return normalizeFactory({ type, label, sourceId, createDebugAdapter: () => normalizedExecutable });
}

function normalizeFactory(factory: DebugAdapterFactory): DebugAdapterFactory {
	if (!factory || typeof factory !== "object") throw new TypeError("Debug Adapter factory must be an object");
	const type = normalizeIdentifier(factory.type, "Debug Adapter type");
	const label = normalizeText(factory.label, "Debug Adapter label", 256);
	const sourceId = normalizeIdentifier(factory.sourceId, "Debug Adapter source ID");
	if (typeof factory.createDebugAdapter !== "function" && typeof factory.createDebugAdapterDescriptor !== "function") throw new TypeError(`Debug Adapter '${type}' must provide a factory`);
	return Object.freeze({
		type,
		label,
		sourceId,
		...(factory.createDebugAdapter ? { createDebugAdapter: () => normalizeDebugAdapterDescriptor(factory.createDebugAdapter!.call(factory), `Debug Adapter '${type}'`) } : {}),
		...(factory.createDebugAdapterDescriptor ? {
			createDebugAdapterDescriptor: async (configuration: IDebugConfiguration, signal: AbortSignal, session: IDebugSession) => {
				const descriptor = await factory.createDebugAdapterDescriptor!.call(factory, configuration, signal, session);
				return descriptor === undefined || descriptor === null ? undefined : normalizeDebugAdapterDescriptor(descriptor, `Debug Adapter '${type}'`);
			}
		} : {}),
	});
}

/** Validates a complete descriptor at the factory and Host callback boundaries. */
export function normalizeDebugAdapterDescriptor(value: unknown, owner: string): DebugAdapterDescriptor {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError(`${owner} descriptor must be an object`); }
	const input = value as Record<string, unknown>;
	if (input.inline !== undefined) {
		if (Object.keys(input).some(key => !['inline', 'arguments'].includes(key)) || !Array.isArray(input.arguments) || input.arguments.length !== 0) { throw new TypeError(`${owner} inline adapter cannot include executable options`); }
		const inline = input.inline as InlineDebugAdapter;
		if (!inline || typeof inline.send !== 'function' || typeof inline.read !== 'function' || typeof inline.close !== 'function') { throw new TypeError(`${owner} inline adapter requires owned IO`); }
		return Object.freeze({ inline, arguments: Object.freeze([]) });
	}
	if (input.connection !== undefined) {
		if (Object.keys(input).some(key => !['connection', 'arguments'].includes(key))) { throw new TypeError(`${owner} connection contains unknown fields`); }
		if (input.program !== undefined || input.cwd !== undefined || input.env !== undefined || input.arguments !== undefined && (!Array.isArray(input.arguments) || input.arguments.length !== 0)) { throw new TypeError(`${owner} connection cannot include executable options`); }
		if (!input.connection || typeof input.connection !== 'object' || Array.isArray(input.connection)) { throw new TypeError(`${owner} connection must be an object`); }
		const connection = input.connection as Record<string, unknown>;
		if (connection.type === 'server') {
			if (Object.keys(connection).some(key => !['type', 'port', 'host'].includes(key)) || !Number.isInteger(connection.port) || (connection.port as number) < 1 || (connection.port as number) > 65535) { throw new TypeError(`${owner} server port is invalid`); }
			const host = connection.host === undefined ? undefined : normalizeText(connection.host as string, `${owner} server host`, 256);
			return Object.freeze({ connection: Object.freeze({ type: 'server', port: connection.port as number, ...(host === undefined ? {} : { host }) }), arguments: Object.freeze([]) });
		}
		if (connection.type === 'namedPipe') {
			if (Object.keys(connection).some(key => !['type', 'path'].includes(key))) { throw new TypeError(`${owner} named pipe contains unknown fields`); }
			normalizeText(connection.path as string, `${owner} named pipe path`, 32768);
			const path = connection.path as string;
			return Object.freeze({ connection: Object.freeze({ type: 'namedPipe', path }), arguments: Object.freeze([]) });
		}
		throw new TypeError(`${owner} connection type is invalid`);
	}
	return normalizeExecutable(value as DebugAdapterExecutable, owner);
}

function normalizeExecutable(executable: DebugAdapterExecutable, owner: string): DebugAdapterExecutable {
	if (!executable || typeof executable !== "object") throw new TypeError(`${owner} executable must be an object`);
	const program = normalizeText(executable.program, `${owner} program`, 4096);
	if (!Array.isArray(executable.arguments)) throw new TypeError(`${owner} arguments must be an array`);
	const argumentsList = executable.arguments.map((argument, index) => {
		if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new TypeError(`${owner} argument ${index} must be a bounded string without NUL`);
		return argument;
	});
	if (argumentsList.length > 256) throw new RangeError(`${owner} has too many arguments`);
	const cwd = executable.cwd === undefined ? undefined : normalizeText(executable.cwd, `${owner} cwd`, 32768);
	const env = executable.env;
	if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 128 || Object.entries(env).some(([key, value]) => !key || key.length > 256 || /[=\0]/.test(key) || value !== null && (typeof value !== 'string' || value.length > 32768 || value.includes('\0'))))) throw new TypeError(`${owner} environment is invalid`);
	return Object.freeze({ program, arguments: Object.freeze(argumentsList), ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env: Object.freeze({ ...env }) }) });
}

function normalizeIdentifier(value: string, owner: string): string {
	return normalizeText(value, owner, 256);
}

function normalizeText(value: string, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} must contain 1 to ${maximum} characters without NUL`);
	return value.trim();
}
