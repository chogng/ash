import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { expect, test } from '../../../automation/test.js';
import { captureElectronMenu } from '../../../automation/menus.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Workbench } from '../../../automation/workbench.js';
import { EditorGroup } from '../../../automation/editors.js';

test('Sessions Settings command queries reuse search and restore saved values after reopening', async ({
	application,
	target,
	workbench,
	runningApplication,
}, testInfo) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate(
		(element, source) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', source);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		},
		JSON.stringify([
			{ key: 'ctrl+alt+y', command: 'workbench.action.openSettings', args: 'chat.disableAIFeatures' },
			{
				key: 'ctrl+alt+u',
				command: 'workbench.action.openSettings',
				args: { query: '@id:chat.disableAIFeatures', target: 3 },
			},
			{ key: 'ctrl+alt+i', command: 'workbench.action.openSettings', args: { query: '' } },
			{ key: 'ctrl+alt+o', command: 'workbench.action.openSettings', args: { section: 'models' } },
			{
				key: 'ctrl+alt+p',
				command: 'workbench.action.openSettings',
				args: { openToSide: true, query: '@id:editor.fontSize' },
			},
		]),
	);
	await group.editor.input.press('ControlOrMeta+S');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute(
		'data-state',
		/dirty|conflict/u,
	);
	let sessionsPage = await workbench.openAgentsWindow(target.kind);
	const openQuery = async (): Promise<void> => {
		const launcher = sessionsPage.locator('.ash-sessions-activity-bottom button').last();
		await expect(launcher).toBeVisible();
		await launcher.focus();
		await expect(launcher).toBeFocused();
		await sessionsPage.keyboard.press('Control+Alt+Y');
		const settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
		await expect(settings.getByRole('searchbox')).toHaveValue('chat.disableAIFeatures');
		await expect(settings.getByRole('searchbox')).toBeFocused();
		await settings
			.getByRole('searchbox')
			.evaluate(element => element.setAttribute('data-settings-query-reuse', 'retained'));
		await settings.getByRole('searchbox').press('Control+Alt+U');
		await expect(settings.getByRole('searchbox')).toHaveAttribute('data-settings-query-reuse', 'retained');
		await expect(settings.getByRole('searchbox')).toHaveValue('@id:chat.disableAIFeatures');
		await expect(settings.getByRole('searchbox')).toBeFocused();
		await expect(sessionsPage.getByRole('dialog', { name: 'Sessions Settings' })).toHaveCount(1);
	};
	await openQuery();
	let settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	const disabledAI = settings.locator('[data-settings-item-id="chat.disableAIFeatures"]').getByRole('switch');
	await expect(disabledAI).not.toBeChecked();
	await disabledAI.press('Space');
	await expect(disabledAI).toBeChecked();
	const readSaved = async (): Promise<unknown> => {
		if ('windows' in application) {
			const profile = await application.evaluate(() => process.env.ASH_HOME!);
			return JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))['chat.disableAIFeatures'];
		}
		return (async () => {
			const snapshot = await readUserSettings(sessionsPage);
			return JSON.parse(snapshot.content)['chat.disableAIFeatures'];
		})();
	};
	await expect.poll(readSaved).toBe(true);
	await settings.getByRole('searchbox').press('Control+Alt+I');
	await expect(settings.getByRole('searchbox')).toHaveValue('');
	await expect(settings.getByRole('searchbox')).toBeFocused();
	await settings.getByRole('searchbox').press('Control+Alt+O');
	await expect(settings.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute('aria-current', 'page');
	await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
	await expect(settings).toHaveCount(0);
	await openQuery();
	await expect(
		sessionsPage.locator('[data-settings-item-id="chat.disableAIFeatures"]').getByRole('switch'),
	).toBeChecked();
	await sessionsPage
		.getByRole('dialog', { name: 'Sessions Settings' })
		.evaluate(element => (element as HTMLDialogElement).requestClose());
	sessionsPage = await workbench.reopenAgentsWindow(application, sessionsPage);
	await openQuery();
	settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(
		settings.locator('[data-settings-item-id="chat.disableAIFeatures"]').getByRole('switch'),
	).toBeChecked();
	await expect.poll(readSaved).toBe(true);
	await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
	await openQuery();
	await sessionsPage
		.getByRole('dialog', { name: 'Sessions Settings' })
		.getByRole('searchbox')
		.fill('@lang:plaintext @id:editor.fontSize');
	await expect(sessionsPage.getByRole('dialog', { name: 'Sessions Settings' })).toHaveCount(0);
	const sharedSettings = sessionsPage
		.getByRole('dialog')
		.filter({ has: sessionsPage.locator('.ash-settings-editor') });
	await expect(sharedSettings.getByRole('searchbox')).toHaveValue('@lang:plaintext @id:editor.fontSize');
	const languageSize = sharedSettings.locator('[data-settings-item-id="editor.fontSize"]').getByRole('spinbutton');
	await languageSize.fill('24');
	await languageSize.press('Tab');
	await expect
		.poll(
			async () => JSON.parse((await readUserSettings(sessionsPage)).content)['[plaintext]']?.['editor.fontSize'],
		)
		.toBe(24);
	expect(JSON.parse((await readUserSettings(sessionsPage)).content)['editor.fontSize']).toBeUndefined();
	await sharedSettings.locator('.ash-modal-editor-close').click();
	await sessionsPage.locator('.ash-sessions-activity-bottom button').last().focus();
	await sessionsPage.keyboard.press('Control+Alt+P');
	const groupedSettings = sessionsPage.locator('.ash-editor-group .ash-settings-editor');
	await expect(groupedSettings).toBeVisible();
	await expect(groupedSettings.getByRole('searchbox')).toHaveValue('@id:editor.fontSize');
	await expect(groupedSettings.getByRole('searchbox')).toBeFocused();
	await expect(sessionsPage.getByRole('dialog', { name: 'Sessions Settings' })).toHaveCount(0);

	await testInfo.attach('sessions-settings-query-diagnostics', {
		body: JSON.stringify(runningApplication.diagnostics),
		contentType: 'application/json',
	});
	expect(runningApplication.diagnostics.errors).toEqual([]);
});

