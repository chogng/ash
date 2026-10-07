import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.describe('Git Fetch From All Remotes', () => {
	test.use({ gitRepository: true });
	test.beforeEach(async ({ target }) => {
		test.skip(target.appServerMode !== 'required', 'Requires the Rust Git backend.');
	});

	test('fetches both local remotes from the palette, toolbar and title menus while preserving HEAD, index and dirty files', async ({ application, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd })).stdout.trim();
		const remotes = await mkdtemp(join(tmpdir(), 'ash-fetch-remotes-'));
		try {
			const origin = join(remotes, 'origin.git');
			const backup = join(remotes, 'backup.git');
			const producer = join(remotes, 'producer');
			await run('git', ['clone', '--bare', cwd, origin]);
			await run('git', ['clone', '--bare', cwd, backup]);
			await run('git', ['clone', origin, producer]);
			const publish = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: producer })).stdout.trim();
			await publish('config', 'user.name', 'Ash Fetch Test');
			await publish('config', 'user.email', 'ash-fetch@example.invalid');
			await publish('config', 'commit.gpgsign', 'false');
			await writeFile(join(producer, 'remote-only.ts'), 'export const remoteValue = 1;\n');
			await publish('add', 'remote-only.ts');
			await publish('commit', '-m', 'First remote update');
			await publish('push', 'origin', 'HEAD:main');
			await publish('push', backup, 'HEAD:main');
			await git('remote', 'add', 'origin', origin);
			await git('remote', 'add', 'backup', backup);
			await writeFile(testWorkspace.file, 'const staged = true;\n');
			await git('add', 'main.ts');
			await writeFile(testWorkspace.file, 'const unstaged = true;\n');
			const untracked = join(cwd, 'untracked.txt');
			await writeFile(untracked, 'keep this untracked content\n');
			const snapshot = async () => ({
				head: await git('rev-parse', 'HEAD'),
				index: await git('ls-files', '--stage'),
				status: await git('status', '--porcelain=v1'),
				file: await readFile(testWorkspace.file, 'utf8'),
				untracked: await readFile(untracked, 'utf8'),
			});
			const before = await snapshot();
			const firstHead = await publish('rev-parse', 'HEAD');
			await workbench.quickaccess.open('>git.fetchAll');
			await expect(workbench.quickaccess.items).toHaveCount(1);
			await expect(workbench.quickaccess.items).toContainText('Git: Fetch From All Remotes');
			await workbench.quickaccess.input.press('Enter');
			await expect.poll(() => git('rev-parse', 'refs/remotes/origin/main')).toBe(firstHead);
			await expect.poll(() => git('rev-parse', 'refs/remotes/backup/main')).toBe(firstHead);
			expect(await snapshot()).toEqual(before);

			await writeFile(join(producer, 'remote-only.ts'), 'export const remoteValue = 2;\n');
			await publish('commit', '-am', 'Second remote update');
			await publish('push', 'origin', 'HEAD:main');
			await publish('push', backup, 'HEAD:main');
			const secondHead = await publish('rev-parse', 'HEAD');
			const page = workbench.page;
			const graph = page.locator('[data-view-id="ash.gitGraph"]');
			if (!await graph.isVisible()) await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
			const toggle = graph.getByRole('button', { name: 'Graph', exact: true });
			// Windows in one browser profile share saved pane expansion state.
			if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			const fetch = graph.locator('[data-action-id="git.fetchAll"] button');
			await expect(fetch).toHaveAccessibleName('Fetch from all Git remotes');
			await fetch.focus();
			await page.keyboard.press('Enter');
			await expect.poll(() => git('rev-parse', 'refs/remotes/origin/main')).toBe(secondHead);
			await expect.poll(() => git('rev-parse', 'refs/remotes/backup/main')).toBe(secondHead);
			await expect(fetch).toBeEnabled();
			expect(await snapshot()).toEqual(before);

			for (const [index, path] of [['Fetch'], ['Pull, Push', 'Fetch']].entries()) {
				await writeFile(join(producer, 'remote-only.ts'), `export const remoteValue = ${index + 3};\n`);
				await publish('commit', '-am', `Title menu remote update ${index + 1}`);
				await publish('push', 'origin', 'HEAD:main');
				await publish('push', backup, 'HEAD:main');
				const remoteHead = await publish('rev-parse', 'HEAD');
				const previousRemoteHead = await git('rev-parse', 'refs/remotes/origin/main');
				await workbench.git.open();
				const toolbar = page.getByRole('toolbar', { name: 'Source control actions', exact: true });
				await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
				// Inspect dismisses the real menu without selecting an action.
				const items = await workbench.menus.inspect(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), path.slice(0, -1));
				expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Fetch', enabled: true })]));
				expect(await git('rev-parse', 'refs/remotes/origin/main')).toBe(previousRemoteHead);
				expect(await git('rev-parse', 'refs/remotes/backup/main')).toBe(previousRemoteHead);
				await workbench.git.selectTitleMenu(application, path);
				await expect.poll(() => git('rev-parse', 'refs/remotes/origin/main')).toBe(remoteHead);
				await expect.poll(() => git('rev-parse', 'refs/remotes/backup/main')).toBe(remoteHead);
				await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
				expect(await snapshot()).toEqual(before);
			}
		} finally {
			await rm(remotes, { recursive: true, force: true });
		}
	});

	test('explains an empty remote list without changing the repository', async ({ testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout;
		await workbench.quickaccess.runCommand('git.fetchAll');
		await expect(workbench.page.getByRole('region', { name: 'Notifications' })).toContainText('This repository has no remotes configured to fetch from.');
		expect((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout).toBe(head);
		expect((await run('git', ['status', '--porcelain=v1'], { cwd })).stdout).toBe('');
	});

	test('localizes the command title and empty remote warning after restarting in Chinese', async ({ workbench, restartWorkbench }) => {
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		({ workbench } = await restartWorkbench());
		await workbench.quickaccess.open('>git.fetchAll');
		await expect(workbench.quickaccess.items).toHaveCount(1);
		await expect(workbench.quickaccess.items).toContainText('Git: 从所有远端获取');
		await workbench.quickaccess.input.press('Enter');
		await expect(workbench.page.getByRole('region', { name: '通知', exact: true })).toContainText('此仓库未配置可获取的远端。');
	});

	test('reports a failed local remote fetch and preserves local changes', async ({ testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		await run('git', ['remote', 'add', 'broken', join(cwd, 'missing-remote.git')], { cwd });
		await writeFile(testWorkspace.file, 'const dirty = true;\n');
		const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout;
		await workbench.git.open();
		await workbench.quickaccess.runCommand('git.fetchAll');
		await expect(workbench.page.locator('[data-view-id="ash.gitView"] .ash-scm-status')).toContainText('GitOperationFailed');
		await expect(workbench.page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
		expect((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout).toBe(head);
		expect((await run('git', ['diff', '--cached'], { cwd })).stdout).toBe('');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const dirty = true;\n');
	});
});
