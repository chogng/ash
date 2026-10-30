import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from '../../../automation/playwrightElectron.js';

// Own these launches to assert fatal diagnostics and verify launcher cleanup.
for (const failure of ['HTTP 404', 'request failed', 'service worker'] as const) {
	test(`webview diagnostics interrupt preview loading after ${failure}`, { tag: '@electron-app-server' }, async ({ }, testInfo) => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-webview-'));
		try {
			const workspace = join(directory, 'workspace');
			await mkdir(workspace);
			await writeFile(join(workspace, 'preview.md'), '# Webview diagnostics\n');
			const desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: workspace, workspacePermissions: 'development' });
			try {
				const { workbench, diagnostics } = desktop.driver;
				const page = workbench.page;
				if (failure === 'service worker') {
					// Fail the real bootstrap's registration call so its production error
					// message, rather than a synthetic console event, reaches diagnostics.
					await page.context().addInitScript(() => {
						if (location.protocol === 'ash-webview:') {
							navigator.serviceWorker.register = () => Promise.reject(new Error('intentional webview registration failure'));
						}
					});
				} else {
					await desktop.application.evaluate(({ protocol }, failure) => {
						protocol.unhandle('ash-webview');
						protocol.handle('ash-webview', () => failure === 'HTTP 404' ? new Response(null, { status: 404 }) : Response.error());
					}, failure);
				}
				await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'preview.md' }).dblclick();
				const expected = failure === 'service worker'
					? /Webview bootstrap failed Error: intentional webview registration failure/u
					: failure === 'HTTP 404' ? /Webview bootstrap request failed: HTTP 404 ash-webview:/u : /Webview bootstrap request failed: net::ERR_FAILED ash-webview:/u;
				await assert.rejects(diagnostics.waitFor(async () => {
					await workbench.quickaccess.runCommand('markdown.reopenAsPreview');
					const preview = workbench.editors.groupAt(0).content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
					await expect(preview.getByRole('heading', { name: 'Webview diagnostics', exact: true })).toBeVisible();
				}), expected);
				expect(diagnostics.errors).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
				if (failure !== 'service worker') {
					expect(diagnostics.resourceErrors).toHaveLength(1);
					expect(diagnostics.resourceErrors[0]).not.toContain('?');
					expect(diagnostics.resourceErrors[0]).not.toContain('#');
				}
				// An earlier fatal error must prevent even an immediately completing action.
				let continued = false;
				await assert.rejects(diagnostics.waitFor(async () => { continued = true; }), expected);
				expect(continued).toBe(false);
				await testInfo.attach('expected-webview-failure', { body: JSON.stringify(diagnostics.errors), contentType: 'application/json' });
			} finally {
				await desktop.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
