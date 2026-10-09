import { expect, test } from '../../../automation/test.js';

test('accessibility signal settings validate modes and survive restart in Chinese', async ({ workbench, restartWorkbench }) => {
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('general');
	await workbench.settingsEditor.selectCategory('general');
	let settings = workbench.settingsEditor.element;
	let progress = settings.locator('[data-configuration-key="accessibility.signals.progress"]');
	const sound = progress.getByRole('textbox', { name: 'Mode 1', exact: true });
	const announcement = progress.getByRole('textbox', { name: 'Mode 2', exact: true });
	await expect(sound).toHaveValue('auto');
	await expect(announcement).toHaveValue('off');
	await sound.fill('on');
	await sound.press('Tab');
	await expect(sound).toBeEnabled();
	await announcement.fill('on');
	await announcement.press('Tab');
	await expect(settings).toContainText('Signals require sound (auto, on, off) and announcement (auto, off).');
	await announcement.fill('auto');
	await announcement.press('Tab');
	await expect(announcement).toBeEnabled();
	for (const name of ['taskCompleted', 'diffLineInserted']) {
		const mode = settings.locator(`[data-configuration-key="accessibility.signals.${name}"]`).getByRole('textbox', { name: 'Mode 1', exact: true });
		await mode.fill('on');
		await mode.press('Tab');
		await expect(mode).toBeEnabled();
	}
	const volume = settings.locator('[data-configuration-key="accessibility.signalOptions.volume"]');
	await expect(volume).toHaveValue('70');
	await volume.fill('25');
	await volume.press('Tab');
	await expect(volume).toBeEnabled();
	await settings.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('general');
	await workbench.settingsEditor.selectCategory('general');
	settings = workbench.settingsEditor.element;
	progress = settings.locator('[data-configuration-key="accessibility.signals.progress"]');
	await expect(progress).toContainText('进度提示');
	await expect(progress.getByRole('textbox', { name: '模式 1', exact: true })).toHaveValue('on');
	await expect(progress.getByRole('textbox', { name: '模式 2', exact: true })).toHaveValue('auto');
	await expect(settings.getByRole('spinbutton', { name: '提示音量', exact: true })).toHaveValue('25');
	const completed = settings.locator('[data-configuration-key="accessibility.signals.taskCompleted"]');
	await expect(completed).toContainText('任务完成提示');
	await expect(completed.getByRole('textbox', { name: '模式 1', exact: true })).toHaveValue('on');
	const inserted = settings.locator('[data-configuration-key="accessibility.signals.diffLineInserted"]');
	await expect(inserted).toContainText('差异新增行提示');
	await expect(inserted.getByRole('textbox', { name: '模式 1', exact: true })).toHaveValue('on');
	await expect(inserted.getByRole('textbox', { name: '模式 2', exact: true })).toHaveCount(0);
});
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Color settings suggest registered keys and descriptions with keyboard and mouse selection', async ({ workbench, restartWorkbench }) => {
	let page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="appearance"]').click();
	let colors = page.locator('[data-configuration-key="workbench.colorCustomizations"]');
	await colors.getByRole('button', { name: 'Add Color', exact: true }).click();
	let row = colors.locator('.ash-string-map-row').last();
	let key = row.getByRole('combobox');
	const value = row.locator('[data-pattern-part="value"]');
	await key.fill('widget.sh');
	const widgetShadow = page.getByRole('option', { name: /^widget\.shadow /u });
	await expect(widgetShadow).toContainText('Shadow around floating widgets.');
	await key.press('ArrowDown');
	await expect(widgetShadow).toHaveAttribute('aria-selected', 'true');
	await expect(widgetShadow).toHaveCSS('outline-style', 'solid');
	await expect(key).toBeFocused();
	await key.press('Enter');
	await expect(value).toBeFocused();
	await value.fill('#12345666');
	await value.press('Tab');
	await expect.poll(() => page.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-widget-shadow').trim())).toBe('rgba(18, 52, 86, 0.4)');

	await colors.getByRole('button', { name: 'Add Color', exact: true }).click();
	row = colors.locator('.ash-string-map-row').last();
	key = row.getByRole('combobox');
	await key.fill('sessions.input');
	const inputShadow = page.getByRole('option', { name: /^sessions\.inputShadow /u });
	await expect(inputShadow).toContainText('Shadow around the Sessions input card.');
	await key.press('Escape');
	await expect(inputShadow).toBeHidden();
	await expect(settings).toBeVisible();
	await expect(key).toBeFocused();
	await key.press('ArrowUp');
	await expect(inputShadow).toHaveAttribute('aria-selected', 'true');
	await key.press('Enter');
	await row.locator('[data-pattern-part="value"]').fill('#00000029');
	await row.locator('[data-pattern-part="value"]').press('Tab');
	await expect.poll(() => page.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-sessions-inputShadow').trim())).toBe('rgba(0, 0, 0, 0.16)');

	await colors.getByRole('button', { name: 'Add Color', exact: true }).click();
	row = colors.locator('.ash-string-map-row').last();
	key = row.getByRole('combobox');
	await key.fill('widget.sh');
	await expect(widgetShadow).toHaveCount(0);
	await expect(key).toHaveAttribute('aria-expanded', 'false');
	await key.fill('hover.sh');
	await page.getByRole('option', { name: /^hover\.shadow /u }).click();
	const hoverValue = row.locator('[data-pattern-part="value"]');
	await expect(hoverValue).toBeFocused();
	await hoverValue.fill('#invalid');
	await hoverValue.press('Tab');
	await expect(settings).toContainText('Invalid theme color or hex value: hover.shadow');
	await hoverValue.fill('#00000029');
	await hoverValue.press('Tab');
	await expect.poll(() => page.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-hover-shadow').trim())).toBe('rgba(0, 0, 0, 0.16)');
	for (const theme of ['Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await settings.locator('[data-settings-item-id="workbench.colorTheme"]').getByRole('combobox').click();
		await page.getByRole('option', { name: theme, exact: true }).click();
		key = colors.locator('.ash-string-map-row').nth(1).getByRole('combobox');
		await key.focus();
		await key.press('ArrowDown');
		await expect(inputShadow).toHaveAttribute('aria-selected', 'true');
		await expect(inputShadow).toHaveCSS('outline-style', 'solid');
		await expect(inputShadow).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await key.press('Escape');
		await expect(settings).toBeVisible();
	}
	await settings.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	colors = page.locator('[data-configuration-key="workbench.colorCustomizations"]');
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const chineseSettings = page.getByRole('dialog', { name: 'Ash 设置' });
	await chineseSettings.locator('[data-settings-group-id="workbench"]').click();
	await chineseSettings.locator('[data-settings-category-id="appearance"]').click();
	await expect.poll(() => colors.locator('[data-pattern-part="key"]').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(['widget.shadow', 'sessions.inputShadow', 'hover.shadow']);
	await expect(colors).toContainText('用方向键选择建议，再按 Enter 确认');
	await colors.locator('.ash-string-map-row').nth(1).getByRole('button').click();
	await colors.getByRole('button', { name: '添加颜色', exact: true }).click();
	key = colors.locator('.ash-string-map-row').last().getByRole('combobox');
	await key.fill('Sessions 输入卡片');
	await expect(page.getByRole('option', { name: /^sessions\.inputShadow /u })).toContainText('Sessions 输入卡片周围的阴影。');
	await key.press('Escape');
	await expect(chineseSettings).toBeVisible();
});

test('Settings sidebar stays at two levels and searches voice input inside Application', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	const application = settings.locator('[data-tree-id="general"]');
	await expect(application).toHaveAttribute('aria-level', '2');
	await expect(application).not.toHaveAttribute('aria-expanded');
	await expect(settings.locator('[data-settings-category-id="dictation"]')).toHaveCount(0);
	for (const group of ['workbench', 'agents']) {
		await settings.locator(`[data-settings-group-id="${group}"]`).click();
	}
	await expect(settings.locator('[role="treeitem"][aria-level="3"]')).toHaveCount(0);
	await expect(settings.locator('[data-settings-target-id]')).toHaveCount(0);
	await expect(settings.getByRole('heading', { name: 'Voice input', exact: true })).toBeVisible();
	const search = settings.getByRole('searchbox');
	for (const query of ['dictation', 'speech', 'Voice input']) {
		await search.fill(query);
		await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(settings.locator('[data-settings-category-id="general"]')).toBeVisible();
	}
	await search.fill('');
	await settings.locator('[data-settings-category-id="general"]').click();
	await application.focus();
	await application.press('ArrowRight');
	await expect(application).not.toHaveAttribute('aria-expanded');
});

test('Dictation settings entry reveals Voice input in Application', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	await workbench.quickaccess.runCommand('workbench.action.chat.dictation.showIntroduction');
	await page.getByRole('button', { name: 'Model and API settings', exact: true }).click();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await expect(settings.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'general');
	await expect(settings.locator('[data-tree-id="general"]')).toHaveAttribute('aria-selected', 'true');
	await expect(settings.getByRole('heading', { name: 'Voice input', exact: true })).toBeInViewport();
	await expect(settings.locator('[data-settings-category-id="dictation"]')).toHaveCount(0);
});

test('Dictation settings separate local models and cloud API connections with keyboard help', async ({ target, workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	const grid = settings.getByRole('grid', { name: 'Local dictation models' });
	await expect(grid).toBeVisible();
	await expect(grid).toHaveAttribute('aria-description', 'Press Alt+F1 for accessibility help.');
	const verbosity = settings.getByRole('switch', { name: 'Dictation model accessibility help' });
	await verbosity.focus();
	await page.keyboard.press('Space');
	await expect(grid).not.toHaveAttribute('aria-description');
	await page.keyboard.press('Space');
	await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toHaveCount(0);
	await grid.focus();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(help.getByRole('textbox')).toHaveValue(/Local dictation models[\s\S]*Preparation continues/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(grid).toBeFocused();
	await page.keyboard.press('Alt+F2');
	const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(accessible.getByRole('textbox')).toHaveValue(/Local dictation models/);
	await accessible.getByRole('button', { name: 'Close', exact: true }).click();
	const backend = settings.getByRole('combobox', { name: 'Dictation service' });
	await backend.click();
	await page.getByRole('option', { name: 'Cloud', exact: true }).click();
	await expect(grid).toHaveCount(0);
	await expect(settings.getByRole('combobox', { name: 'Cloud dictation provider' })).toBeVisible();
	if (target.appServerMode === 'required') { await expect(settings.getByText('An API key is required.', { exact: false })).toBeVisible(); }
	else { await expect(settings.getByText('Could not read the dictation connection.', { exact: true })).toBeVisible(); }
	await settings.getByRole('button', { name: 'Manage API connections' }).click();
	await expect(settings.getByRole('heading', { name: 'API key' })).toBeVisible();
	await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);
});

test('Local model management reports backend import errors and unavailable capture', async ({ target, workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	const controls = settings.locator('.ash-local-transcription-model-controls');
	await expect(controls).toBeVisible();
	const prepare = controls.getByRole('button', { name: 'Install', exact: true });
	await controls.locator('summary').click();
	const importModel = controls.getByRole('button', { name: 'Import model', exact: true });
	const cancel = controls.getByRole('button', { name: 'Cancel', exact: true });
	const status = controls.getByRole('status');
	await expect(cancel).toBeHidden();
	if (target.kind === 'browser' || target.appServerMode !== 'required') {
		await expect(controls.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(importModel).toBeDisabled();
		await expect(status).toHaveText('Dictation connection is unavailable');
		return;
	}
	await expect(status).toContainText('Model package not installed:');
	await expect(prepare).toBeEnabled();
	await expect(importModel).toBeDisabled();
	const source = await mkdtemp(join(tmpdir(), 'ash-model-import-'));
	try {
		await controls.getByRole('textbox', { name: 'Prepared Paraformer model directory' }).fill(source);
		await expect(importModel).toBeEnabled();
		await importModel.click();
		await expect(status).toContainText('Model preparation failed:');
		await expect(status).toContainText('Could not read dictation model package');
		await expect(importModel).toBeEnabled();
		await expect(cancel).toBeHidden();
	} finally {
		await rm(source, { recursive: true, force: true });
	}
});

test('Desktop Voice imports after Settings closes and shares model deletion with Sessions', async ({ application, target, workbench }) => {
	const source = process.env.ASH_DICTATION_MODEL_TEST_SOURCE;
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || !source, 'Requires the connected desktop and a prepared voice model fixture');
	if (!source || !('windows' in application)) { return; }
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	const controls = settings.locator('.ash-local-transcription-model-controls');
	await controls.locator('summary').click();
	await controls.getByRole('textbox', { name: 'Prepared Paraformer model directory' }).fill(source);
	await controls.getByRole('button', { name: 'Import model', exact: true }).click();
	await settings.locator('.ash-modal-editor-close').click();
	const sessionPagePromise = application.waitForEvent('window');
	await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionPagePromise;
	await sessionsPage.locator('.ash-sessions-activity-bottom button').last().click();
	await sessionsPage.getByRole('menuitem', { name: 'Settings' }).click();
	const sessionsSettings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await sessionsSettings.getByRole('navigation').getByRole('button', { name: 'General', exact: true }).click();
	const installed = sessionsSettings.getByRole('row').filter({ hasText: 'paraformer-large-online-ec6a3c64' });
	await expect(installed).toContainText('paraformer-large-online-ec6a3c64', { timeout: 30000 });
	await expect(installed.getByRole('button', { name: 'Current', exact: true })).toBeDisabled();
	await expect(installed.getByRole('button', { name: 'Install', exact: true })).toBeHidden();
	await installed.getByRole('button', { name: 'Uninstall' }).click();
	await installed.getByRole('button', { name: 'Confirm uninstall' }).click();
	await expect(installed).toContainText('Not installed');
	await expect(sessionsSettings.locator('.ash-local-transcription-model-status')).toContainText('Model package not installed:');
	await workbench.settingsEditor.openUserSettingsUI();
	await settings.locator('[data-settings-category-id="general"]').click();
	await expect(controls.getByRole('row').filter({ hasText: 'paraformer-large-online-ec6a3c64' })).toContainText('Not installed');
	await expect(controls.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
});

test('Workbench exposes current Tools and Sandbox capabilities', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires Code with App Server');
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="tools"]').click();
	await expect(settings.locator('.ash-agent-capabilities-settings')).toBeVisible();
	await expect(settings.locator('.ash-agent-capabilities-status')).toBeEmpty();
	await expect(settings.getByText('Could not load agent capabilities.')).toHaveCount(0);
	await settings.locator('[data-settings-category-id="sandbox"]').click();
	await expect(settings.getByRole('heading', { name: 'Configured directory grants' })).toBeVisible();
	await expect(settings.locator('.ash-agent-capabilities-note').first()).toContainText('process sandbox');
	if (target.kind === 'browser') {
		await expect(settings.getByText('Directory grants can only be inspected by the desktop host.')).toBeVisible();
	} else {
		await expect(settings.getByText('These saved grants are an upper bound.', { exact: false })).toBeVisible();
	}
	await expect(settings.getByText('Could not load agent capabilities.')).toHaveCount(0);
});

test('Workbench Models switches control the model picker', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires Code with App Server');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const modelButton = page.locator('.ash-chat-view-pane .ash-chat-input-model-action');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	let modelName: string | undefined;
	for (const visible of [false, true]) {
		await workbench.settingsEditor.openUserSettingsUI();
		await settings.locator('[data-settings-group-id="agents"]').click();
		await settings.locator('[data-settings-category-id="models"]').click();
		const rows = settings.locator('.ash-models-settings-model-row');
		await expect(rows.first()).toBeVisible();
		modelName ??= (await rows.first().locator('.ash-models-settings-model-copy').textContent())!.trim();
		const name = modelName;
		const row = rows.filter({ has: page.getByText(name, { exact: true }) });
		await expect(row.locator('.ash-models-settings-model-copy > span')).toHaveCount(1);
		await expect(row.locator('.ash-models-settings-note')).toHaveCount(0);
		const itemId = await row.getAttribute('data-settings-tree-item-id');
		if (!itemId) throw new Error('Model setting has no search identity');
		const search = settings.getByRole('searchbox', { name: 'Search settings' });
		await search.fill(itemId.slice('models.catalog.'.length));
		await expect(row).toBeVisible();
		await search.fill('');
		const visibility = row.getByRole('switch', { name: `Show ${name} in model picker` });
		await visibility.focus();
		await page.keyboard.press('Space');
		await expect(visibility).toHaveAttribute('aria-checked', String(visible));
		await expect(visibility).not.toHaveAttribute('aria-busy', 'true');
		await settings.locator('.ash-modal-editor-close').click();
		await modelButton.click();
		const picker = page.locator('.ash-chat-model-picker');
		await expect(picker).toBeVisible();
		const auto = picker.getByRole('switch', { name: 'Auto' });
		if (await auto.isChecked()) {
			await auto.press('Space');
			await expect(auto).not.toHaveAttribute('aria-busy', 'true');
		}
		await expect(picker.getByRole('combobox')).toBeVisible();
		if (visible) {
			await expect(picker.getByText(name, { exact: true })).toBeVisible();
		} else {
			await expect(picker.getByText(name, { exact: true })).toHaveCount(0);
		}
		await page.keyboard.press('Escape');
	}
});

test('Workbench and Sessions Models share model visibility', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires Electron Code with App Server');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const page = workbench.page;
	if (process.platform === 'darwin') {
		await page.evaluate(async () => {
			const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { revision: number; document: { version: 1; source: string; }; };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			settings['window.menuStyle'] = 'custom';
			await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		});
	}
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="models"]').click();
	await expect(settings.getByRole('heading', { name: 'API key' })).toBeVisible();
	const firstModel = settings.locator('.ash-models-settings-model-row').first();
	await expect(firstModel).toBeVisible();
	const modelLabel = await firstModel.getByRole('switch').getAttribute('aria-label');
	if (!modelLabel) throw new Error('Model visibility switch has no label');
	const modelSwitch = settings.getByRole('switch', { name: modelLabel, exact: true });
	const initiallyVisible = await modelSwitch.isChecked();
	await modelSwitch.locator('..').locator('.ash-switch-track').click();
	await expect(modelSwitch).toHaveAttribute('aria-checked', String(!initiallyVisible));
	await expect(modelSwitch).not.toHaveAttribute('aria-busy', 'true');
	await expect(modelSwitch).toHaveAttribute('aria-checked', String(!initiallyVisible));
	await expect(settings.locator('.ash-models-settings-status')).toBeHidden();
	await settings.locator('.ash-modal-editor-close').click();
	await expect(settings).toBeHidden();
	const sessionPagePromise = application.waitForEvent('window');
	await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionPagePromise;
	const accounts = sessionsPage.locator('.ash-sessions-activity-bottom button').last();
	await accounts.click();
	await sessionsPage.getByRole('menuitem', { name: 'Settings' }).click();
	const sessionsSettings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await sessionsSettings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models' }).click();
	const sessionSwitch = sessionsSettings.getByRole('switch', { name: modelLabel });
	await expect(sessionSwitch).toHaveAttribute('aria-checked', String(!initiallyVisible));
	await sessionSwitch.locator('..').locator('.ash-switch-track').click();
	await expect(sessionSwitch).toHaveAttribute('aria-checked', String(initiallyVisible));
	await expect(sessionSwitch).not.toHaveAttribute('aria-busy', 'true');
});

