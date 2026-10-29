import { Emitter } from '../../../base/common/event.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import type { IPolicyService, PolicyDefinition } from '../../policy/common/policy.js';
import type { ILogService } from '../../log/common/log.js';
import { ConfigurationModel } from './configurationModels.js';
import { toValuesTree } from './configuration.js';
import type { IConfigurationRegistry } from './configurationRegistry.js';
import { localize } from '../../../nls.js';

/** Converts current policy values through the same registered setting validators as user input. */
export class PolicyConfiguration extends Disposable {
	private readonly changes = this._register(new Emitter<ConfigurationModel>());
	readonly onDidChangeConfiguration = this.changes.event;
	private model: ConfigurationModel;
	private stopped = false;
	private definitionsReady: Promise<void> = Promise.resolve();
	private policyNames = new Map<string, string>();

	get configurationModel(): ConfigurationModel {
		return this.model;
	}

	constructor(
		private readonly registry: IConfigurationRegistry,
		private readonly policies: IPolicyService,
		private readonly log: ILogService,
		private readonly onError: (error: unknown) => void = error => log.error(getErrorMessage(error)),
	) {
		super();
		this.model = ConfigurationModel.createEmptyModel(log);
		this._register(policies.onDidChange(() => this.refreshValues()));
		this._register(
			registry.onDidUpdateConfiguration(() => {
				void this.initialize().catch(this.onError);
			}),
		);
	}

	async initialize(): Promise<ConfigurationModel> {
		const operation = this.definitionsReady.then(async () => {
			if (this.stopped) return;
			const definitions: Record<string, PolicyDefinition> = {};
			for (const setting of this.registry.getRegisteredConfigurations()) {
				if (setting.policy) {
					const type = typeof setting.defaultValue;
					if (type === 'boolean' || type === 'number' || type === 'string')
						definitions[setting.policy.name] = {
							type,
							...(setting.policy.managedSettings === undefined ? {} : { managedSettings: setting.policy.managedSettings }),
							...(setting.policy.value === undefined ? {} : { value: setting.policy.value }),
						};
				}
			}
			try {
				await this.policies.updatePolicyDefinitions(definitions);
			} catch (error) {
				this.onError(error);
			}
			// A host source may be temporarily unavailable. Its next notification recovers
			// the policy while configuration keeps the source's last accepted values.
			// Read live values after registration: policy notifications may arrive during initialization.
			this.refreshValues();
		});
		this.definitionsReady = operation.catch(() => {});
		await operation;
		return this.model;
	}

	private refreshValues(): void {
		if (this.stopped) return;
		const values: Record<string, unknown> = {};
		const names = new Map<string, string>();
		for (const setting of this.registry.getRegisteredConfigurations()) {
			if (!setting.policy) continue;
			try {
				const value = this.policies.getPolicyValue(setting.policy.name);
				if (value === undefined) continue;
				if (typeof value !== typeof setting.defaultValue || (typeof value === 'number' && !Number.isFinite(value))) {
					throw new TypeError(localize('configuration.invalidPolicy', 'Administrator policy {0} has an invalid value.', setting.policy.name));
				}
				values[setting.key] = setting.parse(value);
				names.set(setting.key, setting.policy.name);
			} catch (error) {
				this.onError(error);
				// Malformed input must not silently unlock an already managed setting.
				const previous = this.model.getValue(setting.key);
				if (previous !== undefined && this.policyNames.get(setting.key) === setting.policy.name) {
					try {
						values[setting.key] = setting.parse(previous);
						names.set(setting.key, setting.policy.name);
					} catch {
						/* The replacement setting no longer accepts the old policy. */
					}
				}
			}
		}
		const model = new ConfigurationModel(
			toValuesTree(values, message => this.log.error(message)),
			Object.keys(values),
			[],
			undefined,
			this.log,
		);
		this.policyNames = names;
		if (!equals(this.model.toJSON(), model.toJSON())) {
			this.model = model;
			this.changes.fire(model);
		}
	}

	override dispose(): void {
		this.stopped = true;
		super.dispose();
	}
}
