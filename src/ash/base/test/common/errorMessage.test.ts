import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { resetNlsResolver, setNlsMessages } from '../../../nls.js';
import { toErrorMessage } from '../../common/errorMessage.js';

test('error messages preserve text and describe structured action failures', () => {
	assert.deepEqual(
		[
			toErrorMessage('Clipboard unavailable'),
			toErrorMessage(new Error('Clipboard unavailable')),
			toErrorMessage({ message: 'Clipboard unavailable' }),
			toErrorMessage({ detail: { error: { message: 'Clipboard unavailable' } } }),
			toErrorMessage({ detail: { exception: { message: 'Clipboard unavailable' } } }),
		],
		Array(5).fill('Clipboard unavailable'),
	);
});

test('error messages include stack details only when requested', () => {
	const error = { message: 'Clipboard unavailable', stack: 'Error: Clipboard unavailable\n    at copy' };
	assert.deepEqual(
		[toErrorMessage(error), toErrorMessage(error, true), toErrorMessage({ ...error, stack: ['first frame', 'second frame'] }, true)],
		['Clipboard unavailable', 'Clipboard unavailable\n\nError: Clipboard unavailable\n    at copy', 'Clipboard unavailable\n\nfirst frame\nsecond frame'],
	);
});

test('unknown errors always have useful feedback, including cyclic details', () => {
	const cyclic = { detail: {} as { error?: unknown } };
	cyclic.detail.error = cyclic;
	const fallback = 'An unknown error occurred. Please consult the log for more details.';
	assert.deepEqual([toErrorMessage(), toErrorMessage(null), toErrorMessage({}), toErrorMessage(new Error('')), toErrorMessage(cyclic)], Array(5).fill(fallback));
	assert.equal(toErrorMessage({ stack: 'at copy' }, true), `${fallback}\n\nat copy`);
});

test('multiple error feedback identifies the first failure and total count', () => {
	assert.deepEqual(
		[toErrorMessage([undefined, new Error('First failure')]), toErrorMessage([null, { message: 'First failure' }, 'Second failure'])],
		['First failure', 'First failure (2 errors in total)'],
	);
});

test('error feedback uses the installed Simplified Chinese translation', () => {
	const bundles = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'));
	setNlsMessages('zh-CN', bundles);
	try {
		assert.deepEqual(
			[toErrorMessage({}), toErrorMessage([{ message: 'Clipboard unavailable' }, new Error('Second failure')])],
			['发生未知错误。请查阅日志了解详情。', 'Clipboard unavailable（共 2 个错误）'],
		);
	} finally {
		resetNlsResolver();
	}
});
