import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILoggerService, LogLevel, type LogEntry } from '../../../log/common/log.js';
import { LogService } from '../../../log/common/logServiceImpl.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { TestWorkspaceService } from '../../../../workbench/services/configuration/test/common/testServices.js';
import { TerminalLogService } from '../../common/terminalLogService.js';

suite('Terminal scoped logging', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the original sinks, current workspace, independent level and persistence flush', async () => {
		using lifetime = new DisposableStore();
		const entries: LogEntry[] = [];
		let flushed = false;
		const host = lifetime.add(new LogService({
			level: LogLevel.Trace,
			sinks: [{ log: entry => entries.push(entry) }],
			flush: async () => { flushed = true; },
		}));
		const services = lifetime.add(new InstantiationService());
		const workspace = lifetime.add(new TestWorkspaceService({ id: 'workspace-original', uri: URI.file('/workspace') }));
		services.registerInstance(ILoggerService, host);
		services.registerInstance(IWorkspaceContextService, workspace);
		const terminal = lifetime.add(services.createInstance(TerminalLogService));
		const levels: LogLevel[] = [];
		lifetime.add(terminal.onDidChangeLogLevel(level => levels.push(level)));
		terminal.trace('ready', 'argument');
		workspace.updateWorkspace({ id: 'changed-workspace', uri: URI.file('/changed') });
		terminal.debug('changed');
		terminal.setLevel(LogLevel.Error);
		terminal.warn('filtered');
		terminal.error(new Error('problem'));
		await terminal.flush();
		assert.equal(flushed, true);
		assert.deepEqual(levels, [LogLevel.Error]);
		assert.deepEqual(entries.map(entry => [entry.category, entry.message]), [
			['terminal', '[workspa] ready argument'],
			['terminal', '[changed] changed'],
			['terminal', 'problem'],
		]);
		assert.ok(entries[2]!.error instanceof Error);
		terminal.dispose();
		terminal.error('released');
		assert.equal(entries.length, 3);
		host.info('host remains live');
		assert.equal(entries.length, 4);
	});
});
