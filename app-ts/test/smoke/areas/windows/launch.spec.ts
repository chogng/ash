import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { toDisposable } from '../../../../src/ash/base/common/lifecycle.js';
import type { ConsoleMessage, Page } from '@playwright/test';

test('the first process opens its requested file after restoring the Workbench and positions its caret', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Disk files require the Electron App Server.');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-launch-'));
	try {
		const file = join(testWorkspace.directory, 'startup file.txt');
		await writeFile(file, 'first line\nsecond line\n');
		const launched = await launchElectron({
			appServerMode: 'required',
			userDataDirectory,
			workspaceDirectory: testWorkspace.directory,
			workspacePermissions: 'development',
			extraArgs: ['--goto', `${file}:2:4`],
		});
		try {
			const workbench = launched.driver.workbench;
			await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'startup file.txt' })).toHaveCount(1);
			await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('second line'));
			await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
			await expect(workbench.page.getByText('Ln 2, Col 4', { exact: true })).toBeVisible();
		} finally {
			await launched.close();
		}
	} finally {
		await rm(userDataDirectory, { recursive: true, force: true });
	}
});

test('desktop launch opens files, positions the caret and distinguishes new and reused windows', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Disk files require the Electron App Server.');
	if (!('windows' in application)) {
		return;
	}
	const file = join(testWorkspace.directory, 'launch file.txt');
	const diagnostics: string[] = [];
	const stderr = application.process().stderr;
	const onProcessError = (chunk: Buffer): void => { diagnostics.push(String(chunk)); };
	const onConsole = (message: ConsoleMessage): void => {
		if (message.type() === 'error') {
			diagnostics.push(message.text());
		}
	};
	let newPage: Page | undefined;
	using listeners = toDisposable(() => {
		stderr?.off('data', onProcessError);
		workbench.page.off('console', onConsole);
		newPage?.off('console', onConsole);
	});
	stderr?.on('data', onProcessError);
	workbench.page.on('console', onConsole);
	await writeFile(file, 'first line\nsecond line\nthird line\n');
	const launch = async (args: string[]): Promise<void> => {
		await application.evaluate(({ app }, args) => { app.emit('second-instance', {}, [process.execPath, app.getAppPath(), ...args], process.cwd(), {}); }, args);
	};
	await launch(['--reuse-window', '--goto', `${file}:2:4`]);
	try {
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'launch file.txt' })).toHaveCount(1);
	} catch (error) {
		throw new Error(`File launch failed:\n${diagnostics.join('\n')}\n${await workbench.page.locator('body').innerText()}`, { cause: error });
	}
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('second line'));
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
	await expect(workbench.page.getByText('Ln 2, Col 4', { exact: true })).toBeVisible();
	expect(application.windows()).toHaveLength(1);
	const opened = application.waitForEvent('window');
	await launch(['--new-window', file]);
	newPage = await opened;
	newPage.on('console', onConsole);
	try {
		try {
			await expect(newPage.getByRole('tab').filter({ hasText: 'launch file.txt' })).toHaveCount(1);
		} catch (error) {
			throw new Error(`New window file launch failed:\n${diagnostics.join('\n')}\n${await newPage.locator('body').innerText()}`, { cause: error });
		}
		expect(application.windows()).toHaveLength(2);
		const folder = join(testWorkspace.directory, 'launch-folder');
		await mkdir(folder);
		await launch(['--reuse-window', '--folder', folder]);
		await newPage.getByRole('button', { name: 'Trust Folder & Enable Features', exact: true }).click();
		try {
			await expect.poll(() => newPage.evaluate(() => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ folders: { uri: string }[] }> } } }).ash.ipcRenderer;
				return ipc.invoke('ash:workspace:context:read').then(value => value.folders[0]?.uri);
			})).toBe(pathToFileURL(folder).href);
		} catch (error) {
			throw new Error(`Workspace reuse failed:\n${diagnostics.join('\n')}\n${await newPage.locator('body').innerText()}`, { cause: error });
		}
		expect(application.windows()).toHaveLength(2);
		await application.evaluate(({ app }, url) => { app.emit('open-url', { preventDefault() {} }, url); }, `ash://file${pathToFileURL(file).pathname}`);
		await expect(newPage.getByRole('tab').filter({ hasText: 'launch file.txt' })).toHaveCount(1);
	} finally {
		if (!newPage.isClosed()) {
			await newPage.close();
		}
	}
});

test('a real second process waits until all requested files close while the first window stays usable', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Disk files require the Electron App Server.');
	if (!('windows' in application)) {
		return;
	}
	const file = join(testWorkspace.directory, 'wait file.txt');
	const otherFile = join(testWorkspace.directory, 'second.txt');
	await writeFile(file, 'wait for this tab');
	await writeFile(otherFile, 'wait for the other tab');
	const configuration = await application.evaluate(({ app }) => ({ executable: process.execPath, appPath: app.getAppPath(), userData: app.getPath('userData'), environment: process.env, cwd: process.cwd() }));
	const child = spawn(configuration.executable, [configuration.appPath, `--user-data-dir=${configuration.userData}`, '--reuse-window', '--wait', '--', file, otherFile], { cwd: configuration.cwd, env: configuration.environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', chunk => { output += String(chunk); });
	child.stderr.on('data', chunk => { output += String(chunk); });
	try {
		const tab = workbench.editors.groupAt(0).tabs.filter({ hasText: 'wait file.txt' });
		await expect(tab, { message: output }).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'second.txt' })).toHaveCount(1);
		expect(child.exitCode).toBeNull();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('wait for the other tab'));
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'second.txt' })).toHaveCount(0);
		expect(child.exitCode).toBeNull();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('wait for this tab'));
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect.poll(() => child.exitCode, { message: output }).toBe(0);
		await expect(workbench.element).toBeVisible();
		expect(application.windows()).toHaveLength(1);
	} catch (error) {
		throw new Error(`Waiting launch failed:\n${output}\n${await workbench.page.locator('body').innerText()}`, { cause: error });
	} finally {
		if (child.exitCode === null) {
			const exited = once(child, 'exit');
			child.kill();
			await exited;
		}
	}
});

test('UI-only launches create a requested window and focus it on the next launch', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'This scenario checks window policy without a backend.');
	if (!('windows' in application)) {
		return;
	}
	const opened = application.waitForEvent('window');
	await application.evaluate(({ app }, folder) => { app.emit('second-instance', {}, [process.execPath, app.getAppPath(), '--new-window', '--folder', folder], process.cwd(), {}); }, testWorkspace.directory);
	const page = await opened;
	try {
		await expect(page.locator('.ash-workbench')).toBeVisible();
		expect(application.windows()).toHaveLength(2);
		const id = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()!.id);
		await application.evaluate(({ app }) => { app.emit('second-instance', {}, [process.execPath, app.getAppPath(), '--reuse-window'], process.cwd(), {}); });
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(id);
		expect(application.windows()).toHaveLength(2);
		await expect(workbench.element).toBeVisible();
	} finally {
		await page.close();
	}
});
