import { expect, test } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { DialogRequest } from '../../../../src/ash/platform/dialogs/common/dialogs.js';

for (const locale of ['en', 'zh-CN']) {
	test.describe(`directory permission presentation (${locale})`, () => {
		test.use({ openWorkspace: false, electronUserSettings: { 'workbench.locale': locale } });
		test('Desktop IPC scopes the IDE permission prompt to the IDE and preserves folder details', { tag: ['@electron-ui'] }, async ({ workbench }) => {
			const prompts = await workbench.page.evaluate(async () => {
				const bridge = (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer;
				const remote = await bridge.invoke('ash:host:directoryPermissionPrompt', {
					path: '/synthetic/remote-project', remoteHostLabel: 'Build\n\n# environment `one`',
				}) as DialogRequest;
				const local = await bridge.invoke('ash:host:directoryPermissionPrompt', { path: '/synthetic/local-project' }) as DialogRequest;
				let rejected = false;
				try { await bridge.invoke('ash:host:directoryPermissionPrompt', { path: '/synthetic/remote-project', remoteHostLabel: 42 }); }
				catch { rejected = true; }
				return { remote, local, rejected };
			});
			expect(prompts.rejected).toBe(true);
			expect(prompts.remote.detail).toContain(locale === 'zh-CN' ? '远程环境：Build # environment `one`' : 'Remote environment: Build # environment `one`');
			expect(prompts.remote.detail).toContain(locale === 'zh-CN' ? '文件夹：/synthetic/remote-project' : 'Folder: /synthetic/remote-project');
			expect(prompts.remote.detail).toContain(locale === 'zh-CN' ? '此选择控制 Ash 对该环境中此文件夹的访问权限' : 'This choice controls Ash access to this folder in that environment');
			expect(prompts.local.detail).toContain(locale === 'zh-CN' ? '受限模式下可编辑和保存文件' : 'You can edit and save files in Restricted Mode');
			expect(prompts.local.detail).toContain('/synthetic/local-project');
			const agents = await workbench.openAgentsWindow('electron');
			await expect(agents.evaluate(() => {
				const bridge = (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer;
				return bridge.invoke('ash:host:directoryPermissionPrompt', { path: '/synthetic/local-project' });
			})).rejects.toThrow(/Untrusted renderer IPC sender/);
		});
	});
}
