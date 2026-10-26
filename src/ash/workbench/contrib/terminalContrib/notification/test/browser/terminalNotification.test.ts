import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test, suite } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../../../platform/notification/common/notification.js';
import { ITerminalLogService, TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalService, type ITerminalInstance, type IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import { TerminalExtensionsRegistry } from '../../../../terminal/browser/terminalExtensions.js';
import { TerminalNotificationHandler, type IOsc99NotificationHost } from '../../browser/terminalNotificationHandler.js';
import { TerminalOscNotificationsSettingId } from '../../common/terminalNotificationConfiguration.js';
import '../../browser/terminal.notification.contribution.js';
import '../../../../terminal/common/terminalConfiguration.js';

function fixture(owner: DisposableStore) {
	const notifications = owner.add(new TestNotificationService());
	const writes: string[] = [];
	const warnings: string[] = [];
	let enabled = true;
	let focused = false;
	let visible = false;
	let focusCalls = 0;
	const host: IOsc99NotificationHost = {
		isEnabled: () => enabled, isWindowFocused: () => focused, isTerminalVisible: () => visible,
		focusTerminal: () => { focusCalls++; }, notify: options => notifications.notify(options),
		updateEnableNotifications: async value => { enabled = value; },
		logWarn: message => { warnings.push(message); }, writeToProcess: data => { writes.push(data); },
	};
	const handler = owner.add(new TerminalNotificationHandler(host));
	return {
		handler, notifications, writes, warnings,
		items: () => notifications.model.getNotifications(),
		focusCalls: () => focusCalls,
		setEnabled: (value: boolean) => { enabled = value; },
		setFocused: (value: boolean) => { focused = value; },
		setVisible: (value: boolean) => { visible = value; },
	};
}

test('OSC 99 assembles independently interleaved titles, bodies and UTF-8 encoded chunks, and updates the original handle', () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	f.handler.handleSequence('i=a:d=0;Build ');
	f.handler.handleSequence('i=b;Other process');
	f.handler.handleSequence('i=a:d=0:p=body:e=1;5a6M5oiQ');
	f.handler.handleSequence('i=a;finished');
	assert.deepEqual(f.items().map(item => item.message), ['Other process', 'Build finished: 完成']);
	const id = f.items()[1].id;
	f.handler.handleSequence('i=a:u=2;New warning');
	assert.equal(f.items().length, 2);
	assert.equal(f.items()[1].id, id);
	assert.equal(f.items()[1].message, 'New warning');
	assert.equal(f.items()[1].severity, Severity.Warning);
	f.handler.handleSequence(';Anonymous one');
	f.handler.handleSequence(';Anonymous two');
	assert.deepEqual(f.items().slice(-2).map(item => item.message), ['Anonymous one', 'Anonymous two']);
});

test('OSC 99 reports buttons and closes through their original notification, and exposes only alive identified handles', async () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	f.handler.handleSequence('i=buttons:p=buttons;Run\u2028Cancel');
	f.handler.handleSequence('i=buttons:a=report:c=1;Choose');
	f.handler.handleSequence('i=pending:d=0;Pending');
	f.handler.handleSequence(';Anonymous');
	f.handler.handleSequence('i=query:p=alive;');
	assert.equal(f.writes.pop(), '\x1b]99;i=query:p=alive;buttons\x1b\\');
	await f.items()[0].actions!.primary![1].run();
	assert.deepEqual(f.writes, ['\x1b]99;i=buttons;2\x1b\\', '\x1b]99;i=buttons:p=close;\x1b\\']);
	assert.equal(f.focusCalls(), 1);
	f.handler.handleSequence('i=q:p=?;');
	assert.equal(f.writes.at(-1), '\x1b]99;i=q:p=?:a=report,focus:c=1:o=always,unfocused,invisible:p=title,body,buttons,close,alive,?:u=0,1,2:w=1;\x1b\\');
});

test('OSC 99 protocol close, dismiss and auto-close do not masquerade as button activation; replaced callbacks retire', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using owner = new DisposableStore();
		const f = fixture(owner);
		f.handler.handleSequence('i=a:d=0:p=buttons;Old');
		f.handler.handleSequence('i=a:a=report:c=1;One');
		const retired = f.items()[0].actions!.primary![0];
		f.handler.handleSequence('i=a:a=report:c=1:w=50;Two');
		await retired.run();
		assert.deepEqual(f.writes, []);
		mock.timers.tick(50);
		assert.deepEqual(f.writes, ['\x1b]99;i=a:p=close;\x1b\\']);
		f.handler.handleSequence('i=b:a=report:c=1;Dismiss me');
		await f.items()[0].actions!.secondary![0].run();
		f.handler.handleSequence('i=c:a=report:c=1;Protocol close');
		f.handler.handleSequence('i=c:p=close;');
		assert.deepEqual(f.writes.slice(-2), ['\x1b]99;i=b:p=close;\x1b\\', '\x1b]99;i=c:p=close;\x1b\\']);
		assert.equal(f.focusCalls(), 0);
	} finally { mock.timers.reset(); }
});

