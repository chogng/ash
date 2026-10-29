import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type {
	ExecutionSettingsSnapshot,
	IAgentExecutionSettingsService,
} from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { SandboxSettingsModel } from '../../browser/sandboxSettingsModel.js';

const remote = {
	connectionState: 'connected',
	onDidChangeConnection: Event.None,
	onDidChangeConnectionState: Event.None,
} as IAppServerRemoteAgentService;
const snapshot: ExecutionSettingsSnapshot = {
	revision: 12,
	settings: { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' },
};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('Sandbox settings save through the backend revision and preserve approval mode', async () => {
	let saved: unknown;
	using model = new SandboxSettingsModel(
		{
			onDidChange: Event.None,
			read: async () => snapshot,
			configure: async (settings, revision) => {
				saved = { settings, revision };
			},
		},
		remote,
	);
	assert.equal(model.categoryId, 'sandbox');
	model.setVisible(true);
	await tick();
	const network = model.fields.find(field => field.id === 'network')!;
	assert.equal(network.kind, 'select');
	if (network.kind === 'select') network.setValue('allowed');
	const save = model.fields.find(field => field.id === 'save')!;
	if (save.kind === 'action') {
		assert.equal(save.enabled, true);
		await save.run();
	}
	assert.deepEqual(saved, { settings: { ...snapshot.settings, commandNetworkAccess: 'allowed' }, revision: 12 });
});

test('Sandbox settings reject stale drafts and never retry a failed write', async () => {
	using changes = new Emitter<void>();
	let writes = 0;
	const execution: IAgentExecutionSettingsService = {
		onDidChange: changes.event,
		read: async () => snapshot,
		configure: async () => {
			writes++;
			throw new Error('revision conflict');
		},
	};
	using model = new SandboxSettingsModel(execution, remote);
	model.setVisible(true);
	await tick();
	const files = model.fields.find(field => field.id === 'files')!;
	if (files.kind === 'select') files.setValue('directoryWrite');
	let save = model.fields.find(field => field.id === 'save')!;
	if (save.kind === 'action') await save.run();
	assert.equal(writes, 1);
	save = model.fields.find(field => field.id === 'save')!;
	if (save.kind === 'action') {
		assert.equal(save.enabled, false);
		await save.run();
	}
	assert.equal(writes, 1);
	changes.fire();
	const status = model.fields.find(field => field.id === 'status')!;
	if (status.kind === 'status') assert.match(status.text, /Refresh/);
});

test('Sandbox settings ignore a read completed after leaving the page', async () => {
	const read = new DeferredPromise<ExecutionSettingsSnapshot>();
	using model = new SandboxSettingsModel(
		{
			onDidChange: Event.None,
			read: () => read.p,
			configure: async () => {
				throw new Error('must not write');
			},
		},
		remote,
	);
	model.setVisible(true);
	model.setVisible(false);
	await read.complete(snapshot);
	await tick();
	const files = model.fields.find(field => field.id === 'files')!;
	if (files.kind === 'select') assert.equal(files.enabled, false);
});

suite('sandboxSettings browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN'])
		for (const theme of ['light', 'dark', 'hc']) {
			test(`Chat Sandbox defaults preserve approval and effective policy in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto(`/extensions.html?locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashSandboxIntegration.open());
				expect(await page.evaluate(() => window.ashSandboxIntegration.location())).toEqual(['agents']);
				const root = page.locator('#sandbox-settings');
				const files = root.getByRole('combobox', {
					name: locale === 'en' ? 'Command file access' : '命令文件访问',
					exact: true,
				});
				const network = root.getByRole('combobox', {
					name: locale === 'en' ? 'Command network access' : '命令联网',
					exact: true,
				});
				await expect(network).toBeEnabled();
				await files.focus();
				await page.keyboard.press('Tab');
				await expect(network).toBeFocused();
				await network.press('Enter');
				await page.getByRole('option', { name: locale === 'en' ? 'Allowed' : '允许', exact: true }).click();
				const save = root.getByRole('button', {
					name: locale === 'en' ? 'Save sandbox defaults' : '保存沙箱默认值',
					exact: true,
				});
				await expect(save).toBeEnabled();
				await save.focus();
				await save.press('Enter');
				await expect
					.poll(() => page.evaluate(() => window.ashSandboxIntegration.snapshot()))
					.toEqual({
						revision: 2,
						settings: {
							approvalMode: 'auto',
							commandFileAccess: 'readOnly',
							commandNetworkAccess: 'allowed',
						},
					});
				await expect(save).toBeDisabled();
				await expect(root).toContainText(':readOnly');
				await expect(root).toContainText(locale === 'en' ? 'Managed host constraints' : '管理员宿主约束');
				await expect(root).toContainText(
					locale === 'en' ? 'Workbench terminals are separate' : '工作台终端使用独立路径',
				);
				await root.screenshot({ path: browserTests.info.outputPath('sandbox-settings.png') });
				expect(errors).toEqual([]);
			});
		}
});
