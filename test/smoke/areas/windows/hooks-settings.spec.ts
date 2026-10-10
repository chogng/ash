import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';

test('Hooks management opens from Settings with keyboard search and accessibility help', async ({ target, workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="hooks"]').click();
	await settings.getByRole('button', { name: 'Manage Hooks', exact: true }).click();
	await expect(settings).toBeHidden();
	const hooks = page.locator('.ash-ai-customization-management');
	await expect(hooks).toBeVisible();
	await expect(hooks.locator('.ash-hooks-event')).toHaveCount(33);
	const layout = await hooks.evaluate(element => ({ overflow: getComputedStyle(element).overflowY, height: element.clientHeight, contentHeight: element.scrollHeight }));
	expect(layout.overflow).toBe('auto');
	expect(layout.contentHeight).toBeGreaterThan(layout.height);

	if (target.appServerMode === 'disabled') {
		await expect(hooks.getByRole('status')).toContainText('Could not load Hooks:');
		await expect(hooks.locator('[data-hook-event="preToolUse"] > summary')).toHaveText('PreToolUse · — configured');
		if (target.kind === 'electron') await expect(hooks.locator('[data-hook-action="edit-scope"]')).toBeEnabled();
		else await expect(hooks.locator('[data-hook-action="edit-scope"]')).toBeDisabled();
	} else {
		await expect(hooks.getByRole('status')).toContainText('33 event types');
	}
	const search = hooks.getByRole('searchbox', { name: 'Search events, Hooks, commands, or paths', exact: true });
	await expect(search).toHaveCount(1);
	await search.fill('preToolUse');
	await expect(hooks.locator('.ash-hooks-event:not([hidden])')).toHaveCount(1);
	const summary = hooks.locator('[data-hook-event="preToolUse"] > summary');
	await summary.focus();
	await summary.press('Enter');
	await expect(summary.locator('..')).toHaveAttribute('open', '');
	await summary.focus();
	await summary.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(help.getByRole('textbox')).toHaveValue(/Agent Hooks[\s\S]*without sending it/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(summary).toBeFocused();
	await search.fill('');
	await expect(hooks.locator('.ash-hooks-event:not([hidden])')).toHaveCount(33);
	const themes = new QuickAccess(page);
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await themes.runCommand('workbench.action.selectTheme');
		await themes.search(theme);
		await themes.input.press('Enter');
		await expect(themes.element).toHaveCount(0);
		await expect.poll(() => hooks.locator('[data-hook-event="preToolUse"]').evaluate(element => getComputedStyle(element).borderTopStyle)).toBe('solid');
		await summary.focus();
		await expect.poll(() => summary.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
	}
});

test('Hooks management reads TOML, appends a draft, and configures a project through Quick Pick', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Uses an isolated desktop profile with App Server.');
	if (!('windows' in application)) return;
	const profile = await application.evaluate(() => process.env.ASH_HOME);
	if (!profile) throw new Error('The test application has no isolated profile');
	const configurationPath = join(profile, 'config.toml');
	const original = await readFile(configurationPath, 'utf8');
	const resolvedConfigurationPath = await realpath(configurationPath);
	const declaration = '\n[hooks.hooks."user:hook:settings-check"]\nid = "user:hook:settings-check"\nevent = "preToolUse"\nenablement = "disabled"\n[hooks.hooks."user:hook:settings-check".action]\ntype = "process"\nprogram = "/never-execute/program with spaces"\nargs = ["two words", "quote\\\"value"]\n';
	try {
		await writeFile(configurationPath, original + declaration);
		const page = workbench.page;
		if (!await page.locator('.ash-chat-view-pane').isVisible()) await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-editor');
		await composer.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('Existing draft');
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="agents"]').click();
		await settings.locator('[data-settings-category-id="hooks"]').click();
		await settings.getByRole('button', { name: 'Manage Hooks', exact: true }).click();
		await expect(settings).toBeHidden();
		const hooks = page.locator('.ash-ai-customization-management');
		await expect(hooks.getByRole('status')).toHaveText('33 event types · 1 configured Hooks');
		const event = hooks.locator('[data-hook-event="preToolUse"]');
		await event.locator(':scope > summary').click();
		const hook = event.locator('details[data-hook-id="user:hook:settings-check"]');
		await hook.locator('summary').click();
		await expect(hook).toContainText('Disabled');
		await expect(hook).toContainText(configurationPath);
		await expect(hook).toContainText('["two words","quote\\"value"]');
		await hook.getByRole('button', { name: 'Ask Ash to configure', exact: true }).click();
		await expect(settings).toBeHidden();
		await expect(composer).toContainText('Existing draft');
		await expect(composer).toContainText(`Help me configure PreToolUse Hooks in ${resolvedConfigurationPath}`);
		await expect(page.locator('.ash-chat-list-widget .ash-chat-item')).toHaveCount(0);
		await expect.poll(() => readFile(configurationPath, 'utf8')).toBe(original + declaration);

		const projectPath = join(testWorkspace.directory, '.ash', 'config.toml');
		await mkdir(join(testWorkspace.directory, '.ash'), { recursive: true });
		const projectText = '# Keep project comments\nschemaVersion = 1\n';
		await writeFile(projectPath, projectText);
		await workbench.settingsEditor.openUserSettingsUI();
		await settings.locator('[data-settings-group-id="agents"]').click();
		await settings.locator('[data-settings-category-id="hooks"]').click();
		await settings.getByRole('button', { name: 'Manage Hooks', exact: true }).click();
		const quickAccess = new QuickAccess(page);
		await quickAccess.runCommand('workbench.action.chat.configure.hooks');
		await quickAccess.select('PreToolUse');
		await quickAccess.select(`Configure in ${projectPath}`);
		await expect(settings).toBeHidden();
		await expect(page.getByRole('tab', { name: /config.toml/ })).toBeVisible();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes('Keep project comments'));
		expect(await readFile(projectPath, 'utf8')).toBe(projectText);
	} finally { await writeFile(configurationPath, original); }
});


test('Settings links to Hooks without loading declarations into its search', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
	await expect(search).toHaveCount(1);
	await search.fill('Hooks');
	await expect(settings.getByRole('button', { name: 'Manage Hooks', exact: true })).toBeVisible();
	await expect(settings.locator('[data-hook-event]')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Manage Hooks', exact: true }).click();
	const hooks = page.locator('.ash-ai-customization-management');
	await expect(hooks).toBeVisible();
	await hooks.getByRole('searchbox').fill('PreToolUse');
	await expect(hooks.locator('[data-hook-event]:not([hidden])')).toHaveCount(1);
});

test('Configure Hooks uses the Chat command and dismisses without changing configuration', async ({ workbench }) => {
	const quickAccess = new QuickAccess(workbench.page);
	await quickAccess.runCommand('workbench.action.chat.configure.hooks');
	await expect(quickAccess.input).toHaveAttribute('aria-label', 'Select a lifecycle event');
	await expect(quickAccess.items).toHaveCount(33);
	await quickAccess.search('preToolUse');
	await expect(quickAccess.items).toHaveCount(1);
	await quickAccess.close();
	await expect(workbench.page.getByRole('tab', { name: /config.toml/ })).toHaveCount(0);
});
