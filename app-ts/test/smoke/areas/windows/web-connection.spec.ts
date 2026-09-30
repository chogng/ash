import { expect, test } from '../../../automation/test.js';
import type { IWebWorkbenchHost } from '../../../../src/ash/workbench/browser/web.api.js';
import { basename, join, relative, resolve } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import type { ISandboxGlobals } from "../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js";
import { decodeAppServerServerRequestResult } from '../../../../src/ash/platform/app-server/common/generated/AppServerProtocolDecoder.js';
import type { Page } from '@playwright/test';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server/electron-main/appServerPackage.js';

test('two desktops isolate browser targets and closing one preserves the other', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires the shared managed backend');
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	const profile = join(directory, 'profile');
	const packageLocation = { appPath: resolve(import.meta.dirname, '../../../..'), isPackaged: false, platform: process.platform, resourcesPath: '' };
	const daemon = appServerDaemonExecutablePath(packageLocation);
	const environment = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: appServerExecutablePath(packageLocation) };
	const desktops: Awaited<ReturnType<typeof launchElectron>>[] = [];
	const closed = new Set<Awaited<ReturnType<typeof launchElectron>>>();
	const hostCall = (page: Page, method: string, params: unknown) => page.evaluate(({ method, params }) => {
		return (globalThis as unknown as { ash: ISandboxGlobals }).ash.ipcRenderer.invoke(`ash:browser-host:${method}`, { id: crypto.randomUUID(), params });
	}, { method, params });
	try {
		await promisify(execFile)(daemon, ['start'], { env: environment, windowsHide: true, timeout: 30_000 });
		for (let index = 0; index < 2; index++) {
			desktops.push(await launchElectron({ appServerMode: 'required', userDataDirectory: join(directory, String(index)), profileDirectory: profile, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' }));
		}
		const first = desktops[0]!.driver.workbench.page;
		const second = desktops[1]!.driver.workbench.page;
		const created = decodeAppServerServerRequestResult('browser/create', await hostCall(second, 'create', { url: 'about:blank' }));
		await expect(second.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(1);
		await expect(first.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(0);
		const observe = { targetId: created.targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false };
		await expect(hostCall(first, 'observe', observe)).rejects.toThrow();
		await desktops[0]!.close();
		closed.add(desktops[0]!);
		const state = decodeAppServerServerRequestResult('browser/observe', await hostCall(second, 'observe', observe));
		expect(state.targetId).toBe(created.targetId);
		await second.reload();
		await desktops[1]!.driver.workbench.waitForReady();
		await expect.poll(() => desktops[1]!.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(view => 'webContents' in view).length)).toBe(0);
		await expect(hostCall(second, 'observe', observe)).rejects.toThrow();
	} finally {
		for (const desktop of desktops) { if (!closed.has(desktop)) { await desktop.close(); } }
		await promisify(execFile)(daemon, ['stop'], { env: environment, windowsHide: true, timeout: 30_000 });
		await rm(directory, { recursive: true, force: true });
	}
});

test('authenticated Web cannot claim directory authority or read an ungranted workspace', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires the full Web product');
	const denial = await workbench.page.evaluate(async () => {
		const endpoint = new URL(sessionStorage.getItem('ash.appServer.endpoint')!);
		const token = sessionStorage.getItem(`ash.appServer.session:${endpoint.origin}`)!;
		const url = new URL('/ash/app-server', endpoint);
		url.protocol = 'ws:';
		return new Promise<unknown>((resolve, reject) => {
			const socket = new WebSocket(url, `ash-session.${token}`);
			const timeout = setTimeout(() => { socket.close(); reject(new Error('Authority check timed out')); }, 5_000);
			socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
				clientInfo: { name: 'untrusted-browser', version: '1' }, capabilities: { dirPermissionsHost: { version: 1 } },
			} }));
			socket.onmessage = event => {
				const response = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
				if (response.id === 1) { clearTimeout(timeout); socket.close(); resolve(response.error); }
			};
			socket.onerror = () => { clearTimeout(timeout); socket.close(); reject(new Error('Authority check connection failed')); };
		});
	});
	expect(denial).toMatchObject({ code: -32073 });
	const foreignRead = await workbench.page.evaluate(async () => {
		try {
			await globalThis.ashWebWorkbenchHost!.api.fs.readFile({ dirId: 'ungranted-workspace', path: 'secret.txt' });
			return 'allowed';
		} catch { return 'denied'; }
	});
	expect(foreignRead).toBe('denied');
});

test('Web opens a selected server folder with explicit authorization and a separate session', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires the connected Code browser');
	const page = workbench.page;
	const original = await page.evaluate(() => {
		const endpoint = new URL(sessionStorage.getItem('ash.appServer.endpoint')!);
		return {
			endpoint: endpoint.href,
			token: sessionStorage.getItem(`ash.appServer.session:${endpoint.origin}`)!,
			root: 'uri' in globalThis.ashWebWorkbenchHost!.workspace! ? globalThis.ashWebWorkbenchHost!.workspace!.uri.fsPath : '',
		};
	});
	const selectedDirectory = join(original.root, 'selected-web-workspace');
	await mkdir(selectedDirectory);
	await writeFile(join(selectedDirectory, 'selected.txt'), 'selected workspace\n');
	const denied = await page.request.post(new URL('/ash/workspace/open', original.endpoint).href, {
		headers: { Origin: new URL(original.endpoint).origin, Authorization: `Bearer ${original.token}` },
		data: { path: selectedDirectory, approved: false },
	});
	expect(denied.status()).toBe(403);
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).click();
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Open Folder...' }).click();
	const picker = page.getByRole('dialog', { name: 'Choose a server folder' });
	await picker.getByText(basename(selectedDirectory), { exact: true }).click();
	await picker.getByText('Select this folder', { exact: true }).click();
	await page.getByRole('dialog', { name: 'Authorize Server Folder' }).getByRole('button', { name: 'Open Folder' }).click();
	await page.waitForFunction(path => {
		const workspace = globalThis.ashWebWorkbenchHost?.workspace;
		return workspace && 'uri' in workspace && workspace.uri.fsPath === path;
	}, selectedDirectory);
	await workbench.waitForReady();
	const file = await page.evaluate(async path => {
		const host = globalThis.ashWebWorkbenchHost!;
		return host.api.fs.readFile({ dirId: host.workspace!.id, path });
	}, 'selected.txt');
	expect(file.content).toBe('selected workspace\n');
	const prior = await page.request.get(new URL('/ash/session', original.endpoint).href, {
		headers: { Origin: new URL(original.endpoint).origin, Authorization: `Bearer ${original.token}` },
	});
	expect(prior.status()).toBe(200);
	expect((await prior.json() as { workspaceRoot: string }).workspaceRoot).toBe(original.root);
});

test('built Web workbench reads workspace files and reconnects after reload', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires a browser App Server connection');
	const page = workbench.page;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) {
			await page.reload();
			await page.waitForFunction(() => globalThis.ashWebWorkbenchHost !== undefined);
		}
		const result = await page.evaluate(async path => {
			const host: IWebWorkbenchHost | undefined = globalThis.ashWebWorkbenchHost;
			if (!host?.workspace) throw new Error('Web workspace is unavailable');
			return host.api.fs.readFile({ dirId: host.workspace.id, path });
		}, relative(testWorkspace.directory, testWorkspace.file));
		expect(result.content).toBe('const value = 1;\n');
		expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/@vite/')))).toBe(false);
	}
});
