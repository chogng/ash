import { MenusRegistry, MenuId, isMenuItem } from '../../../../../platform/actions/common/actions.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { showWindowLogActionId, windowLogId } from '../../../../services/log/common/logConstants.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import '../../common/logs.contribution.js';
import { ILoggerService } from '../../../../../platform/log/common/log.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';

test('registered loggers reach Output before and after startup, respect visibility and retire with producers', () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	using loggers = new LogService();
	const startup = loggers.createLogger('startup', { name: 'Startup' });
	startup.warn('before Output loads');
	services.registerInstance(ILoggerService, loggers);
	using contribution = WorkbenchContributionsRegistry.createHost(
		services,
		error => {
			throw error;
		},
		['workbench.contrib.logs'],
	);
	contribution.advance(WorkbenchPhase.AfterRestored);
	const channel = output.getChannel('logger.startup')!;
	assert.match(channel.getText(), /before Output loads/);
	assert.equal(loggers.createLogger('startup'), startup);
	channel.clear();
	startup.info('after clear');
	assert.equal(channel.entries.length, 1);
	assert.match(channel.getText(), /after clear/);
	const dynamic = loggers.createLogger('dynamic');
	const live = output.getChannel('logger.dynamic')!;
	live.descriptor.logger!.control.setLevel('trace');
	dynamic.trace('verbose details');
	assert.equal(live.entries[0]!.severity, 'trace');
	loggers.setVisibility('dynamic', false);
	assert.equal(output.getChannel('logger.dynamic'), undefined);
	dynamic.warn('while hidden');
	loggers.setVisibility('dynamic', true);
	assert.match(output.getChannel('logger.dynamic')!.getText(), /while hidden/);
	dynamic.dispose();
	assert.equal(output.getChannel('logger.dynamic'), undefined);
	assert.equal(loggers.getLogger('dynamic'), undefined);
	loggers.createLogger('hidden', { hidden: true }).info('private');
	assert.equal(output.getChannel('logger.hidden'), undefined);
	contribution.dispose();
	assert.equal(output.getChannel('logger.startup'), undefined);
	startup.info('producer survives UI disposal');
});

test('Show Window Log selects and reveals the Window channel through the registered command', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	using logger = new LogService();
	services.registerInstance(ILoggerService, logger);
	using window = output.createChannel({ id: windowLogId, label: 'Window', kind: 'log' });
	using other = output.createChannel({ id: 'other', label: 'Other' });
	output.selectChannel(other.id);
	using contribution = WorkbenchContributionsRegistry.createHost(
		services,
		error => {
			throw error;
		},
		['workbench.contrib.logs'],
	);
	contribution.advance(WorkbenchPhase.AfterRestored);
	const reveals: [string, string][] = [];
	using listener = output.onDidRequestShowChannel(event => reveals.push([event.channel.id, event.focus]));
	await services.get(ICommandService).executeCommand(showWindowLogActionId);
	assert.equal(output.activeChannel, window);
	assert.deepEqual(reveals, [[windowLogId, 'take']]);
});

test('Show Window Log uses the installed Chinese translation in the command palette', () => {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	try {
		using resources = new DisposableStore();
		const services = workbenchInstantiationService(resources);
		using logger = new LogService();
		services.registerInstance(ILoggerService, logger);
		using contribution = WorkbenchContributionsRegistry.createHost(
			services,
			error => {
				throw error;
			},
			['workbench.contrib.logs'],
		);
		contribution.advance(WorkbenchPhase.AfterRestored);
		const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => isMenuItem(item) && item.command.id === showWindowLogActionId);
		assert.ok(item && isMenuItem(item));
		assert.deepEqual(item.command.title, {
			original: 'Developer: Show Window Log',
			value: '开发人员: 显示窗口日志',
		});
		assert.match(catalog.bundles.ash!['output.help.windowLog']!, /显示窗口日志/);
	} finally {
		resetNlsResolver();
	}
});