test('Sessions Modified Settings refreshes after external writes, reset and window reload', async ({
	application,
	target,
	workbench,
	runningApplication,
}, testInfo) => {
	const workbenchUrl = workbench.page.url();
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, '{ "window.menuStyle": "custom", "chat.disableAIFeatures": false, "workbench.activityBar.compact": true }');
	await group.editor.input.press('ControlOrMeta+S');
	await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute(
		'data-state',
		/dirty|conflict/u,
	);
	let sessionsPage = await workbench.openAgentsWindow(target.kind);
	const openSettings = async (): Promise<void> => {
		await sessionsPage.locator('.ash-sessions-activity-bottom button').last().click();
		await sessionsPage.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	};
	await openSettings();
	let settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('searchbox').fill('AI @id:chat.disableAIFeatures');
	const filter = settings.getByRole('button', { name: 'Filter Settings', exact: true });
	const inputBounds = await settings.getByRole('searchbox').boundingBox();
	const filterBounds = await filter.boundingBox();
	if (!inputBounds || !filterBounds) throw new Error('Settings search controls must be visible');
	expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(filterBounds.x);
	expect(Math.abs(inputBounds.y - filterBounds.y)).toBeLessThanOrEqual(1);
	await filter.press('Enter');
	await settings.getByRole('menuitem', { name: 'Modified', exact: true }).press('Enter');
	await expect(settings.getByRole('searchbox')).toHaveValue('AI @id:chat.disableAIFeatures @modified');
	await expect(settings.getByRole('searchbox')).toBeFocused();
	const row = settings.locator('[data-settings-item-id="chat.disableAIFeatures"]');
	await expect(row.getByRole('switch')).not.toBeChecked();
	await expect(settings.locator('[data-settings-item-id="workbench.activityBar.compact"]')).toHaveCount(0);
	await expect(settings.locator('.ash-models-settings-model-row')).toHaveCount(0);
	let writer: Workbench | undefined;
	const saveExternal = async (disabledAI: boolean | undefined): Promise<void> => {
		const source = JSON.stringify({
			'window.menuStyle': 'custom',
			'workbench.activityBar.compact': true,
			...(disabledAI === undefined ? {} : { 'chat.disableAIFeatures': disabledAI }),
		});
		if ('windows' in application) {
			await (async source => {
				const current = await readUserSettings(sessionsPage);
				await writeUserSettings(sessionsPage, source, current.revision);
			})(source);
		} else {
			if (!writer) {
				const writerPage = await sessionsPage.context().newPage();
				writer = new Workbench(writerPage);
				await writerPage.goto(workbenchUrl);
				await writer.waitForReady();
				await writer.quickaccess.runCommand('workbench.action.openSettingsJson');
			}
			const writerGroup = writer.editors.groupAt(0);
			await writerGroup.editor.input.press('ControlOrMeta+A');
			await writerGroup.editor.input.evaluate((element, source) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', source);
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, source);
			await writerGroup.editor.input.press('ControlOrMeta+S');
			await expect(
				writerGroup.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..'),
			).not.toHaveAttribute('data-state', /dirty|conflict/u);
		}
	};
	try {
		await saveExternal(true);
		await expect(row.getByRole('switch')).toBeChecked();
		await saveExternal(undefined);
		await expect(row).toHaveCount(0);
		await saveExternal(false);
		await expect(row.getByRole('switch')).not.toBeChecked();
	} finally {
		if (writer) {
			await writer.quickaccess.runCommand('workbench.action.closeAllEditors');
			await expect(writer.editors.groupAt(0).tabs).toHaveCount(0);
			await writer.page.close();
		}
	}
	await row.getByRole('button', { name: /^More actions/u }).press('Enter');
	await settings.getByRole('menuitem', { name: 'Reset Setting', exact: true }).press('Enter');
	await expect(row).toHaveCount(0);
	await expect(settings.getByRole('status').filter({ hasText: 'No settings found.' })).toBeVisible();
	await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
	await expect(settings).toHaveCount(0);
	const remaining = { 'window.menuStyle': 'custom', 'workbench.activityBar.compact': true };
	if ('windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		await expect
			.poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')))
			.toEqual(remaining);
	} else {
		await expect
			.poll(() =>
				(async () => {
					const snapshot = await readUserSettings(sessionsPage);
					return JSON.parse(snapshot.content);
				})(),
			)
			.toEqual(remaining);
	}
	sessionsPage = await workbench.reopenAgentsWindow(application, sessionsPage);
	await openSettings();
	settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('searchbox').fill('@modified @id:chat.disableAIFeatures');
	await expect(settings.locator('[data-settings-item-id="chat.disableAIFeatures"]')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Filter Settings', exact: true }).press('Enter');
	await settings.getByRole('menuitem', { name: 'Clear Filters', exact: true }).press('Enter');
	await expect(settings.getByRole('searchbox')).toHaveValue('');
	await settings.getByRole('button', { name: 'General', exact: true }).click();
	await expect(
		settings.locator('[data-settings-item-id="chat.disableAIFeatures"]').getByRole('switch'),
	).not.toBeChecked();
	await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
	await testInfo.attach('sessions-modified-settings-diagnostics', {
		body: JSON.stringify(runningApplication.diagnostics),
		contentType: 'application/json',
	});
	expect(runningApplication.diagnostics.errors).toEqual([]);
});

