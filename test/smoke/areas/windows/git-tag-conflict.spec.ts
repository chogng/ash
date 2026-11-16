import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);
test.use({ gitRepository: true, electronUserSettings: { 'workbench.locale': 'zh-CN' } });

test('Chinese tag conflict summary replaces only the conflicting tags', { tag: '@electron-app-server' }, async ({ application, testWorkspace, workbench }) => {
	if (!('windows' in application)) throw new Error('Electron required');
	const cwd = testWorkspace.directory;
	const remote = join(cwd, 'remote.git');
	await run('git', ['init', '--bare', remote]);
	await run('git', ['remote', 'add', 'origin', remote], { cwd });
	await run('git', ['push', '-u', 'origin', 'HEAD:main'], { cwd });
	await run('git', ['config', 'remote.origin.tagOpt', '--tags'], { cwd });
	for (let index = 0; index < 8; index++) await run('git', ['tag', 'conflict-' + index], { cwd });
	await run('git', ['push', 'origin', '--tags'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Different local tag target'], { cwd });
	for (let index = 0; index < 8; index++) await run('git', ['tag', '-f', 'conflict-' + index], { cwd });
	const localHead = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
	await application.evaluate(({ dialog }) => {
		const state = globalThis as unknown as { tagPrompt: { message?: string; finish?: () => void; restore(): void; }; };
		const original = dialog.showMessageBox;
		state.tagPrompt = { restore: () => { dialog.showMessageBox = original; } };
		dialog.showMessageBox = ((...args: unknown[]) => new Promise(resolve => {
			const options = args.at(-1) as { message: string; };
			state.tagPrompt.message = options.message;
			state.tagPrompt.finish = () => resolve({ response: 0, checkboxChecked: false });
		})) as typeof dialog.showMessageBox;
	});
	try {
		await workbench.quickaccess.runCommand('git.pull');
		const captured = () => application.evaluate(() => (globalThis as unknown as { tagPrompt: { message?: string; }; }).tagPrompt.message);
		await expect.poll(captured).toContain('以及另外 3 项');
		const message = await captured();
		expect(message).toContain('conflict-0, conflict-1, conflict-2, conflict-3, conflict-4');
		expect(message).not.toContain('conflict-5');
		await application.evaluate(() => (globalThis as unknown as { tagPrompt: { finish(): void; }; }).tagPrompt.finish());
		const remoteHead = (await run('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd })).stdout.trim();
		await expect.poll(async () => (await run('git', ['rev-parse', 'refs/tags/conflict-7'], { cwd })).stdout.trim()).toBe(remoteHead);
		expect((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()).toBe(localHead);
	} finally {
		await application.evaluate(() => { const state = (globalThis as unknown as { tagPrompt: { finish?: () => void; restore(): void; }; }).tagPrompt; state.finish?.(); state.restore(); });
	}
});
