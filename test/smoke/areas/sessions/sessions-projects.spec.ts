import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';
import { expect, test } from '../../../automation/test.js';

test('Sessions Projects replaces material categories and supports keyboard creation', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	const projects = page.locator('.ash-projects');
	await expect(projects).toBeVisible();
	await expect(projects.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Library', exact: true })).toHaveCount(0);
	await expect(projects.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
	await projects.getByRole('button', { name: 'New project', exact: true }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Create a project' });
	await expect(dialog.getByRole('textbox', { name: 'What are you working on?' })).toBeFocused();
	await expect(dialog.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
	await dialog.getByRole('textbox', { name: 'What are you working on?' }).fill('Design research');
	await expect(dialog.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(projects.getByRole('button', { name: 'New project', exact: true }).first()).toBeFocused();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Projects organizes your work/);
	await page.keyboard.press('Escape');
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeVisible();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(projects).toBeVisible();
	await expect(page.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeHidden();
});

test('Sessions Projects persists creation and goals through a real backend and reopened window', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
	let projects = page.locator('.ash-projects');
	await expect(projects.getByText('Looking to start a project?', { exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('projects-empty.png') });
	await projects.getByRole('button', { name: 'New project', exact: true }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Create a project' });
	await dialog.getByRole('textbox', { name: 'What are you working on?' }).fill('Research workspace');
	await dialog.getByRole('textbox', { name: 'What are you trying to achieve?' }).fill('Collect images, papers and working documents.');
	await page.screenshot({ path: testInfo.outputPath('projects-create.png') });
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(projects.getByRole('heading', { name: 'Research workspace', exact: true })).toBeVisible();
	await expect(projects.getByRole('region', { name: 'Materials' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('projects-detail.png') });
	await expect(projects.getByText('Collect images, papers and working documents.', { exact: true })).toBeVisible();
	await projects.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(projects.getByRole('button', { name: 'Research workspace', exact: true })).toBeVisible();
	await projects.getByRole('button', { name: 'Search projects', exact: true }).click();
	await projects.getByRole('searchbox').fill('no matching project');
	await expect(projects.getByText('No matching projects', { exact: true })).toBeVisible();
	await projects.getByRole('button', { name: 'Clear search' }).click();
	await projects.getByRole('button', { name: 'Research workspace', exact: true }).click();
	await projects.getByRole('button', { name: 'Edit details' }).click();
	const edit = page.getByRole('dialog', { name: 'Edit details' });
	await edit.getByRole('textbox', { name: 'What are you trying to achieve?' }).fill('Organize the final evidence.');
	await edit.getByRole('button', { name: 'Save changes' }).click();
	await expect(edit).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
	projects = page.locator('.ash-projects');
	await projects.getByRole('button', { name: 'Research workspace', exact: true }).click();
	await expect(projects.getByText('Organize the final evidence.', { exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeHidden();
	if (target.kind === 'browser') { await page.setViewportSize({ width: 720, height: 780 }); }
	else {
		if (!('windows' in application)) { throw new Error('Expected Electron application'); }
		const window = await application.browserWindow(page);
		await window.evaluate(value => value.setSize(720, 780));
	}
	await expect(projects).toHaveClass(/narrow/);
	await expect.poll(() => projects.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	const overview = await projects.locator('.ash-projects-overview').boundingBox();
	const materials = await projects.locator('.ash-projects-materials').boundingBox();
	expect(materials!.y).toBeGreaterThan(overview!.y);
	await page.screenshot({ path: testInfo.outputPath('projects-narrow.png') });
});


test('Sessions Projects keeps PDFs and arbitrary file references inside a project', { tag: ['@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
	if (!('windows' in application)) { throw new Error('Expected Electron application'); }
	const directory = await realpath(testWorkspace.directory);
	const paths = ['paper.pdf', 'notes.txt', 'data.csv'].map(name => join(directory, name));
	await Promise.all(paths.map(path => writeFile(path, 'Project source material')));
	const original = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
	try {
		await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
		let page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
		let projects = page.locator('.ash-projects');
		await projects.getByRole('button', { name: 'New project', exact: true }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Create a project' });
		await dialog.getByRole('textbox', { name: 'What are you working on?' }).fill('Mixed materials');
		await dialog.getByRole('button', { name: 'Use a folder', exact: true }).click();
		await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(projects.locator('.ash-projects-material')).toHaveCount(1);
		await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, paths);
		await projects.getByRole('button', { name: 'Add files', exact: true }).click();
		await expect(projects.locator('.ash-projects-material')).toHaveCount(4);
		page = await workbench.reopenAgentsWindow(application, page);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
		projects = page.locator('.ash-projects');
		await projects.getByRole('button', { name: 'Mixed materials', exact: true }).click();
		await expect(projects.locator('.ash-projects-material')).toHaveCount(4);
		await projects.getByRole('button', { name: 'notes.txt', exact: true }).click();
		await expect(page.getByRole('tabpanel', { name: 'notes.txt', exact: true })).toContainText('Project source material');
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
		await expect(projects).toBeVisible();
		await expect(projects.getByRole('heading', { name: 'Mixed materials', exact: true })).toBeVisible();
		await projects.getByRole('button', { name: 'Remove paper.pdf from project', exact: true }).click();
		await expect(projects.locator('.ash-projects-material')).toHaveCount(3);
		expect(await readFile(paths[0], 'utf8')).toBe('Project source material');
	} finally {
		await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, original);
		await original.dispose();
	}
});

test('Sessions Projects creation is localized in Chinese', { tag: ['@electron-app-server'] }, async ({ target, workbench, restartWorkbench }, testInfo) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: '项目', exact: true }).click();
	await page.locator('.ash-projects').getByRole('button', { name: '新建项目', exact: true }).first().click();
	const dialog = page.getByRole('dialog', { name: '创建项目' });
	await expect(dialog.getByRole('textbox', { name: '你正在做什么？' })).toBeFocused();
	await expect(dialog.getByRole('textbox', { name: '你希望达成什么目标？' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('projects-chinese.png') });
	await page.keyboard.press('Escape');
});

for (const locale of ['en', 'zh-CN']) {
	test(`Sessions Projects merges a stale draft with saved materials and resolves text conflicts in ${locale}`, { tag: ['@electron-app-server'] }, async ({ application, target, workbench, restartWorkbench, webAppServer, testWorkspace }, testInfo) => {
		test.setTimeout(120_000);
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		if (!('windows' in application)) { throw new Error('Expected Electron application'); }
		const copy = locale === 'zh-CN'
			? { projects: '项目', edit: '编辑详情', name: '你正在做什么？', goals: '你希望达成什么目标？', save: '保存更改', reload: '重载并合并', folder: '使用文件夹', saved: '使用已保存的值', draft: '保留草稿' }
			: { projects: 'Projects', edit: 'Edit details', name: 'What are you working on?', goals: 'What are you trying to achieve?', save: 'Save changes', reload: 'Reload and merge', folder: 'Use a folder', saved: 'Use saved value', draft: 'Keep draft' };
		const connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const original = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
		try {
			const directory = await realpath(testWorkspace.directory);
			const { client } = connection;
			const projectId = randomUUID();
			const material = (name: string) => ({ name, kind: 'file' as const, path: pathToFileURL(join(testWorkspace.directory, name)).toString() });
			const retained = material('retained.txt');
			const removed = material('removed.txt');
			const added = material('from-other-window.txt');
			const created = (await client.request(APP_SERVER_METHODS['project/create'], { commandId: randomUUID(), projectId, name: 'Original project', description: 'Original goals', materials: [retained, removed] })).project;
			const page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: copy.projects, exact: true }).click();
			const projects = page.locator('.ash-projects');
			await projects.getByRole('button', { name: 'Original project', exact: true }).click();
			await projects.getByRole('button', { name: copy.edit, exact: true }).click();
			const dialog = page.getByRole('dialog', { name: copy.edit });
			const name = dialog.getByRole('textbox', { name: copy.name });
			const goals = dialog.getByRole('textbox', { name: copy.goals });
			await name.fill('My draft name');
			await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
			await dialog.getByRole('button', { name: copy.folder, exact: true }).click();
			await expect(dialog.locator('.ash-projects-folder-choice button')).toHaveText(directory.split('/').at(-1)!);
			const remote = (await client.request(APP_SERVER_METHODS['project/details/update'], { commandId: randomUUID(), projectId, expectedRevision: created.revision, name: created.name, description: 'Goals from another window', materials: [retained, added] })).project;
			await dialog.getByRole('button', { name: copy.save }).click();
			await expect(dialog.getByRole('button', { name: copy.reload })).toBeFocused();
			await expect(name).toHaveValue('My draft name');
			await dialog.getByRole('button', { name: copy.reload }).press('Enter');
			await expect(goals).toHaveValue(remote.description);
			await expect(name).toHaveValue('My draft name');
			await expect(dialog.getByRole('combobox')).toHaveCount(0);
			await goals.fill('My draft goals');
			const newer = (await client.request(APP_SERVER_METHODS['project/details/update'], { commandId: randomUUID(), projectId, expectedRevision: remote.revision, name: 'Name from another window', description: 'Newer saved goals', materials: remote.materials })).project;
			await dialog.getByRole('button', { name: copy.save }).click();
			await dialog.getByRole('button', { name: copy.reload }).click();
			const choices = dialog.getByRole('combobox');
			await expect(choices).toHaveCount(2);
			await expect(choices.first()).toBeFocused();
			await expect(dialog.getByRole('button', { name: copy.save })).toBeDisabled();
			await choices.first().selectOption({ label: copy.saved });
			await goals.fill('My revised draft goals');
			await choices.last().selectOption({ label: copy.saved });
			await choices.last().selectOption({ label: copy.draft });
			await expect(name).toHaveValue(newer.name);
			await expect(goals).toHaveValue('My revised draft goals');
			await page.screenshot({ path: testInfo.outputPath(`projects-conflict-${locale}.png`) });
			await dialog.getByRole('button', { name: copy.save }).click();
			await expect(dialog).toHaveCount(0);
			const saved = (await client.request(APP_SERVER_METHODS['project/read'], { projectId })).project;
			expect({ name: saved.name, description: saved.description }).toEqual({ name: newer.name, description: 'My revised draft goals' });
			expect(saved.materials).toEqual([...remote.materials, { name: directory.split('/').at(-1), kind: 'folder', path: pathToFileURL(directory).toString() }]);
		} finally {
			await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, original);
			await original.dispose();
			await connection.close();
		}
	});
}
