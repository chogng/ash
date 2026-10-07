import { parse, type ParseError } from '../../../../base/common/json.js';
import { validateJsonValue } from '../../../../base/common/jsonValue.js';
import { parseKeybinding } from '../../../../base/common/keybindingParser.js';
import { Parser } from '../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../nls.js';
import type { CommandId } from '../../../../platform/commands/common/commands.js';
import type { IUserFriendlyKeybinding } from '../../../../platform/keybinding/common/keybinding.js';

/** Parses the complete ordered user resource before installing any rule. */
export function parseUserKeybindings(source: string): readonly IUserFriendlyKeybinding[] {
	const errors: ParseError[] = [];
	const value = parse(source, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length) {
		throw new TypeError(`keybindings.json is not valid JSONC at offset ${errors[0]!.offset}`);
	}
	return value === undefined ? [] : validateKeybindingsResource(value);
}

/** Validates the complete ordered contents of `keybindings.json`. */
function validateKeybindingsResource(
	value: unknown,
): readonly IUserFriendlyKeybinding[] {
	if (!Array.isArray(value)) {
		throw new TypeError('Keybindings resource must be an array');
	}
	if (value.length > 1_024) {
		throw new TypeError('Keybindings resource contains too many rules');
	}
	return value.map((candidate, index) =>
		validateKeybindingEntry(candidate, index)
	);
}

function validateKeybindingEntry(
	value: unknown,
	index: number,
): IUserFriendlyKeybinding {
	const path = `keybindings[${index}]`;
	const source = record(value, path);
	const allowedKeys = new Set([
		'args',
		'command',
		'key',
		'linux',
		'mac',
		'when',
		'win',
		'systemWide',
	]);
	for (const field of Object.keys(source)) {
		if (!allowedKeys.has(field)) {
			throw new TypeError(`${path} contains unknown field '${field}'`);
		}
	}
	if (
		!Object.hasOwn(source, 'key') ||
		!Object.hasOwn(source, 'command')
	) {
		throw new TypeError(`${path} requires key and command`);
	}

	const key = validateKey(source.key, `${path}.key`);
	const command = validateCommand(source.command, `${path}.command`);
	const when = optionalString(source.when, `${path}.when`, 1_024);
	if (when !== undefined) {
		const parser = new Parser();
		if (!parser.parse(when)) {
			const error = parser.lexingErrors[0] ?? parser.parsingErrors[0];
			throw new SyntaxError(localize('contextkey.invalidWhen', 'Invalid when condition at offset {0}: {1}', error.offset,
				parser.parsingErrors[0]?.message ?? parser.lexingErrors[0]?.additionalInfo));
		}
	}
	const args = Object.hasOwn(source, 'args')
		? validateJsonValue(source.args, {
			path: `${path}.args`,
			maxDepth: 8,
			maxNodes: 2_048,
			maxStringLength: 16 * 1_024,
		})
		: undefined;
	if (command === null && args !== undefined) {
		throw new TypeError(`${path}.args requires a command`);
	}
	const mac = optionalKey(source.mac, `${path}.mac`);
	const linux = optionalKey(source.linux, `${path}.linux`);
	const win = optionalKey(source.win, `${path}.win`);
	const systemWide = source.systemWide;
	if (systemWide !== undefined && typeof systemWide !== 'boolean') {
		throw new TypeError(`${path}.systemWide must be a boolean`);
	}

	return {
		key,
		command,
		...(when === undefined ? {} : { when }),
		...(args === undefined ? {} : { args }),
		...(mac === undefined ? {} : { mac }),
		...(linux === undefined ? {} : { linux }),
		...(win === undefined ? {} : { win }),
		...(systemWide === undefined ? {} : { systemWide }),
	};
}

function validateCommand(
	value: unknown,
	path: string,
): CommandId | null {
	if (value === null) {
		return null;
	}
	if (
		typeof value !== 'string' ||
		value.trim().length === 0 ||
		value.length > 256
	) {
		throw new TypeError(`${path} must be a non-empty command id or null`);
	}
	return value;
}

function optionalString(
	value: unknown,
	path: string,
	maxLength: number,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		typeof value !== 'string' ||
		value.trim().length === 0 ||
		value.length > maxLength
	) {
		throw new TypeError(`${path} must be a non-empty bounded string`);
	}
	return value;
}

function optionalKey(
	value: unknown,
	path: string,
): string | null | undefined {
	if (value === undefined || value === null) {
		return value;
	}
	return validateKey(value, path);
}

function validateKey(
	value: unknown,
	path: string,
): string {
	if (
		typeof value !== 'string' ||
		value.length > 256
	) {
		throw new TypeError(`${path} must be a valid keybinding`);
	}
	const keybinding = parseKeybinding(value);
	if (!keybinding || keybinding.chords.length > 4) {
		throw new TypeError(`${path} must be a valid keybinding`);
	}
	return value;
}

function record(
	value: unknown,
	path: string,
): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}
