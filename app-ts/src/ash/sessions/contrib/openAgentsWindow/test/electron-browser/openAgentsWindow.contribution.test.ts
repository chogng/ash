import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test, setup, teardown } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IKeybindingService, type IUserFriendlyKeybinding } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { INativeHostApi, INativeSystemWideKeybinding, INativeSystemWideKeybindingResult, IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { INativeHostService } from '../../../../../workbench/common/services.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../../workbench/contrib/chat/common/constants.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { NotificationService } from '../../../../../workbench/services/notification/common/notificationService.js';
import { OpenAgentsWindowSystemWideKeybindingContribution } from '../../electron-browser/openAgentsWindow.contribution.js';
import { registerOpenAgentsWindowCommand } from '../../electron-browser/openAgentsWindowCommand.js';

class TestKeybindingService extends Disposable implements IKeybindingService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidUpdateKeybindings = this.changed.event;
	public bindings: readonly IUserFriendlyKeybinding[] = [];

	public readonly inChordMode = false;
	public getKeybindings(): readonly ResolvedKeybindingItem[] { return this.bindings.map((entry, index) => new ResolvedKeybindingItem(undefined, entry.command, entry.args, undefined, false, null, false, { entry, index })); }
	public registerSchemaContribution() { return Disposable.None; }
	public resolveKeybinding(): never { throw new Error('unused'); }
	public resolveUserBinding() { return undefined; }
	public lookupKeybinding() { return undefined; }
	public lookupKeybindings() { return []; }
	public async reload(): Promise<void> {}
	public async updateKeybindings(bindings: readonly IUserFriendlyKeybinding[]): Promise<void> {
		this.bindings = bindings;
		this.changed.fire();
	}
}

class RecordingLog extends NullLoggerService {
	public readonly warnings: string[] = [];
	public readonly errors: unknown[] = [];
	public override warn(message: string): void { this.warnings.push(message); }
	public override error(message: string | Error, argument?: unknown): void { this.errors.push(argument ?? message); }
}

class Fixture extends Disposable {
	public readonly services = this._register(new InstantiationService());
	public readonly resource = this._register(new TestKeybindingService());
	public readonly notifications = this._register(new NotificationService());
	public readonly log = new RecordingLog();
	public readonly payloads: INativeSystemWideKeybinding[][] = [];
	public readonly opened: (IOpenAgentsWindowOptions | undefined)[] = [];
	public result: INativeSystemWideKeybindingResult | Promise<INativeSystemWideKeybindingResult> = { failed: [] };
	public error: Error | undefined;

	constructor(bindings: readonly IUserFriendlyKeybinding[] = []) {
		super();
		this.resource.bindings = bindings;
		const host: INativeHostApi = {
			isAdmin: async () => false,
			getOSColorScheme: async () => ({ dark: false, highContrast: false }),
			onDidChangeColorScheme: () => Disposable.None,
			openExternal: async () => { throw new Error('unused'); },
			showNativeDialog: async () => { throw new Error('unused'); },
			installShellCommand: async () => '',
			uninstallShellCommand: async () => '',
			listWindows: async () => [],
			focusWindowById: async () => {},
			focusWindow: async () => {},
			closeWindow: async () => {},
			closeOtherWindows: async () => {},
			getZoomLevel: async () => 0,
			onDidChangeZoomLevel: () => Disposable.None,
			setZoomLevel: async () => {},
			isAlwaysOnTop: async () => false,
			setAlwaysOnTop: async () => {},
			performNativeTabAction: async () => {},
			openNewWindowTab: async () => {},
			pickFolder: async () => undefined,
			pickFile: async () => undefined,
			openWorkspace: async () => {},
			openWindow: async () => {},
			openAgentsWindow: async options => { this.opened.push(options); },
			syncSystemWideKeybindings: async bindings => {
				this.payloads.push(structuredClone([...bindings]));
				if (this.error) { throw this.error; }
				return this.result;
			},
			revealFile: async () => {},
			setWindowTheme: async () => {},
			setWindowDimmed: async () => {},
			toggleDeveloperTools: async () => {},
			saveFile: async () => undefined,
			isAccessibilitySupportEnabled: async () => false,
			onDidChangeAccessibilitySupport: () => Disposable.None,
		};
		this.services.registerInstance(INativeHostService, host);
		this.services.registerInstance(IKeybindingService, this.resource);
		this.services.registerInstance(INotificationService, this.notifications);
		this.services.registerInstance(ILogService, this.log);
	}

	public start(): void {
		const host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, [OpenAgentsWindowSystemWideKeybindingContribution.ID]));
		host.advance(WorkbenchPhase.AfterRestored);
	}
}

function binding(key: string, extras: Partial<IUserFriendlyKeybinding> = {}): IUserFriendlyKeybinding {
	return { key, command: OPEN_AGENTS_WINDOW_COMMAND_ID, systemWide: true, ...extras };
}

