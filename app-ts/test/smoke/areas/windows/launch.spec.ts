import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';

test('desktop launch opens files, positions the caret and distinguishes new and reused windows', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Disk files require the Electron App Server.');
	if (!('windows' in application)) return;
	const file = join(testWorkspace.directory, 'launch file.txt');
	const diagnostics: string[] = [];
	application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
	workbench.page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
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
	const newPage = await opened;
	newPage.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
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
		await expect.poll(() => newPage.evaluate(() => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ folders: { uri: string }[] }> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:workspace:context:read').then(value => value.folders[0]?.uri);
		})).toBe(pathToFileURL(folder).href);
		expect(application.windows()).toHaveLength(2);
		await application.evaluate(({ app }, url) => { app.emit('open-url', { preventDefault() {} }, url); }, `ash://file${pathToFileURL(file).pathname}`);
		await expect(newPage.getByRole('tab').filter({ hasText: 'launch file.txt' })).toHaveCount(1);
	} finally {
		if (!newPage.isClosed()) await newPage.close();
	}
});

test('a real second process waits until its requested file closes while the first window stays usable', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Disk files require the Electron App Server.');
	if (!('windows' in application)) return;
	const file = join(testWorkspace.directory, 'wait file.txt');
	await writeFile(file, 'wait for this tab');
	const configuration = await application.evaluate(({ app }) => ({ executable: process.execPath, appPath: app.getAppPath(), userData: app.getPath('userData'), environment: process.env, cwd: process.cwd() }));
	const child = spawn(configuration.executable, [configuration.appPath, `--user-data-dir=${configuration.userData}`, '--reuse-window', '--wait', file], { cwd: configuration.cwd, env: configuration.environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', chunk => { output += String(chunk); });
	child.stderr.on('data', chunk => { output += String(chunk); });
	try {
		const tab = workbench.editors.groupAt(0).tabs.filter({ hasText: 'wait file.txt' });
		await expect(tab, { message: output }).toHaveCount(1);
		expect(child.exitCode).toBeNull();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('wait for this tab'));
		await tab.getByRole('button', { name: /close/i }).click();
		await expect.poll(() => child.exitCode, { message: output }).toBe(0);
		await expect(workbench.element).toBeVisible();
		expect(application.windows()).toHaveLength(1);
	} finally {
		if (child.exitCode === null) child.kill();
	}
});

test('UI-only launches create a requested window and focus it on the next launch', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'This scenario checks window policy without a backend.');
	if (!('windows' in application)) return;
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
