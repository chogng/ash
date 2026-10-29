export interface ErrorListenerCallback {
	(error: unknown): void;
}

export interface ErrorListenerUnbind {
	(): void;
}

/** Coordinates errors that escape a local recovery boundary. */
export class ErrorHandler {
	private unexpectedErrorHandler: (error: unknown) => void;
	private readonly listeners: ErrorListenerCallback[] = [];

	public constructor() {
		this.unexpectedErrorHandler = (error: unknown): void => {
			setTimeout(() => {
				if (error instanceof Error && error.stack) {
					throw new Error(`${error.message}\n\n${error.stack}`);
				}
				throw error;
			}, 0);
		};
	}

	public addListener(listener: ErrorListenerCallback): ErrorListenerUnbind {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	public setUnexpectedErrorHandler(handler: (error: unknown) => void): void {
		this.unexpectedErrorHandler = handler;
	}

	public getUnexpectedErrorHandler(): (error: unknown) => void {
		return this.unexpectedErrorHandler;
	}

	public onUnexpectedError(error: unknown): void {
		this.unexpectedErrorHandler(error);
		for (const listener of [...this.listeners]) listener(error);
	}

	public onUnexpectedExternalError(error: unknown): void {
		this.unexpectedErrorHandler(error);
	}
}

export const errorHandler = new ErrorHandler();

export function isCancellationError(error: unknown): error is CancellationError {
	return error instanceof CancellationError;
}

export class CancellationError extends Error {
	public constructor(message = 'Operation cancelled', public readonly reason?: unknown) {
		super(message, { cause: reason });
		this.name = 'CancellationError';
	}
}

export function canceled(reason?: unknown): CancellationError {
	return new CancellationError('Operation cancelled', reason);
}

export function illegalArgument(name?: string): Error {
	return new TypeError(name ? `Illegal argument: ${name}` : 'Illegal argument');
}

export function setUnexpectedErrorHandler(handler: (error: unknown) => void): void {
	errorHandler.setUnexpectedErrorHandler(handler);
}

/** Reports an error caused by the product itself. */
export function onBugIndicatingError(error: unknown): undefined {
	errorHandler.onUnexpectedError(error);
	return undefined;
}

/** Reports an unexpected internal error, ignoring expected cancellation. */
export function onUnexpectedError(error: unknown): undefined {
	if (!isCancellationError(error)) errorHandler.onUnexpectedError(error);
	return undefined;
}

/** Reports an external error without notifying internal error listeners. */
export function onUnexpectedExternalError(error: unknown): undefined {
	if (!isCancellationError(error)) errorHandler.onUnexpectedExternalError(error);
	return undefined;
}

/** Marks an exception as a violation of an internal product invariant. */
export class BugIndicatingError extends Error {
	public constructor(message?: string) {
		super(message || 'An unexpected bug occurred.');
		Object.setPrototypeOf(this, BugIndicatingError.prototype);
	}
}

export class NotSupportedError extends Error {
	constructor(message?: string) {
		super('NotSupported');
		if (message) {
			this.message = message;
		}
	}
}

/** Preserves Error instances and wraps any other thrown value as an Error. */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** Returns a useful one-line description of an error-like value. */
export function getErrorMessage(err: any): string {
	if (!err) {
		return 'Error';
	}

	if (err.message) {
		return err.message;
	}

	if (err.stack) {
		return err.stack.split('\n')[0];
	}

	return String(err);
}