test('Browser Workbench and Sessions persist model visibility across page navigation', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires browser Code with App Server');
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="models"]').click();
	const firstModelSwitch = settings.locator('.ash-models-settings-model-row').first().getByRole('switch');
	await expect(firstModelSwitch).toBeVisible();
	const modelLabel = await firstModelSwitch.getAttribute('aria-label');
	if (!modelLabel) throw new Error('Model visibility switch has no label');
	const modelSwitch = settings.getByRole('switch', { name: modelLabel, exact: true });
	const initiallyVisible = await modelSwitch.isChecked();
	await modelSwitch.locator('..').locator('.ash-switch-track').click();
	await expect(modelSwitch).toHaveAttribute('aria-checked', String(!initiallyVisible));
	await expect(modelSwitch).not.toHaveAttribute('aria-busy', 'true');
	await settings.locator('.ash-modal-editor-close').click();
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const sessionsSettings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await sessionsSettings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models' }).click();
	const sessionSwitch = sessionsSettings.getByRole('switch', { name: modelLabel });
	await expect(sessionSwitch).toHaveAttribute('aria-checked', String(!initiallyVisible));
	await sessionSwitch.locator('..').locator('.ash-switch-track').click();
	await expect(sessionSwitch).toHaveAttribute('aria-checked', String(initiallyVisible));
	await expect(sessionSwitch).not.toHaveAttribute('aria-busy', 'true');
	await page.keyboard.press('Escape');
	await expect(sessionsSettings).toBeHidden();
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: 'Return to Workbench' }).click();
	await expect(page.locator('[data-action-id="ash.code.open-sessions"] button')).toBeVisible();
	await workbench.settingsEditor.openUserSettingsUI();
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="models"]').click();
	await expect(settings.getByRole('switch', { name: modelLabel })).toHaveAttribute('aria-checked', String(initiallyVisible));
});

