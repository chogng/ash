import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { getFirstFrame, isRemoteConsoleLog, log, parse } from '../../common/console.js';
import { URI } from '../../common/uri.js';

suite('Console', () => {
	test('decodes a forwarded log and writes its values and first frame in order', () => {
		const stack = 'Error: example\r\n    at run (/tmp/ash test/task.js:12:5)\r\n    at /tmp/other.js:2:1';
		const entry = {
			type: '__$console',
			severity: 'warn',
			arguments: JSON.stringify(['Message %s', { value: 7 }, { __$stack: stack }]),
		};
		assert.ok(isRemoteConsoleLog(entry));
		assert.deepEqual(parse(entry), { args: ['Message %s', { value: 7 }], stack });
		assert.deepEqual(getFirstFrame(entry), { uri: URI.file('/tmp/ash test/task.js'), line: 12, column: 5 });

		const calls: unknown[][] = [];
		const unexpected = () => assert.fail('Incorrect console method');
		log(entry, 'Host', {
			debug: unexpected, error: unexpected, info: unexpected, log: unexpected,
			warn: (...args) => calls.push(args),
		});
		assert.deepEqual(calls, [[
			'%c[Host] %cMessage %s', 'color: blue', 'color: ', { value: 7 },
			'(at run (/tmp/ash test/task.js:12:5))',
		]]);
	});

	test('accepts Windows paths, UNC paths and file URLs independently of the current host', () => {
		assert.deepEqual(getFirstFrame('at run(C:\\Ash App\\entry.js:9:3)'), {
			uri: URI.file('C:/Ash App/entry.js'), line: 9, column: 3,
		});
		assert.deepEqual(getFirstFrame('at \\\\server\\share\\entry.js:2:8'), {
			uri: URI.file('//server/share/entry.js'), line: 2, column: 8,
		});
		assert.deepEqual(getFirstFrame('at async file:///tmp/ash%20test.js:5:7'), {
			uri: URI.file('/tmp/ash test.js'), line: 5, column: 7,
		});
		assert.equal(getFirstFrame(undefined), undefined);
		assert.equal(getFirstFrame('at node:internal/test:1:1'), undefined);
	});

	test('rejects unrelated messages and retains the original arguments when decoding fails', () => {
		assert.equal(isRemoteConsoleLog({ type: 'rpc', severity: 'log', arguments: '[]' }), false);
		assert.equal(isRemoteConsoleLog({ type: '__$console', severity: 'clear', arguments: '[]' }), false);
		assert.equal(isRemoteConsoleLog({ type: '__$console', severity: 'log', arguments: [] }), false);
		for (const payload of ['broken json', 'null', '{"message":"test"}']) {
			assert.deepEqual(parse({ type: '__$console', severity: 'log', arguments: payload }), {
				args: ['Unable to log remote console arguments', payload], stack: undefined,
			});
		}
	});
});
