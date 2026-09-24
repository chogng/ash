import { toDisposable } from '../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type {
	IKeyboardLayoutDefinition,
	IKeyboardLayoutInfo,
	IKeyboardLayoutProvider,
} from './keyboardLayout.js';
import {
	expectKeyboardLayoutKeys,
	expectKeyboardLayoutRecord,
	validateKeyboardLayoutDefinition,
	validateKeyboardMapping,
} from './keyboardLayoutValidation.js';

export const USER_KEYBOARD_LAYOUT_READ_CHANNEL = 'ash:user-keyboard-layout:read';
export const USER_KEYBOARD_LAYOUT_OPEN_RESOURCE_CHANNEL = 'ash:user-keyboard-layout:open-resource';
export const USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL = 'ash:user-keyboard-layout:changed';

export const USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT = `// Defines a custom keyboard layout for Ash.
// Run "Developer: Inspect Key Mappings (JSON)", then replace null with its output.
null
`;

export interface IUserKeyboardLayoutService extends IKeyboardLayoutProvider {
	readonly available: boolean;
	/** Creates the profile resource when missing and opens it with the host editor. */
	openResource(): Promise<void>;
}

export interface IUserKeyboardLayoutApi extends IUserKeyboardLayoutService {}

export const IUserKeyboardLayoutService = createServiceIdentifier<IUserKeyboardLayoutService>('userKeyboardLayoutService');

export const UnavailableUserKeyboardLayoutService: IUserKeyboardLayoutService = Object.freeze({
	available: false,
	onDidChangeKeyboardLayout: () => toDisposable(() => undefined),
	readKeyboardLayout: () => Promise.resolve(undefined),
	openResource: () => Promise.reject(new Error('User keyboard layouts are not available in this host')),
});

/** Validates the canonical snapshot received by a renderer. */
export function validateUserKeyboardLayout(value: unknown): IKeyboardLayoutDefinition | undefined {
	return validateKeyboardLayoutDefinition(value, 'user');
}

/** Parses the VS Code-compatible `{ layout, rawMapping }` profile resource. */
export function parseUserKeyboardLayoutResource(value: unknown): IKeyboardLayoutDefinition | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const resource = expectKeyboardLayoutRecord(value, 'user keyboard layout resource');
	expectKeyboardLayoutKeys(resource, ['layout', 'rawMapping'], 'user keyboard layout resource');
	const layout = normalizeUserLayoutInfo(resource.layout);
	return Object.freeze({
		layout,
		mapping: validateKeyboardMapping(resource.rawMapping),
	});
}

export function validateUserKeyboardLayoutRead(value: unknown): undefined {
	if (value !== undefined) {
		throw new TypeError('user keyboard layout read does not accept parameters');
	}
	return undefined;
}

export const validateUserKeyboardLayoutOpenResource = validateUserKeyboardLayoutRead;

function normalizeUserLayoutInfo(value: unknown): IKeyboardLayoutInfo {
	const layout = expectKeyboardLayoutRecord(value, 'user keyboard layout info');
	if ('label' in layout) {
		expectKeyboardLayoutKeys(layout, ['id', 'isUSStandard', 'isUserKeyboardLayout', 'label', 'operatingSystem', 'source'], 'user keyboard layout info');
		return validateKeyboardLayoutDefinition({
			layout: {
				id: layout.id,
				label: layout.label,
				operatingSystem: layout.operatingSystem,
				isUSStandard: layout.isUSStandard,
				source: 'user',
			},
			mapping: {},
		}, 'user')!.layout;
	}
	if ('name' in layout) {
		expectKeyboardLayoutKeys(layout, ['id', 'isUSStandard', 'isUserKeyboardLayout', 'name', 'text'], 'Windows keyboard layout info');
		return createLayoutInfo(
			expectBoundedString(layout.name, 'layout.name'),
			expectBoundedString(layout.text, 'layout.text'),
			OperatingSystem.Windows,
			layout.isUSStandard,
		);
	}
	if ('lang' in layout) {
		expectKeyboardLayoutKeys(layout, ['id', 'isUSStandard', 'isUserKeyboardLayout', 'lang', 'localizedName'], 'macOS keyboard layout info');
		const id = expectBoundedString(layout.id, 'layout.id');
		return createLayoutInfo(
			id,
			layout.localizedName === undefined
				? id.replace(/^com\.apple\.keylayout\./u, '').replace(/-/gu, ' ')
				: expectBoundedString(layout.localizedName, 'layout.localizedName'),
			OperatingSystem.Macintosh,
			layout.isUSStandard,
		);
	}
	if ('layout' in layout) {
		expectKeyboardLayoutKeys(layout, ['group', 'isUSStandard', 'isUserKeyboardLayout', 'layout', 'model', 'options', 'rules', 'variant'], 'Linux keyboard layout info');
		const id = expectBoundedString(layout.layout, 'layout.layout');
		const variant = layout.variant === undefined ? '' : expectBoundedString(layout.variant, 'layout.variant', true);
		return createLayoutInfo(
			id,
			variant ? `${id} (${variant})` : id,
			OperatingSystem.Linux,
			layout.isUSStandard,
		);
	}
	throw new TypeError('user keyboard layout info does not identify a supported platform');
}

function createLayoutInfo(
	id: string,
	label: string,
	operatingSystem: OperatingSystem,
	isUSStandard: unknown,
): IKeyboardLayoutInfo {
	if (isUSStandard !== undefined && typeof isUSStandard !== 'boolean') {
		throw new TypeError('layout.isUSStandard must be boolean');
	}
	return Object.freeze({
		id,
		label,
		source: 'user',
		operatingSystem,
		...(isUSStandard === true ? { isUSStandard: true } : {}),
	});
}

function expectBoundedString(value: unknown, name: string, allowEmpty = false): string {
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 256) {
		throw new TypeError(`${name} must be a bounded ${allowEmpty ? '' : 'non-empty '}string`);
	}
	return value;
}