test('Editor settings have separate pages with keyboard navigation and global search', async ({ workbench }) => {
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = workbench.settingsEditor.element;
	const editorGroup = settings.getByRole('treeitem').filter({ has: workbench.page.locator('[data-settings-group-id="editor"]') });
	await expect(editorGroup).toHaveAttribute('aria-expanded', 'false');
	const navigation = settings.getByRole('tree', { name: 'Settings categories' });
	await navigation.focus();
	await navigation.press('Home');
	for (let index = 0; index < 4; index++) await navigation.press('ArrowDown');
	await expect(navigation).toHaveAttribute('aria-activedescendant', (await editorGroup.getAttribute('id'))!);
	await navigation.press('ArrowRight');
	await expect(editorGroup).toHaveAttribute('aria-expanded', 'true');
	await navigation.press('ArrowDown');
	await workbench.page.keyboard.press('Enter');
	await expect(settings.locator('.ash-settings-page h3')).toHaveText('Fonts and spacing');
	await expect(settings.locator('[data-settings-item-id]')).toHaveCount(4);
	const fontFamily = settings.locator('[data-configuration-key="editor.fontFamily"]');
	await expect(fontFamily).toHaveAttribute('placeholder', 'System default');
	await expect(fontFamily).toHaveValue('');
	await expect(settings.locator('[data-settings-item-id="editor.fontFamily"]')).toContainText('monospace');
	await expect(settings.locator('[data-configuration-key="editor.fontSize"]')).toHaveValue(process.platform === 'darwin' ? '12' : '14');
	for (const [category, setting] of [
		['editor-display', 'editor.renderWhitespace'],
		['editor-editing', 'editor.tabSize'],
		['editor-suggestions', 'editor.codeLens'],
		['editor-language', 'language-servers.configuration'],
		['editor-search', 'search.maxResults'],
		['editor-diff', 'diffEditor.renderSideBySide'],
		['editor-opening', 'workbench.editor.showTabs'],
		['editor-files', 'files.autoSave'],
	]) {
		await workbench.settingsEditor.selectEditorCategory(category!);
		const control = category === 'editor-language'
			? settings.locator(`[data-settings-item-id="${setting}"]`)
			: settings.locator(`[data-configuration-key="${setting}"]`);
		await expect(control).toBeVisible();
		await expect(settings.locator('[data-configuration-key="editor.fontFamily"]')).toHaveCount(0);
	}
	const search = settings.getByRole('searchbox', { name: 'Search settings' });
	await search.fill('@id:editor.fontSize');
	await expect(settings.locator('[data-settings-item-id]')).toHaveCount(1);
	await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toBeVisible();
	await search.fill('@id:editor.font*');
	await expect(settings.locator('[data-configuration-key="editor.fontFamily"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="editor.fontSize"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="chat.editor.fontSize"]')).toHaveCount(0);
	await search.fill('');
	await expect(settings.locator('[data-configuration-key="files.autoSave"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="editor.fontSize"]')).toHaveCount(0);
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	await expect(settings.locator('.ash-settings-page h3')).toHaveText('Language servers');
	await expect(settings.locator('.ash-language-server-settings')).toBeVisible();
});