async function flush(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

suite('OpenAgentsWindowSystemWideKeybindingContribution', () => {
	setup(() => mock.timers.enable({ apis: ['setTimeout'] }));
	teardown(() => mock.timers.reset());

	test('creates through the contribution host and sends an initial empty payload', async () => {
		using fixture = new Fixture();
		fixture.start();
		await flush();
		assert.deepEqual(fixture.payloads, [[]]);
		using incompleteServices = new InstantiationService();
		assert.throws(() => incompleteServices.createInstance(OpenAgentsWindowSystemWideKeybindingContribution), /Unknown service|Missing service/);
	});

	test('selects across all commands before filtering and keeps direct command arguments', async () => {
		const args = { draft: { mode: 'agent', text: 'Review this', contexts: [] } };
		using fixture = new Fixture([
			binding('ctrl+shift+a', { command: 'other.command' }),
			binding('ctrl+shift+a'),
			binding('ctrl+shift+b', { command: 'runCommands', args: { commands: [OPEN_AGENTS_WINDOW_COMMAND_ID] } }),
			binding('ctrl+shift+c', { args }),
		]);
		fixture.start();
		await flush();
		assert.deepEqual(fixture.payloads.map(payload => payload.map(({ commandId, args, userSettingsLabel }) => ({ commandId, args, userSettingsLabel }))), [[{
			commandId: OPEN_AGENTS_WINDOW_COMMAND_ID, args, userSettingsLabel: 'ctrl+shift+c',
		}]]);
		assert.deepEqual(fixture.log.warnings, ['[OpenAgentsWindow] duplicate system-wide shortcut ctrl+shift+a']);
	});

	test('debounces changes, skips successful unchanged payloads and clears removed ownership', async () => {
		using fixture = new Fixture([binding('ctrl+shift+a')]);
		fixture.start();
		await flush();
		await fixture.resource.updateKeybindings([binding('ctrl+shift+a')]);
		mock.timers.tick(100);
		await flush();
		assert.equal(fixture.payloads.length, 1);
		await fixture.resource.updateKeybindings([binding('ctrl+shift+b')]);
		await fixture.resource.updateKeybindings([]);
		mock.timers.tick(99);
		await flush();
		assert.equal(fixture.payloads.length, 1);
		mock.timers.tick(1);
		await flush();
		assert.deepEqual(fixture.payloads.map(payload => payload.map(binding => binding.userSettingsLabel)), [['ctrl+shift+a'], []]);
	});

	test('retries registration failures without repeating warnings', async () => {
		using fixture = new Fixture([binding('ctrl+shift+a')]);
		fixture.result = { failed: ['ctrl+shift+a'] };
		fixture.start();
		await flush();
		await fixture.resource.updateKeybindings(fixture.resource.bindings);
		mock.timers.tick(100);
		await flush();
		assert.deepEqual({ attempts: fixture.payloads.length, messages: fixture.notifications.getNotifications().length }, { attempts: 2, messages: 1 });
		fixture.result = { failed: [] };
		await fixture.resource.updateKeybindings([]);
		mock.timers.tick(100);
		await flush();
		assert.deepEqual(fixture.payloads.at(-1), []);
	});

	test('resends a previously successful payload after a later IPC failure', async () => {
		using fixture = new Fixture([binding('ctrl+shift+a')]);
		fixture.start();
		await flush();
		fixture.error = new Error('connection interrupted');
		await fixture.resource.updateKeybindings([binding('ctrl+shift+b')]);
		mock.timers.tick(100);
		await flush();
		fixture.error = undefined;
		await fixture.resource.updateKeybindings([binding('ctrl+shift+a')]);
		mock.timers.tick(100);
		await flush();
		assert.deepEqual(fixture.payloads.map(payload => payload.map(binding => binding.userSettingsLabel)), [['ctrl+shift+a'], ['ctrl+shift+b'], ['ctrl+shift+a']]);
		assert.equal(fixture.log.errors.length, 1);
	});

	test('disposal cancels scheduled synchronization and ignores in-flight results', async () => {
		using fixture = new Fixture([binding('ctrl+shift+a')]);
		const result = promiseWithResolvers<INativeSystemWideKeybindingResult>();
		fixture.result = result.promise;
		fixture.start();
		await flush();
		await fixture.resource.updateKeybindings([]);
		fixture.dispose();
		result.resolve({ failed: ['ctrl+shift+a'] });
		mock.timers.tick(100);
		await flush();
		assert.deepEqual({ attempts: fixture.payloads.length, messages: fixture.notifications.getNotifications().length }, { attempts: 1, messages: 0 });
	});

	test('Sessions command forwards options without adding palette or default keybinding entries', async () => {
		using fixture = new Fixture();
		const menus = MenusRegistry.getMenuItems(MenuId.CommandPalette);
		const keybindings = KeybindingsRegistry.getKeybindings();
		using registration = registerOpenAgentsWindowCommand();
		using commands = new CommandService(fixture.services);
		const options = { draft: { mode: 'agent', text: 'Keep this draft', contexts: [] } };
		await commands.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID, options);
		await commands.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID);
		await assert.rejects(commands.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID, { unexpected: true }), /Invalid Agents Window options/);
		assert.deepEqual({ opened: fixture.opened, menus: MenusRegistry.getMenuItems(MenuId.CommandPalette), keybindings: KeybindingsRegistry.getKeybindings() }, { opened: [options, undefined], menus, keybindings });
	});
});
