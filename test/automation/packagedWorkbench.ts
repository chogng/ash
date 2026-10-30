import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type TestInfo } from '@playwright/test';
import { launchElectron } from './playwrightElectron.js';
import type { ElectronLaunchOptions } from './electron.js';

/** Verify editing, terminal and webview resources through the delivered application's own backend. */
export async function exercisePackagedWorkbench(
	installation: string,
	version: string,
	userDataDirectory: string,
	workspaceDirectory: string,
	saved: string,
	testInfo: TestInfo,
	stage: string,
	options?: Pick<ElectronLaunchOptions, 'environment' | 'homeDirectory'>,
): Promise<void> {
	const packagedBundle = process.platform === 'darwin' ? join(installation, 'Ash.app') : installation;
	await writeFile(join(workspaceDirectory, 'sanity-preview.md'), '# Release webview\n\n![Release image](./sanity%20image.svg)\n');
	await writeFile(join(workspaceDirectory, 'sanity image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="green"/></svg>');
	const attachBackendLogs = async (): Promise<void> => {
		const logs = join(userDataDirectory, 'profile', 'run');
		for (const entry of await readdir(logs, { withFileTypes: true }).catch(() => [])) {
			if (entry.isFile() && entry.name.endsWith('.log')) {
				await testInfo.attach(`${stage}-app-server-${entry.name}`, {
					path: join(logs, entry.name),
					contentType: 'text/plain',
				});
			}
		}
	};
	const desktop = await test.step(`${stage}: launch delivered application`, async () => {
		try {
			return await launchElectron({
				...options,
				packagedBundle,
				appServerMode: 'required',
				startupTimeout: 60_000,
				userDataDirectory,
				workspaceDirectory,
				workspacePermissions: 'development',
			});
		} catch (error) {
			await attachBackendLogs();
			throw error;
		}
	});
	const page = desktop.driver.workbench.page;
	const diagnostics = desktop.driver.diagnostics;
	let failed = false;
	try {
		await page.context().tracing.start({ snapshots: true, sources: true });
		try {
			expect(
				await desktop.application.evaluate(({ app }) => ({
					packaged: app.isPackaged,
					version: app.getVersion(),
				})),
			).toEqual({ packaged: true, version });
			const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
			if (await showSidebar.isVisible()) await showSidebar.click();
			const row = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
			await expect(row).toHaveCount(1, { timeout: 30_000 });
			await row.dblclick();
			const editor = desktop.driver.workbench.editors.groupAt(0).editor;
			await editor.waitForEditorFocus();
			await editor.input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
			// Use the shared editor driver: one text insertion followed by a rendered-content
			// checkpoint keeps package lifecycle acceptance independent of typing throughput.
			await editor.waitForTypeInEditor(saved);
			await editor.waitForEditorContents(contents => contents === saved);
			await editor.input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
			await expect
				.poll(() => readFile(join(workspaceDirectory, 'main.ts'), 'utf8'), { timeout: 30_000 })
				.toBe(saved);
			const terminal = page.locator('.ash-terminal-instance:visible').first();
			if (!(await terminal.isVisible()))
				await page.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
			await expect(terminal).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
			await terminal.locator('.xterm-helper-textarea').focus();
			await page.keyboard.type('echo ash-release-ready');
			await page.keyboard.press('Enter');
			// Match a complete output row; the prompt's echoed command cannot satisfy this assertion.
			await expect(
				terminal.locator('.xterm-rows > div').filter({ hasText: /^ash-release-ready\s*$/ }),
			).toHaveCount(1, { timeout: 30_000 });
			await page.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
			// An upgrade baseline may predate preview support. Exercise the candidate's
			// packaged bootstrap, extension scripts and workspace resources on each launch.
			if (stage !== 'previous') {
				await test.step(`${stage}: render packaged Markdown and a workspace image`, () => diagnostics.waitFor(async () => {
					await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'sanity-preview.md' }).dblclick();
					const source = desktop.driver.workbench.editors.groupAt(0);
					await source.editor.waitForEditorContents(contents => contents.includes('# Release webview'));
					await source.title.locator('[data-action-id="markdown.reopenAsPreview"] button').click();
					const preview = source.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
					await expect(preview.getByRole('heading', { name: 'Release webview', exact: true })).toBeVisible();
					await expect.poll(() => preview.getByRole('img', { name: 'Release image', exact: true }).evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 24, height: 16 });
					await expect.poll(() => preview.locator('body').evaluate(body => body.ownerDocument.readyState)).toBe('complete');
				}));
			}
			expect(diagnostics.errors).toEqual([]);
		} catch (error) {
			failed = true;
			await attachBackendLogs();
			await testInfo.attach(`${stage}-diagnostics`, {
				body: JSON.stringify(
					{
						pageErrors: diagnostics.pageErrors,
						consoleErrors: diagnostics.consoleErrors,
						resourceErrors: diagnostics.resourceErrors,
						dom: await page.locator('body').innerText(),
					},
					null,
					2,
				),
				contentType: 'application/json',
			});
			throw error;
		} finally {
			if (failed) {
				const path = testInfo.outputPath(`${stage}-trace.zip`);
				await page.context().tracing.stop({ path });
				await testInfo.attach(`${stage}-trace`, { path, contentType: 'application/zip' });
			} else await page.context().tracing.stop();
		}
	} finally {
		await test.step(`${stage}: stop delivered backend`, () => (failed ? desktop.close() : desktop.quit()));
	}
}