test('Sessions setting menus copy their current registered value as JSON', async ({
	application,
	target,
	workbench,
}) => {
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, '{ "window.menuStyle": "custom", "chat.disableAIFeatures": true }');
	await group.editor.input.press('ControlOrMeta+S');
	await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute(
		'data-state',
		/dirty|conflict/u,
	);
	const sessionsPage = await workbench.openAgentsWindow(target.kind);
	if ('windows' in application) {
		await application.evaluate(({ clipboard }) => {
			const captured = globalThis as typeof globalThis & {
				sessionsCopyText: string;
				sessionsCopyCount: number;
				restoreSessionsCopy(): void;
			};
			const write = clipboard.writeText.bind(clipboard);
			captured.sessionsCopyText = '';
			captured.sessionsCopyCount = 0;
			clipboard.writeText = async text => {
				captured.sessionsCopyText = text;
				captured.sessionsCopyCount++;
				await write(text);
			};
			captured.restoreSessionsCopy = () => {
				clipboard.writeText = write;
			};
		});
	} else {
		await sessionsPage.evaluate(() => {
			const captured = globalThis as typeof globalThis & {
				sessionsCopyText: string;
				sessionsCopyCount: number;
				restoreSessionsCopy(): void;
			};
			const write = navigator.clipboard.writeText.bind(navigator.clipboard);
			captured.sessionsCopyText = '';
			captured.sessionsCopyCount = 0;
			navigator.clipboard.writeText = async text => {
				captured.sessionsCopyText = text;
				captured.sessionsCopyCount++;
			};
			captured.restoreSessionsCopy = () => {
				navigator.clipboard.writeText = write;
			};
		});
	}
	try {
		const settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
		const openSettings = async (): Promise<void> => {
			const accounts = sessionsPage.locator('.ash-sessions-activity-bottom button').last();
			// The saved custom menu style also applies to the Sessions account menu.
			await accounts.click();
			await sessionsPage.getByRole('menuitem', { name: 'Settings', exact: true }).click();
			await expect(settings).toHaveCount(1);
			await expect(settings.locator('.ash-context-view')).toHaveCount(1);
			await settings.getByRole('button', { name: 'General', exact: true }).click();
		};
		const row = settings.locator('[data-settings-item-id="chat.disableAIFeatures"]');
		const more = row.getByRole('button', { name: /^More actions/u });
		const copy = settings.getByRole('menuitem', { name: 'Copy Setting as JSON', exact: true });
		const openMenu = async (): Promise<void> => {
			await more.focus();
			await more.press('Enter');
			await sessionsPage.keyboard.press('End');
			await expect(settings.getByRole('menuitem', { name: 'Edit in settings.json', exact: true })).toBeFocused();
			await sessionsPage.keyboard.press('ArrowUp');
			await expect(copy).toBeFocused();
		};
		const read =
			'windows' in application
				? () =>
						application.evaluate(() => {
							const captured = globalThis as typeof globalThis & {
								sessionsCopyText: string;
								sessionsCopyCount: number;
							};
							return { text: captured.sessionsCopyText, count: captured.sessionsCopyCount };
						})
				: () =>
						sessionsPage.evaluate(() => {
							const captured = globalThis as typeof globalThis & {
								sessionsCopyText: string;
								sessionsCopyCount: number;
							};
							return { text: captured.sessionsCopyText, count: captured.sessionsCopyCount };
						});
		await openSettings();
		await expect(row.getByRole('switch')).toBeChecked();
		await expect(row).toHaveClass(/is-configured/u);
		await expect(row).toHaveAccessibleDescription('Configured in local user settings.');
		const marker = row.locator('.ash-settings-configured-marker');
		await expect(marker).toBeVisible();
		await expect(marker).not.toHaveAttribute('tabindex');
		await marker.hover();
		await expect(settings.getByRole('tooltip')).toHaveText('Configured in local user settings.');
		await sessionsPage.keyboard.press('Escape');
		await expect(settings.getByRole('tooltip')).toHaveCount(0);
		await expect(settings).toBeVisible();
		await openMenu();
		await copy.press('Enter');
		await expect(copy).toHaveCount(0);
		await expect(more).toBeFocused();
		await expect.poll(read).toEqual({ text: '"chat.disableAIFeatures": true', count: 1 });
		await openMenu();
		await sessionsPage.keyboard.press('Escape');
		await expect(copy).toHaveCount(0);
		await expect(more).toBeFocused();
		await expect(settings).toBeVisible();
		await openMenu();
		// Request the platform cancel path while the dialog still owns an open menu.
		await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
		await expect(settings).toHaveCount(0);
		await expect(sessionsPage.locator('.ash-context-view-menu')).toHaveCount(0);
		await expect.poll(read).toEqual({ text: '"chat.disableAIFeatures": true', count: 1 });
		await openSettings();
		await expect(row.getByRole('switch')).toBeChecked();
		await openMenu();
		await copy.press('Enter');
		await expect(more).toBeFocused();
		await expect.poll(read).toEqual({ text: '"chat.disableAIFeatures": true', count: 2 });
		await marker.hover();
		await expect(settings.getByRole('tooltip')).toBeVisible();
		await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
		await expect(settings).toHaveCount(0);
		await expect(sessionsPage.locator('.ash-context-view-menu')).toHaveCount(0);
		await expect(
			sessionsPage.getByRole('tooltip').filter({ hasText: 'Configured in local user settings.' }),
		).toHaveCount(0);
		await expect(sessionsPage.locator('.ash-sessions-activity-bottom button').last()).toBeFocused();
	} finally {
		if ('windows' in application) {
			await application.evaluate(() => {
				(globalThis as typeof globalThis & { restoreSessionsCopy(): void }).restoreSessionsCopy();
			});
		} else {
			await sessionsPage.evaluate(() => {
				(globalThis as typeof globalThis & { restoreSessionsCopy(): void }).restoreSessionsCopy();
			});
		}
	}
});