test('Settings opens with editor display controls', async ({ target, workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await expect(page.locator('.ash-modal-editor')).toBeVisible();
	await workbench.settingsEditor.selectEditorCategory('editor-display');
	await expect(page.locator('.ash-settings-content-tree > .is-settings-root > .ash-settings-tree-group-title')).toHaveCount(0);
	await expect(page.locator('.ash-settings-card').first()).toHaveCSS('border-radius', '8px');
	await expect(page.locator('[data-configuration-key="editor.renderWhitespace"]')).toBeVisible();
	await expect(page.locator('[data-configuration-key="editor.renderControlCharacters"]')).toBeVisible();
	const rootTitle = page.locator('.ash-settings-page .is-settings-root > .ash-settings-tree-group-title');
	const rootDescription = page.locator('.ash-settings-page .is-settings-root > .ash-settings-tree-group-description');
	await expect(rootTitle).toHaveCount(0);
	await expect(rootDescription).toHaveCount(0);

	await workbench.settingsEditor.selectEditorCategory('editor-opening');
	await expect(page.getByRole('heading', { name: 'Tabs and editors', exact: true })).toBeVisible();
	for (const key of ['workbench.editor.showTabs', 'workbench.editor.defaultBinaryEditor']) {
		const row = page.locator(`[data-settings-item-id="${key}"]`);
		const control = row.getByRole('combobox');
		const [rowBounds, controlBounds] = await Promise.all([row.boundingBox(), control.boundingBox()]);
		expect(rowBounds).not.toBeNull();
		expect(controlBounds).not.toBeNull();
		expect(Math.abs(rowBounds!.x + rowBounds!.width - 16 - controlBounds!.x - controlBounds!.width)).toBeLessThanOrEqual(1);
	}

	await workbench.settingsEditor.selectEditorCategory('editor-display');
	await expect(page.getByRole('heading', { name: 'Minimap', exact: true })).toBeVisible();
	await expect(page.locator('[data-configuration-key="editor.minimap.enabled"]')).toBeVisible();
	if (target.kind === 'electron') {
		await page.locator('[data-settings-category-id="general"]').click();
		await expect(rootTitle).toHaveCount(0);
		await expect(rootDescription).toHaveCount(0);
		await expect(page.locator('.ash-settings-page h3')).toHaveText('Application');
		await expect(page.getByRole('heading', { name: 'Voice input', exact: true })).toBeVisible();
		await expect(page.locator('.ash-settings-content-tree > .is-settings-root > .ash-settings-tree-group-title')).toHaveCount(0);
		await expect(page.locator('.ash-settings-content-tree > .is-settings-root > .ash-settings-tree-group-description')).toHaveCount(0);
		const voiceInput = page.locator('.ash-settings-page');
		await expect(voiceInput.getByRole('combobox', { name: 'Dictation service' })).toBeVisible();
		await expect(voiceInput.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(voiceInput.getByRole('textbox', { name: 'Local dictation model' })).toHaveCount(0);
	}
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="startup"]').click();
	const startupNavigationRow = page.locator('.ash-tree-row', { has: page.locator('[data-settings-category-id="startup"]') });
	await expect(startupNavigationRow).not.toHaveAttribute('aria-expanded');
	await expect(page.locator('[data-settings-target-id="startup.group.startup-windows"], [data-settings-target-id="startup.group.startup-editor"]')).toHaveCount(0);
	await expect(rootTitle).toHaveCount(0);
	await expect(rootDescription).toHaveCount(0);
	if (target.kind === 'electron') await expect(page.locator('[data-configuration-key="window.restoreWindows"]')).toBeVisible();
	await expect(page.locator('[data-configuration-key="workbench.editor.restoreEditors"]')).toBeVisible();
	const startupEditor = page.locator('[data-configuration-key="workbench.startupEditor"]').getByRole('combobox');
	await expect(startupEditor).toBeVisible();
	const startupRow = page.locator('[data-settings-item-id="workbench.startupEditor"]');
	const [startupRowBounds, startupControlBounds] = await Promise.all([startupRow.boundingBox(), startupEditor.boundingBox()]);
	expect(startupRowBounds).not.toBeNull();
	expect(startupControlBounds).not.toBeNull();
	expect(Math.abs(startupRowBounds!.x + startupRowBounds!.width - 16 - startupControlBounds!.x - startupControlBounds!.width)).toBeLessThanOrEqual(1);
	await startupEditor.click();
	await expect(page.getByRole('option', { name: 'Welcome in empty workbench' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('.ash-notification')).toHaveCount(0);
	await expect(page.locator('[data-settings-category-id="sessions"]')).toHaveCount(0);
});

test('File opening settings save through their controls and survive reloading the window', async ({ target, workbench }) => {
	const page = workbench.page;
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	const openSettings = async () => {
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		await workbench.settingsEditor.selectEditorCategory('editor-opening');
		await expect(settings.getByRole('heading', { name: 'File opening', exact: true })).toBeVisible();
	};
	await openSettings();
	const dialog = settings.getByRole('switch', { name: 'File Open Error Dialog', exact: true });
	await expect(dialog).toBeChecked();
	await dialog.focus();
	await dialog.press('Space');
	await expect(dialog).not.toBeChecked();
	await expect(dialog).not.toHaveAttribute('aria-busy', 'true');
	const binary = settings.getByRole('combobox', { name: 'Default Binary Editor', exact: true });
	await binary.click();
	await page.getByRole('option', { name: 'Binary Editor', exact: true }).click();
	await expect(binary).toHaveText('Binary Editor');
	const threshold = settings.getByRole('spinbutton', { name: 'Large File Confirmation (MiB)', exact: true });
	await threshold.fill('16');
	await threshold.press('Tab');
	await expect(threshold).toBeEnabled();
	await settings.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	if (target.appServerMode === 'required') {
		await expect(workbench.element).toHaveAttribute('data-workbench-state', 'folder');
		await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true })).toBeAttached();
		await workbench.waitForUiIdle();
	}
	await openSettings();
	await expect(dialog).not.toBeChecked();
	await expect(binary).toHaveText('Binary Editor');
	await expect(threshold).toHaveValue('16');
});

