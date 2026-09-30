import { _electron, expect, test } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';
import { dirname, join, resolve } from 'node:path';
import { Workbench } from '../../../automation/workbench.js';
import { exercisePackagedWorkbench } from '../../../automation/packagedWorkbench.js';

test('Windows package saves files, executes a terminal command and restarts with its bundled backend', async ({}, testInfo) => {
	test.setTimeout(120_000);
	test.skip(process.platform !== 'win32', 'The Windows package requires a Windows host.');
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a built Ash-win32-x64 directory.');
	const bundlePath = resolve(bundle!);
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	try {
		const userData = directory;
		const workspace = join(directory, 'workspace');
		await mkdir(workspace);
		await mkdir(join(userData, 'profile'), { recursive: true });
		await writeFile(join(userData, 'profile', 'settings.json'), '{"update.policy":"never","workbench.mode":"code"}');
		await writeFile(join(workspace, 'main.ts'), 'const release = 1;\n');
		const { version } = JSON.parse(await readFile(join(bundlePath, 'resources', 'app', 'package.json'), 'utf8'));
		await exercisePackagedWorkbench(bundlePath, version, userData, workspace, 'const release = 2;', testInfo, 'package');
		await exercisePackagedWorkbench(bundlePath, version, userData, workspace, 'const release = 3;', testInfo, 'restart');
	} finally {
		const absolute = await realpath(directory);
		assert.equal(dirname(absolute), await realpath(tmpdir()));
		assert(absolute.startsWith(join(await realpath(tmpdir()), 'ash-')));
		await rm(absolute, { recursive: true, force: true });
	}
});

test('macOS package launches, opens a window tab, and installs its shell command', async ({}, testInfo) => {
	test.skip(process.platform !== 'darwin', 'The macOS package requires a macOS host.');
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a built Ash.app directory.');
	const bundlePath = resolve(bundle!);
	const userDataDirectory = testInfo.outputPath('user-data');
	const shellBin = join(userDataDirectory, '.local', 'bin');
	await mkdir(shellBin, { recursive: true });
	const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	delete environment.ASH_DESKTOP_UI_ONLY;
	environment.ASH_WORKBENCH_MODE = 'code';
	environment.ASH_HOME = join(userDataDirectory, 'profile');
	environment.HOME = userDataDirectory;
	environment.PATH = `${shellBin}:${environment.PATH ?? ''}`;
	environment.SHELL = '/bin/sh';
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.ASH_RENDERER_URL;
	const application = await _electron.launch({
		executablePath: join(bundlePath, 'Contents', 'MacOS', 'Ash'),
		args: [`--user-data-dir=${userDataDirectory}`],
		cwd: dirname(bundlePath),
		env: environment,
	});
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		expect(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, dockVisible: app.dock!.isVisible() }))).toEqual({ packaged: true, dockVisible: true });
		const commandPath = await page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:native-host:shell-command', 'install') as Promise<string>;
		});
		await access(commandPath);
		expect(await readFile(commandPath, 'utf8')).toContain(bundlePath);
		await page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:native-host:shell-command', 'uninstall');
		});
		expect(await access(commandPath).then(() => true, () => false)).toBe(false);
		await page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'newTab' });
		});
		await expect.poll(() => application.windows().length).toBe(2);
	} finally {
		await application.close();
	}
});