test('Workbench and Sessions keep one settings document across edits and window restarts', async ({
	application,
	target,
	workbench,
}) => {
	const source = JSON.stringify(
		{
			'window.title': 'Shared settings test',
			'workbench.sideBar.location': 'right',
			'workbench.activityBar.compact': true,
			'workbench.layoutStyle': 'modern',
			'sessions.layoutStyle': 'flat',
			'chat.disableAIFeatures': false,
		},
		null,
		'\t',
	);
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, text) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', text);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, source);
	await group.editor.waitForEditorContents(
		contents => JSON.stringify(JSON.parse(contents)) === JSON.stringify(JSON.parse(source)),
	);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute(
		'data-state',
		/dirty|conflict/u,
	);
	await expect(workbench.page.locator('[data-part="sidebar"]')).toHaveClass(/sidebar-right/u);
	await expect(workbench.element).toHaveAttribute('data-layout-style', 'modern');

	let sessionsPage = await workbench.openAgentsWindow(target.kind);
	await expect(sessionsPage.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'flat');
	await expect(sessionsPage.locator('.ash-sessions-activity-content')).not.toHaveClass(/compact/u);
	await expect(sessionsPage.locator('[data-part="sidebar"]')).not.toHaveClass(/sidebar-right/u);
	const accounts = sessionsPage.locator('.ash-sessions-activity-bottom button').last();
	if ('windows' in application && process.platform === 'darwin') {
		await captureElectronMenu(application, () => accounts.click(), { label: 'Settings' });
	} else {
		await accounts.click();
		await sessionsPage.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	}
	const settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox').click();
	await sessionsPage.getByRole('option', { name: 'Modern', exact: true }).click();
	await sessionsPage.keyboard.press('Escape');
	await expect(settings).toBeHidden();
	await expect(sessionsPage.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'modern');
	sessionsPage = await workbench.reopenAgentsWindow(application, sessionsPage);
	await expect(sessionsPage.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'modern');

	if (target.kind === 'browser') {
		await sessionsPage.locator('.ash-sessions-activity-bottom button').last().click();
		await sessionsPage.getByRole('menuitem', { name: 'Return to Workbench', exact: true }).click();
		await workbench.waitForReady();
	}
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await expect(group.editor.element).toBeVisible();
	await expect
		.poll(async () => {
			const contents = (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
			if (contents.trim().length === 0) return undefined;
			return JSON.parse(contents);
		})
		.toEqual({
			'window.title': 'Shared settings test',
			'workbench.sideBar.location': 'right',
			'workbench.activityBar.compact': true,
			'workbench.layoutStyle': 'modern',
			'chat.disableAIFeatures': false,
		});
	await expect(workbench.page.locator('[data-part="sidebar"]')).toHaveClass(/sidebar-right/u);
});

