import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { DialogResult, IDialogService, type IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, NotificationSeverity, type NotificationOptions } from '../../../../../platform/notification/common/notification.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/browser/viewsService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IOnboardingScenarioService } from '../../common/onboardingScenarioService.js';
import { createOnboardingTryoutLink, registerOnboardingTryout } from '../../common/onboardingTryout.js';
import { OnboardingTryoutService } from '../../browser/onboardingTryoutService.js';

suite('OnboardingTryoutService', () => {
	function createServices() {
		const services = new ServiceContainer();
		const commands = new CommandService(services);
		const notifications: NotificationOptions[] = [];
		let confirmed = false;
		let shown = 0;
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IOnboardingScenarioService, {
			start() {},
			async run() { return 'unavailable' as const; },
			async showSteps() { shown += 1; return 'completed' as const; },
			resetAll() {},
		});
		services.registerInstance(IViewsService, { openView: () => undefined, focusView: () => false });
		services.registerInstance(IDialogService, {
			async showMessage() {},
			async confirm(_options: IConfirmationDialogOptions) { return confirmed; },
			async prompt() { return DialogResult.Cancel; },
		});
		const notify = (options: NotificationOptions) => {
			notifications.push(options);
			return { item: { ...options, id: 1, createdAt: 0 }, close() {} };
		};
		services.registerInstance(INotificationService, {
			onDidAdd: Event.None,
			onDidRemove: Event.None,
			notify,
			info(message, actions) { return notify({ severity: NotificationSeverity.Info, message, actions }); },
			warning(message, actions) { return notify({ severity: NotificationSeverity.Warning, message, actions }); },
			error(message, actions) { return notify({ severity: NotificationSeverity.Error, message, actions }); },
			getNotifications: () => [], remove: () => false, clear() {},
		});
		return {
			services,
			commands,
			notifications,
			getShown: () => shown,
			confirm: () => { confirmed = true; },
		};
	}

	test('executes only a registered command with installed arguments', async () => {
		const fixture = createServices();
		using services = fixture.services;
		using command = CommandsRegistry.register('test.onboarding.command', (_accessor, value) => value);
		using tryout = registerOnboardingTryout({
			id: 'test.command', title: 'Test', description: 'A test command',
			presentation: { kind: 'command', commandId: 'test.onboarding.command', arguments: ['installed'] },
		});
		const service = services.createInstance(OnboardingTryoutService);
		const executed: string[] = [];
		using listener = fixture.commands.onWillExecuteCommand(event => executed.push(event.commandId));
		assert.equal(await service.run('test.command'), 'completed');
		assert.deepEqual(executed, ['test.onboarding.command']);
	});

	test('unavailable setup is offered but never executed', async () => {
		const fixture = createServices();
		using services = fixture.services;
		using command = CommandsRegistry.register('test.onboarding.setup', () => assert.fail('setup ran automatically'));
		using tryout = registerOnboardingTryout({
			id: 'test.setup', title: 'Test', description: 'A test setup',
			presentation: { kind: 'command', commandId: 'test.onboarding.setup' },
			isAvailable: () => false,
			setup: { label: 'Open setup', commandId: 'test.onboarding.setup' },
		});
		const service = services.createInstance(OnboardingTryoutService);
		assert.equal(await service.run('test.setup'), 'unavailable');
		assert.deepEqual(fixture.notifications.map(item => item.actions?.[0]?.label), ['Open setup']);
	});

	test('cancellation during preparation prevents late guidance', async () => {
		const fixture = createServices();
		using services = fixture.services;
		using source = new CancellationTokenSource();
		let release!: () => void;
		const preparing = new Promise<void>(resolve => { release = resolve; });
		using tryout = registerOnboardingTryout({
			id: 'test.guided', title: 'Test', description: 'A test guide',
			presentation: { kind: 'guided', steps: [{ target: 'test.target', title: 'Test', description: 'Step' }], prepare: () => preparing },
		});
		const service = services.createInstance(OnboardingTryoutService);
		const running = service.run('test.guided', source.token);
		source.cancel();
		release();
		assert.deepEqual({ outcome: await running, shown: fixture.getShown() }, { outcome: 'cancelled', shown: 0 });
	});

	test('external links require confirmation and reject malformed IDs', async () => {
		const fixture = createServices();
		using services = fixture.services;
		using command = CommandsRegistry.register('test.onboarding.external', () => undefined);
		using tryout = registerOnboardingTryout({
			id: 'test.external', title: 'Test', description: 'External test',
			presentation: { kind: 'command', commandId: 'test.onboarding.external' },
		});
		const service = services.createInstance(OnboardingTryoutService);
		assert.equal(await service.openLink('ash://tryout/test.external?command=anything'), 'unavailable');
		assert.equal(await service.openLink(createOnboardingTryoutLink('test.external')), 'cancelled');
		fixture.confirm();
		assert.equal(await service.openLink(createOnboardingTryoutLink('test.external')), 'completed');
	});
});