test('OSC 99 ordinary close reports body activation and user disable retires all notifications', async () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	f.handler.handleSequence('i=a:a=report,-focus:c=1;Activate');
	f.notifications.model.remove(f.items()[0].id);
	assert.deepEqual(f.writes, ['\x1b]99;i=a;\x1b\\', '\x1b]99;i=a:p=close;\x1b\\']);
	assert.equal(f.focusCalls(), 0);
	f.handler.handleSequence('i=b;First');
	f.handler.handleSequence('i=c;Second');
	await f.items()[0].actions!.secondary![1].run();
	assert.deepEqual(f.items(), []);
	f.handler.handleSequence('i=q:p=?;');
	assert.equal(f.writes.length, 2);
});

test('OSC 99 releases a notification removed by a synchronous arrival listener before its handle is returned', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using owner = new DisposableStore();
		const f = fixture(owner);
		owner.add(f.notifications.model.onDidAdd(item => f.notifications.model.remove(item.id)));
		f.handler.handleSequence('i=a:a=report:c=1:w=10;Closed on arrival');
		assert.deepEqual(f.items(), []);
		assert.deepEqual(f.writes, ['\x1b]99;i=a;\x1b\\', '\x1b]99;i=a:p=close;\x1b\\']);
		mock.timers.tick(10);
		f.handler.handleSequence('i=q:p=alive;');
		assert.equal(f.writes.at(-1), '\x1b]99;i=q:p=alive;\x1b\\');
		assert.equal(f.writes.length, 3);
	} finally { mock.timers.reset(); }
});

test('OSC 99 honors focus, visibility and the enable setting without retaining suppressed drafts', () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	f.setFocused(true);
	f.handler.handleSequence('i=a:o=unfocused;Hidden');
	f.setFocused(false);
	f.setVisible(true);
	f.handler.handleSequence('i=a:o=invisible;Hidden');
	f.setVisible(false);
	f.handler.handleSequence('i=a:o=invisible:u=0;Shown');
	assert.equal(f.items()[0].message, 'Shown');
	assert.equal(f.items()[0].priority, NotificationPriority.SILENT);
	f.setEnabled(false);
	f.handler.handleSequence(';Disabled');
	assert.equal(f.items().length, 1);
});

test('OSC 99 rejects invalid UTF-8, malformed base64 and oversized drafts, bounds retained handles and strips executable markdown', () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	for (const encoded of ['!!!', '/w==', 'QQ==junk', 'A']) f.handler.handleSequence(`e=1;${encoded}`);
	f.handler.handleSequence(`i=big:d=0;${'a'.repeat(64000)}`);
	f.handler.handleSequence(`i=big;${'b'.repeat(2000)}`);
	assert.deepEqual(f.items(), []);
	assert.equal(f.warnings.length, 5);
	f.handler.handleSequence(';[[ ](http://z)Run](command:unsafe)\x1b');
	assert.equal(f.items()[0].message, ' Run');
	for (let index = 0; index < 200; index++) f.handler.handleSequence(`i=n${index};Message ${index}`);
	assert.equal(f.items().length, 128);
	f.handler.dispose();
	assert.deepEqual(f.items(), []);
});

