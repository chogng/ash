/** JSON-compatible data accepted across trusted host boundaries. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| Readonly<{ [key: string]: JsonValue }>;

export interface JsonValueValidationOptions {
	readonly path?: string;
	readonly maxDepth?: number;
	readonly maxNodes?: number;
	readonly maxCollectionSize?: number;
	readonly maxStringLength?: number;
}

interface ValidationState {
	nodes: number;
	readonly maxDepth: number;
	readonly maxNodes: number;
	readonly maxCollectionSize: number;
	readonly maxStringLength: number;
}

const unsafeObjectKeys = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/**
 * Validates and clones untrusted JSON-compatible data under explicit bounds.
 */
export function validateJsonValue(
	value: unknown,
	options: JsonValueValidationOptions = {},
): JsonValue {
	return validateValue(
		value,
		options.path ?? "value",
		0,
		{
			nodes: 0,
			maxDepth: options.maxDepth ?? 16,
			maxNodes: options.maxNodes ?? 8_192,
			maxCollectionSize: options.maxCollectionSize ?? 1_024,
			maxStringLength: options.maxStringLength ?? 64 * 1_024,
		},
	);
}

function validateValue(
	value: unknown,
	path: string,
	depth: number,
	state: ValidationState,
): JsonValue {
	state.nodes += 1;
	if (state.nodes > state.maxNodes) {
		throw new Error(`${path} contains too many values`);
	}
	if (depth > state.maxDepth) {
		throw new Error(`${path} is too deeply nested`);
	}
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`${path} must contain a finite number`);
		}
		return value;
	}
	if (typeof value === "string") {
		if (value.length > state.maxStringLength) {
			throw new Error(`${path} contains a string that is too long`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > state.maxCollectionSize) {
			throw new Error(`${path} contains too many array items`);
		}
		return value.map((item, index) =>
			validateValue(item, `${path}[${index}]`, depth + 1, state)
		);
	}

	const source = asRecord(value, path);
	const entries = Object.entries(source);
	if (entries.length > state.maxCollectionSize) {
		throw new Error(`${path} contains too many object properties`);
	}
	const result: Record<string, JsonValue> = {};
	for (const [key, candidate] of entries) {
		if (
			key.length === 0 ||
			key.length > 256 ||
			unsafeObjectKeys.has(key)
		) {
			throw new Error(`${path} contains an unsafe object key`);
		}
		result[key] = validateValue(
			candidate,
			`${path}.${key}`,
			depth + 1,
			state,
		);
	}
	return result;
}

function asRecord(
	value: unknown,
	path: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}
