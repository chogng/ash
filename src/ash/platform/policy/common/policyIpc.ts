import { Emitter, type Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { PolicyValue } from '../../../base/common/policy.js';
import { AbstractPolicyService, PolicyValueSource, validatePolicyDefinitions, validatePolicyValues, type IPolicyService, type PolicyDefinition } from './policy.js';

type PolicySnapshot = Record<string, { value: PolicyValue; source: PolicyValueSource; } | null>;

/** Source metadata is validated with its value before either can replace the accepted snapshot. */
function readSnapshot(candidate: unknown, definitions: Record<string, PolicyDefinition>): PolicySnapshot {
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length > 4096) throw new TypeError('Invalid policy snapshot');
	const entries = Object.entries(candidate).filter(([name]) => Object.hasOwn(definitions, name));
	for (const [, entry] of entries) {
		if (entry === null) continue;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => key !== 'value' && key !== 'source') || !Object.values(PolicyValueSource).includes((entry as { source: PolicyValueSource; }).source)) throw new TypeError('Invalid policy source');
	}
	validatePolicyValues(Object.fromEntries(entries.filter(([, entry]) => entry !== null).map(([name, entry]) => [name, (entry as { value: unknown; }).value])), definitions);
	return Object.fromEntries(entries) as PolicySnapshot;
}

/** Exposes definition registration and read-only policy snapshots through trusted Main IPC. */
export class PolicyChannel implements IServerChannel {
	private readonly lifetime = new DisposableStore();
	private readonly changed: Event<PolicySnapshot>;
	constructor(private readonly service: IPolicyService) {
		const changes = this.lifetime.add(new Emitter<PolicySnapshot>());
		this.changed = changes.event;
		this.lifetime.add(service.onDidChange(names => changes.fire(this.snapshot(names))));
	}
	call<T>(_: unknown, command: string, argument: unknown): Promise<T> {
		if (command !== 'updatePolicyDefinitions') throw new Error('Unknown policy command');
		return this.service.updatePolicyDefinitions(validatePolicyDefinitions(argument)).then(() => this.snapshot(Object.keys(this.service.policyDefinitions))) as Promise<T>;
	}
	private snapshot(names: readonly string[]): PolicySnapshot {
		return Object.fromEntries(names.map(name => {
			const value = this.service.getPolicyValue(name);
			return [name, value === undefined ? null : { value, source: this.service.getPolicyValueSource(name)! }];
		}));
	}
	listen<T>(_: unknown, event: string): Event<T> {
		if (event !== 'onDidChange') throw new Error('Unknown policy event');
		return this.changed as Event<T>;
	}
	dispose(): void { this.lifetime.dispose(); }
	[Symbol.dispose](): void { this.dispose(); }
}

/** The window caches immutable source snapshots, never system policy persistence. */
export class PolicyChannelClient extends AbstractPolicyService {
	private generation = 0;
	private readonly notified = new Map<string, number>();
	constructor(private readonly channel: IChannel) {
		super();
		this._register(channel.listen<unknown>('onDidChange')(candidate => {
			const snapshot = readSnapshot(candidate, this.policyDefinitions);
			const next = { ...this.policyValues };
			const sources = Object.fromEntries(Object.keys(next).map(name => [name, this.getPolicyValueSource(name)!]));
			for (const [name, entry] of Object.entries(snapshot)) {
				if (entry === null) { delete next[name]; delete sources[name]; }
				else {
					Object.defineProperty(next, name, { value: entry.value, enumerable: true, configurable: true });
					Object.defineProperty(sources, name, { value: entry.source, enumerable: true, configurable: true });
				}
			}
			this.generation++;
			for (const name of Object.keys(snapshot)) {
				this.notified.set(name, this.generation);
			}
			this.accept(next, sources);
		}));
	}
	protected async refresh(): Promise<void> {
		const generation = this.generation;
		// Account mapping functions remain in the window; Main needs scalar OS definitions only.
		const definitions = Object.fromEntries(Object.entries(this.policyDefinitions).map(([name, definition]) => [name, { type: definition.type }]));
		const snapshot = readSnapshot(await this.channel.call<unknown>('updatePolicyDefinitions', definitions), this.policyDefinitions);
		const values: Record<string, PolicyValue> = {};
		const sources: Record<string, PolicyValueSource> = {};
		for (const [name, entry] of Object.entries(snapshot)) {
			if (entry === null) continue;
			Object.defineProperty(values, name, { value: entry.value, enumerable: true, configurable: true });
			Object.defineProperty(sources, name, { value: entry.source, enumerable: true, configurable: true });
		}
		// Retain newer notifications per key without losing unchanged values from the initial snapshot.
		for (const name of Object.keys(this.policyDefinitions)) {
			if ((this.notified.get(name) ?? 0) <= generation) continue;
			const current = this.getPolicyValue(name);
			if (current === undefined) { delete values[name]; delete sources[name]; }
			else {
				Object.defineProperty(values, name, { value: current, enumerable: true, configurable: true });
				Object.defineProperty(sources, name, { value: this.getPolicyValueSource(name)!, enumerable: true, configurable: true });
			}
		}
		this.accept(values, sources);
	}
}
