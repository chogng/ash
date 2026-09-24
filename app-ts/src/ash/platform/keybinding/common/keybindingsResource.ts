import { type Event } from "../../../base/common/event.js";
import {
	type JsonValue,
	validateJsonValue,
} from "../../../base/common/jsonValue.js";
import { parseKeybinding } from "../../../base/common/keybindingParser.js";
import type {
	CommandId,
} from "../../commands/common/commands.js";
import {
	parseContextKeyExpression,
} from "../../contextkey/common/contextKeyExpressionParser.js";
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";

export const KEYBINDINGS_RESOURCE_READ_CHANNEL =
	"ash:keybindings-resource:read";
export const KEYBINDINGS_RESOURCE_UPDATE_CHANNEL =
	"ash:keybindings-resource:update";
export const KEYBINDINGS_RESOURCE_CHANGED_CHANNEL =
	"ash:keybindings-resource:changed";

/** One ordered shortcut rule from the active `keybindings.json`. */
export interface IKeybindingEntry {
	readonly key: string;
	readonly command: CommandId | null;
	readonly when?: string;
	readonly args?: JsonValue;
	readonly mac?: string | null;
	readonly linux?: string | null;
	readonly win?: string | null;
}

/** One host-authoritative keybinding resource snapshot. */
export interface IKeybindingsResourceSnapshot {
	readonly revision: number;
	readonly bindings: readonly IKeybindingEntry[];
}

/** Compare-and-swap update that preserves external file changes. */
export interface IKeybindingsResourceUpdateRequest {
	readonly expectedRevision: number;
	readonly bindings: readonly IKeybindingEntry[];
}

export interface IKeybindingsResourceSubscription {
	dispose(): void;
}

/**
 * Narrow host capability for the active profile's `keybindings.json`.
 *
 * The active resource can later move with a profile without changing
 * renderer consumers. Values crossing contextBridge remain untrusted.
 */
export interface IKeybindingsResourceApi {
	read(): Promise<unknown>;
	update(request: IKeybindingsResourceUpdateRequest): Promise<unknown>;
	onDidChange(
		listener: (snapshot: unknown) => void,
	): IKeybindingsResourceSubscription;
}

/**
 * Window service exposing validated rules from the active keybinding resource.
 */
export interface IKeybindingsResourceService {
	readonly onDidChangeKeybindings: Event<readonly IKeybindingEntry[]>;

	getKeybindings(): readonly IKeybindingEntry[];
	updateKeybindings(bindings: readonly IKeybindingEntry[]): Promise<void>;
	reload(): Promise<void>;
}

export const IKeybindingsResourceService =
	createServiceIdentifier<IKeybindingsResourceService>(
		"keybindingsResourceService",
	);

/** Validates the complete ordered contents of `keybindings.json`. */
export function validateKeybindingsResource(
	value: unknown,
): readonly IKeybindingEntry[] {
	if (!Array.isArray(value)) {
		throw new TypeError("Keybindings resource must be an array");
	}
	if (value.length > 1_024) {
		throw new TypeError("Keybindings resource contains too many rules");
	}
	return value.map((candidate, index) =>
		validateKeybindingEntry(candidate, index)
	);
}

export function validateKeybindingsResourceSnapshot(
	value: unknown,
): IKeybindingsResourceSnapshot {
	const snapshot = exactRecord(
		value,
		["bindings", "revision"],
		"keybindings resource snapshot",
	);
	return {
		revision: nonNegativeSafeInteger(snapshot.revision, "revision"),
		bindings: validateKeybindingsResource(snapshot.bindings),
	};
}

export function validateKeybindingsResourceUpdateRequest(
	value: unknown,
): IKeybindingsResourceUpdateRequest {
	const request = exactRecord(
		value,
		["bindings", "expectedRevision"],
		"keybindings resource update",
	);
	return {
		expectedRevision: nonNegativeSafeInteger(
			request.expectedRevision,
			"expectedRevision",
		),
		bindings: validateKeybindingsResource(request.bindings),
	};
}

export function validateKeybindingsResourceRead(
	value: unknown,
): undefined {
	if (value !== undefined) {
		throw new Error("Keybindings resource read does not accept parameters");
	}
	return undefined;
}

function validateKeybindingEntry(
	value: unknown,
	index: number,
): IKeybindingEntry {
	const path = `keybindings[${index}]`;
	const source = record(value, path);
	const allowedKeys = new Set([
		"args",
		"command",
		"key",
		"linux",
		"mac",
		"when",
		"win",
	]);
	for (const field of Object.keys(source)) {
		if (!allowedKeys.has(field)) {
			throw new TypeError(`${path} contains unknown field '${field}'`);
		}
	}
	if (
		!Object.hasOwn(source, "key") ||
		!Object.hasOwn(source, "command")
	) {
		throw new TypeError(`${path} requires key and command`);
	}

	const key = validateKey(source.key, `${path}.key`);
	const command = validateCommand(source.command, `${path}.command`);
	const when = optionalString(source.when, `${path}.when`, 1_024);
	if (when !== undefined) parseContextKeyExpression(when);
	const args = Object.hasOwn(source, "args")
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

	return {
		key,
		command,
		...(when === undefined ? {} : { when }),
		...(args === undefined ? {} : { args }),
		...(mac === undefined ? {} : { mac }),
		...(linux === undefined ? {} : { linux }),
		...(win === undefined ? {} : { win }),
	};
}

function validateCommand(
	value: unknown,
	path: string,
): CommandId | null {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
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
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
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
	if (value === undefined || value === null) return value;
	return validateKey(value, path);
}

function validateKey(
	value: unknown,
	path: string,
): string {
	if (
		typeof value !== "string" ||
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

function exactRecord(
	value: unknown,
	keys: readonly string[],
	path: string,
): Record<string, unknown> {
	const result = record(value, path);
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`${path} must contain exactly: ${expected.join(", ")}`);
	}
	return result;
}

function record(
	value: unknown,
	path: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function nonNegativeSafeInteger(
	value: unknown,
	field: string,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}
