import { _electron, type Page } from '@playwright/test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { readDevelopmentAppServerGeneration } from '../../../../src/ash/platform/app-server-daemon/electron-main/developmentAppServerReloader.js';
import { developmentAppServerGenerationPath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';

const desktopDirectory = resolve(import.meta.dirname, '../../../..');
const execFileAsync = promisify(execFile);

async function publish(source: string, directory: string, identity: string): Promise<string> {
	const marker = join(directory, 'test-generation');
	await writeFile(marker, identity);
	const script = 'import json,sys; from pathlib import Path; from build.ash_rs.develop import publish_generation; changed,generation=publish_generation(Path(sys.argv[1]), {"test-generation":Path(sys.argv[2])}, Path(sys.argv[3])); print(json.dumps({"generation":generation}))';
	const result = await execFileAsync(process.execPath, [resolve(desktopDirectory, '../build/python.ts'), '-B', '-c', script, source, marker, directory], { cwd: resolve(desktopDirectory, '..'), windowsHide: true });
	return (JSON.parse(result.stdout) as { generation: string }).generation;
}

async function connection(page: Page): Promise<{ generation: number }> {
	return page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ generation: number }> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:remote:connection');
	});
}

test('Rust publication reconnects Workbench and Agents once while keeping both windows open', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the development Desktop backend');
	test.setTimeout(120_000);
	const source = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktopDirectory));
	if (!source) throw new Error('Prepare the development backend before this scenario');
	const directory = await mkdtemp(resolve(desktopDirectory, '../.build/app-ts/dev/test-runtime-'));
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
	const generationFile = join(directory, 'current.json');
	const previous = { reload: process.env.ASH_DEV_APP_SERVER_RELOAD, generation: process.env.ASH_DEV_APP_SERVER_GENERATION };
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	let processOutput = '';
	const output = (chunk: Buffer): void => { processOutput += chunk.toString(); };
	try {
		const first = await publish(source, directory, 'first');
		process.env.ASH_DEV_APP_SERVER_RELOAD = '1';
		process.env.ASH_DEV_APP_SERVER_GENERATION = generationFile;
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		desktop.application.process().stdout?.on('data', output);
		const workbench = desktop.driver.workbench.page;
		const opened = desktop.application.waitForEvent('window');
		await workbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		const beforeWorkbench = await connection(workbench);
		const beforeAgents = await connection(agents);
		const daemon = join(source, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`);
		const environment = { ...process.env, ASH_HOME: join(userDataDirectory, 'profile') };
		const beforePid = JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout).pid;

		const second = await publish(source, directory, 'second');
		await expect.poll(async () => (await connection(workbench)).generation).toBe(beforeWorkbench.generation + 1);
		await expect.poll(async () => (await connection(agents)).generation).toBe(beforeAgents.generation + 1);
		await expect.poll(() => processOutput.includes(`Restarted development runtime ${second}`)).toBe(true);
		const afterPid = JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout).pid;
		expect(afterPid).not.toBe(beforePid);
		expect(desktop.application.windows()).toHaveLength(2);
		await expect(desktop.driver.workbench.element).toBeVisible();
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		await expect(agents.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);

		await expect.poll(async () => {
			await publish(source, directory, 'second');
			try { await access(join(directory, 'generations', first)); return true; }
			catch { return false; }
		}).toBe(false);
		expect((await connection(workbench)).generation).toBe(beforeWorkbench.generation + 1);
		expect(JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout).pid).toBe(afterPid);
		await agents.close();
		await expect.poll(() => desktop!.application.windows().length).toBe(1);
		expect(await publish(source, directory, 'first')).toBe(first);
		await expect.poll(async () => (await connection(workbench)).generation).toBe(beforeWorkbench.generation + 2);
		await expect.poll(() => processOutput.includes(`Restarted development runtime ${first}`)).toBe(true);
	} finally {
		try {
			desktop?.application.process().stdout?.off('data', output);
			await desktop?.close();
		}
		finally {
			for (const [key, value] of [['ASH_DEV_APP_SERVER_RELOAD', previous.reload], ['ASH_DEV_APP_SERVER_GENERATION', previous.generation]] as const) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

test('publication between runtime selection and Windows process startup preserves the selected build', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the development Desktop backend');
	test.setTimeout(120_000);
	const source = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktopDirectory));
	if (!source) throw new Error('Prepare the development backend before this scenario');
	const directory = await mkdtemp(resolve(desktopDirectory, '../.build/app-ts/dev/test-startup-'));
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
	const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory });
	const generationFile = join(directory, 'current.json');
	let launcher: ReturnType<typeof createAppServerDaemonLauncher>['launcher'] | undefined;
	try {
		await publish(source, directory, 'first');
		launcher = createAppServerDaemonLauncher({ packageLocation: { appPath: desktopDirectory, isPackaged: false, platform: process.platform, resourcesPath: '' }, sourceEnvironment: { ...configuration.env, ASH_DEV_APP_SERVER_RELOAD: '1', ASH_DEV_APP_SERVER_GENERATION: generationFile }, profileRoot: configuration.env.ASH_HOME!, electronExecutable: configuration.executablePath, role: 'agents' }).launcher;
		// The pointer changes after Electron creates the launcher but before Rust leases it.
		const second = await publish(source, directory, 'second');
		await launcher.validate();
		expect(launcher.environment.ASH_DEV_RUNTIME_ROOT).toBe(join(directory, 'generations', second));
		// Another real publication must retain the leased runtime before any daemon starts.
		await publish(source, directory, 'third');
		await launcher.validate();
		await access(launcher.executable);
		const result = await execFileAsync(launcher.executable, ['start'], { env: { ...launcher.environment }, windowsHide: true });
		expect((JSON.parse(result.stdout) as { pid: number }).pid).toBeGreaterThan(0);
		await execFileAsync(launcher.executable, ['stop'], { env: { ...launcher.environment }, windowsHide: true });
		launcher.dispose();
		await expect.poll(async () => {
			await publish(source, directory, 'third');
			try { await access(join(directory, 'generations', second)); return true; }
			catch { return false; }
		}).toBe(false);
	} finally {
		if (launcher && !launcher.isDisposed) {
			try { await execFileAsync(launcher.executable, ['stop'], { env: { ...launcher.environment }, windowsHide: true }); }
			finally { launcher.dispose(); }
		}
		await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('the Agents development entry opens one connected Agents window directly', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the development Desktop backend');
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory: directory });
	const application = await _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, executablePath: configuration.executablePath, env: { ...configuration.env, ASH_DEV_APP_SERVER_RELOAD: '1', ASH_DEV_AGENTS_WINDOW: '1' } });
	try {
		const page = await application.firstWindow();
		await expect(page.locator('.ash-sessions-window')).toBeVisible();
		expect(application.windows()).toHaveLength(1);
		await expect(page.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
	} finally {
		await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
		const runtime = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktopDirectory));
		if (runtime) await execFileAsync(join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`), ['stop'], { env: { ...configuration.env }, windowsHide: true });
		await application.close();
		await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
	}
});
