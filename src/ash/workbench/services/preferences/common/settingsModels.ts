import { isObject } from '../../../../base/common/types.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { JsonSchema } from '../../../../base/common/jsonSchema.js';
import { localize } from '../../../../nls.js';
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
	type IConfigurationSettingSchema,
	type IRegisteredConfiguration,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, getConfigValueInTarget, merge, type IConfigurationOverrides, type IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type {
	IBooleanSetting,
	INumberSetting,
	INumberWithOptionsSetting,
	ISelectSetting,
	ISetting,
	ISettingsEditorModel,
	ITextSetting,
	SettingReference,
	SettingsStatus,
	SettingValueBinding,
} from './preferences.js';

export interface SettingState<T> {
	readonly id: string;
	readonly value: T;
	readonly defaultValue: T;
	readonly isDefault: boolean;
	readonly isPending: boolean;
}

/** Resolves one addressable setting and emits only that setting's state changes. */
export class SettingModel<T> extends Disposable implements SettingReference {
	private readonly changeEmitter = this._register(new Emitter<SettingState<T>>());
	private value: T;
	private pending = false;
	// Only the last emitted status is cached; the binding owns the stored override.
	private lastIsDefault: boolean;

	public readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly binding: SettingValueBinding<T>) {
		super();
		this.value = binding.getValue();
		this.lastIsDefault = this.isDefault();
		if (binding.onDidChange) this._register(binding.onDidChange(() => this.refresh()));
	}

	public get id(): string {
		return this.binding.id;
	}

	public get state(): SettingState<T> {
		return {
			id: this.binding.id,
			value: this.value,
			defaultValue: this.binding.defaultValue,
			isDefault: this.isDefault(),
			isPending: this.pending,
		};
	}

	public isDefault(): boolean {
		return this.binding.isDefault?.() ?? Object.is(this.value, this.binding.defaultValue);
	}

	public async update(value: T): Promise<void> {
		if (this.pending) return;
		this.value = value;
		this.setPending(true);
		try {
			await this.binding.updateValue(value);
		} finally {
			this.value = this.binding.getValue();
			this.setPending(false);
		}
	}

	public async reset(): Promise<void> {
		if (this.pending) return;
		this.value = this.binding.defaultValue;
		this.setPending(true);
		try {
			await this.binding.resetValue();
		} finally {
			this.value = this.binding.getValue();
			this.setPending(false);
		}
	}

	public refresh(): void {
		const value = this.binding.getValue();
		// Presence changes matter even when an explicit override equals the default.
		const isDefault = this.binding.isDefault?.() ?? Object.is(value, this.binding.defaultValue);
		if (Object.is(value, this.value) && isDefault === this.lastIsDefault) return;
		this.value = value;
		this.emitState();
	}

	private setPending(pending: boolean): void {
		if (pending === this.pending) return;
		this.pending = pending;
		this.emitState();
	}

	private emitState(): void {
		const state = this.state;
		this.lastIsDefault = state.isDefault;
		this.changeEmitter.fire(state);
	}
}

export function configurationSettingBinding<T>(
	configurationService: IConfigurationService,
	configuration: IRegisteredConfiguration<T>,
	overrides: IConfigurationOverrides = {},
	target = ConfigurationTarget.USER_LOCAL,
): SettingValueBinding<T> {
	// Each control owns an immutable address. A late save must not follow a pane's new target.
	const address = { ...overrides };
	const inspect = () => configurationService.inspect<T>(configuration.key, address);
	const configuredValue = (): Readonly<T> | undefined => {
		const value = inspect();
		if (!address.overrideIdentifier) return getConfigValueInTarget(value, target);
		const layer = target === ConfigurationTarget.WORKSPACE_FOLDER ? value.workspaceFolder : target === ConfigurationTarget.WORKSPACE ? value.workspace : value.userLocal;
		return layer?.override;
	};
	return {
		id: configuration.key,
		defaultValue: inspect().defaultValue! as T,
		onDidChange: listener =>
			configurationService.onDidChangeConfiguration(event => {
				// Catalog withdrawal can notify configuration consumers before the editor releases controls.
				if (event.affectsConfiguration(configuration.key) && configurationService.keys().default.includes(configuration.key)) listener();
			}),
		getValue: () => {
			const value = inspect();
			if (value.policyValue !== undefined) return value.policyValue as T;
			const selected = configuredValue() === undefined ? undefined : getConfigValueInTarget(value, target);
			if (isObject(value.defaultValue) && isObject(selected)) {
				const combined = structuredClone(value.defaultValue) as Record<string, unknown>;
				merge(combined, selected as Record<string, unknown>, true);
				return combined as T;
			}
			return (selected === undefined ? value.defaultValue : selected) as T;
		},
		isDefault: () => configuredValue() === undefined,
		updateValue: value => configurationService.updateValue(configuration.key, value, address, target),
		resetValue: () => configurationService.updateValue(configuration.key, undefined, address, target),
	};
}

