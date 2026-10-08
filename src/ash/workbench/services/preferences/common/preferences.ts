import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';

export type SettingValueType = 'boolean' | 'number' | 'select' | 'text' | 'stringMap';
export type SettingsPresentation = 'editor' | 'general';

export interface SettingValueBinding<T> {
	readonly id: string;
	readonly defaultValue: T;
	readonly onDidChange?: Event<void>;

	getValue(): T;
	/** Persisted bindings distinguish an absent override from an explicitly saved default. */
	isDefault?(): boolean;
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

export interface IStringMapSetting extends ISettingBase {
	readonly valueType: 'stringMap';
	readonly structuredValues?: boolean;
	readonly configuration: IRegisteredConfiguration<Record<string, unknown>>;
	readonly binding?: SettingValueBinding<Record<string, unknown>>;
	readonly keyLabel: string;
	readonly valueLabel: string;
	readonly addLabel: string;
	readonly removeLabel: string;
	readonly incompleteMessage: string;
	readonly duplicateMessage: string;
}

export type ISetting = IBooleanSetting | INumberSetting | ISelectSetting | ITextSetting | IStringMapSetting;

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

/** Opening options for the supported local user Settings surfaces. */
export interface IOpenSettingsOptions {
	readonly target?: ConfigurationTarget;
	/** Initial graphical search; an empty string clears a reused surface's query. */
	readonly query?: string;
	/** Ash Settings page or section identity; independent of the configuration target. */
	readonly section?: string;
	/** JSONC only. Graphical Settings uses query to find a setting. */
	readonly revealSetting?: { readonly key: string; readonly edit?: boolean; };
}

/** Both graphical hosts validate opening requests before changing their live surface. */
export function validateSettingsEditorOptions(options: IOpenSettingsOptions = {}): IOpenSettingsOptions {
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new TypeError(localize({ bundle: 'ash.settings', key: 'open.invalidOptions' }, 'Settings opening options must be an object.'));
	}
	const unsupported = Object.keys(options).find(key => key !== 'query' && key !== 'section' && key !== 'target');
	if (unsupported !== undefined) {
		throw new TypeError(localize({ bundle: 'ash.settings', key: 'open.unsupportedOption' }, 'Settings opening option {0} is not supported.', unsupported));
	}
	if (options.query !== undefined && typeof options.query !== 'string') {
		throw new TypeError(localize({ bundle: 'ash.settings', key: 'open.invalidQuery' }, 'The Settings query must be a string.'));
	}
	if (options.section !== undefined && (typeof options.section !== 'string' || options.section.trim().length === 0)) {
		throw new TypeError(localize({ bundle: 'ash.settings', key: 'open.invalidSection' }, 'The Settings section must be a non-empty string.'));
	}
	if (options.target !== undefined && options.target !== ConfigurationTarget.USER && options.target !== ConfigurationTarget.USER_LOCAL) {
		throw new Error(localize({ bundle: 'ash.settings', key: 'open.unsupportedTarget' }, 'This Settings editor supports only local user settings.'));
	}
	return options;
}

/** Workbench-level entry point for opening Preferences surfaces. */
export interface IPreferencesService {
	/** Opens a settings page or reveals a section in its containing page. */
	openSettings(options?: IOpenSettingsOptions): Promise<void>;
	openUserSettings(options?: IOpenSettingsOptions): Promise<void>;
	openGlobalKeybindingSettings(textual: boolean): Promise<void>;
}

export const IPreferencesService = createServiceIdentifier<IPreferencesService>('preferencesService');
