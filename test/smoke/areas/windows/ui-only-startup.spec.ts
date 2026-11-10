import { expect, test } from '../../../automation/test.js';
import type { Page } from '@playwright/test';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import { NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL, NATIVE_HOST_OPEN_WINDOW_CHANNEL } from '../../../../src/ash/platform/native/common/nativeHost.js';

test.use({ openWorkspace: false });


test('Electron Workbench and Agents open without preparing the App Server package', { tag: ['@electron-ui'] }, async ({ workbench, target, runningApplication }) => {
	const applicationMenu = workbench.page.getByRole('menuitem', { name: 'Application menu', exact: true });
	await expect(applicationMenu).toHaveCount(process.platform === 'darwin' ? 0 : 1);
	await expect(workbench.page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button')).toBeVisible();
	await expect(workbench.page.getByRole('region', { name: 'Editor', exact: true })).toBeVisible();
	const agents = await workbench.openAgentsWindow(target.kind);
	await expect(agents.locator('.ash-sessions-window[aria-busy="false"]')).toBeVisible();
	expect(runningApplication.diagnostics.errors).toEqual([]);
});

test('An Agents window only accepts empty workspaces on its own connection', { tag: ['@electron-ui'] }, async ({ workbench, target }) => {
	const invoke = (page: Page, channel: string, args?: unknown) => page.evaluate(({ channel, args }) => {
		const bridge = (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer;
		return bridge.invoke(channel, args);
	}, { channel, args });
	const workspace = (page: Page) => invoke(page, 'ash:workspace:context:read');
	const openRemote = async (remoteAuthority: string) => {
		const [page] = await Promise.all([
			workbench.page.context().waitForEvent('page'),
			invoke(workbench.page, NATIVE_HOST_OPEN_WINDOW_CHANNEL, { remoteAuthority }),
		]);
		await expect(page.getByRole('region', { name: 'Editor', exact: true })).toBeVisible();
		expect(await workspace(page)).toMatchObject({ remoteAuthority, folders: [] });
		return page;
	};
	const authority = 'ssh+agents-workspace-test';
	const original = await openRemote(authority);
	const [agents] = await Promise.all([
		original.context().waitForEvent('page'),
		invoke(original, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL),
	]);
	await expect(agents.locator('.ash-sessions-window[aria-busy="false"]')).toBeVisible();
	const initial = await workspace(agents);
	expect(initial).toMatchObject({ remoteAuthority: authority, folders: [] });

	await invoke(workbench.page, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL);
	expect(await workspace(agents)).toEqual(initial);
	const otherRemote = await openRemote('ssh+agents-workspace-other');
	await invoke(otherRemote, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL);
	expect(await workspace(agents)).toEqual(initial);

	const sameRemote = await openRemote(authority);
	const next = await workspace(sameRemote);
	expect(next).not.toEqual(initial);
	await invoke(sameRemote, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL);
	expect(await workspace(agents)).toEqual(next);
	expect(await workbench.openAgentsWindow(target.kind)).toBe(agents);
});
