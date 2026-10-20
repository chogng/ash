import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { ElectronWorkbenchEnvironmentService } from '../../../environment/electron-browser/environmentService.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { LogLevel, type LogEntry } from '../../../../../platform/log/common/log.js';
import { LoggerChannel } from '../../../../../platform/log/electron-main/logIpc.js';
import { LoggerService } from '../../../../../platform/log/node/loggerService.js';
import { NativeLogService } from '../../electron-browser/logService.js';

suite('Workbench Desktop logging', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const category of ['workbench', 'agents']) {
		test(`${category} owns Window filtering, replay, child loggers and authenticated persistence`, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'ash-workbench-logs-'));
			try {
				using owner = new LoggerService({ logsHome: directory });
				await owner.initialize();
				const channel = new LoggerChannel(owner, { initialLogLevel: LogLevel.Debug, extensionLogLevel: [] });
				using services = new InstantiationService();
				using startup = new DisposableStore();
				using workbench = new DisposableStore();
				services.registerInstance(IWorkbenchEnvironmentService, new ElectronWorkbenchEnvironmentService(await channel.call('window:7', 'getDefaultLogLevels', undefined)));
				assert.throws(() => services.createInstance(NativeLogService, category), /mainProcessService/);
				services.registerInstance(IMainProcessService, {
					_serviceBrand: undefined,
					getChannel: () => ({
						call: (command, arg) => channel.call('window:7', command, JSON.parse(JSON.stringify(arg ?? null)) ?? undefined),
						listen: event => channel.listen('window:7', event),
					}),
					registerChannel: () => { throw new Error('Unexpected channel registration'); },
				});
				const logger = startup.add(services.createInstance(NativeLogService, category));
				// Native startup retains failure cleanup until the factory takes ownership.
				assert.throws(() => workbench.add(logger), /NativeLogService already belongs to DisposableStore/);
				startup.delete(logger);
				workbench.add(logger);
				startup.dispose();
				assert.equal(logger.isDisposed, false);
				assert.equal(logger.getLevel(), LogLevel.Debug);
				logger.setLevel(LogLevel.Info);
				logger.debug('filtered');
				logger.info('ready');
				logger.setLevel(LogLevel.Trace);
				logger.trace('connection', 'connected');
				using child = logger.createLogger('language-server');
				assert.equal(logger.getLogger('language-server'), child);
				// A child owns its level even when the Window logger is turned off.
				logger.setLevel(LogLevel.Off);
				child.debug('child recorded');
				logger.error('filtered after off');
				const replay: LogEntry[] = [];
				using subscription = logger.registerSink({ log: entry => replay.push(entry) }, true);
				assert.deepEqual(replay.map(entry => entry.message), ['ready', 'connected', 'child recorded']);
				await child.flush();
				const files = await logger.files.list();
				assert.equal(files.length, 1);
				assert.equal(files[0]!.currentWindow, true);
				const saved = await logger.files.read(files[0]!.id);
				assert.deepEqual(saved.text.trim().split('\n').map(line => {
					const entry = JSON.parse(line);
					return [entry.source, entry.category, entry.level, entry.message];
				}), [
					['window-7', category, LogLevel.Info, 'ready'],
					['window-7', 'connection', LogLevel.Trace, 'connected'],
					['window-7', 'language-server', LogLevel.Debug, 'child recorded'],
				]);
				workbench.dispose();
				assert.equal(logger.isDisposed, true);
				assert.equal(child.isDisposed, true);
				child.info('ignored after disposal');
				assert.equal(logger.getLogger('language-server'), undefined);
				await owner.close();
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
});
