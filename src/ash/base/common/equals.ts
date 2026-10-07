import { arraysEqual } from './arrays.js';

export type EqualityComparer<T> = (left: T, right: T) => boolean;

export interface IEquatable<T> {
	equals(other: T): boolean;
}

export function strictEquals<T>(left: T, right: T): boolean { return left === right; }
export function strictEqualsC<T>(): EqualityComparer<T> { return strictEquals; }
export function arrayEquals<T>(left: readonly T[], right: readonly T[], equals: EqualityComparer<T> = strictEquals): boolean { return arraysEqual(left, right, equals); }
export function arrayEqualsC<T>(equals: EqualityComparer<T> = strictEquals): EqualityComparer<readonly T[]> { return (left, right) => arrayEquals(left, right, equals); }

export function structuralEquals<T>(left: T, right: T): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && arrayEquals(left, right, structuralEquals);
	}
	if (!isPlainObject(left) || !isPlainObject(right)) return false;
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	if (!arrayEquals(leftKeys, rightKeys)) return false;
	return leftKeys.every(key => structuralEquals(left[key], right[key]));
}

export function structuralEqualsC<T>(): EqualityComparer<T> { return structuralEquals; }
export function thisEqualsC<T extends IEquatable<T>>(): EqualityComparer<T> { return (left, right) => left.equals(right); }

export function equalsIfDefined<T>(left: T | null | undefined, right: T | null | undefined, equals: EqualityComparer<T>): boolean {
	if (left == null || right == null) return left === right;
	return equals(left, right);
}

export function equalsIfDefinedC<T>(equals: EqualityComparer<T>): EqualityComparer<T | null | undefined> {
	return (left, right) => equalsIfDefined(left, right, equals);
}

export namespace equals {
	export const strict = strictEquals;
	export const strictC = strictEqualsC;
	export const array = arrayEquals;
	export const arrayC = arrayEqualsC;
	export const structural = structuralEquals;
	export const structuralC = structuralEqualsC;
	export const thisC = thisEqualsC;
	export const ifDefined = equalsIfDefined;
	export const ifDefinedC = equalsIfDefinedC;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
