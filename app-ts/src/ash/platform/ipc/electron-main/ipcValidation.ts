export function record(value: unknown, keys: readonly string[], optionalKeys: readonly string[] = []): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("IPC params must be an object");
	}
	const params = value as Record<string, unknown>;
	const actualKeys = Object.keys(params).sort();
	const allowedKeys = new Set([...keys, ...optionalKeys]);
	if (actualKeys.some(key => !allowedKeys.has(key)) || keys.some(key => !Object.hasOwn(params, key))) {
		throw new Error(`IPC params must contain exactly required keys ${keys.join(", ")} and only optional keys ${optionalKeys.join(", ")}`);
	}
	return params;
}

export function nonEmptyString(value: unknown, field: string): string {
	const resolved = string(value, field);
	if (resolved.trim().length === 0) throw new Error(`${field} must not be empty`);
	return resolved;
}

export function string(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

export function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

export function nonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

export function positiveInteger(value: unknown, field: string): number {
	const resolved = nonNegativeInteger(value, field);
	if (resolved === 0) throw new Error(`${field} must be positive`);
	return resolved;
}

export function boundedPositiveInteger(value: unknown, field: string, maximum: number): number {
	const resolved = positiveInteger(value, field);
	if (resolved > maximum) throw new Error(`${field} must not exceed ${maximum}`);
	return resolved;
}

export function stringEnum<const T extends readonly string[]>(value: unknown, field: string, values: T): T[number] {
	if (typeof value !== "string" || !values.includes(value)) {
		throw new Error(`${field} must be one of: ${values.join(", ")}`);
	}
	return value as T[number];
}
