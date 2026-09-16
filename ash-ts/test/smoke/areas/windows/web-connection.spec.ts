import { expect, test } from '../../../automation/test.js';
import type { IWebWorkbenchHost } from '../../../../src/ash/workbench/browser/web.api.js';
import { join, relative } from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/common/sandboxTypes.js';
import { decodeAppServerServerRequestResult } from '../../../../src/ash/platform/app-server/common/generated/AppServerProtocolDecoder.js';
import type { Page } from '@playwright/test';

test('two desktops isolate browser targets and closing one preserves the other', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires the shared managed backend');
	const profile = process.env.ASH_PLAYWRIGHT_PROFILE;
	if (!profile) { throw new Error('Missing managed test profile'); }
	const directories: string[] = [];
	const desktops: Awaited<ReturnType<typeof launchElectron>>[] = [];
	const closed = new Set<Awaited<ReturnType<typeof launchElectron>>>();
	const hostCall = (page: Page, method: string, params: unknown) => page.evaluate(({ method, params }) => {
		return (globalThis as unknown as { ash: ISandboxGlobals }).ash.ipcRenderer.invoke(`ash:browser-host:${method}`, { id: crypto.randomUUID(), params });
	}, { method, params });
	try {
		for (let index = 0; index < 2; index++) {
			const directory = await mkdtemp(join(tmpdir(), 'ash-browser-owner-'));
			directories.push(directory);
			desktops.push(await launchElectron({ appServerMode: 'required', userDataDirectory: directory, profileDirectory: profile, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' }));
		}
		const first = desktops[0]!.driver.workbench.page;
		const second = desktops[1]!.driver.workbench.page;
		const created = decodeAppServerServerRequestResult('browser/create', await hostCall(second, 'create', { url: 'about:blank' }));
		await expect(second.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(1);
		await expect(first.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(0);
		const observe = { targetId: created.targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false };
		await expect(hostCall(first, 'observe', observe)).rejects.toThrow();
		await desktops[0]!.application.close();
		closed.add(desktops[0]!);
		const state = decodeAppServerServerRequestResult('browser/observe', await hostCall(second, 'observe', observe));
		expect(state.targetId).toBe(created.targetId);
		await second.reload();
		await desktops[1]!.driver.workbench.waitForReady();
		await expect.poll(() => desktops[1]!.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(view => 'webContents' in view).length)).toBe(0);
		await expect(hostCall(second, 'observe', observe)).rejects.toThrow();
	} finally {
		for (const desktop of desktops) { if (!closed.has(desktop)) { await desktop.application.close(); } }
		for (const directory of directories) { await rm(directory, { recursive: true, force: true }); }
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

test('Web and Electron share a managed backend and closing Electron preserves Web file access', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Requires the full Web product');
	const profile = process.env.ASH_PLAYWRIGHT_PROFILE;
	if (!profile) { throw new Error('The full Web test runner must provide its profile'); }
	const records = (await readdir(join(profile, 'run'))).filter(name => name.endsWith('.pid.json'));
	expect(records).toHaveLength(1);
	const record = join(profile, 'run', records[0]!);
	const before = JSON.parse(await readFile(record, 'utf8')) as { pid: number; instanceId: string };
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-shared-'));
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory, profileDirectory: profile, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const page = desktop.driver.workbench.page;
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) { await showSidebar.click(); }
		const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
		await expect(file).toHaveCount(1);
		await file.dblclick();
		await expect(page.locator('.stanza-editor')).toBeVisible();
		expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(before);
	} finally {
		await desktop?.application.close();
		await rm(userDataDirectory, { recursive: true, force: true });
	}
	const content = await workbench.page.evaluate(async () => {
		const host = globalThis.ashWebWorkbenchHost!;
		return host.api.fs.readFile({ dirId: host.workspace!.id, path: 'main.ts' });
	});
	expect(content.content).toBe('const value = 1;\n');
	expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(before);
});
