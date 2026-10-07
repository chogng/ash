import { OperatingSystem } from '../../../base/common/platform.js';
import type {
	IKeyboardLayoutDefinition,
	IKeyboardLayoutInfo,
	IKeyboardMapping,
	IKeyboardMappingEntry,
	KeyboardLayoutSource,
} from './keyboardLayout.js';

/** Validates a canonical keyboard-layout snapshot crossing a host boundary. */
export function validateKeyboardLayoutDefinition(
	value: unknown,
	expectedSource: KeyboardLayoutSource,
): IKeyboardLayoutDefinition | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const candidate = expectRecord(value, 'keyboard layout');
	expectKeys(candidate, ['layout', 'mapping'], 'keyboard layout');
	return Object.freeze({
		layout: validateLayoutInfo(candidate.layout, expectedSource),
		mapping: validateKeyboardMapping(candidate.mapping),
	});
}

/** Validates the physical-key mapping shared by native and user layouts. */
export function validateKeyboardMapping(value: unknown): IKeyboardMapping {
	const rawMapping = expectRecord(value, 'keyboard mapping');
	if (Object.keys(rawMapping).length > 256) {
		throw new TypeError('keyboard mapping contains too many keys');
	}
	const mapping: Record<string, IKeyboardMappingEntry> = {};
	for (const [code, entry] of Object.entries(rawMapping)) {
		if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(code)) {
			throw new TypeError(`invalid keyboard scan code: ${code}`);
		}
		mapping[code] = validateMappingEntry(entry, code);
	}
	return Object.freeze(mapping);
}

function validateLayoutInfo(
	value: unknown,
	expectedSource: KeyboardLayoutSource,
): IKeyboardLayoutInfo {
	const layout = expectRecord(value, 'keyboard layout info');
	expectKeys(layout, ['id', 'isUSStandard', 'label', 'operatingSystem', 'source'], 'keyboard layout info');
	if (typeof layout.id !== 'string' || layout.id.length === 0 || layout.id.length > 256) {
		throw new TypeError('keyboard layout id must be a bounded non-empty string');
	}
	if (typeof layout.label !== 'string' || layout.label.length === 0 || layout.label.length > 256) {
		throw new TypeError('keyboard layout label must be a bounded non-empty string');
	}
	if (layout.source !== expectedSource) {
		throw new TypeError(`keyboard layout must use the ${expectedSource} source`);
	}
	if (!isOperatingSystem(layout.operatingSystem)) {
		throw new TypeError('keyboard layout has an invalid operating system');
	}
	if (layout.isUSStandard !== undefined && typeof layout.isUSStandard !== 'boolean') {
		throw new TypeError('keyboard layout isUSStandard must be boolean');
	}
	return Object.freeze({
		id: layout.id,
		label: layout.label,
		source: expectedSource,
		operatingSystem: layout.operatingSystem,
		...(layout.isUSStandard === true ? { isUSStandard: true } : {}),
	});
}

function validateMappingEntry(value: unknown, code: string): IKeyboardMappingEntry {
	const entry = expectRecord(value, `keyboard mapping ${code}`);
	expectKeys(entry, [
		'value',
		'valueIsDeadKey',
		'vkey',
		'withAltGr',
		'withAltGrIsDeadKey',
		'withShift',
		'withShiftAltGr',
		'withShiftAltGrIsDeadKey',
		'withShiftIsDeadKey',
	], `keyboard mapping ${code}`);
	return Object.freeze({
		value: expectOutput(entry.value, `${code}.value`),
		withShift: expectOutput(entry.withShift, `${code}.withShift`),
		withAltGr: expectOutput(entry.withAltGr, `${code}.withAltGr`),
		withShiftAltGr: expectOutput(entry.withShiftAltGr, `${code}.withShiftAltGr`),
		valueIsDeadKey: expectOptionalBoolean(entry.valueIsDeadKey, `${code}.valueIsDeadKey`),
		withShiftIsDeadKey: expectOptionalBoolean(entry.withShiftIsDeadKey, `${code}.withShiftIsDeadKey`),
		withAltGrIsDeadKey: expectOptionalBoolean(entry.withAltGrIsDeadKey, `${code}.withAltGrIsDeadKey`),
		withShiftAltGrIsDeadKey: expectOptionalBoolean(entry.withShiftAltGrIsDeadKey, `${code}.withShiftAltGrIsDeadKey`),
		vkey: entry.vkey === undefined ? undefined : expectOutput(entry.vkey, `${code}.vkey`),
	});
}

export function expectKeyboardLayoutRecord(value: unknown, name: string): Record<string, unknown> {
	return expectRecord(value, name);
}

export function expectKeyboardLayoutKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	name: string,
): void {
	expectKeys(value, allowed, name);
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
		throw new TypeError(`${name} contains unknown fields`);
	}
}

function expectOutput(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length > 64) {
		throw new TypeError(`${name} must be a bounded string`);
	}
	return value;
}

function expectOptionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new TypeError(`${name} must be boolean`);
	}
	return value;
}

function isOperatingSystem(value: unknown): value is OperatingSystem {
	return value === OperatingSystem.Windows ||
		value === OperatingSystem.Macintosh ||
		value === OperatingSystem.Linux;
}
