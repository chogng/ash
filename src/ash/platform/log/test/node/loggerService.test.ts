import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, appendFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { LogLevel, type LogEntry } from '../../common/log.js';
import { LoggerChannelClient } from '../../common/logIpc.js';
import { LoggerChannel } from '../../electron-main/logIpc.js';
import { LoggerService } from '../../node/loggerService.js';

suite('Desktop log files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const entry = (message: string): LogEntry => ({
		timestampMillis: 123,
		category: 'test',
		level: LogLevel.Info,
		message,
		error: undefined,
	});

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
						if (entries.length === 1) {
							void started.complete();
							await firstWrite.p;
						}
					} else if (command === 'flush') {
						flushes++;
					}
					return undefined as T;
				},
				listen: () => Event.None,
			}),
			registerChannel: () => {
				throw new Error('Unexpected channel registration');
			},
		});
		using client = new LoggerChannelClient(services.get(IMainProcessService).getChannel('logger'));
		try {
			for (let index = 0; index < 10000; index++) {
				client.log(entry(`diagnostic ${index}`));
			}
			await started.p;
			assert.equal(entries.length, 1, 'Only one IPC write may remain in flight while Main is stalled');
		} finally {
			await firstWrite.complete();
		}
		await client.flush();
		assert.deepEqual(
			entries.slice(0, 128).map(value => value.message),
			Array.from({ length: 128 }, (_, index) => `diagnostic ${index}`),
		);
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
				call: async <T>(command: string, arg?: unknown): Promise<T> => {
					if (command === 'log') {
						entries.push(arg as LogEntry);
					}
					return undefined as T;
				},
				listen: () => Event.None,
			}),
			registerChannel: () => {
				throw new Error('Unexpected channel registration');
			},
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
			getChannel: () => ({
				call: async () => {
					throw failure;
				},
				listen: () => Event.None,
			}),
			registerChannel: () => {
				throw new Error('Unexpected channel registration');
			},
		});
		using client = new LoggerChannelClient(services.get(IMainProcessService).getChannel('logger'));
		const original = console.error;
		let reports = 0;
		console.error = () => {
			reports++;
			throw new Error('Disconnected console');
		};
		try {
			for (let index = 0; index < 1000; index++) {
				client.log(entry(`diagnostic ${index}`));
			}
			await assert.rejects(client.flush(), error => error === failure);
			assert.equal(reports, 1);
		} finally {
			console.error = original;
		}
	});

	test('window channel persists ordered structured logs and error stacks before flush', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			using owner = new LoggerService({ logsHome: directory });
			await owner.initialize();
			const channel = new LoggerChannel(owner);
			using services = new InstantiationService();
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => channel.call('window:7', command, JSON.parse(JSON.stringify(arg ?? null)) ?? undefined),
					listen: event => channel.listen('window:7', event),
				}),
				registerChannel: () => {
					throw new Error('Unexpected channel registration');
				},
			});
			using client = new LoggerChannelClient(services.get(IMainProcessService).getChannel('logger'));
			using logger = client.createLogger('agents');
			logger.info('connection', 'ready', { generation: 2 });
			logger.error('connection', 'crashed', new Error('carrier exited'));
			// A caller flushes its logger; this must reach the authenticated Main queue.
			await logger.flush();
			const files = await client.files.list();
			assert.equal(files.length, 1);
			assert.equal(files[0]!.currentWindow, true);
			const replay = await client.files.read(files[0]!.id);
			assert.deepEqual(
				replay.text
					.trim()
					.split('\n')
					.map(line => JSON.parse(line).message),
				['ready {"generation":2}', 'crashed carrier exited'],
			);
			await assert.rejects(channel.call('window:7', 'read', { id: files[0]!.id, cursor: { generation: 'x', offset: -1 } }), /Invalid log cursor/);
			await assert.rejects(client.files.read('../outside'), /Invalid log file identity/);
			const logs = (await readFile(join(owner.sessionPath, 'window-7.log'), 'utf8'))
				.trim()
				.split('\n')
				.map(line => JSON.parse(line));
			assert.deepEqual(
				logs.map(log => ({
					source: log.source,
					category: log.category,
					level: log.level,
					message: log.message,
					processId: log.processId,
				})),
				[
					{
						source: 'window-7',
						category: 'connection',
						level: LogLevel.Info,
						message: 'ready {"generation":2}',
						processId: process.pid,
					},
					{
						source: 'window-7',
						category: 'connection',
						level: LogLevel.Error,
						message: 'crashed carrier exited',
						processId: process.pid,
					},
				],
			);
			assert.match(logs[1].error, /Error: carrier exited/);
			await assert.rejects(channel.call('../outside', 'log', entry('invalid source')), /Invalid logger window/);
			await assert.rejects(channel.call('window:7', 'log', { ...entry('invalid entry'), level: 'invalid' }), /Invalid log entry/);
			await owner.close();
			assert.throws(() => owner.log('main', entry('after close')), /not open/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('rotation retains the last three bounded files without losing their order', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			using owner = new LoggerService({ logsHome: directory, maxFileBytes: 400 });
			await owner.initialize();
			await Promise.all([1, 2, 3, 4, 5].map(index => owner.log('main', entry('x'.repeat(200) + index))));
			await owner.close();
			assert.deepEqual((await readdir(owner.sessionPath)).sort(), ['main.log', 'main.log.1', 'main.log.2']);
			const sources = await Promise.all(['main.log.2', 'main.log.1', 'main.log'].map(file => readFile(join(owner.sessionPath, file), 'utf8')));
			assert.deepEqual(
				sources.map(source => JSON.parse(source.trim()).message.at(-1)),
				['3', '4', '5'],
			);
			assert.ok(sources.every(source => Buffer.byteLength(source) <= 400));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('maintenance retains the current and latest session and leaves unrelated directories alone', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			const old = ['20250101T000000000', '20250102T000000000', '20250103T000000000'].map(timestamp => `${timestamp}-00000000-0000-0000-0000-000000000000`);
			for (const name of [...old, 'custom']) {
				await mkdir(join(directory, name));
			}
			using owner = new LoggerService({ logsHome: directory, retainedSessions: 2 });
			await owner.initialize();
			await owner.cleanUpLogs();
			await owner.log('main', entry('after maintenance'));
			await owner.flush();
			assert.deepEqual((await readdir(directory)).sort(), [old[2]!, owner.sessionPath.slice(directory.length + 1), 'custom'].sort());
			assert.match(await readFile(join(owner.sessionPath, 'main.log'), 'utf8'), /after maintenance/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('saved log reads restore previous sessions and keep complete UTF-8 records behind an incremental cursor', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			using previous = new LoggerService({ logsHome: directory });
			await previous.initialize();
			await previous.log('window-7', entry('previous session'));
			using current = new LoggerService({ logsHome: directory });
			await current.initialize();
			await current.log('window-7', entry('current session'));
			const sources = await current.getLogFiles('window-7');
			const live = sources.find(source => source.currentWindow)!;
			const history = sources.find(source => !source.live)!;
			assert.ok(live);
			assert.ok(history);
			assert.equal((await current.readLogFile(history.id)).text.includes('previous session'), true);
			const first = await current.readLogFile(live.id);
			assert.equal(first.gap, false);
			assert.equal(JSON.parse(first.text).message, 'current session');
			const bytes = Buffer.from(JSON.stringify(entry('中文日志')) + '\n');
			const split = bytes.indexOf(Buffer.from('中')) + 1;
			await appendFile(join(current.sessionPath, 'window-7.log'), bytes.subarray(0, split));
			const partial = await current.readLogFile(live.id, first.cursor);
			assert.equal(partial.text, '');
			assert.deepEqual(partial.cursor, first.cursor);
			await appendFile(join(current.sessionPath, 'window-7.log'), bytes.subarray(split));
			const next = await current.readLogFile(live.id, partial.cursor);
			assert.equal(JSON.parse(next.text).message, '中文日志');
			assert.equal((await current.readLogFile(live.id, next.cursor)).text, '');
			await assert.rejects(current.readLogFile('../outside.log'), /Invalid log file identity/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('reads follow rotation and daemon-owned raw logs without copying or truncating their files', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			const daemonLog = join(directory, 'daemon.log');
			await writeFile(daemonLog, 'real backend diagnostic\n');
			using owner = new LoggerService({
				logsHome: directory,
				maxFileBytes: 400,
				appServerLog: async () => daemonLog,
			});
			await owner.initialize();
			await owner.log('main', entry('x'.repeat(200)));
			const sources = await owner.getLogFiles('window-1');
			const main = sources.find(source => source.source === 'main')!;
			const first = await owner.readLogFile(main.id);
			await owner.log('main', entry('y'.repeat(200)));
			const rotated = await owner.readLogFile(main.id, first.cursor);
			assert.equal(rotated.gap, true);
			assert.equal(JSON.parse(rotated.text).message, 'y'.repeat(200));
			assert.equal(
				(await owner.getLogFiles('window-1')).some(source => source.id.endsWith('.log.1')),
				true,
			);
			const daemon = sources.find(source => source.id === 'app-server')!;
			assert.equal(daemon.format, 'text');
			const raw = await owner.readLogFile(daemon.id);
			assert.equal(raw.text, 'real backend diagnostic\n');
			await appendFile(daemonLog, 'another diagnostic\n');
			assert.equal((await owner.readLogFile(daemon.id, raw.cursor)).text, 'another diagnostic\n');
			assert.equal(await readFile(daemonLog, 'utf8'), 'real backend diagnostic\nanother diagnostic\n');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('bounded tails report gaps and reject symlinked session directories', async function () {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			using owner = new LoggerService({ logsHome: directory });
			await owner.initialize();
			await owner.log('main', entry('start'));
			const source = (await owner.getLogFiles('window-1'))[0]!;
			await appendFile(join(owner.sessionPath, 'main.log'), 'x'.repeat(1024 * 1024) + '\n' + JSON.stringify(entry('tail')) + '\n');
			const result = await owner.readLogFile(source.id);
			assert.equal(result.gap, true);
			assert.equal(JSON.parse(result.text).message, 'tail');
			if (process.platform !== 'win32') {
				const sessionId = source.id.split('/')[0]!;
				await symlink(join(owner.sessionPath, 'main.log'), join(owner.sessionPath, 'window-99.log'));
				await assert.rejects(owner.readLogFile(`${sessionId}/window-99.log`), /Log source must be a regular file/);
				const session = '20250101T000000000-00000000-0000-0000-0000-000000000000';
				await symlink(owner.sessionPath, join(directory, session));
				await assert.rejects(owner.readLogFile(`${session}/main.log`), /Invalid log session directory/);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
