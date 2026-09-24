import assert from "node:assert/strict";
import { test } from "mocha";
import { canLog, ConsoleLogger, LogLevel, NullLoggerService, type LogEntry } from "../../common/log.js";
import { LogService } from "../../common/logServiceImpl.js";

test("LogService publishes structured entries and releases dynamic sinks", () => {
	const entries: LogEntry[] = [];
	using service = new LogService({ now: () => 42 });
	const registration = service.registerSink({ log: entry => entries.push(entry) });
	service.warn("workspace", "Could not restore state", new Error("invalid"));
	registration.dispose();
	service.info("workspace", "Ignored after disposal");
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.timestampMillis, 42);
	assert.equal(entries[0]?.level, "warning");
	assert.equal(entries[0]?.category, "workspace");
	assert.match(String(entries[0]?.error), /invalid/u);
});

test("LogService isolates a failing sink", () => {
	const entries: LogEntry[] = [];
	const sinkErrors: unknown[] = [];
	using service = new LogService({ sinks: [{ log: () => { throw new Error("sink failed"); } }, { log: entry => entries.push(entry) }], onSinkError: (_entry, error) => sinkErrors.push(error) });
	service.error("test", "failure");
	assert.equal(entries.length, 1);
	assert.equal(sinkErrors.length, 1);
});

test("log levels, null logging, and console logging expose the complete platform contract", () => {
	assert.equal(canLog(LogLevel.Info, LogLevel.Debug), false);
	assert.equal(canLog(LogLevel.Info, LogLevel.Error), true);
	assert.equal(canLog(LogLevel.Off, LogLevel.Error), false);
	const nullLogger = new NullLoggerService();
	assert.doesNotThrow(() => nullLogger.error(new Error("ignored")));
	assert.equal(nullLogger.createLogger("child"), nullLogger);

	const calls: unknown[][] = [];
	const logger = new ConsoleLogger("editor", {
		debug: (...arguments_) => calls.push(arguments_),
		info: (...arguments_) => calls.push(arguments_),
		warn: (...arguments_) => calls.push(arguments_),
		error: (...arguments_) => calls.push(arguments_),
	});
	logger.info("ready", { version: 1 });
	assert.deepEqual(calls, [["[editor] ready", { version: 1 }]]);
});

test("LogService accepts uncategorized messages without losing structured local calls", () => {
	const entries: LogEntry[] = [];
	using service = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
	service.info("standalone message");
	service.info("editor", "opened", { id: 1 });
	assert.deepEqual(entries.map(entry => [entry.category, entry.message]), [
		["application", "standalone message"],
		["editor", "opened {\"id\":1}"],
	]);
});
