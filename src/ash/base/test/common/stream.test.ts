import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { consumeStream, newWriteableStream, transform } from '../../common/stream.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('Streams', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('retains buffered data and terminal errors until consumption', async () => {
		const stream = newWriteableStream<string>(values => values.join(''));
		stream.write('first');
		stream.end('second');
		assert.equal(await consumeStream(stream, values => values.join('')), 'firstsecond');
		const failed = newWriteableStream<string>(null);
		const reason = new Error('read failed');
		failed.error(reason);
		failed.end();
		await assert.rejects(consumeStream(failed), error => error === reason);
		failed.destroy();
	});

	test('releases backpressure after consumption or destruction', async () => {
		const stream = newWriteableStream<string>(null, { highWaterMark: 0 });
		const blocked = stream.write('buffered');
		assert.equal(blocked instanceof Promise, true);
		stream.end();
		assert.equal(await consumeStream(stream, values => values.join('')), 'buffered');
		await blocked;
		const abandoned = newWriteableStream<string>(null, { highWaterMark: 0 });
		const pending = abandoned.write('abandoned');
		abandoned.destroy();
		await pending;
	});

	test('transformation preserves chunk order across pause and resume', async () => {
		const source = newWriteableStream<number>(null, { highWaterMark: 1 });
		const result = transform(source, { data: value => String(value) }, values => values.join(''));
		source.write(0);
		source.write(1);
		const producer = (async () => {
			for (let index = 2; index < 20; index++) { await source.write(index); }
			source.end();
		})();
		assert.equal(await consumeStream(result, values => values.join('')), Array.from({ length: 20 }, (_, index) => String(index)).join(''));
		await producer;
	});
});
