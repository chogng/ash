import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

const run = promisify(execFile);

test.use({ gitRepository: true });


test('Changes title worktree menu creates a detached checkout and protects local changes before deletion', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const page = workbench.page;
	let checkout: string | undefined;
	try {
		await workbench.git.selectTitleMenu(application, ['Worktrees', 'Create Worktree…']);
		const input = page.getByRole('dialog', { name: 'Git: Create Worktree', exact: true }).getByRole('textbox');
		await input.fill('../escape');
		await input.press('Enter');
		await expect(page.getByText('Use 1–64 letters, numbers, hyphens or underscores.', { exact: true })).toBeVisible();
		await input.fill('ui-review');
		await workbench.dialogs.expectMessage(application, 'Git: Open Worktree', () => input.press('Enter'));
		const primary = await realpath(cwd);
		const paths = (await run('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
		checkout = paths.find(path => resolve(path) !== primary)!;
		expect(checkout).toBeTruthy();
		expect((await run('git', ['branch', '--show-current'], { cwd: checkout })).stdout.trim()).toBe('');

		await writeFile(join(checkout, 'main.ts'), 'local edits\n');
		await workbench.git.selectTitleMenu(application, ['Worktrees', 'Delete Worktree…']);
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(resolve(checkout));
		await workbench.dialogs.confirm(application, 'Git: Delete Worktree', 'Delete Worktree', () => picker.getByRole('option').first().click());
		await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('article').filter({ hasText: 'Could not delete worktree' })).toContainText('Check local changes, locks and session ownership.');
		expect(await readFile(join(checkout, 'main.ts'), 'utf8')).toBe('local edits\n');

		await run('git', ['restore', '--worktree', 'main.ts'], { cwd: checkout });
		await workbench.git.selectTitleMenu(application, ['Worktrees', 'Delete Worktree…']);
		await picker.getByRole('combobox').fill(resolve(checkout));
		await workbench.dialogs.confirm(application, 'Git: Delete Worktree', 'Delete Worktree', () => picker.getByRole('option').first().click());
		await expect.poll(async () => (await run('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout).not.toContain(checkout);
	} finally {
		const inventory = (await run('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout;
		if (checkout && inventory.includes(`worktree ${checkout}\n`)) { await run('git', ['worktree', 'remove', '--force', checkout], { cwd }); }
	}
});


test('Changes title open worktree menu switches to the resolved workspace on both hosts', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const directory = join(cwd, '.git', 'title-open-worktree');
	await mkdir(directory);
	const checkout = join(directory, 'checkout');
	await run('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], { cwd });
	// The workspace fixture removes the checkout after its directory grants close.
	const page = workbench.page;
	await workbench.git.selectTitleMenu(application, ['Worktrees', 'Open Worktree…']);
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill(checkout);
	await picker.getByRole('combobox').press('Enter');
	if (target.kind === 'electron') {
		const permission = page.getByRole('dialog', { name: 'Ash', exact: true });
		await expect(permission).toBeVisible();
		await permission.getByRole('button', { name: 'Open Read Only', exact: true }).click();
		await expect.poll(async () => {
			const workspace = await page.evaluate(() => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash.ipcRenderer;
				return ipc.invoke('ash:workspace:context:read');
			});
			return parseWorkspace(workspace).folders[0]?.uri.fsPath;
		}).toBe(URI.file(await realpath(checkout)).fsPath);
	} else {
		await page.getByRole('dialog', { name: 'Authorize Server Folder', exact: true }).getByRole('button', { name: 'Open Folder', exact: true }).click();
		await page.waitForFunction(path => {
			const workspace = globalThis.ashWebWorkbenchHost?.workspace;
			return workspace && 'uri' in workspace && workspace.uri.fsPath === path;
		}, await realpath(checkout));
		await workbench.waitForReady();
	}

	await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true })).toBeVisible();
});
