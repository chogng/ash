import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { SSEParser, type ISSEEvent } from '../../common/sseParser.js';

suite('SSE framing', () => {
	test('preserves UTF-8, fields and blank lines across arbitrary byte splits', () => {
		for (const newline of ['\n', '\r', '\r\n']) {
			const bytes = new TextEncoder().encode([
				': keepalive', 'event: delta', 'data: 你好 🌲', 'data: next', '',
				'event: ignored', '', 'data', '', '',
			].join(newline));
			for (let split = 0; split <= bytes.length; split++) {
				const events: ISSEEvent[] = [];
				const parser = new SSEParser(event => events.push(event));
				parser.feed(bytes.subarray(0, split));
				parser.feed(new Uint8Array());
				parser.feed(bytes.subarray(split));
				assert.deepEqual(events, [
					{ type: 'delta', data: '你好 🌲\nnext' },
					{ type: 'message', data: '' },
				], `newline ${JSON.stringify(newline)}, split ${split}`);
			}
		}
	});

	test('retains reconnection metadata while ignoring invalid and unknown fields', () => {
		const events: ISSEEvent[] = [];
		const parser = new SSEParser(event => events.push(event));
		parser.feed(new TextEncoder().encode([
			'id: cursor', 'retry: 250', 'data:  leading space', '',
			'id: invalid\0cursor', 'retry: -1', 'retry: 1x', 'unknown: ignored', 'data: next', '',
			'id', 'event:', 'data: final', '', '',
		].join('\n')));
		assert.deepEqual(events, [
			{ type: 'message', data: ' leading space', id: 'cursor', retry: 250 },
			{ type: 'message', data: 'next', id: 'cursor', retry: 250 },
			{ type: 'message', data: 'final', id: '', retry: 250 },
		]);
	});

	test('does not dispatch an unfinished event or a frame without data', () => {
		const events: ISSEEvent[] = [];
		const parser = new SSEParser(event => events.push(event));
		parser.feed(new TextEncoder().encode(': comment\n\nevent: ignored\n\ndata: unfinished\n'));
		assert.deepEqual(events, []);
		parser.feed(new TextEncoder().encode('\n'));
		assert.deepEqual(events, [{ type: 'message', data: 'unfinished' }]);
	});
});