test('editor settings apply immediately, persist after reload and reset to their default', async ({ application, target, workbench, reloadWorkbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a workspace text editor.');
	let page = workbench.page;
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	let numbers = workbench.editors.groupAt(0).editor.element.locator('.line-numbers');
	await expect(numbers.first()).toHaveText('1');
	let settings = workbench.settingsEditor;
	await settings.openUserSettingsUI();
	await settings.selectEditorCategory('editor-display');
	await settings.element.getByRole('searchbox', { name: 'Search settings' }).fill('editor.lineNumbers');
	let row = settings.element.locator('[data-settings-item-id="editor.lineNumbers"]');
	let control = row.getByRole('switch');
	await expect(control).toBeChecked();
	await control.press('Space');
	await expect(control).not.toBeChecked();
	await expect(control).not.toHaveAttribute('aria-busy', 'true');
	await settings.element.locator('.ash-modal-editor-close').click();
	await expect(numbers.first()).toHaveText('');
	({ application, workbench } = await reloadWorkbench());
	page = workbench.page;
	numbers = workbench.editors.groupAt(0).editor.element.locator('.line-numbers');
	settings = workbench.settingsEditor;
	row = settings.element.locator('[data-settings-item-id="editor.lineNumbers"]');
	control = row.getByRole('switch');
	await expect(numbers.first()).toHaveText('');
	await settings.openUserSettingsUI();
	await settings.selectEditorCategory('editor-display');
	await settings.element.getByRole('searchbox', { name: 'Search settings' }).fill('editor.lineNumbers');
	await expect(control).not.toBeChecked();
	await row.hover();
	await workbench.menus.select(application, () => row.locator('.ash-setting-item-actions-trigger').click(), ['Reset Setting']);
	await expect(control).toBeChecked();
	await settings.element.locator('.ash-modal-editor-close').click();
	await expect(numbers.first()).toHaveText('1');
});

test('Changing the color theme does not add a modified marker', async ({ target, workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="appearance"]').click();
	const setting = page.locator('[data-settings-item-id="workbench.colorTheme"]');
	const control = setting.getByRole('combobox');
	const initialHeight = (await setting.boundingBox())?.height;
	expect(initialHeight).toBeDefined();
	await control.click();
	await page.getByRole('option', { name: 'Ash Dark', exact: true }).click();
	await expect(control).toHaveText('Ash Dark');
	await expect(setting.locator('.ash-settings-indicators')).toHaveCSS('display', 'none');
	expect((await setting.boundingBox())?.height).toBeCloseTo(initialHeight!, 0);
	if (target.kind === 'browser') {
		await page.locator('.ash-settings-search-filter').click();
		await expect(page.getByRole('menuitem', { name: 'Setting ID…' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Modified' })).toHaveCount(0);
	}
});

test('Workbench boolean settings use keyboard-operable switches', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await expect(settings).toBeVisible();
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="layout"]').click();
	const compactActivityBar = settings.getByRole('switch', { name: 'Compact Activity Bar' });
	await expect(compactActivityBar).toBeVisible();
	const initialState = await compactActivityBar.isChecked();
	await expect(compactActivityBar).toHaveAttribute('aria-checked', String(initialState));
	await compactActivityBar.focus();
	await compactActivityBar.press('Space');
	await expect(compactActivityBar).toHaveAttribute('aria-checked', String(!initialState));
	await expect(compactActivityBar).not.toHaveAttribute('aria-busy', 'true');
	await compactActivityBar.press('Space');
	await expect(compactActivityBar).toHaveAttribute('aria-checked', String(initialState));
	await expect(compactActivityBar).not.toHaveAttribute('aria-busy', 'true');
});

test('Saving a boolean setting does not move neighboring settings', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	const row = settings.locator('[data-settings-item-id="accessibility.verbosity.memories"]');
	const control = row.getByRole('switch', { name: 'Memories accessibility help' });
	await expect(control).toBeVisible();
	await expect(row.locator('.ash-settings-indicators')).toHaveAttribute('aria-live', 'polite');
	await expect(row.locator('.ash-settings-indicators')).toHaveCSS('clip-path', 'inset(50%)');
	const initialChecked = await control.isChecked();
	await page.evaluate(() => {
		const row = document.querySelector<HTMLElement>('[data-settings-item-id="accessibility.verbosity.memories"]')!;
		const indicator = row.querySelector<HTMLElement>('.ash-settings-indicators')!;
		const measurements: { pending: boolean; height: number; }[] = [];
		const sample = () => measurements.push({ pending: !indicator.hidden, height: row.getBoundingClientRect().height });
		const observer = new MutationObserver(sample);
		observer.observe(indicator, { attributes: true, childList: true, subtree: true });
		sample();
		(window as Window & { settingRowMeasurements?: typeof measurements; settingRowObserver?: MutationObserver; }).settingRowMeasurements = measurements;
		(window as Window & { settingRowObserver?: MutationObserver; }).settingRowObserver = observer;
	});
	for (let index = 0; index < 4; index++) {
		await row.locator('.ash-switch-track').click();
		await expect(control).toHaveAttribute('aria-checked', String(index % 2 === 0 ? !initialChecked : initialChecked));
		await expect(row.locator('.ash-settings-indicators')).toBeHidden();
	}
	const measurements = await page.evaluate(() => {
		const state = window as Window & { settingRowMeasurements?: { pending: boolean; height: number; }[]; settingRowObserver?: MutationObserver; };
		state.settingRowObserver!.disconnect();
		return state.settingRowMeasurements!;
	});
	expect(measurements.some(measurement => measurement.pending)).toBe(true);
	expect(measurements.every(measurement => Math.abs(measurement.height - measurements[0].height) <= 1)).toBe(true);
});

test.describe('Manage menu', () => {
	test.use({ openWorkspace: false });

	test('Manage menu runs its other workbench commands', async ({ application, target, workbench }) => {
		const page = workbench.page;
		const manageButton = page.getByRole('button', { name: 'Manage' });
		const layoutButton = page.locator('[data-action-id="workbench.action.toggleAuxiliaryBar"] button');
		const [manageBounds, layoutBounds] = await Promise.all([manageButton.boundingBox(), layoutButton.boundingBox()]);
		expect(manageBounds).not.toBeNull();
		expect(layoutBounds).not.toBeNull();
		expect(manageBounds!.x).toBeLessThan(layoutBounds!.x);
		expect(manageBounds!.y).toBeGreaterThan(layoutBounds!.y);
		await expect(manageButton.locator('.ash-dropdown-menu-indicator')).toBeHidden();
		const select = async (name: string) => {
			await workbench.menus.select(application, () => manageButton.click(), [name]);
		};

		await select('Command Palette...');
		await expect(page.getByPlaceholder('Type the name of a command to run')).toBeVisible();
		await page.keyboard.press('Escape');

		await select('Keyboard Shortcuts');
		await expect(page.locator('.ash-keybindings-editor')).toBeVisible();

		await select('Extensions');
		await expect(page.locator('.ash-marketplace')).toBeVisible();

		await select('Run Task...');
		if (target.kind === 'browser' && target.appServerMode === 'required') {
			// Connected Web opens its authorized folder, whose Cargo manifest contributes tasks.
			await expect(page.getByPlaceholder('Select a task to run')).toBeVisible();
			await page.keyboard.press('Escape');
		} else {
			await expect(page.locator('.ash-tasks')).toBeVisible();
		}
		await manageButton.focus();
		await workbench.menus.inspect(application, () => manageButton.press('ArrowDown'));
		await expect(manageButton).toHaveAttribute('aria-expanded', 'false');
		await expect(manageButton).toBeFocused();
	});

	test('Manage Themes menu changes the color theme', async ({ application, workbench }) => {
		const page = workbench.page;
		const open = () => page.getByRole('button', { name: 'Manage' }).click();
		const themes = await workbench.menus.inspect(application, open, ['Themes']);
		expect(themes.map(item => item.label)).toEqual(['Color Theme', 'File Icon Theme', 'Product Icon Theme']);
		await workbench.menus.select(application, open, ['Themes', 'Color Theme']);
		const picker = page.locator('.ash-quick-pick-input input');
		await expect(picker).toBeVisible();
		await picker.fill('Ash Dark');
		await picker.press('Enter');
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
		for (const name of ['File Icon Theme', 'Product Icon Theme']) {
			await workbench.menus.select(application, open, ['Themes', name]);
			await expect(picker).toBeVisible();
			await picker.press('Escape');
		}
	});

	test('Activity Bar Manage menu opens Settings from the welcome page', async ({ application, target, workbench }) => {
		const page = workbench.page;
		const manageButton = page.getByRole('button', { name: 'Manage' });
		await manageButton.focus();
		const tooltip = page.locator('.ash-hover', { hasText: 'Manage' });
		await expect(tooltip).toBeVisible();
		const buttonBounds = await manageButton.boundingBox();
		const tooltipBounds = await page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(tooltipBounds).not.toBeNull();
		const viewportWidth = await page.evaluate(() => window.innerWidth);
		expect(tooltipBounds!.x).toBeGreaterThanOrEqual(0);
		expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(viewportWidth);
		expect(tooltipBounds!.x).toBeGreaterThanOrEqual(buttonBounds!.x + buttonBounds!.width);
		const items = await workbench.menus.inspect(application, () => manageButton.click());
		expect(items.map(item => item.label)).toEqual([
			expect.stringMatching(/^Command Palette/), expect.stringMatching(/^Settings/), 'Extensions', 'Keyboard Shortcuts', expect.stringMatching(/^Run Task/), 'Themes',
			...(target.kind === 'electron' ? ['Check for Updates...'] : []),
		]);
		await workbench.menus.select(application, () => manageButton.click(), ['Settings']);
		await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
		await expect(page.locator('.ash-settings-editor')).toBeVisible();
		await page.locator('[data-settings-category-id="general"]').click();
		if (target.kind === 'electron') {
			const updatePolicy = page.locator('[data-configuration-key="update.policy"]').getByRole('combobox');
			await expect(updatePolicy).toBeVisible();
			await updatePolicy.click();
			await page.getByRole('option', { name: 'Never' }).click();
			await expect(updatePolicy).toHaveText('Never');
			await updatePolicy.click();
			await page.getByRole('option', { name: 'Latest' }).click();
			await expect(updatePolicy).toHaveText('Latest');
		} else {
			await expect(page.locator('[data-configuration-key="update.policy"]')).toHaveCount(0);
		}
		const quickDiffWhitespace = page.locator('[data-configuration-key="scm.diffDecorationsIgnoreTrimWhitespace"]').getByRole('combobox');
		await expect(quickDiffWhitespace).toHaveCSS('height', '24px');
		const autoFetchPeriod = page.locator('[data-configuration-key="git.autofetchPeriod"]');
		await expect(autoFetchPeriod).toHaveCSS('height', '24px');
		await expect(autoFetchPeriod).toHaveCSS('width', '96px');
		await expect(autoFetchPeriod).toHaveCSS('justify-self', 'end');
		await expect(autoFetchPeriod).toHaveCSS('appearance', 'textfield');
		const autoFetch = page.locator('[data-configuration-key="git.autofetch"]').getByRole('combobox');
		await autoFetch.click();
		const autoFetchPopup = page.locator('.ash-context-view-default', { has: page.locator('.ash-select-box-list') });
		const [autoFetchBounds, popupBounds] = await Promise.all([autoFetch.boundingBox(), autoFetchPopup.boundingBox()]);
		expect(autoFetchBounds).not.toBeNull();
		expect(popupBounds).not.toBeNull();
		expect(popupBounds!.width).toBeGreaterThan(autoFetchBounds!.width);
		expect(Math.abs(popupBounds!.x + popupBounds!.width - autoFetchBounds!.x - autoFetchBounds!.width)).toBeLessThanOrEqual(1);
		await page.keyboard.press('Escape');
		await page.locator('[data-settings-group-id="workbench"]').click();
		const appearanceRow = page.locator('.ash-tree-row', { has: page.locator('[data-settings-category-id="appearance"]') });
		expect(await appearanceRow.getAttribute('aria-expanded')).toBeNull();
		await expect(page.locator('[data-settings-target-id="appearance.group.theme"]')).toHaveCount(0);
		await page.locator('[data-settings-category-id="appearance"]').click();
		const appearanceGroups = page.locator('.ash-settings-content-group:not(.is-settings-root)');
		await expect(appearanceGroups.locator(':scope > .ash-settings-tree-group-title')).toHaveText(['Color theme', 'Editor tips']);
		for (const card of await appearanceGroups.locator('.ash-settings-card').all()) {
			await expect(card).toHaveCSS('border-radius', '8px');
		}
		await expect(page.locator('[data-configuration-key="workbench.colorTheme"]').getByRole('combobox')).toBeVisible();
		const themeGroup = appearanceGroups.filter({ has: page.getByRole('heading', { name: 'Color theme', exact: true }) });
		const appearanceSettings = themeGroup.locator('.ash-configuration-setting').filter({ has: page.locator('[data-configuration-key="workbench.colorTheme"], [data-configuration-key="workbench.iconTheme"], [data-configuration-key="workbench.productIconTheme"]') });
		await expect(appearanceSettings).toHaveCount(3);
		for (const setting of await appearanceSettings.all()) {
			await expect(setting.locator('.ash-settings-indicators')).toHaveCSS('display', 'none');
			await expect(setting).toHaveCSS('height', '68px');
		}
		await expect(page.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
		await page.locator('[data-settings-category-id="layout"]').click();
		const layoutStyle = page.locator('[data-configuration-key="workbench.layoutStyle"]');
		await expect(layoutStyle).toBeVisible();
		for (const key of ['window.titleBarStyle', 'window.menuStyle']) {
			if (target.kind === 'electron') await expect(page.locator(`[data-configuration-key="${key}"]`)).toBeVisible();
			else await expect(page.locator(`[data-configuration-key="${key}"]`)).toHaveCount(0);
		}
		await expect(page.locator('[data-configuration-key="sessions.activityBar.location"]')).toHaveCount(0);
		const modernWidth = (await layoutStyle.getByRole('combobox').boundingBox())?.width;
		expect(modernWidth).toBeDefined();
		expect(modernWidth!).toBeLessThan(120);
		const layoutIndicator = layoutStyle.locator('.ash-dropdown-indicator [data-ash-icon-id="chevron-down"]');
		await expect(layoutIndicator).toBeVisible();
		await expect(layoutStyle.getByRole('combobox')).toHaveCSS('gap', '4px');
		await expect(layoutIndicator).toHaveCSS('width', '16px');
		await expect(layoutIndicator).toHaveCSS('height', '16px');
		await layoutStyle.getByRole('combobox').click();
		const selectedCheck = page.locator('.ash-select-box-option-selected .ash-select-box-option-check [data-ash-icon-id="check"]');
		await expect(selectedCheck).toHaveCSS('width', '16px');
		await expect(selectedCheck).toHaveCSS('height', '16px');
		const clippedOptions = await page.locator('.ash-select-box-option-label').evaluateAll(labels => labels.some(label => label.scrollWidth > label.clientWidth));
		expect(clippedOptions).toBe(false);
		await expect(page.locator('.ash-context-view-default', { has: page.locator('.ash-select-box-list') })).toHaveCSS('border-radius', '6px');
		const fontSizes = await page.evaluate(() => {
			const trigger = document.querySelector('[data-configuration-key="workbench.layoutStyle"] .ash-dropdown-label');
			const option = document.querySelector('.ash-select-box-option-label');
			return { trigger: getComputedStyle(trigger!).fontSize, option: getComputedStyle(option!).fontSize };
		});
		expect(fontSizes.option).toBe(fontSizes.trigger);
		await page.getByRole('option', { name: 'Flat' }).click();
		const flatWidth = (await layoutStyle.getByRole('combobox').boundingBox())?.width;
		expect(flatWidth).toBeDefined();
		expect(flatWidth!).toBeLessThan(modernWidth!);
		await layoutStyle.getByRole('combobox').click();
		await page.getByRole('option', { name: 'Modern' }).click();
		if (target.kind === 'electron') {
			await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toBeVisible();
		} else {
			await expect(page.locator('[data-configuration-key="window.zoomLevel"]')).toHaveCount(0);
		}
		await workbench.settingsEditor.selectEditorCategory('editor-fonts');
		const fontSizeControl = page.locator('[data-configuration-key="editor.fontSize"]').locator('..');
		await expect(fontSizeControl).toHaveCSS('height', '24px');
		await expect(fontSizeControl).toHaveCSS('width', '96px');
		await expect(fontSizeControl).toHaveCSS('justify-self', 'end');
		await expect(page.locator('[data-configuration-key="editor.fontFamily"]')).toHaveCSS('height', '24px');
		await workbench.settingsEditor.selectEditorCategory('editor-display');
		await expect(page.locator('[data-configuration-key="editor.wordWrap"]').getByRole('combobox')).toHaveCSS('height', '24px');
		await workbench.settingsEditor.selectEditorCategory('editor-files');
		await expect(page.locator('[data-configuration-key="explorer.fileNesting.patterns"] .ash-string-map-row input').first()).toHaveCSS('height', '24px');
	});

	test('Manage menu starts a desktop update check', async ({ application, target, workbench }) => {
		test.skip(target.kind !== 'electron', 'The web host does not install desktop updates');
		const page = workbench.page;
		await workbench.menus.select(application, () => page.getByRole('button', { name: 'Manage' }).click(), ['Check for Updates...']);
		await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText(/Could not check for updates\.|Ash .* is up to date\.|Ash .* is available\./)).toBeVisible({ timeout: 45_000 });
		await expect(page.getByText('Checking for updates...')).toHaveCount(0);
	});

	test('editor More Actions tooltip clears the window controls', async ({ workbench }) => {
		const page = workbench.page;
		const moreActions = page.locator('.ash-editor-title-actions').getByRole('button', { name: 'More Actions' });
		await moreActions.focus();
		const tooltip = page.locator('.ash-hover', { hasText: 'More Actions' });
		await expect(tooltip).toBeVisible();
		const buttonBounds = await moreActions.boundingBox();
		const tooltipBounds = await tooltip.boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(tooltipBounds).not.toBeNull();
		expect(tooltipBounds!.y).toBeGreaterThanOrEqual(buttonBounds!.y + buttonBounds!.height);
	});
});
