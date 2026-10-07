import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

// Palette acceptance precedes fetch completion, so the first remote ref may still be absent.
async function readRemoteHead(cwd: string, remote: string): Promise<string | undefined> {
	try {
		return (await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/main`], { cwd })).stdout.trim();
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) { return undefined; }
		throw error;
	}
}

test.describe('Git Fetch', () => {
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
			await expect.poll(() => readRemoteHead(cwd, 'origin')).toBe(firstHead);
			await expect.poll(() => readRemoteHead(cwd, 'backup')).toBe(firstHead);
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
			await expect(fetch).toHaveAccessibleName('Git: Fetch From All Remotes');
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
		for (const command of ['git.fetchAll', 'git.fetch']) {
			await workbench.quickaccess.runCommand(command);
			await expect(workbench.page.getByRole('region', { name: 'Notifications' })).toContainText('This repository has no remotes configured to fetch from.');
		}
		expect((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout).toBe(head);
		expect((await run('git', ['status', '--porcelain=v1'], { cwd })).stdout).toBe('');
	});

	test('localizes both commands, the empty remote warning and the remote picker after restarting in Chinese', async ({ testWorkspace, workbench, restartWorkbench }) => {
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
		const remotes = await mkdtemp(join(tmpdir(), 'ash-fetch-locale-'));
		try {
			for (const name of ['origin', 'backup']) {
				const path = join(remotes, `${name}.git`);
				await run('git', ['clone', '--bare', testWorkspace.directory, path]);
				await run('git', ['remote', 'add', name, path], { cwd: testWorkspace.directory });
			}
			await workbench.quickaccess.open('>git.fetch');
			const command = workbench.quickaccess.items.filter({ has: workbench.page.locator('.ash-quick-pick-row-description').getByText('git.fetch', { exact: true }) });
			await expect(command).toContainText('Git: 获取');
			await command.click();
			const picker = workbench.page.getByRole('dialog', { name: '选择要获取的远端', exact: true });
			await expect(picker.getByRole('combobox')).toBeFocused();
			await expect(picker.getByRole('option')).toHaveCount(3);
			await expect(picker.getByRole('option').last()).toContainText('获取所有远端');
			await picker.getByRole('combobox').press('Escape');
			await expect(picker).toBeHidden();
		} finally { await rm(remotes, { recursive: true, force: true }); }
	});

	test('selects the upstream remote, another remote and all remotes, and revalidates a removed remote after the picker opens', async ({ testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd })).stdout.trim();
		const remotes = await mkdtemp(join(tmpdir(), 'ash-fetch-selected-'));
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
			await git('remote', 'add', 'origin', origin);
			await git('remote', 'add', 'backup', backup);
			await git('fetch', '--all');
			await git('branch', '--set-upstream-to=origin/main', 'main');
			const initial = await git('rev-parse', 'HEAD');
			await writeFile(testWorkspace.file, 'const staged = true;\n');
			await git('add', 'main.ts');
			await writeFile(testWorkspace.file, 'const unstaged = true;\n');
			await writeFile(join(cwd, 'untracked.txt'), 'keep me\n');
			const snapshot = async () => ({ head: await git('rev-parse', 'HEAD'), index: await git('ls-files', '--stage'), status: await git('status', '--porcelain=v1'), file: await readFile(testWorkspace.file, 'utf8'), untracked: await readFile(join(cwd, 'untracked.txt'), 'utf8') });
			const before = await snapshot();
			await writeFile(join(producer, 'remote-only.ts'), 'export const remoteValue = 1;\n');
			await publish('add', 'remote-only.ts');
			await publish('commit', '-m', 'Origin update');
			await publish('push', 'origin', 'HEAD:main');
			const originHead = await publish('rev-parse', 'HEAD');
			await writeFile(join(producer, 'remote-only.ts'), 'export const remoteValue = 2;\n');
			await publish('commit', '-am', 'Backup update');
			await publish('push', backup, 'HEAD:main');
			const backupHead = await publish('rev-parse', 'HEAD');
			const picker = workbench.page.getByRole('dialog', { name: 'Select a remote to fetch', exact: true });
			await workbench.git.open();
			const refresh = workbench.page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'Refresh', exact: true });
			await workbench.quickaccess.runCommand('git.fetch');
			await expect(picker.getByRole('combobox')).toBeFocused();
			await expect(picker.getByRole('option')).toHaveText(['origin', 'backup', 'Fetch all remotes']);
			await picker.getByRole('combobox').press('Escape');
			await expect(picker).toBeHidden();
			await expect(refresh).toBeEnabled();
			expect(await git('rev-parse', 'refs/remotes/origin/main')).toBe(initial);
			expect(await git('rev-parse', 'refs/remotes/backup/main')).toBe(initial);
			await workbench.quickaccess.runCommand('git.fetch');
			await picker.getByRole('combobox').press('Enter');
			await expect.poll(() => git('rev-parse', 'refs/remotes/origin/main')).toBe(originHead);
			expect(await git('rev-parse', 'refs/remotes/backup/main')).toBe(initial);
			await expect(refresh).toBeEnabled();
			await workbench.quickaccess.runCommand('git.fetch');
			await picker.getByRole('combobox').press('ArrowDown');
			await picker.getByRole('combobox').press('Enter');
			await expect.poll(() => git('rev-parse', 'refs/remotes/backup/main')).toBe(backupHead);
			expect(await git('rev-parse', 'refs/remotes/origin/main')).toBe(originHead);
			await expect(refresh).toBeEnabled();
			await publish('push', 'origin', 'HEAD:main');
			await workbench.quickaccess.runCommand('git.fetch');
			await workbench.quickaccess.select('Fetch all remotes');
			await expect.poll(() => git('rev-parse', 'refs/remotes/origin/main')).toBe(backupHead);
			await expect(refresh).toBeEnabled();
			expect(await snapshot()).toEqual(before);

			await workbench.quickaccess.runCommand('git.fetch');
			await expect(picker).toBeVisible();
			await writeFile(join(producer, 'remote-only.ts'), 'export const remoteValue = 3;\n');
			await publish('commit', '-am', 'Unfetched origin update');
			await publish('push', 'origin', 'HEAD:main');
			await git('remote', 'remove', 'backup');
			await workbench.quickaccess.select('backup');
			await expect(workbench.page.locator('[data-view-id="ash.gitView"] .ash-scm-status')).toContainText('GitOperationFailed');
			await expect(refresh).toBeEnabled();
			expect(await git('rev-parse', 'refs/remotes/origin/main')).toBe(backupHead);
			expect(await snapshot()).toEqual(before);
		} finally { await rm(remotes, { recursive: true, force: true }); }
	});

	test('fetches the sole configured remote through the default mode without a picker', async ({ testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const remotes = await mkdtemp(join(tmpdir(), 'ash-fetch-default-'));
		try {
			const backup = join(remotes, 'backup.git');
			const producer = join(remotes, 'producer');
			await run('git', ['clone', '--bare', cwd, backup]);
			await run('git', ['clone', backup, producer]);
			const publish = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: producer })).stdout.trim();
			await publish('config', 'user.name', 'Ash Fetch Test');
			await publish('config', 'user.email', 'ash-fetch@example.invalid');
			await publish('config', 'commit.gpgsign', 'false');
			await writeFile(join(producer, 'remote-only.ts'), 'export const remoteValue = 1;\n');
			await publish('add', 'remote-only.ts');
			await publish('commit', '-m', 'Default remote update');
			await publish('push', 'origin', 'HEAD:main');
			await run('git', ['remote', 'add', 'backup', backup], { cwd });
			const head = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout;
			await workbench.quickaccess.runCommand('git.fetch');
			await expect.poll(() => readRemoteHead(cwd, 'backup')).toBe(await publish('rev-parse', 'HEAD'));
			await expect(workbench.page.getByRole('dialog', { name: 'Select a remote to fetch', exact: true })).toBeHidden();
			expect((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout).toBe(head);
			expect((await run('git', ['status', '--porcelain=v1'], { cwd })).stdout).toBe('');
		} finally { await rm(remotes, { recursive: true, force: true }); }
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
