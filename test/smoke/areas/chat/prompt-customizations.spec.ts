import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import { connectTraceAppServer } from '../sessions/traceFixture.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { createAppServerSkillOperations } from '../../../../src/ash/platform/agentHost/browser/appServerApi.js';

const instructions = '---\nname: c-review\ndescription: Reviews the synthetic C fixture.\n---\n# C review\n[Guide](references/guide.md)\n';
const test = base.extend({
	testWorkspace: async ({ testWorkspace }, use) => {
		const root = join(testWorkspace.directory, '.ash', 'skills');
		await mkdir(join(root, 'c-review', 'references', 'nested'), { recursive: true });
		await writeFile(join(root, 'c-review', 'SKILL.md'), instructions);
		await writeFile(join(root, 'c-review', 'references', 'guide.md'), '[Checks](nested/checks.md)\n');
		await writeFile(join(root, 'c-review', 'references', 'nested', 'checks.md'), 'C nested reference.\n');
		await mkdir(join(root, 'c-broken'), { recursive: true });
		await writeFile(join(root, 'c-broken', 'SKILL.md'), '---\nname: Invalid_Name\ndescription: Broken synthetic fixture.\n---\n');
		await use(testWorkspace);
	},
});

test('Real Prompt catalog pins nested resources, reports diagnostics and preserves stale-revision enablement conflicts', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench, testWorkspace }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const connection = await connectTraceAppServer(application, page, testWorkspace.directory);
	try {
		const created = await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'c-skill-session', title: 'C Prompt fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'C Prompt fixture' }).click();
		const backend = createAppServerSkillOperations(connection.client);
		const before = await backend.read(sessionId);
		const skill = before.catalog.skills.find(skill => skill.id.name === 'c-review')!;
		expect(skill).toBeDefined();
		expect(before.diagnostics.some(item => item.subject?.includes('c-broken'))).toBe(true);
		const reference = { id: skill.id, version: { type: 'pinnedDigest' as const, digest: skill.contentDigest } };
		expect(await backend.readTextResource(reference, 'SKILL.md', new AbortController().signal, sessionId)).toBe(instructions);
		expect(await backend.readTextResource(reference, 'references/guide.md', new AbortController().signal, sessionId)).toBe('[Checks](nested/checks.md)\n');
		expect(await backend.readTextResource(reference, 'references/nested/checks.md', new AbortController().signal, sessionId)).toBe('C nested reference.\n');
		await expect(backend.readTextResource({ id: skill.id, version: { type: 'pinnedDigest', digest: skill.contentDigest } }, '../outside', new AbortController().signal, sessionId)).rejects.toMatchObject({ errorName: 'InvalidParams' });
		await expect(backend.readTextResource({ id: skill.id, version: { type: 'pinnedDigest', digest: `sha256:${'0'.repeat(64)}` } }, 'SKILL.md', new AbortController().signal, sessionId)).rejects.toMatchObject({ errorName: 'SkillOperationFailed' });
		await backend.setEnabled(skill.id, false, before.revision, sessionId);
		await expect(backend.setEnabled(skill.id, true, before.revision, sessionId)).rejects.toMatchObject({ errorName: 'ConfigRevisionConflict' });
		const disabled = await backend.read(sessionId);
		expect(disabled.catalog.skills.find(item => item.id.name === 'c-review')!.enabled).toBe(false);
		await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
		const list = page.locator('[data-view-id="ash.extensions.skills"]').getByRole('listbox');
		await list.getByRole('option').filter({ hasText: 'c-review' }).click();
		await page.locator('.ash-extension-editor').getByRole('button', { name: 'Open instructions', exact: true }).click();
		const editor = page.getByRole('region', { name: 'c-review/SKILL.md', exact: true });
		await expect(editor.locator('.stanza-editor-input')).toHaveAttribute('aria-readonly', 'true');
		await expect(editor.locator('.view-lines')).toContainText('Reviews the synthetic C fixture.');
		const image = testInfo.outputPath('c-real-skill-snapshot.png');
		await page.screenshot({ path: image });
		await testInfo.attach('c-real-skill-snapshot', { path: image, contentType: 'image/png' });
		const reopened = await workbench.reopenAgentsWindow(application, page);
		await new QuickAccess(reopened).runCommand('workbench.action.chat.configure.skills');
		await expect(reopened.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').filter({ hasText: 'c-review' })).toContainText('Disabled');
	} finally { await connection.close(); }
});

test('Hook management observes a real TOML editor save without losing filter and disclosure', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench, testWorkspace }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const connection = await connectTraceAppServer(application, page, testWorkspace.directory);
	try {
		const created = await connection.client.request(APP_SERVER_METHODS['session/create'], { commandId: 'c-hooks-session', title: 'C Hook fixture', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'C Hook fixture' }).click();
		const sources = await connection.client.request(APP_SERVER_METHODS['hook/list'], { sessionId });
		const source = sources.sources.find(item => item.namespace !== 'user' && item.configPath === join(testWorkspace.directory, '.ash', 'config.toml'))!;
		expect(source).toBeDefined();
		const hookId = `${source.namespace}:hook:c-review`;
		const config = `[hooks.hooks."${hookId}"]\nid = "${hookId}"\nevent = "preToolUse"\nenablement = "enabled"\n[hooks.hooks."${hookId}".action]\ntype = "process"\nprogram = "/synthetic/c-review"\n`;
		await writeFile(source.configPath, config);
		await new QuickAccess(page).runCommand('aiCustomization.openManagementEditor');
		const pane = page.locator('.ash-ai-customization-management:visible');
		await expect(pane).toHaveAttribute('aria-busy', 'false');
		await pane.getByRole('searchbox').fill('c-review');
		await pane.locator('[data-hook-event="preToolUse"] > summary').click();
		const hook = pane.locator('.ash-hooks-declaration');
		await hook.locator(':scope > summary').click();
		await expect(hook).toHaveJSProperty('open', true);
		await hook.locator('[data-hook-action="edit-hook"]').click();
		const editor = new Editor(page.locator('.ash-editor-group-content:visible'));
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+A');
		await page.keyboard.insertText(config.replace('enablement = "enabled"', 'enablement = "disabled"'));
		await editor.input.press('ControlOrMeta+S');
		await expect.poll(() => readFile(source.configPath, 'utf8')).toContain('enablement = "disabled"');
		await expect.poll(async () => (await connection.client.request(APP_SERVER_METHODS['hook/list'], { sessionId })).sources.find(item => item.namespace === source.namespace)!.hooks.find(item => item.id === hookId)!.enablement).toBe('disabled');
		await page.getByRole('tab', { name: 'Agent Customizations: Hooks', exact: true }).click();
		await expect(pane.getByRole('searchbox')).toHaveValue('c-review');
		await expect(hook).toHaveJSProperty('open', true);
		await expect(hook).toContainText('Disabled');
		const image = testInfo.outputPath('c-real-hook-editor-save.png');
		await page.screenshot({ path: image });
		await testInfo.attach('c-real-hook-editor-save', { path: image, contentType: 'image/png' });
	} finally { await connection.close(); }
});
