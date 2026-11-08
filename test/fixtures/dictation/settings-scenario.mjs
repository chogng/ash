import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import fixtures from './dictation.json' with { type: 'json' };
import { startDictationFixtureServer } from './server.ts';

const workspacePath = mkdtempSync(join(tmpdir(), 'ash-dictation-scenario-'));
const server = await startDictationFixtureServer(true);
server.unref();
server.on('connection', socket => socket.unref());
process.env.ASH_DEV_APP_SERVER_RELOAD = '1';
process.env.ASH_DEV_DICTATION_CATALOG = join(import.meta.dirname, 'dictation.json');

const modelId = 'dictation-fixture-5mb';
const secondModelId = 'dictation-fixture-8mb';
let models, row, secondRow, modelRoot;
const installButton = () => row.getByRole('button', { name: '安装', exact: true });
const uninstallButton = () => row.getByRole('button', { name: '卸载', exact: true });
const downloadProgress = modelRow => modelRow.getByRole('button', { name: /^正在下载 [1-9]\d?%$/u });
const marker = (id = modelId) => join(modelRoot, id, 'dictation-model.json');

export default {
	id: 'dictation-dev-settings',
	title: 'Opt-in development dictation models can be downloaded, selected and removed independently',
	scenarioPath: import.meta.filename,
	workspacePath,
	extraArgs: ['--agents-window'],
	userSettings: { 'workbench.locale': 'zh-CN', 'dictation.backend': 'local', 'dictation.model': fixtures[0].id },
	stepPauseMs: 0,
	steps: [
		{
			id: 'SETTINGS',
			title: 'List the replacement catalog in Settings',
			async run({ app, page, workbench }) {
				const profile = await app.evaluate(() => process.env.ASH_HOME);
				expect(profile).toMatch(/ash-scenario-/u);
				modelRoot = join(profile, 'dictation-models');
				await workbench.quickaccess.runCommand('workbench.action.openSettings');
				const settings = page.getByRole('dialog', { name: '设置', exact: true });
				await settings.getByRole('button', { name: '语音', exact: true }).click();
				models = settings.getByRole('group', { name: '本地听写模型' });
				await expect(models.locator('tr[data-model-id]')).toHaveCount(fixtures.length);
				row = models.locator(`tr[data-model-id="${modelId}"]`);
				secondRow = models.locator(`tr[data-model-id="${secondModelId}"]`);
				await expect(row.getByRole('rowheader')).toContainText(modelId);
				await expect(secondRow.getByRole('rowheader')).toContainText(secondModelId);
				await expect(row.getByRole('cell', { name: '4.8 MiB', exact: true })).toBeVisible();
				await expect(secondRow.getByRole('cell', { name: '7.6 MiB', exact: true })).toBeVisible();
				for (const { id } of fixtures) {
					await expect(models.locator(`tr[data-model-id="${id}"]`).getByRole('button', { name: '安装', exact: true })).toBeEnabled();
				}
				expect(existsSync(marker())).toBe(false);
				expect(existsSync(marker(secondModelId))).toBe(false);
				return 'Voice settings lists exactly the replacement catalog entries with their declared sizes.';
			},
		},
		{
			id: 'CANCEL',
			title: 'Retry after HTTP 503 and cancel the transfer',
			async run() {
				await installButton().click();
				await expect(row).toContainText('HTTP 503', { timeout: 10000 });
				await installButton().click();
				await expect(downloadProgress(row)).toBeVisible({ timeout: 12000 });
				await row.getByRole('button', { name: '取消', exact: true }).click();
				await expect(installButton()).toBeEnabled();
				expect(existsSync(marker())).toBe(false);
				expect(existsSync(join(modelRoot, `.${modelId}.installing`))).toBe(false);
				return 'The failure was visible, and cancellation removed staging and made Install available again.';
			},
		},
		{
			id: 'INSTALL',
			title: 'Download both models concurrently and verify both packages',
			async run() {
				await installButton().click();
				await secondRow.getByRole('button', { name: '安装', exact: true }).click();
				await Promise.all([
					expect(downloadProgress(row)).toBeVisible({ timeout: 12000 }),
					expect(downloadProgress(secondRow)).toBeVisible({ timeout: 12000 }),
				]);
				expect(existsSync(marker())).toBe(false);
				expect(existsSync(marker(secondModelId))).toBe(false);
				await expect(uninstallButton()).toBeEnabled({ timeout: 40000 });
				expect(existsSync(marker())).toBe(true);
				await expect(secondRow.getByRole('button', { name: '卸载', exact: true })).toBeEnabled({ timeout: 40000 });
				expect(existsSync(marker(secondModelId))).toBe(true);
				expect(readFileSync(join(modelRoot, secondModelId, 'tokens.txt'), 'utf8').split('\n')[1]).toBe('第二个听写测试。 1');
				return 'Both downloads were verified and published to separate directories.';
			},
		},
		{
			id: 'SELECT',
			title: 'Switch the active dictation model to the 8 MB fixture',
			async run({ page }) {
				const selector = models.getByRole('combobox', { name: '听写模型', exact: true });
				await expect(selector).toHaveText(modelId);
				await selector.press('Enter');
				await expect(page.getByRole('option', { name: modelId, exact: true })).toBeVisible();
				await page.getByRole('option', { name: secondModelId, exact: true }).click();
				await expect(selector).toHaveText(secondModelId);
				await expect(secondRow.getByText('已就绪', { exact: true })).toHaveCSS('clip-path', 'inset(50%)');
				await expect(row.getByText('已安装', { exact: true })).toBeAttached();
				return 'Both options have distinct accessible names, and selecting the 8 MB fixture makes it ready.';
			},
		},
		{
			id: 'UNINSTALL',
			title: 'Uninstall the 5 MB fixture while keeping the 8 MB fixture active',
			async run({ page }) {
				await uninstallButton().click();
				const dialog = page.getByRole('dialog').filter({ hasText: `卸载 ${modelId}？` });
				await dialog.getByRole('button', { name: '卸载', exact: true }).click();
				await expect(installButton()).toBeEnabled();
				expect(existsSync(marker())).toBe(false);
				expect(existsSync(marker(secondModelId))).toBe(true);
				await expect(models.getByRole('combobox', { name: '听写模型', exact: true })).toHaveText(secondModelId);
				server.close();
				return 'The 5 MB fixture became downloadable again and the 8 MB fixture stayed installed and selected.';
			},
		},
	],
};
