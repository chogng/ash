import { _electron, expect, test } from '@playwright/test';
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Workbench } from '../../../automation/workbench.js';

test('Windows package opens the Workbench from its installed layout', async ({}, testInfo) => {
	test.skip(process.platform !== 'win32', 'The Windows package requires a Windows host.');
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a built Ash-win32-x64 directory.');
	const bundlePath = resolve(bundle!);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const environment = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	environment.ASH_DESKTOP_UI_ONLY = '1';
	environment.ASH_WORKBENCH_MODE = 'code';
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.ASH_RENDERER_URL;
	const application = await _electron.launch({
		executablePath: join(bundlePath, 'Ash.exe'),
		args: ['--disable-gpu', '--in-process-gpu', `--user-data-dir=${userDataDirectory}`],
		cwd: bundlePath,
		env: environment,
	});
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
	} finally {
		await application.close();
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
		expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
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
