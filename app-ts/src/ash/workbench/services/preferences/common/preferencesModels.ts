import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IConfigurationSettingSchema, type IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type { IBooleanSetting, INumberSetting, ISelectSetting, ISetting, ISettingsEditorModel, ITextSetting, SettingReference, SettingsStatus, SettingValueBinding } from './preferences.js';

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

	public readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly binding: SettingValueBinding<T>) {
		super();
		this.value = binding.getValue();
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
			isDefault: Object.is(this.value, this.binding.defaultValue),
			isPending: this.pending,
		};
	}

	public isDefault(): boolean {
		return Object.is(this.value, this.binding.defaultValue);
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
		if (Object.is(value, this.value)) return;
		this.value = value;
		this.changeEmitter.fire(this.state);
	}

	private setPending(pending: boolean): void {
		if (pending === this.pending) return;
		this.pending = pending;
		this.changeEmitter.fire(this.state);
	}
}

export function configurationSettingBinding<T>(configurationService: IConfigurationService, configuration: IRegisteredConfiguration<T>): SettingValueBinding<T> {
	return {
		id: configuration.key,
		defaultValue: configuration.defaultValue,
		onDidChange: listener => configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(configuration.key)) listener();
		}),
		getValue: () => configurationService.getValue<T>(configuration.key),
		updateValue: value => configurationService.updateValue(configuration.key, value),
		resetValue: () => configurationService.updateValue(configuration.key, undefined),
	};
}

/** Projects registered configuration schemas into Settings-domain entries. */
export class DefaultSettings {
	private readonly settings = new Map<string, ISetting>();

	constructor(registry: IConfigurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)) {
		for (const configuration of registry.getRegisteredConfigurations()) {
			if (!configuration.setting) continue;
			this.settings.set(configuration.key, registeredSetting(configuration, configuration.setting));
		}
	}

	public get all(): readonly ISetting[] {
		return [...this.settings.values()];
	}

	public get(key: string): ISetting {
		const setting = this.settings.get(key);
		if (!setting) throw new RangeError(`Configuration '${key}' does not declare Settings metadata`);
		return setting;
	}
}

function registeredSetting(configuration: IRegisteredConfiguration, schema: IConfigurationSettingSchema): ISetting {
	const base = {
		id: configuration.key,
		title: schema.title,
		description: schema.description,
		keywords: schema.keywords,
	};
	switch (schema.valueType) {
		case 'boolean':
			return { ...base, valueType: 'boolean', configuration: configuration as IRegisteredConfiguration<boolean> };
		case 'number':
			return { ...base, valueType: 'number', configuration: configuration as IRegisteredConfiguration<number>, minimum: schema.minimum, maximum: schema.maximum };
		case 'select':
			return {
				...base,
				valueType: 'select',
				configuration: configuration as IRegisteredConfiguration<string | boolean>,
				get options() { return schema.options; },
			};
		case 'text':
			return { ...base, valueType: 'text', configuration: configuration as IRegisteredConfiguration<string>, placeholder: schema.placeholder };
	}
}

/** Owns the immutable Settings projection and transient editor status. */
export class SettingsEditorModel extends Disposable implements ISettingsEditorModel {
	private readonly statusEmitter = this._register(new Emitter<SettingsStatus>());

	public readonly onDidChangeStatus = this.statusEmitter.event;
	public readonly settings: readonly ISetting[];

	public readonly reportStatus = (message: string, isError: boolean): void => {
		this.statusEmitter.fire({ message, isError });
	};

	constructor(settings: readonly ISetting[]) {
		super();
		const ids = new Set<string>();
		for (const setting of settings) {
			if (ids.has(setting.id)) throw new Error(`Setting is already registered: ${setting.id}`);
			ids.add(setting.id);
		}
		this.settings = Object.freeze([...settings]);
	}
}
