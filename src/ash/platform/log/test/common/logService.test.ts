import assert from 'node:assert/strict';
import { test } from 'mocha';
import { canLog, ConsoleLogger, LogLevel, NullLoggerService, type LogEntry } from '../../common/log.js';
import { LogService } from '../../common/logServiceImpl.js';

test('LogService publishes structured entries and releases dynamic sinks', () => {
	const entries: LogEntry[] = [];
	using service = new LogService({ now: () => 42 });
	const registration = service.registerSink({ log: entry => entries.push(entry) });
	service.warn('workspace', 'Could not restore state', new Error('invalid'));
	registration.dispose();
	service.info('workspace', 'Ignored after disposal');
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.timestampMillis, 42);
	assert.equal(entries[0]?.level, 'warning');
	assert.equal(entries[0]?.category, 'workspace');
	assert.match(String(entries[0]?.error), /invalid/u);
});

test('LogService isolates a failing sink', () => {
	const entries: LogEntry[] = [];
	const sinkErrors: unknown[] = [];
	using service = new LogService({ sinks: [{ log: () => { throw new Error('sink failed'); } }, { log: entry => entries.push(entry) }], onSinkError: (_entry, error) => sinkErrors.push(error) });
	service.error('test', 'failure');
	assert.equal(entries.length, 1);
	assert.equal(sinkErrors.length, 1);
});

test('LogService preserves diagnostics when both a sink and its failure reporter throw', () => {
	const entries: LogEntry[] = [];
	let reports = 0;
	using service = new LogService({
		sinks: [{ log: () => { throw new Error('console transport disconnected'); } }, { log: entry => entries.push(entry) }],
		onSinkError: () => { reports++; throw new Error('failure reporter disconnected'); },
	});
	assert.doesNotThrow(() => service.error('runtime', 'original failure'));
	service.info('runtime', 'still usable');
	assert.deepEqual(entries.map(entry => entry.message), ['original failure', 'still usable']);
	assert.equal(reports, 2);
});

test('LogService defaults to Info and changes production verbosity independently of consumers', () => {
	const entries: LogEntry[] = [];
	using service = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
	service.trace('NativeEditContext.focus');
	service.debug('debug message');
	service.info('ready');
	assert.deepEqual(entries.map(entry => entry.message), ['ready']);
	service.setLevel(LogLevel.Trace);
	service.trace('NativeEditContext.focus');
	assert.deepEqual(entries.map(entry => entry.message), ['ready', 'NativeEditContext.focus']);
});

test('log levels, null logging, and console logging expose the complete platform contract', () => {
	assert.equal(canLog(LogLevel.Info, LogLevel.Debug), false);
	assert.equal(canLog(LogLevel.Info, LogLevel.Error), true);
	assert.equal(canLog(LogLevel.Off, LogLevel.Error), false);
	const nullLogger = new NullLoggerService();
	assert.doesNotThrow(() => nullLogger.error(new Error('ignored')));
	assert.equal(nullLogger.createLogger('child'), nullLogger);

	const calls: unknown[][] = [];
	const logger = new ConsoleLogger('editor', {
		debug: (...arguments_) => calls.push(arguments_),
		info: (...arguments_) => calls.push(arguments_),
		warn: (...arguments_) => calls.push(arguments_),
		error: (...arguments_) => calls.push(arguments_),
	});
	logger.info('ready', { version: 1 });
	assert.deepEqual(calls, [['[editor] ready', { version: 1 }]]);
});

test('LogService accepts uncategorized messages without losing structured local calls', () => {
	const entries: LogEntry[] = [];
	using service = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
	service.info('standalone message');
	service.info('editor', 'opened', { id: 1 });
	assert.deepEqual(entries.map(entry => [entry.category, entry.message]), [
		['application', 'standalone message'],
		['editor', 'opened {"id":1}'],
	]);
});

test('named loggers own filtering, string arguments and flush on the original sink', async () => {
	const entries: LogEntry[] = [];
	let flushes = 0;
	using host = new LogService({ sinks: [{ log: entry => entries.push(entry) }], flush: async () => { flushes++; } });
	using terminal = host.createLogger('terminal');
	const levels: LogLevel[] = [];
	using listener = terminal.onDidChangeLogLevel(level => levels.push(level));
	terminal.setLevel(LogLevel.Warning);
	terminal.setLevel(LogLevel.Warning);
	terminal.info('filtered');
	terminal.warn('message', 'argument');
	await terminal.flush();
	assert.deepEqual(levels, [LogLevel.Warning]);
	assert.deepEqual(entries.map(entry => [entry.category, entry.message]), [['terminal', 'message argument']]);
	assert.equal(flushes, 1);
	terminal.dispose();
	terminal.error('released');
	assert.equal(entries.length, 1);
});
