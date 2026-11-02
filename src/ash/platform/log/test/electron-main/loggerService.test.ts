import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { LogLevel, type LogEntry } from '../../common/log.js';
import { LoggerChannelClient } from '../../common/logIpc.js';
import { LoggerService } from '../../electron-main/loggerService.js';
import type { HostLogRequest, HostLogResponse } from '../../../../../../.build/protocol/typescript/HostLogs.js';

suite('Desktop Rust log adapter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const entry = (message: string): LogEntry => ({ timestampMillis: 123, category: 'test', level: LogLevel.Info, message, error: undefined });
	test('a stalled Main write bounds the renderer backlog and reports omitted diagnostics before flush', async () => {
		const firstWrite = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		const entries: LogEntry[] = [];
		let flushes = 0;
		using services = new InstantiationService();
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: () => ({
				call: async <T>(command: string, arg?: unknown): Promise<T> => {
					if (command === 'log') {
						entries.push(arg as LogEntry);
						if (entries.length === 1) { void started.complete(); await firstWrite.p; }
					} else if (command === 'flush') { flushes++; }
					return undefined as T;
				},
				listen: () => Event.None,
			}),
			registerChannel: () => { throw new Error('Unexpected channel registration'); },
		});
		using client = new LoggerChannelClient(services.get(IMainProcessService).getChannel('logger'));
		try {
			for (let index = 0; index < 10000; index++) { client.log(entry(`diagnostic ${index}`)); }
			await started.p;
			assert.equal(entries.length, 1, 'Only one IPC write may remain in flight while Main is stalled');
		} finally { await firstWrite.complete(); }
		await client.flush();
		assert.deepEqual(entries.slice(0, 128).map(value => value.message), Array.from({ length: 128 }, (_, index) => `diagnostic ${index}`));
		assert.equal(entries.length, 129);
		assert.equal(entries[128]!.level, LogLevel.Warning);
		assert.match(entries[128]!.message, /9872/);
		assert.equal(flushes, 1);
		client.log(entry('recovered'));
		await client.flush();
		assert.equal(entries.at(-1)!.message, 'recovered');
	});

	test('an oversized diagnostic cannot bypass the pending text budget or block later writes', async () => {
		const entries: LogEntry[] = [];
		using services = new InstantiationService();
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: () => ({
				call: async <T>(command: string, arg?: unknown): Promise<T> => { if (command === 'log') { entries.push(arg as LogEntry); } return undefined as T; },
				listen: () => Event.None,
			}),
			registerChannel: () => { throw new Error('Unexpected channel registration'); },
		});
		using client = new LoggerChannelClient(services.get(IMainProcessService).getChannel('logger'));
		client.log(entry('x'.repeat(1024 * 1024)));
		client.log(entry('still writable'));
		await client.flush();
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.level, LogLevel.Warning);
		assert.match(entries[0]!.message, /1/);
		assert.equal(entries[1]!.message, 'still writable');
	});

	test('a broken transport and console cannot recursively report every queued failure', async () => {
		const failure = new Error('Disconnected log transport');
		using services = new InstantiationService();
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: () => ({ call: async () => { throw failure; }, listen: () => Event.None }),
			registerChannel: () => { throw new Error('Unexpected channel registration'); },
		});
		using client = new LoggerChannelClient(services.get(IMainProcessService).getChannel('logger'));
		const original = console.error;
		let reports = 0;
		console.error = () => { reports++; throw new Error('Disconnected console'); };
		try {
			for (let index = 0; index < 1000; index++) { client.log(entry(`diagnostic ${index}`)); }
			await assert.rejects(client.flush(), error => error === failure);
			assert.equal(reports, 1);
		} finally { console.error = original; }
	});


	function fixture(handler: (request: HostLogRequest, reply: (response: HostLogResponse) => void) => void) {
		const requests: HostLogRequest[] = [];
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), {
			exitCode: null as number | null, stdout, stderr,
			stdin: new Writable({
				write: (chunk, _encoding, callback) => {
					const request = JSON.parse(String(chunk)) as HostLogRequest;
					requests.push(request);
					const reply = (response: HostLogResponse): void => { stdout.write(JSON.stringify(response) + '\n'); };
					if (request.op === 'initialize') reply({ kind: 'initialized', version: 1, sessionPath: '/logs/session' });
					else if (request.op === 'close') {
						reply({ kind: 'ok' });
						queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0, null); });
					} else handler(request, reply);
					callback();
				}
			}),
			kill: () => { child.exitCode = 1; child.emit('close', 1, null); return true; },
		});
		const logger = new LoggerService({ logsHome: '/logs', start: () => child as unknown as ChildProcessWithoutNullStreams });
		return { logger, requests, child };
	}

	test('quit before startup does not launch a logging process', async () => {
		using logger = new LoggerService({ logsHome: '/logs', start: () => { throw new Error('Logger must not start'); } });
		await logger.close();
	});

	test('orders writes before flush and drains the Rust process once on close', async () => {
		const f = fixture((_request, reply) => reply({ kind: 'ok' }));
		using logger = f.logger;
		await logger.initialize();
		assert.equal(logger.sessionPath, '/logs/session');
		await Promise.all([logger.log('window-7', entry('first')), logger.log('main', entry('second')), logger.flush()]);
		const closed = logger.close();
		assert.equal(logger.close(), closed);
		await closed;
		assert.deepEqual(f.requests.map(request => request.op), ['initialize', 'append', 'append', 'flush', 'close']);
		await assert.rejects(logger.log('main', entry('late')), /not open/);
	});

	test('a stalled Rust pipe bounds requests and releases capacity after acknowledgment', async () => {
		let release: (() => void) | undefined;
		const entered = new DeferredPromise<void>();
		const f = fixture((request, reply) => {
			if (request.op === 'append' && !release) {
				release = () => reply({ kind: 'ok' });
				void entered.complete();
			} else reply({ kind: 'ok' });
		});
		using logger = f.logger;
		await logger.initialize();
		const writes = Array.from({ length: 129 }, (_, index) => logger.log('main', entry(String(index))));
		const results = Promise.allSettled(writes);
		await entered.p;
		assert.equal(f.requests.length, 2);
		const closed = logger.close();
		release!();
		const settled = await results;
		assert.equal(settled.filter(result => result.status === 'fulfilled').length, 128);
		assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
		await closed;
	});

	test('Rust failure rejects pending and queued requests without restarting or replaying writes', async () => {
		const entered = new DeferredPromise<void>();
		const f = fixture(() => { void entered.complete(); });
		using logger = f.logger;
		await logger.initialize();
		const writes = Promise.allSettled([logger.log('main', entry('first')), logger.log('main', entry('second'))]);
		await entered.p;
		f.child.kill();
		assert.ok((await writes).every(result => result.status === 'rejected'));
		assert.deepEqual(f.requests.map(request => request.op), ['initialize', 'append']);
		await assert.rejects(logger.flush(), /exited/);
	});

	test('malformed Rust responses close the pipe instead of publishing unchecked file metadata', async () => {
		const f = fixture(() => { f.child.stdout.write('{"kind":"listed","files":[{"id":"unchecked"}]}\n'); });
		using logger = f.logger;
		await logger.initialize();
		await assert.rejects(logger.getLogFiles('window-1'));
		assert.equal(f.child.exitCode, 1);
	});
});
