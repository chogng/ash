import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export type SettingValueType = 'boolean' | 'number' | 'select' | 'text';
export type SettingsPresentation = 'editor' | 'general';

export interface SettingValueBinding<T> {
	readonly id: string;
	readonly defaultValue: T;
	readonly onDidChange?: Event<void>;

	getValue(): T;
	updateValue(value: T): Promise<void>;
	resetValue(): Promise<void>;
}

export interface SettingReference {
	readonly id: string;

	isDefault(): boolean;
	reset(): Promise<void>;
}

export interface ISettingBase {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
	readonly presentation?: SettingsPresentation;
}

export interface IBooleanSetting extends ISettingBase {
	readonly valueType: 'boolean';
	readonly configuration: IRegisteredConfiguration<boolean>;
	readonly binding?: SettingValueBinding<boolean>;
}

export interface INumberSetting extends ISettingBase {
	readonly valueType: 'number';
	readonly configuration: IRegisteredConfiguration<number>;
	readonly binding?: SettingValueBinding<number>;
	readonly minimum: number;
	readonly maximum: number;
}

export interface ISelectSetting extends ISettingBase {
	readonly valueType: 'select';
	readonly configuration: IRegisteredConfiguration<string | boolean>;
	readonly binding?: SettingValueBinding<string | boolean>;
	readonly options: readonly ISelectSettingOption[];
}

export interface ITextSetting extends ISettingBase {
	readonly valueType: 'text';
	readonly configuration: IRegisteredConfiguration<string>;
	readonly binding?: SettingValueBinding<string>;
	readonly placeholder: string;
}

export type ISetting = IBooleanSetting | INumberSetting | ISelectSetting | ITextSetting;

export interface ISelectSettingOption {
	readonly value: string | boolean;
	readonly label: string;
}

export interface ISettingsGroup {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly settings: readonly ISetting[];
}

export interface SettingsStatus {
	readonly message: string;
	readonly isError: boolean;
}

export interface ISettingsEditorModel extends IDisposable {
	readonly onDidChangeStatus: Event<SettingsStatus>;
	readonly settings: readonly ISetting[];
	readonly reportStatus: (message: string, isError: boolean) => void;
}

/** Workbench-level entry point for opening Preferences surfaces. */
export interface IPreferencesService {
	openSettings(): Promise<void>;
	openUserSettingsJson(): Promise<void>;
	openKeybindings(): Promise<void>;
}

export const IPreferencesService = createServiceIdentifier<IPreferencesService>('preferencesService');
