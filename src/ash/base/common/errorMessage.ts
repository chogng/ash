import { localize } from '../../nls.js';

/** Formats thrown values for user feedback, including stack details on request. */
export function toErrorMessage(error: unknown = null, verbose = false): string {
	const errors = Array.isArray(error) ? error.filter(Boolean) : [error];
	const message = describeError(errors[0], verbose, new Set<object>());
	return errors.length > 1 ? localize('error.moreErrors', '{0} ({1} errors in total)', message, errors.length) : message;
}

function describeError(error: unknown, verbose: boolean, seen: Set<object>): string {
	if (typeof error === 'string' && error.length > 0) return error;
	if (typeof error !== 'object' || error === null || seen.has(error)) return unknownErrorMessage();
	seen.add(error);

	const value = error as { readonly message?: unknown; readonly stack?: unknown; readonly detail?: unknown };
	if (typeof value.detail === 'object' && value.detail !== null) {
		const detail = value.detail as { readonly error?: unknown; readonly exception?: unknown };
		const nested = detail.error ?? detail.exception;
		if (nested !== undefined && nested !== null) return describeError(nested, verbose, seen);
	}

	const message = typeof value.message === 'string' && value.message.length > 0 ? value.message : unknownErrorMessage();
	const stack = Array.isArray(value.stack) ? value.stack.filter((line): line is string => typeof line === 'string').join('\n') : typeof value.stack === 'string' ? value.stack : undefined;
	return verbose && stack ? `${message}\n\n${stack}` : message;
}

function unknownErrorMessage(): string {
	return localize('error.defaultMessage', 'An unknown error occurred. Please consult the log for more details.');
}
