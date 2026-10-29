import { EditorOpenSource, type IEditorOptions } from '../../../../platform/editor/common/editor.js';
import type { IEditorPane } from '../../../common/editor.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';

export type SettingValueType = 'boolean' | 'number' | 'numberWithOptions' | 'select' | 'text' | 'stringMap' | 'complex';
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
	readonly tags?: readonly string[];
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

/** Numeric schemas can also accept an automatic value or named sizing modes. */
export interface INumberWithOptionsSetting extends ISettingBase {
	readonly valueType: 'numberWithOptions';
	readonly configuration: IRegisteredConfiguration<number | string | null>;
	readonly binding?: SettingValueBinding<number | string | null>;
	readonly minimum: number;
	readonly maximum: number;
	readonly integer: boolean;
	readonly options: readonly { readonly value: string | null; readonly label: string }[];
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

export interface IComplexSetting extends ISettingBase {
	readonly valueType: 'complex';
	readonly binding?: never;
	readonly configuration: IRegisteredConfiguration;
}

export type ISetting =
	| IBooleanSetting
	| INumberSetting
	| INumberWithOptionsSetting
	| ISelectSetting
	| ITextSetting
	| IStringMapSetting
	| IComplexSetting;

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

/** Opening options shared by the Settings hosts. */
export interface IOpenSettingsOptions extends IEditorOptions {
	readonly openToSide?: boolean;
	readonly groupId?: number;
	readonly target?: ConfigurationTarget;
	readonly folderUri?: URI;
	readonly focusSearch?: boolean;
	/** Overrides the default settings editor for this opening request only. */
	readonly jsonEditor?: boolean;
	/** Initial search; JSON reveals an exact registered setting ID when supplied. */
	readonly query?: string;
	/** Ash Settings page or section identity; independent of the configuration target. */
	readonly section?: string;
	/** Reveals a setting in JSONC, or filters the graphical editor to its ID. */
	readonly revealSetting?: { readonly key: string; readonly edit?: boolean };
}

/** Both graphical hosts validate opening requests before changing their live surface. */
export function validateSettingsEditorOptions(options: IOpenSettingsOptions = {}): IOpenSettingsOptions {
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.invalidOptions' },
				'Settings opening options must be an object.',
			),
		);
	}
	const supported = [
		'query',
		'section',
		'target',
		'folderUri',
		'focusSearch',
		'jsonEditor',
		'revealSetting',
		'openToSide',
		'groupId',
		'pinned',
		'preserveFocus',
		'forceReload',
		'revealIfOpened',
		'ignoreError',
		'source',
	];
	const unsupported = Object.keys(options).find(key => !supported.includes(key));
	if (unsupported !== undefined) {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.unsupportedOption' },
				'Settings opening option {0} is not supported.',
				unsupported,
			),
		);
	}
	if (options.query !== undefined && typeof options.query !== 'string') {
		throw new TypeError(
			localize({ bundle: 'ash.settings', key: 'open.invalidQuery' }, 'The Settings query must be a string.'),
		);
	}
	if (options.jsonEditor !== undefined && typeof options.jsonEditor !== 'boolean') {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.invalidEditor' },
				'The JSON editor option must be true or false.',
			),
		);
	}
	if (options.openToSide !== undefined && typeof options.openToSide !== 'boolean') {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.invalidSide' },
				'The side editor option must be true or false.',
			),
		);
	}
	if (options.groupId !== undefined && (!Number.isSafeInteger(options.groupId) || options.groupId < 0)) {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.invalidGroup' },
				'The editor group ID must be a non-negative integer.',
			),
		);
	}
	for (const key of ['pinned', 'preserveFocus', 'forceReload', 'revealIfOpened', 'ignoreError'] as const) {
		if (options[key] !== undefined && typeof options[key] !== 'boolean') {
			throw new TypeError(
				localize(
					{ bundle: 'ash.settings', key: 'open.invalidEditorOption' },
					'Editor option {0} must be true or false.',
					key,
				),
			);
		}
	}
	if (
		options.source !== undefined &&
		options.source !== EditorOpenSource.API &&
		options.source !== EditorOpenSource.USER
	) {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.unsupportedOption' },
				'Settings opening option {0} is not supported.',
				'source',
			),
		);
	}
	if (options.focusSearch !== undefined && typeof options.focusSearch !== 'boolean') {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.invalidFocus' },
				'The search focus option must be true or false.',
			),
		);
	}
	if (options.folderUri !== undefined && !URI.isUri(options.folderUri)) {
		throw new TypeError(
			localize({ bundle: 'ash.settings', key: 'open.invalidFolder' }, 'The Settings folder must be a URI.'),
		);
	}
	if (options.revealSetting !== undefined) {
		const reveal = options.revealSetting;
		if (
			!reveal ||
			typeof reveal !== 'object' ||
			Array.isArray(reveal) ||
			typeof reveal.key !== 'string' ||
			!reveal.key.trim() ||
			(reveal.edit !== undefined && typeof reveal.edit !== 'boolean') ||
			Object.keys(reveal).some(key => key !== 'key' && key !== 'edit')
		) {
			throw new TypeError(
				localize(
					{ bundle: 'ash.settings', key: 'open.invalidReveal' },
					'A setting to reveal must have a key and an optional edit flag.',
				),
			);
		}
	}
	if (options.section !== undefined && (typeof options.section !== 'string' || options.section.trim().length === 0)) {
		throw new TypeError(
			localize(
				{ bundle: 'ash.settings', key: 'open.invalidSection' },
				'The Settings section must be a non-empty string.',
			),
		);
	}
	if (
		options.target !== undefined &&
		![
			ConfigurationTarget.USER,
			ConfigurationTarget.USER_LOCAL,
			ConfigurationTarget.WORKSPACE,
			ConfigurationTarget.WORKSPACE_FOLDER,
		].includes(options.target)
	) {
		throw new Error(
			localize(
				{ bundle: 'ash.settings', key: 'open.unsupportedTarget' },
				'This Settings editor supports local user, workspace and folder settings.',
			),
		);
	}
	if (options.target === ConfigurationTarget.WORKSPACE_FOLDER && !options.folderUri) {
		throw new Error(
			localize(
				{ bundle: 'ash.settings', key: 'open.missingFolder' },
				'Choose a workspace folder to open its settings.',
			),
		);
	}
	return options;
}

/** Initial filter for the graphical Keyboard Shortcuts editor. */
export interface IOpenKeybindingsEditorOptions {
	readonly query?: string;
}

export interface IKeybindingsEditorPane extends IEditorPane {
	search(filter: string): void;
	recordSearchKeys(): void;
	toggleSortByPrecedence(): void;
	clearSearchResults(): void;
}

/** Workbench-level entry point for opening Preferences surfaces. */
export interface IPreferencesService {
	/** Opens a settings page or reveals a section in its containing page. */
	openSettings(options?: IOpenSettingsOptions): Promise<void>;
	openUserSettings(options?: IOpenSettingsOptions): Promise<void>;
	openGlobalKeybindingSettings(textual: boolean, options?: IOpenKeybindingsEditorOptions): Promise<void>;
}

export const IPreferencesService = createServiceIdentifier<IPreferencesService>('preferencesService');
