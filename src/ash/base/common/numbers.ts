/** Restricts a number to an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Wraps an integer into the range from zero (inclusive) to modulo (exclusive). */
export function rot(index: number, modulo: number): number {
	return (modulo + (index % modulo)) % modulo;
}

/** Returns whether a value is a finite number. */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Returns whether a value is a safe integer. */
export function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/** Returns whether a value is a non-negative safe integer. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

/** Returns whether a value is a positive safe integer. */
export function isPositiveSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value > 0;
}