/** Projects registered configuration schemas into Settings-domain entries. */
export class DefaultSettings {
	private readonly settings = new Map<string, ISetting>();

	constructor(registry: IConfigurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)) {
		for (const configuration of registry.getRegisteredConfigurations()) {
			const numeric = !configuration.setting && configuration.source ? contributedNumberSetting(configuration) : undefined;
			if (numeric) {
				this.settings.set(configuration.key, numeric);
				continue;
			}
			const schema = configuration.setting ?? (configuration.source ? contributedSettingSchema(configuration) : undefined);
			if (schema) {
				this.settings.set(configuration.key, registeredSetting(configuration, schema));
			} else if (configuration.source) {
				this.settings.set(configuration.key, {
					...contributedSettingCopy(configuration),
					valueType: 'complex',
					configuration,
				});
			}
		}
	}

	public get all(): readonly ISetting[] {
		return [...this.settings.values()].filter(setting => setting.configuration.setting?.included !== false);
	}

	public get(key: string): ISetting {
		const setting = this.settings.get(key);
		if (!setting) throw new RangeError(`Configuration '${key}' does not declare Settings metadata`);
		return setting;
	}
}

/** Keep nullable numbers and numeric-or-enum unions editable without changing their persisted schema. */
function contributedNumberSetting(configuration: IRegisteredConfiguration): INumberWithOptionsSetting | undefined {
	const schema = configuration.schema;
	if (!schema || schema.enum) return undefined;
	let numeric: JsonSchema | undefined;
	const options: { value: string | null; label: string }[] = [];
	for (const branch of schema.anyOf ?? [schema]) {
		if (branch.anyOf || branch.oneOf || branch.$ref) return undefined;
		const types = Array.isArray(branch.type) ? branch.type : [branch.type];
		for (const type of types) {
			if (type === 'integer' || type === 'number') {
				// Multiple numeric branches can describe disjoint ranges; leave those to the JSON editor.
				if (numeric || branch.enum) return undefined;
				numeric = { ...branch, type };
			} else if (type === 'null') {
				options.push({
					value: null,
					label: localize({ bundle: 'ash.settings', key: 'number.automatic' }, 'Automatic'),
				});
			} else if (type === 'string' && branch.enum?.length && branch.enum.every(value => typeof value === 'string')) {
				for (const [index, value] of branch.enum.entries()) {
					options.push({ value: value as string, label: branch.enumDescriptions?.[index] ?? String(value) });
				}
			} else {
				return undefined;
			}
		}
	}
	if (!numeric || !options.length) return undefined;
	return {
		...contributedSettingCopy(configuration),
		valueType: 'numberWithOptions',
		configuration: configuration as IRegisteredConfiguration<number | string | null>,
		minimum: Math.max(schema.minimum ?? -Number.MAX_VALUE, numeric.minimum ?? -Number.MAX_VALUE),
		maximum: Math.min(schema.maximum ?? Number.MAX_VALUE, numeric.maximum ?? Number.MAX_VALUE),
		integer: numeric.type === 'integer',
		options: options.filter((option, index) => options.findIndex(candidate => candidate.value === option.value) === index),
	};
}

