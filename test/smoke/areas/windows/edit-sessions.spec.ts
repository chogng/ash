import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { launchElectron, type ElectronLaunchResult } from '../../../automation/playwrightElectron.js';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);
const store = 'workbench.editSessions.actions.storeCurrent';
const resume = 'workbench.editSessions.actions.resumeLatest';
const review = 'workbench.editSessions.actions.showEditSessions';
const discard = 'workbench.editSessions.actions.discardLocal';

test.use({ gitRepository: true });

test('Desktop saves uncommitted files and restores them in a linked worktree after restart', { tag: '@electron-app-server' }, async ({ testWorkspace }) => {
	test.setTimeout(120_000);
	const temporary = await mkdtemp(join(tmpdir(), 'ash-edit-sessions-'));
	const profile = join(temporary, 'user-data');
	const worktree = join(temporary, 'linked');
	const source = testWorkspace.directory;
	const added = Buffer.from([0, 255, 9]);
	let desktop: ElectronLaunchResult | undefined;
	try {
		await writeFile(join(source, 'obsolete.txt'), 'remove this\n');
		await run('git', ['add', 'obsolete.txt'], { cwd: source });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash@example.invalid', 'commit', '-m', 'Seed deletion'], { cwd: source });
		await run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: source });
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await rm(join(source, 'obsolete.txt'));
		await mkdir(join(source, 'assets'));
		await writeFile(join(source, 'assets', 'data.bin'), added);
		await mkdir(join(profile, 'profile'), { recursive: true });
		await writeFile(join(profile, 'profile', 'settings.json'), JSON.stringify({
			'window.restoreWindows': 'none',
			'workbench.startupEditor': 'none',
		}));

		const open = (workspaceDirectory: string) => launchElectron({
			appServerMode: 'required',
			userDataDirectory: profile,
			workspaceDirectory,
			workspacePermissions: 'development',
		});
		desktop = await open(source);
		let workbench = desktop.driver.workbench;
		await workbench.quickaccess.runCommand(store);
		await expect(workbench.page.getByRole('article').getByText(/Working changes saved on this device/i)).toBeVisible();
		const replace = await workbench.dialogs.expectMessage(desktop.application, 'Replace Saved Working Changes', () => workbench.quickaccess.runCommand(store));
		expect(replace.buttons).toContain('Replace');
		await desktop.close();
		desktop = await open(worktree);
		workbench = desktop.driver.workbench;

		const targetFile = join(worktree, 'main.ts');
		const baseline = await readFile(targetFile);
		await workbench.quickaccess.runCommand(review);
		const diff = workbench.page.locator('.stanza-multi-diff-editor:visible');
		await expect(diff).toContainText(/const\s+value\s*=\s*2;/u);
		expect(await readFile(targetFile)).toEqual(baseline);
		await writeFile(targetFile, 'const value = 3;\n');
		const conflict = await workbench.dialogs.expectMessage(desktop.application, 'Warning', () => workbench.quickaccess.runCommand(resume));
		expect(conflict.detail).toBe('Modify main.ts');
		expect(await readFile(targetFile, 'utf8')).toBe('const value = 3;\n');
		expect(await readFile(join(worktree, 'obsolete.txt'), 'utf8')).toBe('remove this\n');
		await writeFile(targetFile, baseline);

		const resumeButton = workbench.page.getByRole('button', { name: 'Resume Working Changes', exact: true });
		const preview = await workbench.dialogs.confirm(desktop.application, 'Resume Working Changes', 'Restore Changes', () => resumeButton.click());
		expect(preview.detail.split('\n').sort()).toEqual(['Add assets/data.bin', 'Delete obsolete.txt', 'Modify main.ts']);
		await expect(workbench.page.getByRole('article').getByText('Restored 3 working changes.', { exact: true })).toBeVisible();
		expect(await readFile(targetFile, 'utf8')).toBe('const value = 2;\n');
		expect(await readFile(join(worktree, 'assets', 'data.bin'))).toEqual(added);
		await expect(readFile(join(worktree, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await run('git', ['diff', '--cached', '--name-only'], { cwd: worktree })).stdout).toBe('');
		await workbench.quickaccess.runCommand(review);
		await expect(workbench.page.getByRole('article').getByText(/has no saved working changes/)).toBeVisible();

		await workbench.quickaccess.runCommand(store);
		await expect(workbench.page.getByRole('article').getByText(/Working changes saved on this device/i)).toBeVisible();
		await workbench.dialogs.confirm(desktop.application, 'Discard Saved Working Changes', 'Discard', () => workbench.quickaccess.runCommand(discard));
		await expect(workbench.page.getByRole('article').getByText('Saved working changes discarded.', { exact: true })).toBeVisible();
		expect(await readFile(targetFile, 'utf8')).toBe('const value = 2;\n');
	} finally {
		try { await desktop?.close(); }
		finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
	}
});