test('Sessions preferences opens shared shortcuts and retains the profile after reopening', async ({
	application,
	target,
	workbench,
	runningApplication,
}, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const openPreferences = async (): Promise<void> => {
		const shortcuts = page.getByRole('dialog', { name: 'Keyboard Shortcuts', exact: true });
		if (await shortcuts.isVisible())
			await shortcuts.getByRole('button', { name: 'Close Keyboard Shortcuts', exact: true }).click();
		const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
		if ('windows' in application && process.platform === 'darwin') {
			await captureElectronMenu(application, () => accounts.click(), { label: 'Settings' });
		} else {
			await accounts.click();
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
		}
		await expect(page.getByRole('dialog', { name: 'Sessions Settings' })).toBeVisible();
	};
	const openShortcuts = async (): Promise<void> => {
		await openPreferences();
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		await settings.locator('[data-settings-category-id="keyboard-shortcuts"]').click();
		await settings
			.locator('.ash-sessions-settings-page')
			.getByRole('button', { name: 'Keyboard Shortcuts', exact: true })
			.click();
		await expect(settings).toHaveCount(0);
		await expect(page.locator('.ash-keybindings-editor')).toBeVisible();
	};
	await openShortcuts();
	await expect(
		page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Chat', exact: true }),
	).toHaveAttribute('aria-current', 'page');
	let shortcuts = page.locator('.ash-keybindings-editor');
	await shortcuts.getByRole('searchbox').fill('workbench.action.openSettings');
	const userRows = () =>
		shortcuts
			.locator('.ash-keybindings-row')
			.filter({ has: page.locator('.ash-keybindings-source', { hasText: /^User$/u }) });
	const defaultRow = shortcuts
		.locator('.ash-keybindings-row')
		.filter({ has: page.locator('.ash-keybindings-source', { hasText: /^System$/u }) })
		.filter({
			has: page.locator('.ash-keybindings-command-id', { hasText: /^workbench\.action\.openSettings$/u }),
		});
	const addShortcut = defaultRow.getByRole('button', { name: /^Edit keybinding for /u });
	await addShortcut.click();
	const recorder = shortcuts.getByRole('textbox', { name: 'Record keybinding', exact: true });
	await expect(recorder).toBeFocused();
	await recorder.press('Control+Alt+Y');
	await recorder.press('Escape');
	await expect(recorder).toHaveValue('');
	await recorder.press('Escape');
	await expect(shortcuts.locator('.ash-keybindings-recorder')).toBeHidden();
	await expect(userRows()).toHaveCount(0);
	await expect(addShortcut).toBeFocused();
	await addShortcut.click();
	await recorder.press('Control+Alt+Y');
	await recorder.press('Enter');
	await expect(shortcuts.locator('.ash-keybindings-recorder')).toBeHidden();
	await expect(userRows()).toHaveCount(1);
	await openPreferences();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('searchbox').fill('compact');
	await settings.getByRole('searchbox').press('Escape');
	await expect(settings).toBeVisible();
	await expect(settings.getByRole('searchbox')).toHaveValue('');
	await settings.getByRole('searchbox').press('Escape');
	await expect(settings).toHaveCount(0);
	await page.getByRole('button', { name: 'Accounts', exact: true }).focus();
	await page.keyboard.press('Control+Alt+Y');
	await expect(settings).toBeVisible();
	await settings.getByRole('searchbox').press('Escape');
	page = await workbench.reopenAgentsWindow(application, page);
	await openShortcuts();
	shortcuts = page.locator('.ash-keybindings-editor');
	await shortcuts.getByRole('searchbox').fill('workbench.action.openSettings');
	const userRow = userRows();
	await expect(userRow).toHaveCount(1);
	await expect(userRow.locator('.ash-keybindings-key')).toHaveText(/Y/u);
	await userRow.getByRole('button', { name: /^Remove keybinding for /u }).click();
	await expect(userRows()).toHaveCount(0);
	await openPreferences();
	await page.locator('[data-settings-category-id="keyboard-shortcuts"]').click();
	await page
		.locator('.ash-sessions-settings-page')
		.getByRole('button', { name: 'Preferences: Open Keyboard Shortcuts (JSON)', exact: true })
		.click();
	const group = new EditorGroup(
		page
			.locator('.ash-editor-group:visible')
			.filter({ has: page.getByRole('tab', { name: 'Keyboard Shortcuts (JSON)', exact: true }) }),
	);
	await expect(group.tabs.getByText('Keyboard Shortcuts (JSON)', { exact: true })).toBeVisible();
	await group.editor.waitForEditorContents(source => source.replace(/\s/gu, '') === '[]');
	expect(
		runningApplication.diagnostics.consoleErrors.filter(message =>
			message.startsWith('Code editor contribution failed'),
		),
	).toEqual([]);
	await testInfo.attach('sessions-preferences-shortcuts-diagnostics', {
		body: JSON.stringify(runningApplication.diagnostics),
		contentType: 'application/json',
	});
	expect(runningApplication.diagnostics.errors).toEqual([]);
});
