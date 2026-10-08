import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService, NotificationSeverity } from '../../../../../platform/notification/common/notification.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import '../../common/commands.contribution.js';

suite('runCommands', () => {
	test('awaits each command before starting the next one', async () => {
		using environment = new CommandEnvironment();
		const started = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const order: string[] = [];
		using registration = CommandsRegistry.registerMany([
			{
				id: 'test.batch.first', handler: async () => {
					order.push('first started');
					await started.complete();
					await release.p;
					order.push('first finished');
				}
			},
			{ id: 'test.batch.second', handler: () => order.push('second') },
		]);
		const execution = environment.commands.executeCommand('runCommands', { commands: ['test.batch.first', 'test.batch.second'] });
		try {
			await started.p;
			assert.deepEqual(order, ['first started']);
		} finally {
			await release.complete();
			await execution;
		}
		assert.deepEqual(order, ['first started', 'first finished', 'second']);
		assert.deepEqual(environment.notifications.getNotifications(), []);
	});

	test('forwards arrays as positional arguments and other values as a single argument', async () => {
		using environment = new CommandEnvironment();
		const received: unknown[][] = [];
		using registration = CommandsRegistry.register('test.batch.arguments', (_accessor, ...args) => received.push([...args]));
		await environment.commands.executeCommand('runCommands', {
			commands: [
				'test.batch.arguments',
				{ command: 'test.batch.arguments' },
				{ command: 'test.batch.arguments', args: [] },
				{ command: 'test.batch.arguments', args: ['one', 2] },
				{ command: 'test.batch.arguments', args: [[1, 2]] },
				{ command: 'test.batch.arguments', args: { value: 'object' } },
				{ command: 'test.batch.arguments', args: null },
				{ command: 'test.batch.arguments', args: false },
				{ command: 'test.batch.arguments', args: 0 },
			],
		});
		assert.deepEqual(received, [[], [], [], ['one', 2], [[1, 2]], [{ value: 'object' }], [null], [false], [0]]);
	});

	test('rejects an invalid batch before any command runs', async () => {
		using environment = new CommandEnvironment();
		let calls = 0;
		using registration = CommandsRegistry.register('test.batch.valid', () => calls++);
		const invalid = [undefined, null, 'command', {}, { commands: 'command' }, { commands: ['test.batch.valid', null] }, { commands: ['test.batch.valid', { command: 3 }] }];
		for (const args of invalid) {
			await environment.commands.executeCommand('runCommands', args);
		}
		assert.equal(calls, 0);
		assert.deepEqual(environment.notifications.getNotifications().map(item => item.severity), invalid.map(() => NotificationSeverity.Error));
	});

	test('warns when the command list is empty', async () => {
		using environment = new CommandEnvironment();
		await environment.commands.executeCommand('runCommands', { commands: [] });
		assert.deepEqual(environment.notifications.getNotifications().map(item => item.severity), [NotificationSeverity.Warning]);
	});

	for (const failure of ['synchronous', 'asynchronous', 'unknown']) {
		test(`reports a ${failure} failure and skips the remaining commands`, async () => {
			using environment = new CommandEnvironment();
			const order: string[] = [];
			using registration = CommandsRegistry.registerMany([
				{ id: 'test.batch.before', handler: () => order.push('before') },
				{ id: 'test.batch.throw', handler: () => { throw new Error('Synchronous failure'); } },
				{ id: 'test.batch.reject', handler: () => Promise.reject(new Error('Asynchronous failure')) },
				{ id: 'test.batch.after', handler: () => order.push('after') },
			]);
			const failedCommand = { synchronous: 'test.batch.throw', asynchronous: 'test.batch.reject', unknown: 'test.batch.missing' }[failure]!;
			await environment.commands.executeCommand('runCommands', { commands: ['test.batch.before', failedCommand, 'test.batch.after'] });
			assert.deepEqual(order, ['before']);
			const expected = { synchronous: 'Synchronous failure', asynchronous: 'Asynchronous failure', unknown: 'Unknown command: test.batch.missing' }[failure];
			assert.deepEqual(environment.notifications.getNotifications().map(item => ({ severity: item.severity, message: item.message })), [{ severity: NotificationSeverity.Error, message: expected }]);
		});
	}

	test('reports invalid and empty arguments in Chinese', async () => {
		using environment = new CommandEnvironment();
		const catalog = builtinLanguagePackCatalogs.find(item => item.locale === 'zh-CN')!;
		try {
			setNlsMessages(catalog.locale, catalog.bundles);
			await environment.commands.executeCommand('runCommands', null);
			await environment.commands.executeCommand('runCommands', { commands: [] });
			assert.deepEqual(environment.notifications.getNotifications().map(item => item.message), [
				'“runCommands” 收到的参数类型不正确。请检查传给该命令的参数。',
				'“runCommands” 没有收到要运行的命令。请在参数的 “commands” 中添加命令。',
			]);
		} finally {
			resetNlsResolver();
		}
	});
});

class CommandEnvironment extends Disposable {
	public readonly notifications = this._register(new NotificationService());
	public readonly commands: CommandService;

	constructor() {
		super();
		const services = this._register(new InstantiationService());
		services.registerInstance(INotificationService, this.notifications);
		services.registerInstance(ILogService, new NullLoggerService());
		this.commands = this._register(new CommandService(services));
		services.registerInstance(ICommandService, this.commands);
	}
}
