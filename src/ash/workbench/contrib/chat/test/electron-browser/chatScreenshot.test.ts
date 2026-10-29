import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Keybinding, logicalKey, resolveKeybinding, type ResolvedKeybinding } from '../../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { resetNlsResolver } from '../../../../../nls.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import { GLOBAL_KEYBINDING_UPDATE_CHANNEL, GLOBAL_KEYBINDING_TRIGGER_CHANNEL, type GlobalKeybindingResult } from '../../../../../platform/globalKeybindings/common/globalKeybindings.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { ImageEditorService } from '../../../../services/imageEditor/browser/imageEditorService.js';
import type { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { ScreenshotCommandId } from '../../common/constants.js';

class TestImageEditorService extends ImageEditorService {
	constructor() { super(); }
	async capture(): Promise<never> { return assert.fail('Checking a shortcut must not capture the screen'); }
}

suite('Chat screenshot shortcut policy', () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	let Contribution: typeof import('../../electron-browser/chatScreenshot.js').ChatScreenshotContribution;
	let response: GlobalKeybindingResult | Error;
	const requests: unknown[] = [];
	const listeners = new Set<(value: unknown) => void>();
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', {
			configurable: true, value: {
				ipcRenderer: {
					invoke: async (channel: string, request: unknown) => {
						assert.equal(channel, GLOBAL_KEYBINDING_UPDATE_CHANNEL); requests.push(request);
						if (response instanceof Error) throw response;
						return response;
					},
					on: (channel: string, listener: (value: unknown) => void) => {
						assert.equal(channel, GLOBAL_KEYBINDING_TRIGGER_CHANNEL); listeners.add(listener);
						return { dispose: () => { listeners.delete(listener); } };
					},
				}
			}
		});
		Contribution = (await import('../../electron-browser/chatScreenshot.js')).ChatScreenshotContribution;
	});
	suiteTeardown(() => { if (previous) Object.defineProperty(globalThis, 'ash', previous); else Reflect.deleteProperty(globalThis, 'ash'); });

	function fixture() {
		response = { available: false, activeLabel: '' }; requests.length = 0;
		const resources = new DisposableStore();
		const changes = resources.add(new Emitter<void>());
		const editors = resources.add(new TestImageEditorService());
		const provider = resources.add(editors.register({ id: 'test.editor', displayName: 'Test', default: true, accessibilityHelp: '', signal: new AbortController().signal, resolve: async () => ({ html: '' }) }));
		const notifications = resources.add(new TestNotificationService());
		let global = false;
		let binding: ResolvedKeybinding | undefined = resolveKeybinding(Keybinding.single(logicalKey('a', { ctrlKey: true, metaKey: true })), OperatingSystem.Macintosh);
		const queries: unknown[] = [];
		const commands: string[] = [];
		const contribution = resources.add(new Contribution(
			{ getValue: () => global, onDidChangeConfiguration: changes.event } as unknown as IConfigurationService,
			{ onDidUpdateKeybindings: changes.event, lookupKeybinding: () => binding } as unknown as IKeybindingService,
			{ executeCommand: async (id: string) => { commands.push(id); } } as unknown as ICommandService,
			{ error: () => { } } as unknown as ILogService, editors, notifications,
			{ openGlobalKeybindingSettings: async (textual, options) => { queries.push([textual, options]); } } as IPreferencesService,
		));
		return { notifications, contribution, editors, queries, commands, retireProvider: () => provider.dispose(), check: () => contribution.checkShortcut(), set global(value: boolean) { global = value; }, set binding(value: ResolvedKeybinding | undefined) { binding = value; }, [Symbol.dispose]: () => resources.dispose() };
	}

	test('conflicts notify once, preserve the active shortcut and route only this Chat lease', async () => {
		using value = fixture();
		await value.check();
		assert.deepEqual(value.notifications.model.getNotifications(), []);
		value.global = true; response = { available: false, activeLabel: 'Control+Command+A' };
		await value.check();
		const warning = value.notifications.model.getNotifications()[0]!;
		assert.match(warning.message, /previous shortcut still works: Control\+Command\+A/);
		await warning.actions!.primary![0].run();
		assert.deepEqual(value.queries, [[false, { query: `@command:${ScreenshotCommandId}` }]]);
		await value.check();
		assert.equal(value.notifications.model.getNotifications()[0], warning);
		value.notifications.model.remove(warning.id);
		await value.check();
		assert.deepEqual(value.notifications.model.getNotifications(), []);
		response = { available: false, activeLabel: 'Control+Command+B' };
		await value.check();
		assert.match(value.notifications.model.getNotifications()[0]!.message, /Control\+Command\+B/);
		for (const listener of listeners) { listener({ id: 'another.lease' }); listener({ id: 'chat.screenshot' }); }
		assert.deepEqual(value.commands, [ScreenshotCommandId]);
		response = { available: true, activeLabel: 'Control+Command+B' };
		await value.check();
		assert.deepEqual(value.notifications.model.getNotifications(), []);
		value.retireProvider(); response = { available: false, activeLabel: '' };
		await value.check();
		assert.equal((requests.at(-1) as { global: boolean; }).global, false);
		assert.deepEqual(value.notifications.model.getNotifications(), []);
		value.contribution.dispose();
		assert.equal(listeners.size, 0);
		assert.deepEqual(requests.at(-1), { id: 'chat.screenshot', commandId: ScreenshotCommandId, accelerator: '', label: '', global: false });
	});

	test('registration failures and their edit action use the Chinese catalog', async () => {
		initializeTestLocalization('zh-CN');
		try {
			using value = fixture(); value.global = true;
			response = { available: false, activeLabel: '⌃⌘A' };
			await value.check();
			assert.match(value.notifications.model.getNotifications()[0]!.message, /无法注册全局截图快捷键/);
			value.binding = undefined;
			await value.check();
			assert.match(value.notifications.model.getNotifications()[0]!.message, /请先设置截图快捷键/);
			value.binding = resolveKeybinding(Keybinding.chord(logicalKey('k'), logicalKey('c')), OperatingSystem.Macintosh);
			await value.check();
			assert.match(value.notifications.model.getNotifications()[0]!.message, /此截图快捷键无法全局使用/);
			response = new Error('Host unavailable');
			await value.check();
			const warning = value.notifications.model.getNotifications()[0]!;
			assert.match(warning.message, /无法启用全局截图快捷键/);
			assert.equal(warning.actions!.primary![0].label, '修改快捷键');
		} finally { resetNlsResolver(); }
	});
});