/** Standard extension schemas use the same controls as product settings. */
function contributedSettingSchema(configuration: IRegisteredConfiguration): IConfigurationSettingSchema | undefined {
	const schema = configuration.schema;
	if (!schema) return undefined;
	const base = contributedSettingCopy(configuration);
	if (schema.enum?.length && schema.enum.every(value => typeof value === 'string' || typeof value === 'boolean')) {
		return {
			...base,
			valueType: 'select',
			options: schema.enum.map(value => ({ value: value as string | boolean, label: String(value) })),
		};
	}
	switch (schema.type) {
		case 'boolean':
			return { ...base, valueType: 'boolean' };
		case 'integer':
		case 'number':
			return {
				...base,
				valueType: 'number',
				minimum: schema.minimum ?? -Number.MAX_VALUE,
				maximum: schema.maximum ?? Number.MAX_VALUE,
			};
		case 'string':
			return { ...base, valueType: 'text', placeholder: '' };
		default:
			return undefined;
	}
}

function contributedSettingCopy(configuration: IRegisteredConfiguration): {
	id: string;
	title: string;
	description: string;
	keywords: readonly string[];
	tags?: readonly string[];
} {
	return {
		id: configuration.key,
		tags: configuration.tags,
		title: configuration.schema?.title ?? configuration.key,
		description: configuration.schema?.description ?? configuration.schema?.markdownDescription ?? '',
		keywords: [configuration.source!.id, configuration.source!.displayName ?? ''],
	};
}

function registeredSetting(configuration: IRegisteredConfiguration, schema: IConfigurationSettingSchema): ISetting {
	const base = {
		id: configuration.key,
		tags: configuration.tags,
		title: schema.title,
		description: schema.description,
		keywords: configuration.source ? [...new Set([configuration.source.id, configuration.source.displayName ?? '', ...(schema.keywords ?? [])])] : schema.keywords,
	};
	switch (schema.valueType) {
		case 'boolean':
			return { ...base, valueType: 'boolean', configuration: configuration as IRegisteredConfiguration<boolean> };
		case 'number':
			return {
				...base,
				valueType: 'number',
				configuration: configuration as IRegisteredConfiguration<number>,
				minimum: schema.minimum,
				maximum: schema.maximum,
			};
		case 'select':
			return {
				...base,
				valueType: 'select',
				configuration: configuration as IRegisteredConfiguration<string | boolean>,
				get options() {
					return schema.options;
				},
			};
		case 'text':
			return {
				...base,
				valueType: 'text',
				configuration: configuration as IRegisteredConfiguration<string>,
				placeholder: schema.placeholder,
			};
		case 'stringMap':
			return {
				...base,
				valueType: 'stringMap',
				structuredValues: schema.structuredValues,
				configuration: configuration as IRegisteredConfiguration<Record<string, unknown>>,
				keyLabel: schema.keyLabel,
				valueLabel: schema.valueLabel,
				addLabel: schema.addLabel,
				removeLabel: schema.removeLabel,
				incompleteMessage: schema.incompleteMessage,
				duplicateMessage: schema.duplicateMessage,
			};
	}
}

/** Owns catalog metadata and transient editor status; bindings own setting values. */
export class SettingsEditorModel extends Disposable implements ISettingsEditorModel {
	private readonly statusEmitter = this._register(new Emitter<SettingsStatus>());

	public readonly onDidChangeStatus = this.statusEmitter.event;
	private entries: readonly ISetting[] = [];

	public get settings(): readonly ISetting[] {
		return this.entries;
	}

	public readonly reportStatus = (message: string, isError: boolean): void => {
		this.statusEmitter.fire({ message, isError });
	};

	constructor(settings: readonly ISetting[]) {
		super();
		this.setSettings(settings);
	}

	/** Replaces catalog metadata while configuration and domain bindings retain value ownership. */
	public setSettings(settings: readonly ISetting[]): void {
		const ids = new Set<string>();
		for (const setting of settings) {
			if (ids.has(setting.id)) throw new Error(`Setting is already registered: ${setting.id}`);
			ids.add(setting.id);
		}
		this.entries = Object.freeze([...settings]);
	}
}
