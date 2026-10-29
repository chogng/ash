import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import type { IStringDictionary } from '../../../base/common/collections.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IPolicyData } from '../../../base/common/defaultAccount.js';
import type {
	IManagedSettingPolicyDefinition,
	IManagedSettingsPolicyDefinitions,
	PolicyValue,
} from '../../../base/common/policy.js';

export interface PolicyDefinition extends IManagedSettingPolicyDefinition {
	readonly managedSettings?: IManagedSettingsPolicyDefinitions;
	readonly value?: (data: IPolicyData) => PolicyValue | undefined;
}

/** Host-owned administrator policy. User and workspace settings cannot write to this service. */
export interface IPolicyService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<readonly string[]>;
	readonly policyDefinitions: IStringDictionary<PolicyDefinition>;
	updatePolicyDefinitions(definitions: IStringDictionary<PolicyDefinition>): Promise<IStringDictionary<PolicyValue>>;
	getPolicyValue(name: string): PolicyValue | undefined;
}

export const IPolicyService = createServiceIdentifier<IPolicyService>('policyService');

/** Owns source values; consumers register definitions but cannot supply policy values. */
export abstract class AbstractPolicyService extends Disposable implements IPolicyService {
	readonly _serviceBrand = undefined;
	private readonly changes = this._register(new Emitter<readonly string[]>());
	readonly onDidChange = this.changes.event;
	private definitions: IStringDictionary<PolicyDefinition> = {};
	private values: IStringDictionary<PolicyValue> = {};
	protected stopped = false;

	get policyDefinitions(): IStringDictionary<PolicyDefinition> {
		return this.definitions;
	}
	protected get policyValues(): Readonly<IStringDictionary<PolicyValue>> {
		return this.values;
	}

	async updatePolicyDefinitions(
		definitions: IStringDictionary<PolicyDefinition>,
	): Promise<IStringDictionary<PolicyValue>> {
		for (const [name, definition] of Object.entries(definitions)) {
			if (Object.hasOwn(this.definitions, name) && this.definitions[name]!.type !== definition.type)
				throw new TypeError(`Conflicting policy definition: ${name}`);
		}
		const next = { ...this.definitions, ...definitions };
		if (Object.keys(next).length > 4096) throw new TypeError('Too many policy definitions');
		if (!equals(next, this.definitions)) this.definitions = Object.freeze(next);
		await this.refresh();
		return { ...this.values };
	}

	getPolicyValue(name: string): PolicyValue | undefined {
		return Object.hasOwn(this.values, name) ? this.values[name] : undefined;
	}

	protected accept(values: IStringDictionary<PolicyValue>): void {
		if (this.stopped) return;
		const keys = new Set([...Object.keys(this.values), ...Object.keys(values)]);
		const changed = [...keys].filter(name => !Object.is(this.values[name], values[name]));
		this.values = Object.freeze({ ...values });
		if (changed.length) this.changes.fire(changed);
	}

	protected abstract refresh(): Promise<void>;

	override dispose(): void {
		this.stopped = true;
		super.dispose();
	}
}

/** Validate the whole IPC/source snapshot before replacing the last valid values. */
export function validatePolicyValues(
	value: unknown,
	definitions: IStringDictionary<PolicyDefinition>,
): IStringDictionary<PolicyValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 4096)
		throw new TypeError('Invalid policy values');
	const values: IStringDictionary<PolicyValue> = {};
	for (const [name, candidate] of Object.entries(value)) {
		const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
		if (!definition) continue;
		if (
			typeof candidate !== definition.type ||
			(typeof candidate === 'number' && !Number.isFinite(candidate)) ||
			(typeof candidate === 'string' && candidate.length > 1024 * 1024)
		)
			throw new TypeError(`Invalid policy value: ${name}`);
		Object.defineProperty(values, name, { value: candidate, enumerable: true, configurable: true });
	}
	return values;
}

export function validatePolicyDefinitions(value: unknown): IStringDictionary<PolicyDefinition> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 4096)
		throw new TypeError('Invalid policy definitions');
	const definitions: IStringDictionary<PolicyDefinition> = {};
	for (const [name, definition] of Object.entries(value)) {
		if (
			!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(name) ||
			!definition ||
			typeof definition !== 'object' ||
			Array.isArray(definition)
		)
			throw new TypeError('Invalid policy definition');
		const type = (definition as PolicyDefinition).type;
		if (!['string', 'number', 'boolean'].includes(type) || Object.keys(definition).some(key => key !== 'type'))
			throw new TypeError('Invalid policy definition type');
		Object.defineProperty(definitions, name, { value: Object.freeze({ type }), enumerable: true });
	}
	return definitions;
}

/** Explicit absence of a host policy source; never reads user-editable settings as policy. */
export class NullPolicyService implements IPolicyService {
	readonly _serviceBrand = undefined;
	readonly onDidChange = Event.None;
	readonly policyDefinitions = {};
	async updatePolicyDefinitions(): Promise<IStringDictionary<PolicyValue>> {
		return {};
	}
	getPolicyValue(): undefined {
		return undefined;
	}
}
