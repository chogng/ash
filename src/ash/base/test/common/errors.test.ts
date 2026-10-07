import assert from 'node:assert/strict';
import { test } from 'mocha';
import { BugIndicatingError, CancellationError, ErrorHandler, errorHandler, getErrorMessage, illegalArgument, isCancellationError, onBugIndicatingError, onUnexpectedError, setUnexpectedErrorHandler, toError } from '../../common/errors.js';

test('CancellationError preserves context and is the only project cancellation error', () => {
	const reason = new Error('superseded');
	const error = new CancellationError('Request cancelled', reason);

	assert.equal(isCancellationError(error), true);
	assert.equal(error.message, 'Request cancelled');
	assert.equal(error.reason, reason);
	assert.equal(error.cause, reason);
	assert.equal(isCancellationError(new Error('cancelled')), false);
});

test('toError preserves Error instances', () => {
	const error = new TypeError('failure');
	assert.equal(toError(error), error);
});

test('toError wraps non-Error values', () => {
	assert.deepEqual(toError('failure'), new Error('failure'));
	assert.deepEqual(toError(undefined), new Error('undefined'));
});

test('illegalArgument identifies the rejected input', () => {
	assert.throws(() => { throw illegalArgument('lineIndex'); }, /Illegal argument: lineIndex/);
});

test('getErrorMessage reads messages, stack headers, and fallback values', () => {
	assert.equal(getErrorMessage(new Error('failure')), 'failure');
	assert.equal(getErrorMessage('failure'), 'failure');
	assert.equal(getErrorMessage({ stack: 'Failure\nsecond line' }), 'Failure');
	assert.equal(getErrorMessage(undefined), 'Error');
});

test('ErrorHandler dispatches unexpected errors and supports listener removal', () => {
	const handler = new ErrorHandler();
	const reported: unknown[] = [];
	const observed: unknown[] = [];
	const unbind = handler.addListener(error => observed.push(error));
	const error = new Error('failure');

	handler.setUnexpectedErrorHandler(value => reported.push(value));
	handler.onUnexpectedError(error);
	unbind();
	handler.onUnexpectedError(error);

	assert.deepEqual(reported, [error, error]);
	assert.deepEqual(observed, [error]);
});

test('unexpected error helpers ignore cancellation and preserve bug intent', () => {
	const previousHandler = errorHandler.getUnexpectedErrorHandler();
	const reported: unknown[] = [];
	const normalError = new Error('failure');
	const bug = new BugIndicatingError('invariant failed');
	setUnexpectedErrorHandler(error => reported.push(error));

	try {
		onUnexpectedError(new CancellationError());
		onUnexpectedError(normalError);
		onBugIndicatingError(bug);
	} finally {
		setUnexpectedErrorHandler(previousHandler);
	}

	assert.deepEqual(reported, [normalError, bug]);
	assert.equal(bug instanceof BugIndicatingError, true);
});
