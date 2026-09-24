import { BugIndicatingError, onUnexpectedError } from './errors.js';

export function assert(condition: unknown, messageOrError: string | Error = 'unexpected state'): asserts condition {
	if (condition) return;
	throw typeof messageOrError === 'string'
		? new BugIndicatingError(`Assertion failed: ${messageOrError}`)
		: messageOrError;
}

export function assertNever(_value: never, message = 'Unreachable code'): never {
	throw new BugIndicatingError(message);
}

export function assertFn(condition: () => boolean): void {
	if (!condition()) onUnexpectedError(new BugIndicatingError('Assertion failed'));
}

export function checkAdjacentItems<T>(items: readonly T[], predicate: (left: T, right: T) => boolean): boolean {
	for (let index = 1; index < items.length; index += 1) {
		if (!predicate(items[index - 1]!, items[index]!)) return false;
	}
	return true;
}
