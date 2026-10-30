import { _electron, type ElectronApplication } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import { expect, test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';
import { registerRunResource } from '../../../../build/processes.js';
import { appServerDaemonExecutablePath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';

const execFileAsync = promisify(execFile);

test.use({ gitRepository: true });

for (const reloadBackend of [false, true]) test(`development extension manifests hot reload without restarting App Server (Rust watch: ${reloadBackend})`, { tag: '@electron-app-server' }, async ({ testWorkspace }, testInfo) => {

	test.setTimeout(120_000);
	await writeFile(testWorkspace.file, 'const value = 2;\n');
	const repository = resolve(import.meta.dirname, '../../../..');
	const sourceFile = join(repository, 'extensions/git/package.json');
	const original = await readFile(sourceFile, 'utf8');
	const manifest = JSON.parse(original);
	manifest.contributes.menus['editor/title'].find((entry: { command: string; }) => entry.command === 'git.openFile').group = 'navigation@12';
	const modified = `${JSON.stringify(manifest, null, 2)}\n`;
	let written = original;
	const profile = await mkdtemp(join(tmpdir(), 'ash-extension-hot-reload-'));
	const server = await createServer({
		configFile: join(repository, 'build/desktop/vite/vite.config.ts'),
		server: { host: '127.0.0.1', port: 0 },
	});
	const configuration = resolveElectronConfiguration({
		desktopDirectory: repository, appServerMode: 'required', userDataDirectory: profile,
		workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development',
	});
	const daemon = appServerDaemonExecutablePath({ appPath: repository, isPackaged: false, platform: process.platform, resourcesPath: '' });
	const resource = await registerRunResource(() => ({ executable: daemon, profile: configuration.env.ASH_HOME! }));
	let application: ElectronApplication | undefined;
	const daemonVersion = async () => JSON.parse((await execFileAsync(daemon, ['version'], { env: configuration.env, timeout: 15_000 })).stdout) as { pid: number; instanceId: string; };
	try {
		await server.listen();
		application = await _electron.launch({
			args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath,
			env: { ...configuration.env, ASH_DEV_APP_SERVER_RELOAD: reloadBackend ? '1' : '0', ASH_RENDERER_URL: server.resolvedUrls!.local[0]! },
		});
		await resource.process(application.process());
		const page = await application.firstWindow();
		const workbench = new Workbench(page);
		const ready = workbench.waitForReady();
		const trust = page.getByRole('dialog', { name: 'Ash' });
		await Promise.race([ready, trust.waitFor({ state: 'visible' })]);
		if (await trust.isVisible()) await trust.getByRole('button', { name: 'Trust Folder', exact: true }).click();
		await ready;
		await workbench.git.open();
		const sourceControl = page.getByRole('tab', { name: /^Source Control(?:,|$)/u });
		const change = page.locator('.ash-scm-change-open').filter({ hasText: 'main.ts' });
		await expect(change).toHaveCount(1);
		await change.dblclick();
		const actions = page.locator('.ash-editor-title-actions').last().locator('[data-action-id]');
		const order = () => actions.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.actionId).slice(0, 3));
		const initial = ['git.openFile', 'workbench.action.compareEditor.previousChange', 'workbench.action.compareEditor.nextChange'];
		await expect.poll(order).toEqual(initial);
		const before = await daemonVersion();

		for (const [contents, expected] of [[modified, [initial[1], initial[2], initial[0]]], [original, initial]] as const) {
			await page.evaluate(() => { document.body.dataset.extensionHotReload = 'before'; });
			written = contents;
			await writeFile(sourceFile, contents);
			await expect(page.locator('body')).not.toHaveAttribute('data-extension-hot-reload', 'before', { timeout: 30_000 });
			await expect(sourceControl).toBeVisible();
			if (await sourceControl.getAttribute('aria-selected') !== 'true') await sourceControl.click();
			await expect(change).toHaveCount(1);
			await change.dblclick();
			await expect.poll(order).toEqual(expected);
			const after = await daemonVersion();
			expect({ pid: after.pid, instanceId: after.instanceId }).toEqual({ pid: before.pid, instanceId: before.instanceId });
		}
		await testInfo.attach('extension-manifest-reloaded', { body: await page.screenshot(), contentType: 'image/png' });
	} finally {
		const current = await readFile(sourceFile, 'utf8');
		if (current === written && current !== original) await writeFile(sourceFile, original);
		try {
			if (application) {
				try {
					await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
				} finally {
					await application.close();
				}
			}
		} finally {
			await execFileAsync(daemon, ['stop'], { env: configuration.env, timeout: 30_000 });
			await server.close();
			// Closing Vite cancels pending work; publish restored sources even after a failed assertion.
			await execFileAsync(process.execPath, ['build/builtin/extensions.ts'], { cwd: repository });
			await resource.dispose();
			await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		if (current !== written && current !== original) throw new Error(`Concurrent edit detected; preserved ${sourceFile}`);
	}
});
