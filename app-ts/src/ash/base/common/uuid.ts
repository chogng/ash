declare const uuidBrand: unique symbol;

/** A validated RFC 9562 UUID string in lowercase canonical form. */
export type UUID = string & { readonly [uuidBrand]: "UUID" };

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns whether an unknown value is a non-nil RFC 9562 UUID. */
export function isUuid(value: unknown): value is UUID {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Validates an external UUID value and returns its canonical representation. */
export function parseUuid(value: unknown): UUID {
	if (!isUuid(value)) {
		throw new TypeError("Expected a valid UUID");
	}
	return value.toLowerCase() as UUID;
}

/** Creates a cryptographically random UUID. */
export function createUuid(): UUID {
	return globalThis.crypto.randomUUID() as UUID;
}

export function generateUuid(): UUID {
	return createUuid();
}

/** Namespace should be 3 letters, e.g. `abc-<uuid>`. */
export function prefixedUuid(namespace: string): string {
	return `${namespace}-${generateUuid()}`;
}
