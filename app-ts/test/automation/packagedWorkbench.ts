import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type ConsoleMessage, type TestInfo } from '@playwright/test';
import { launchElectron } from './playwrightElectron.js';

/** Verify file and terminal operations through the delivered application's own backend. */
export async function exercisePackagedWorkbench(installation: string, version: string, userDataDirectory: string, workspaceDirectory: string, saved: string, testInfo: TestInfo, stage: string): Promise<void> {
	const packagedBundle = process.platform === 'darwin' ? join(installation, 'Ash.app') : installation;
	const desktop = await test.step(`${stage}: launch delivered application`, () => launchElectron({ packagedBundle, appServerMode: 'required', userDataDirectory, workspaceDirectory, workspacePermissions: 'development' }));
	const page = desktop.driver.workbench.page;
	const errors: string[] = [];
	const consoleErrors: string[] = [];
	const onPageError = (error: Error): void => { errors.push(error.message); };
	const onConsole = (message: ConsoleMessage): void => { if (message.type() === 'error') consoleErrors.push(message.text()); };
	page.on('pageerror', onPageError);
	page.on('console', onConsole);
	let failed = false;
	try {
		await page.context().tracing.start({ snapshots: true, sources: true });
		try {
			expect(await desktop.application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version });
			const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
			if (await showSidebar.isVisible()) await showSidebar.click();
			const row = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
			await expect(row).toHaveCount(1, { timeout: 30_000 });
			await row.dblclick();
			const input = desktop.driver.workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
			await input.focus();
			await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
			await input.type(saved);
			await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
			await expect.poll(() => readFile(join(workspaceDirectory, 'main.ts'), 'utf8'), { timeout: 30_000 }).toBe(saved);
			const showPanel = page.getByRole('button', { name: 'Show Panel', exact: true });
			if (await showPanel.isVisible()) await showPanel.click();
			const terminal = page.locator('.ash-terminal-instance:visible').first();
			await expect(terminal).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
			await terminal.locator('.xterm-helper-textarea').focus();
			await page.keyboard.type('echo ash-release-ready');
			await page.keyboard.press('Enter');
			// Match a complete output row; the prompt's echoed command cannot satisfy this assertion.
			await expect(terminal.locator('.xterm-rows > div').filter({ hasText: /^ash-release-ready\s*$/ })).toHaveCount(1, { timeout: 30_000 });
			await page.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
			expect(errors).toEqual([]);
		} catch (error) {
			failed = true;
			await testInfo.attach(`${stage}-diagnostics`, { body: JSON.stringify({ errors, console: consoleErrors, dom: await page.locator('body').innerText() }, null, 2), contentType: 'application/json' });
			throw error;
		} finally {
			if (failed) {
				const path = testInfo.outputPath(`${stage}-trace.zip`);
				await page.context().tracing.stop({ path });
				await testInfo.attach(`${stage}-trace`, { path, contentType: 'application/zip' });
			} else await page.context().tracing.stop();
		}
	} finally {
		page.off('pageerror', onPageError);
		page.off('console', onConsole);
		await test.step(`${stage}: stop delivered backend`, () => desktop.close());
	}
}
