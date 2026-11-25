import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { DEVELOPMENT_DIR_PERMISSIONS } from '../../../../src/ash/platform/workspace/common/workspaceTrust.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

async function seedCodeProject(client: Awaited<ReturnType<typeof connectProfile>>['client'], root: string, name: string): Promise<void> {
	const { revision } = await client.request(APP_SERVER_METHODS['config/read'], {});
	await client.request(APP_SERVER_METHODS['config/directoryGrants/set'], {
		path: root, expectedRevision: revision, commandId: randomUUID(), permissions: [...DEVELOPMENT_DIR_PERMISSIONS],
	});
	await client.request(APP_SERVER_METHODS['project/create'], {
		projectId: randomUUID(), commandId: randomUUID(), name, description: '', scope: 'code',
		materials: [{ kind: 'folder', name, path: pathToFileURL(root).toString() }],
	});
}

for (const locale of ['en', 'zh-CN']) {
	test.describe(`Editor tab restoration in ${locale}`, () => {
		test.use({ electronWindowMode: 'active', electronUserSettings: { 'workbench.locale': locale } });

		test('Files opens a project folder outside the initial workspace roots before first send', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }, testInfo) => {
			const name = 'Draft project';
			const root = testInfo.outputPath('draft-project');
			await mkdir(root, { recursive: true });
			await writeFile(join(root, 'draft.txt'), 'Draft project file\n');
			const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page, { directoryGrantsHost: true });
			try {
				await seedCodeProject(connection.client, root, name);
			} finally {
				await connection.close();
			}

			const page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-window-mode-control').getByRole('button').nth(1).click();
			const project = page.locator('.ash-sessions-chat-slot.active .ash-sessions-workspace-picker');
			await project.click();
			await page.getByRole('menuitemradio', { name, exact: true }).click();
			await expect(project).toHaveText(name);
			const commands = new QuickAccess(page);
			await commands.runCommand('workbench.action.agentSessions.newFileTab');
			const details = page.locator('[data-editor-tool="files"] .ash-desktop-auxiliarybar');
			await details.getByText('draft.txt', { exact: true }).dblclick();
			await expect(page.locator('[data-editor-tool="files"] .stanza-editor-document')).toContainText('Draft project file');
			await commands.runCommand('ash.sessions.toggleDetails');
			await expect(details).toBeHidden();
		});

		test('Files and its document tab survive closing and reopening the window', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, driver, testWorkspace }, testInfo) => {
			const name = basename(testWorkspace.directory);
			const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page, { directoryGrantsHost: true });
			try {
				await seedCodeProject(connection.client, testWorkspace.directory, name);
			} finally {
				await connection.close();
			}
			let page = await workbench.openAgentsWindow(target.kind);
			// This regression closes a settled Code layout after the initial Chat entry finishes loading.
			await expect(page.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'false');
			await page.locator('.ash-window-mode-control').getByRole('button').nth(1).click();
			const files = () => page.locator('[data-editor-tool="files"]');
			const groups = () => files().locator('.ash-editor-group:not(.ash-code-page-group):visible');
			const details = () => files().locator('.ash-desktop-auxiliarybar');
			const filesTab = () => page.getByRole('tab', { name: locale === 'en' ? 'Files' : '文件', exact: true });
			const documentTab = () => page.getByRole('tab', { name: 'main.ts', exact: true });
			const projectPicker = page.locator('.ash-sessions-chat-slot.active .ash-sessions-workspace-picker');
			await expect(projectPicker).toHaveText(locale === 'en' ? 'Choose project' : '选择项目');
			await expect(filesTab()).toHaveCount(0);
			await projectPicker.click();
			await page.getByRole('menuitemradio', { name, exact: true }).click();
			await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
			await expect(details()).toBeVisible();
			await details().getByText('main.ts', { exact: true }).dblclick();
			await expect(documentTab()).toHaveAttribute('aria-selected', 'true');
			for (let reopen = 0; reopen < 2; reopen++) {
				page = await workbench.reopenAgentsWindow(application, page);
				await expect(groups()).toHaveCount(1);
				await expect(documentTab()).toHaveAttribute('aria-selected', 'true');
				await expect(files().locator('.stanza-editor-document:visible')).toContainText('const value = 1;');
				await filesTab().click();
				await expect(details().getByText('main.ts', { exact: true })).toBeVisible();
				await documentTab().click();
				expect(driver.diagnostics.errors).toEqual([]);
			}
			await testInfo.attach('restored-editor-tabs', { body: await page.screenshot(), contentType: 'image/png' });
		});
	});
}