test('OSC 99 production contribution binds parser and replies to the emitting terminal, then retires callbacks on disconnect and disposal', async () => {
	using owner = new DisposableStore();
	const services = owner.add(new InstantiationService());
	const configuration = owner.add(new InMemoryConfigurationService());
	const notifications = owner.add(new TestNotificationService());
	const changed = owner.add(new Emitter<ITerminalInstance['state']>());
	const writes: string[] = [];
	let parser: ((data: string) => boolean) | undefined;
	let parserDisposed = false;
	const instance = {
		state: 'running', processId: 1, target: TerminalLocation.Panel,
		onDidChangeState: changed.event, onDidExit: Event.None,
		sendText: async (data: string) => { writes.push(data); },
	} as unknown as ITerminalInstance;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IHostService, { hasFocus: false } as IHostService);
	services.registerInstance(ITerminalService, { instances: [instance], setActiveInstance: () => { } } as unknown as ITerminalService);
	services.registerInstance(ITerminalGroupService, { showPanel: async () => { } } as unknown as ITerminalGroupService);
	services.registerInstance(ITerminalEditorService, {} as ITerminalEditorService);
	services.registerInstance(ITerminalLogService, { warn: () => { } } as unknown as ITerminalLogService);
	const definition = TerminalExtensionsRegistry.getTerminalContributions().find(entry => entry.id === 'terminal.oscNotifications')!;
	const contribution = owner.add(services.createInstance(definition.ctor, { instance }));
	contribution.xtermReady!({
		raw: {
			parser: {
				registerOscHandler: (id: number, callback: (data: string) => boolean) => {
					assert.equal(id, 99); parser = callback; return { dispose: () => { parserDisposed = true; } };
				}
			}
		}, element: { isConnected: false }, isDisposed: false
	} as unknown as IXtermTerminal);
	assert.ok(parser);
	parser('i=a:a=report;Hello');
	parser('i=q:p=alive;');
	assert.deepEqual(writes, ['\x1b]99;i=q:p=alive;a\x1b\\']);
	const action = notifications.model.getNotifications()[0].actions!.secondary![0];
	changed.fire('reconnecting');
	assert.equal(notifications.model.getNotifications().length, 0);
	await action.run();
	assert.equal(writes.length, 1);
	await configuration.updateValue(TerminalOscNotificationsSettingId.EnableNotifications, false);
	parser(';Disabled');
	assert.equal(notifications.model.getNotifications().length, 0);
	contribution.dispose();
	assert.equal(parserDisposed, true);
});

suite('terminalNotification browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		test(`terminal OSC 99 flows from process output through the real parser and replies to the originating process in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/terminal.html?input&groups&clipboard&browser&osc99&locale=${locale}`);
			await page.waitForFunction(() => !!window.ashTerminalOscIntegration);
			await page.evaluate(() => {
				window.ashTerminalInputIntegration.clear();
				window.ashTerminalInputIntegration.feed('\x1b]99;i=build:d=0;Build\x1b\\');
				window.ashTerminalInputIntegration.feed('\x1b]99;i=build:d=0:p=buttons;View\u2028Dismiss\x1b\\');
				window.ashTerminalInputIntegration.feed('\x1b]99;i=build:p=body:a=report:c=1;finished\x1b\\');
			});
			await expect.poll(() => page.evaluate(() => window.ashTerminalOscIntegration.notifications().map(item => item.message))).toEqual(['Build: finished']);
			await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b]99;i=query:p=alive;\x1b\\'));
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toContain('\x1b]99;i=query:p=alive;build\x1b\\');
			const view = page.locator('.ash-notification').filter({ hasText: 'Build: finished' }).getByRole('button', { name: 'View', exact: true });
			await expect(view).toBeVisible();
			await view.focus();
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toContain('\x1b]99;i=build;1\x1b\\');
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toContain('\x1b]99;i=build:p=close;\x1b\\');
			await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.enableNotifications', false));
			await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b]99;;Disabled\x1b\\discard-check'));
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('discard-check');
			expect(await page.evaluate(() => window.ashTerminalOscIntegration.notifications())).toEqual([]);
		});
	}

	test('terminal developer writes display escapes through its command and records real output until stopped', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?input&groups&clipboard&browser&osc99');
		await page.waitForFunction(() => !!window.ashTerminalOscIntegration);
		await page.evaluate(() => {
			window.ashTerminalInputIntegration.clear();
			void window.ashTerminalInputIntegration.command('workbench.action.terminal.writeDataToTerminal');
		});
		await page.getByRole('textbox').last().fill('debug\\r\\nline');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('debug\nline');
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.recordSession'); });
		await expect.poll(() => page.evaluate(() => window.ashTerminalOscIntegration.recording())).toBe(true);
		await page.evaluate(() => window.ashTerminalOscIntegration.feedActive('recorded real process output\r\n'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalOscIntegration.snapshotActive())).toContain('recorded real process output');
		await page.evaluate(() => window.ashTerminalOscIntegration.stopRecording());
		await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.copied.length)).toBe(1);
		const recording = await page.evaluate(() => JSON.parse(window.ashTerminalClipboardIntegration.copied[0]));
		expect(recording.replay.events.map((entry: { data: string; }) => entry.data).join('')).toContain('recorded real process output');
		expect(recording.truncated).toBe(false);
	});

	test('terminal dictation converts spoken symbols before acknowledged input and keeps non-English text without executing Enter', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?pane&existing');
		await page.waitForFunction(() => !!window.ashTerminalPaneIntegration);
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		await page.getByRole('button', { name: 'Terminal: Start dictation', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled();
		await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('Echo dollar sign HOME ampersand echo 中文\r\n\x1b\x9b', true));
		await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual(['echo $ HOME & echo 中文 ']);
	});
});
