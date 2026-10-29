import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { simpleChatGPTModelCatalog } from '../../../fixtures/chatGPTModels.js';

/** Keep the actual history transport and UI, replacing only remote service I/O. */
async function installHistory(application: ElectronApplication): Promise<void> {
	await application.evaluate(
		async ({ app, session, webContents }, catalog) => {
			const fs = process.getBuiltinModule('fs/promises');
			const path = process.getBuiltinModule('path');
			const home = path.join(process.env.HOME!, '.codex');
			await fs.mkdir(home, { recursive: true });
			await fs.writeFile(
				path.join(home, 'auth.json'),
				JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-search-login' } }),
			);
			const installed = new WeakSet<Electron.Session>();
			const install = (storage: Electron.Session) => {
				if (installed.has(storage)) {
					return;
				}
				installed.add(storage);
				storage.protocol.handle(
					'https',
					() =>
						new Response('<!doctype html><title>Search fixture</title>', {
							headers: { 'Content-Type': 'text/html' },
						}),
				);
				storage.fetch = async input => {
					const url = new URL(
						typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
					);
					if (url.hostname !== 'chatgpt.com') {
						throw new Error('Unexpected search fixture origin');
					}
					if (url.pathname.endsWith('/models')) {
						return Response.json(catalog);
					}
					if (url.pathname.endsWith('/pins')) {
						return Response.json([]);
					}
					if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) {
						return Response.json({ items: [], cursor: null });
					}
					if (url.pathname.endsWith('/conversations')) {
						return Response.json({
							items: [{ id: 'history-one', title: 'First native history' }],
							total: 1,
						});
					}
					if (url.pathname.endsWith('/conversation/history-one')) {
						return Response.json({
							title: 'First native history',
							current_node: 'answer',
							mapping: {
								answer: {
									parent: null,
									message: {
										id: 'answer',
										author: { role: 'assistant' },
										content: { content_type: 'text', parts: ['History one answer'] },
									},
								},
							},
						});
					}
					throw new Error(`Unexpected search fixture path: ${url.pathname}`);
				};
			};
			install(session.defaultSession);
			for (const contents of webContents.getAllWebContents()) {
				install(contents.session);
			}
			app.on('session-created', install);
		},
		simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]),
	);
}

for (const locale of ['en', 'zh-CN'] as const) {
	test.describe(`Unified conversation search in ${locale}`, () => {
		test.use({ electronWindowMode: 'active' });
		test(
			'finds native conversations through Search and preserves sidebar groups',
			{ tag: ['@electron-ui', '@electron-app-server'] },
			async (
				{ application: initialApplication, workbench: initialWorkbench, target, restartWorkbench },
				testInfo,
			) => {
				let application = initialApplication as ElectronApplication;
				let workbench = initialWorkbench;
				if (locale === 'zh-CN') {
					await workbench.quickaccess.runCommand('workbench.action.configureLocale');
					const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
					await picker.getByRole('combobox').fill('简体中文');
					await picker.getByRole('combobox').press('Enter');
					const restarted = await restartWorkbench();
					application = restarted.application as ElectronApplication;
					workbench = restarted.workbench;
				}
				await installHistory(application);
				const page = await workbench.openAgentsWindow(target.kind);
				await page.locator('[data-action-id="sessions.newSession"] button').click();
				const sidebar = page.locator('.ash-chatgpt-navigation');
				await expect(sidebar.getByRole('button', { name: 'First native history', exact: true })).toBeVisible();
				await expect(sidebar.getByRole('searchbox')).toHaveCount(0);
				const recent = sidebar.getByRole('button', { name: locale === 'en' ? 'Recent' : '最近', exact: true });
				await recent.click();
				await expect(recent).toHaveAttribute('aria-expanded', 'false');
				const search = page.locator('[data-action-id="sessions.search"]').getByRole('button');
				await search.click();
				const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Search' : '搜索', exact: true });
				await expect(dialog.locator('.ash-sessions-search-body > h2')).toHaveCount(0);
				await expect(dialog.locator('.ash-sessions-search-footer kbd')).toHaveText(['Esc', '↑', '↓', '↵']);
				for (const keycap of await dialog.locator('.ash-sessions-search-footer kbd').all()) {
					await expect(keycap).toHaveCSS('box-shadow', 'none');
					await expect(keycap).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				}
				await dialog.getByRole('combobox').fill('First native');
				await expect(dialog.getByRole('option')).toHaveCount(1);
				await expect(dialog.getByRole('option')).toContainText('First native history');
				await expect(dialog.getByRole('option')).toContainText('ChatGPT');
				const categories = dialog.getByRole('toolbar', {
					name: locale === 'en' ? 'Search categories' : '搜索分类',
					exact: true,
				});
				await expect(categories).toHaveCSS('border-radius', '8px');
				for (const button of await categories.getByRole('button').all()) {
					await expect(button).toHaveCSS('height', '28px');
					await expect(button).toHaveCSS('border-radius', '8px');
					await expect(button).toHaveCSS('font-size', '14px');
				}
				await categories
					.getByRole('button', { name: locale === 'en' ? 'Sessions' : '会话', exact: true })
					.click();
				await expect(
					categories.getByRole('button', { name: locale === 'en' ? 'Sessions' : '会话', exact: true }),
				).toHaveAttribute('aria-pressed', 'true');
				await expect(dialog.getByRole('option')).toContainText('First native history');
				await expect(recent).toHaveAttribute('aria-expanded', 'false');
				await categories.evaluate(element =>
					Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)),
				);
				await testInfo.attach(`unified-conversation-search-${locale}`, {
					body: await page.screenshot(),
					contentType: 'image/png',
				});
				await page.keyboard.press('Escape');
				await expect(search).toBeFocused();
				await page.locator('[data-action-id="sessions.open.projects"] button').click();
				await expect(page.locator('.ash-chatgpt-widget')).toBeHidden();
				await search.click();
				const input = dialog.getByRole('combobox');
				await input.fill('First native');
				await input.press('Enter');
				await expect(dialog).toBeHidden();
				await expect(page.locator('.ash-chatgpt-widget')).toContainText('History one answer');
				await expect(
					page
						.locator('.ash-chatgpt-widget')
						.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT', exact: true }),
				).toBeFocused();
				await expect(recent).toHaveAttribute('aria-expanded', 'false');
			},
		);
	});
}
