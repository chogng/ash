import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Hooks Settings exposes all events with keyboard search and accessibility help', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Hooks are configured in Code Settings.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="hooks"]').click();
	const hooks = settings.locator('.ash-hooks-settings');
	await expect(hooks).toBeVisible();
	await expect(hooks.locator('.ash-hooks-event')).toHaveCount(33);
	if (target.appServerMode === 'disabled') {
		await expect(hooks.getByRole('status')).toContainText('Could not load Hooks:');
		await expect(hooks.locator('[data-hook-event="preToolUse"] > summary')).toHaveText('PreToolUse · — configured');
		if (target.kind === 'electron') await expect(hooks.locator('[data-hook-action="edit-scope"]')).toBeEnabled();
		else await expect(hooks.locator('[data-hook-action="edit-scope"]')).toBeDisabled();
	} else {
		await expect(hooks.getByRole('status')).toContainText('33 event types');
	}
	const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
	await expect(settings.getByRole('searchbox')).toHaveCount(1);
	await search.fill('preToolUse');
	await expect(hooks.locator('.ash-hooks-event')).toHaveCount(1);
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
});

test('Hooks Settings reads saved TOML, appends a draft, and opens project configuration', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Uses an isolated desktop profile with App Server.');
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
		await page.keyboard.press('ControlOrMeta+Shift+P');
		await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
		await page.keyboard.press('Enter');
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="agents"]').click();
		await settings.locator('[data-settings-category-id="hooks"]').click();
		const hooks = settings.locator('.ash-hooks-settings');
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
		await page.keyboard.press('ControlOrMeta+Shift+P');
		await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
		await page.keyboard.press('Enter');
		await settings.locator('[data-settings-group-id="agents"]').click();
		await settings.locator('[data-settings-category-id="hooks"]').click();
		await hooks.getByRole('combobox', { name: 'Configuration scope' }).click();
		await page.getByRole('option', { name: `Project: ${testWorkspace.directory.split(/[\\/]/).at(-1)}`, exact: true }).click();
		await hooks.locator('[data-hook-action="edit-scope"]').click();
		await expect(settings).toBeHidden();
		await expect(page.getByRole('tab', { name: /config.toml/ })).toBeVisible();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes('Keep project comments'));
		expect(await readFile(projectPath, 'utf8')).toBe(projectText);
	} finally { await writeFile(configurationPath, original); }
});


test('Settings uses one search across Models, Hooks and registered configuration', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Uses Code Settings.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="agents"]').click();
	await settings.locator('[data-settings-category-id="models"]').click();
	await expect(settings.getByRole('searchbox')).toHaveCount(1);
	await expect(settings.locator('[data-configuration-key="dictation.localModel"]')).toBeVisible();
	const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
	await search.fill('PreToolUse');
	await expect(settings.locator('[data-hook-event]')).toHaveCount(1);
	await expect(settings.locator('[data-hook-event="preToolUse"]')).toBeVisible();
	await expect(settings.locator('[data-settings-category-id="hooks"]')).toBeVisible();
	await search.fill('@id:dictation.localModel');
	await expect(settings.locator('[data-configuration-key="dictation.localModel"]')).toBeVisible();
	await expect(settings.locator('[data-hook-event]')).toHaveCount(0);
	await search.fill('no-such-setting-or-model');
	await expect(settings.locator('.ash-settings-page').getByRole('status').filter({ hasText: 'No settings found.' })).toBeVisible();
	await search.fill('');
	await expect(settings.getByRole('searchbox')).toHaveCount(1);
	await expect(settings.locator('[data-configuration-key="dictation.localModel"]')).toBeVisible();
});
