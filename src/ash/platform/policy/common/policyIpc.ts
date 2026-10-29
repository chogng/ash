import { Emitter, type Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { PolicyValue } from '../../../base/common/policy.js';
import { AbstractPolicyService, validatePolicyDefinitions, validatePolicyValues, type IPolicyService } from './policy.js';

/** Exposes definition registration and read-only policy snapshots through trusted Main IPC. */
export class PolicyChannel implements IServerChannel {
	private readonly lifetime = new DisposableStore();
	private readonly changed: Event<Record<string, PolicyValue | null>>;
	constructor(private readonly service: IPolicyService) {
		const changes = this.lifetime.add(new Emitter<Record<string, PolicyValue | null>>());
		this.changed = changes.event;
		this.lifetime.add(service.onDidChange(names => changes.fire(Object.fromEntries(names.map(name => [name, service.getPolicyValue(name) ?? null])))));
	}
	call<T>(_: unknown, command: string, argument: unknown): Promise<T> {
		if (command !== 'updatePolicyDefinitions') throw new Error('Unknown policy command');
		return this.service.updatePolicyDefinitions(validatePolicyDefinitions(argument)) as Promise<T>;
	}
	listen<T>(_: unknown, event: string): Event<T> {
		if (event !== 'onDidChange') throw new Error('Unknown policy event');
		return this.changed as Event<T>;
	}
	dispose(): void {
		this.lifetime.dispose();
	}
	[Symbol.dispose](): void {
		this.dispose();
	}
}

/** The window caches immutable source snapshots, never system policy persistence. */
export class PolicyChannelClient extends AbstractPolicyService {
	private generation = 0;
	private readonly notified = new Map<string, number>();
	constructor(private readonly channel: IChannel) {
		super();
		this._register(
			channel.listen<unknown>('onDidChange')(candidate => {
				if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length > 4096) throw new TypeError('Invalid policy notification');
				const next = { ...this.policyValues };
				for (const [name, value] of Object.entries(candidate)) {
					if (value === null) delete next[name];
					else if (Object.hasOwn(this.policyDefinitions, name)) Object.defineProperty(next, name, { value, enumerable: true, configurable: true });
				}
				const values = validatePolicyValues(next, this.policyDefinitions);
				this.generation++;
				for (const name of Object.keys(candidate)) {
					if (Object.hasOwn(this.policyDefinitions, name)) this.notified.set(name, this.generation);
				}
				this.accept(values);
			}),
		);
	}
	protected async refresh(): Promise<void> {
		const generation = this.generation;
		// Account mapping functions remain in the window; Main needs scalar OS definitions only.
		const definitions = Object.fromEntries(Object.entries(this.policyDefinitions).map(([name, definition]) => [name, { type: definition.type }]));
		const values = validatePolicyValues(await this.channel.call<unknown>('updatePolicyDefinitions', definitions), this.policyDefinitions);
		// Retain newer notifications per key without losing unchanged values from the initial snapshot.
		for (const name of Object.keys(this.policyDefinitions)) {
			if ((this.notified.get(name) ?? 0) <= generation) continue;
			const current = this.getPolicyValue(name);
			if (current === undefined) delete values[name];
			else Object.defineProperty(values, name, { value: current, enumerable: true, configurable: true });
		}
		this.accept(values);
	}
}
