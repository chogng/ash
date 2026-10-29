import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { MockDebugService, MockDebugSession } from '../common/mockDebug.js';
import { findExpressionInStackFrame } from '../../browser/debugHover.js';
import type { IDebugScopeInspection } from '../../common/debug.js';

test('Debug hover reads scalar and nested scope values without evaluating source expressions', async () => {
	using debug = new MockDebugService();
	const session = debug.sessions[0] as MockDebugSession;
	const frame = { id: 10, name: 'main', lineNumber: 1, columnNumber: 1 };
	const signal = new AbortController().signal;
	session.variables = async reference =>
		reference === 20
			? [
					{ name: 'answer', value: '42', variablesReference: 0 },
					{ name: 'parent', value: 'Object', variablesReference: 21 },
				]
			: [{ name: 'child', value: '7', variablesReference: 0 }];
	session.evaluate = async () => assert.fail('Hover must not evaluate source expressions');
	assert.equal((await findExpressionInStackFrame(session, frame, ['answer'], signal))?.value, '42');
	assert.equal((await findExpressionInStackFrame(session, frame, ['parent', 'child'], signal))?.value, '7');
	assert.equal(await findExpressionInStackFrame(session, frame, ['absent'], signal), undefined);
	assert.deepEqual(session.operations, []);
});

test('Debug hover discards inspection work after caller cancellation or continuing', async () => {
	using debug = new MockDebugService();
	const session = debug.sessions[0] as MockDebugSession;
	const frame = { id: 10, name: 'main', lineNumber: 1, columnNumber: 1 };
	const held = new DeferredPromise<IDebugScopeInspection[]>();
	session.inspectFrame = async () => held.p;
	const controller = new AbortController();
	const result = findExpressionInStackFrame(session, frame, ['answer'], controller.signal);
	controller.abort();
	await held.complete([]);
	await assert.rejects(result, isCancellationError);
	session.state = 'running';
	await assert.rejects(
		findExpressionInStackFrame(session, frame, ['answer'], new AbortController().signal),
		isCancellationError,
	);
});
