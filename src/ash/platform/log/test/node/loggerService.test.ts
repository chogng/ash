import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { LogLevel, type LogEntry } from '../../common/log.js';
import { LoggerChannelClient } from '../../common/logIpc.js';
import { LoggerChannel } from '../../electron-main/logIpc.js';
import { LoggerService } from '../../node/loggerService.js';

suite('Desktop log files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const entry = (message: string): LogEntry => ({ timestampMillis: 123, category: 'test', level: LogLevel.Info, message, error: undefined });

	test('window channel persists ordered structured logs and error stacks before flush', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			using owner = new LoggerService({ logsHome: directory });
			await owner.initialize();
			const channel = new LoggerChannel(owner);
			using services = new InstantiationService();
			assert.throws(() => services.createInstance(LoggerChannelClient), /mainProcessService/);
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => channel.call('window:7', command, JSON.parse(JSON.stringify(arg ?? null)) ?? undefined),
					listen: event => channel.listen('window:7', event),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			const client = services.createInstance(LoggerChannelClient);
			using logger = client.createLogger('agents');
			logger.info('connection', 'ready', { generation: 2 });
			logger.error('connection', 'crashed', new Error('carrier exited'));
			await client.flush();
			const logs = (await readFile(join(owner.sessionPath, 'window-7.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
			assert.deepEqual(logs.map(log => ({ source: log.source, category: log.category, level: log.level, message: log.message, processId: log.processId })), [
				{ source: 'window-7', category: 'connection', level: LogLevel.Info, message: 'ready {"generation":2}', processId: process.pid },
				{ source: 'window-7', category: 'connection', level: LogLevel.Error, message: 'crashed carrier exited', processId: process.pid },
			]);
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
			assert.deepEqual(sources.map(source => JSON.parse(source.trim()).message.at(-1)), ['3', '4', '5']);
			assert.ok(sources.every(source => Buffer.byteLength(source) <= 400));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('maintenance retains the current and latest session and leaves unrelated directories alone', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-logs-'));
		try {
			const old = ['20250101T000000000', '20250102T000000000', '20250103T000000000'].map(timestamp => `${timestamp}-00000000-0000-0000-0000-000000000000`);
			for (const name of [...old, 'custom']) { await mkdir(join(directory, name)); }
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
});
