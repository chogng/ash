import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { NotificationSeverity } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import type { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { ScreenshotShortcutContribution } from '../../browser/screenshot.contribution.js';
import { ScreenshotCommandId, type IScreenshotService, type ScreenshotShortcutStatus } from '../../common/screenshot.js';

test('global screenshot conflicts notify once, retain the previous binding, and link directly to its editor', async () => {
	using changes = new Emitter<void>();
	using notifications = new NotificationService();
	let status: ScreenshotShortcutStatus = { availability: 'unavailable', global: false, activeLabel: '' };
	let checks = 0;
	const screenshot: IScreenshotService = {
		onDidChangeShortcut: changes.event,
		get shortcutStatus() { return status; },
		checkShortcut: async () => { checks++; changes.fire(); },
		captureScreenshot: async () => assert.fail('Shortcut registration must not request capture or screen permission'),
	};
	const queries: unknown[] = [];
	const preferences: IPreferencesService = {
		openSettings: async () => assert.fail('Conflicts must open the shortcut editor directly'),
		openUserSettings: async () => assert.fail('Conflicts must not open settings.json'),
		openGlobalKeybindingSettings: async (textual, options) => { queries.push([textual, options]); },
	};
	using contribution = new ScreenshotShortcutContribution(screenshot, notifications, preferences);
	assert.equal(checks, 1);
	assert.deepEqual(notifications.getNotifications(), [], 'Local-only shortcuts do not report system registration conflicts');

	status = { ...status, global: true, activeLabel: 'Control+Command+A' };
	changes.fire();
	const warning = notifications.getNotifications()[0]!;
	assert.equal(notifications.getNotifications().length, 1);
	assert.equal(warning.severity, NotificationSeverity.Warning);
	assert.match(warning.message, /previous shortcut still works: Control\+Command\+A/);
	assert.equal(warning.actions?.primary?.[0]?.label, 'Change Shortcut');
	await warning.actions!.primary![0].run();
	assert.deepEqual(queries, [[false, { query: `@command:${ScreenshotCommandId}` }]]);
	changes.fire();
	assert.equal(notifications.getNotifications()[0], warning, 'Repeated checks preserve the same notification');

	notifications.remove(warning.id);
	changes.fire();
	assert.deepEqual(notifications.getNotifications(), [], 'Dismissing an unchanged conflict keeps it quiet');
	status = { ...status, activeLabel: 'Control+Command+B' };
	changes.fire();
	assert.equal(notifications.getNotifications().length, 1);
	assert.match(notifications.getNotifications()[0]!.message, /Control\+Command\+B/);
	assert.doesNotMatch(notifications.getNotifications()[0]!.message, /Control\+Command\+A/);

	status = { ...status, availability: 'available' };
	changes.fire();
	assert.deepEqual(notifications.getNotifications(), []);
	status = { ...status, availability: 'unavailable' };
	changes.fire();
	assert.equal(notifications.getNotifications().length, 1, 'A new conflict after recovery is reported');
	status = { ...status, global: false };
	changes.fire();
	assert.deepEqual(notifications.getNotifications(), []);
	status = { ...status, global: true };
	changes.fire();
	contribution.dispose();
	assert.deepEqual(notifications.getNotifications(), []);
	changes.fire();
	assert.deepEqual(notifications.getNotifications(), [], 'Disposal releases the shortcut listener');
});

test('global screenshot registration failures and their edit action use the Chinese catalog', () => {
	initializeTestLocalization('zh-CN');
	try {
		using changes = new Emitter<void>();
		using notifications = new NotificationService();
		let status: ScreenshotShortcutStatus = { availability: 'unchecked', global: true, activeLabel: '' };
		const screenshot: IScreenshotService = {
			onDidChangeShortcut: changes.event,
			get shortcutStatus() { return status; },
			checkShortcut: async () => { changes.fire(); },
			captureScreenshot: async () => assert.fail('Registration must not start capture'),
		};
		using contribution = new ScreenshotShortcutContribution(screenshot, notifications, {
			openSettings: async () => { }, openUserSettings: async () => { }, openGlobalKeybindingSettings: async () => { },
		});
		assert.deepEqual(notifications.getNotifications(), []);
		const failures = [
			['unavailable', '无法注册全局截图快捷键'],
			['unsupported', '此截图快捷键无法全局使用'],
			['unassigned', '请先设置截图快捷键'],
			['unknown', '无法启用全局截图快捷键'],
		] as const;
		for (const [availability, message] of failures) {
			status = { ...status, availability, activeLabel: '⌃⌘A' };
			changes.fire();
			assert.equal(notifications.getNotifications().length, 1);
			const warning = notifications.getNotifications()[0]!;
			assert.ok(warning.message.includes(message));
			assert.match(warning.message, /之前的快捷键仍可使用：⌃⌘A。/);
			assert.equal(warning.actions?.primary?.[0]?.label, '修改快捷键');
		}
	} finally {
		resetNlsResolver();
	}
});
