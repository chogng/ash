import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { LogLevel, type LogEntry } from '../../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../../platform/log/common/logServiceImpl.js';
import { ChatLayoutTrace } from '../../../browser/widget/chatLayoutTrace.js';

interface TraceRecord {
	readonly events: readonly { readonly method: string; readonly count: number; readonly firstIndex?: number; readonly lastIndex?: number; readonly samples: readonly string[]; }[];
}

suite('ChatLayoutTrace', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregates a blocked event loop without losing operations or formatting every sample', () => {
		const entries: LogEntry[] = [];
		using logger = new LogService({ level: LogLevel.Trace, category: 'chat.layout', sinks: [{ log: entry => entries.push(entry) }] });
		let time = 0;
		let formatted = 0;
		using trace = new ChatLayoutTrace(() => time, logger);
		for (let index = 0; index < 20_000; index++) {
			time = Math.floor(index / 500) * 1000;
			trace.trace(index % 2 ? 'disposeElement' : 'renderElement', () => {
				formatted++;
				return 'sample'.repeat(1000);
			}, index % 500);
		}
		trace.dispose();
		assert.equal(entries.length, 40);
		assert.equal(formatted, 160);
		const records = entries.map(entry => JSON.parse(entry.message) as TraceRecord);
		assert.equal(records.flatMap(record => record.events).reduce((total, event) => total + event.count, 0), 20_000);
		for (const record of records) {
			assert.deepEqual(record.events.map(event => [event.method, event.count, event.firstIndex, event.lastIndex]), [
				['renderElement', 250, 0, 498], ['disposeElement', 250, 1, 499],
			]);
			for (const event of record.events) assert.deepEqual(event.samples.map(sample => sample.length), [180, 180]);
		}
		assert.ok(entries.every(entry => entry.category === 'chat.layout' && entry.message.length < 2000));
	});

	test('disabled and disposed tracing never reads the clock or formats samples', () => {
		const entries: LogEntry[] = [];
		using logger = new LogService({ level: LogLevel.Info, sinks: [{ log: entry => entries.push(entry) }] });
		using trace = new ChatLayoutTrace(() => { throw new Error('Unexpected clock read'); }, logger);
		trace.trace('renderElement', () => { throw new Error('Unexpected formatting'); });
		trace.dispose();
		logger.setLevel(LogLevel.Trace);
		trace.trace('disposeElement', () => { throw new Error('Unexpected formatting after disposal'); });
		assert.deepEqual(entries, []);
	});

	test('publishes idle and final batches once and discards a batch when tracing is disabled', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const entries: LogEntry[] = [];
			using logger = new LogService({ level: LogLevel.Trace, sinks: [{ log: entry => entries.push(entry) }] });
			let time = 0;
			using trace = new ChatLayoutTrace(() => time, logger);
			trace.trace('renderElement', () => 'first');
			time = 999;
			mock.timers.tick(999);
			assert.equal(entries.length, 0);
			time = 1000;
			mock.timers.tick(1);
			assert.equal(entries.length, 1);
			mock.timers.tick(2000);
			assert.equal(entries.length, 1);
			trace.trace('renderElement', () => 'retired');
			logger.setLevel(LogLevel.Info);
			logger.setLevel(LogLevel.Trace);
			mock.timers.tick(1000);
			assert.equal(entries.length, 1);
			trace.trace('disposeElement', () => 'last', 4);
			trace.dispose();
			trace.dispose();
			mock.timers.tick(5000);
			assert.equal(entries.length, 2);
			const records = entries.map(entry => JSON.parse(entry.message) as TraceRecord);
			assert.deepEqual(records.map(record => record.events), [
				[{ method: 'renderElement', count: 1, samples: ['first'] }],
				[{ method: 'disposeElement', count: 1, firstIndex: 4, lastIndex: 4, samples: ['last'] }],
			]);
		} finally { mock.timers.reset(); }
	});
});
