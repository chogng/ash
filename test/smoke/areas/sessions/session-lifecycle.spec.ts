import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS, type ModelRef } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

for (const locale of ['en', 'zh-CN']) {
	test(
		`Session first send uses one atomic root and restores drafts in ${locale}`,
		{ tag: ['@browser-app-server', '@electron-app-server'] },
		async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
			test.setTimeout(240_000);
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const language = workbench.page
					.getByRole('dialog', { name: 'Select Display Language' })
					.getByRole('combobox');
				await language.fill('简体中文');
				await language.press('Enter');
				({ application, workbench } = await restartWorkbench());
			}
			const copy =
				locale === 'zh-CN'
					? { code: '代码', picker: '选择聊天模型', auto: '自动', enable: '启用' }
					: { code: 'Code', picker: 'Choose a chat model', auto: 'Auto', enable: 'Enable' };
			const invokedModels: string[] = [];
			const modelServer = createServer(async (request, response) => {
				if (request.method === 'GET') {
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ data: [{ id: 'lifecycle-model' }] }));
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
				invokedModels.push(body.model);
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.end(
					'data: {"id":"lifecycle-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Isolated lifecycle answer"},"finish_reason":null}]}\n\ndata: {"id":"lifecycle-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				);
			});
			await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
			let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
			let page: Page | undefined;
			try {
				connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
				const { client } = connection;
				const address = modelServer.address();
				if (!address || typeof address === 'string') throw new Error('Lifecycle model fixture has no port');
				const provider = 'custom-session-lifecycle-fixture';
				const model: ModelRef = { provider, model: 'lifecycle-model' };
				const config = await client.request(APP_SERVER_METHODS['config/read'], {});
				await client.request(APP_SERVER_METHODS['provider/configure'], {
					commandId: 'lifecycle-provider',
					expectedRevision: config.revision,
					config: {
						connection: provider,
						provider,
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						custom: {
							name: 'Isolated lifecycle model',
							protocol: 'chatCompletions',
							order: 0,
							contextWindow: 272_000,
						},
						modelContext: { 'lifecycle-model': { contextWindow: 272_000 } },
					},
				});
				await client.request(APP_SERVER_METHODS['provider/apiKey/set'], {
					connection: provider,
					apiKey: 'isolated-fixture-key',
				});
				const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
				await client.request(APP_SERVER_METHODS['config/update'], {
					commandId: 'lifecycle-default',
					expectedRevision: configured.revision,
					model,
				});
				await workbench.settingsEditor.openUserSettingsUI();
				await workbench.settingsEditor.selectGroup('agents');
				await workbench.settingsEditor.selectCategory('models');
				const enabled = workbench.page.getByRole('switch', {
					name: `${copy.enable} ${model.model}`,
					exact: true,
				});
				if (!(await enabled.isChecked())) await enabled.press('Space');
				await expect(enabled).toBeChecked();
				await workbench.page.locator('.ash-modal-editor-close').click();

				let agentsWorkbench = workbench;
				if (target.kind === 'browser') {
					// Keep the independent verification connection in the original Workbench realm.
					const source = await workbench.page.context().newPage();
					await source.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
					agentsWorkbench = new Workbench(source);
					await agentsWorkbench.waitForReady();
				}
				page = await agentsWorkbench.openAgentsWindow(target.kind);
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: copy.code, exact: true })
					.click();
				await page.locator('[data-action-id="sessions.newSession"] button').click();
				const active = (): ReturnType<Page['locator']> =>
					page!.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
				const editor = new Editor(active());
				await editor.waitForEditorFocus();
				await editor.waitForTypeInEditor('Return the isolated lifecycle answer without using tools.');
				await active().locator('.ash-chat-input-model-action').press('ArrowDown');
				const picker = page.getByRole('dialog', { name: copy.picker, exact: true });
				const automatic = picker.getByRole('switch', { name: copy.auto, exact: true });
				if (await automatic.isChecked()) await automatic.press('Space');
				await expect(automatic).not.toBeChecked();
				const search = picker.getByRole('combobox');
				await search.fill(model.model);
				await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
				await search.press('Enter');
				await editor.waitForEditorFocus();
				await page.keyboard.press('Enter');
				await expect
					.poll(async () => (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions.length)
					.toBe(1);
				const created = (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions[0]!;
				// Inspect the product-created Session, not a fixture-created backend Session.
				expect(created.threads).toHaveLength(1);
				const root = created.threads[0]!;
				expect(root.parentThreadId).toBeFalsy();
				await expect(active()).toHaveAttribute('data-thread-id', root.threadId);
				await expect
					.poll(
						async () =>
							(
								await client.request(APP_SERVER_METHODS['session/thread/read'], {
									sessionId: created.sessionId,
									threadId: root.threadId,
								})
							).thread.turns.at(-1)?.status,
					)
					.toBe('completed');
				expect(invokedModels.length).toBeGreaterThan(0);
				expect(invokedModels.every(invoked => invoked === model.model)).toBe(true);
				await expect(active()).toContainText('Isolated lifecycle answer');

				await page.locator('[data-action-id="sessions.newSession"] button').click();
				const draftEditor = new Editor(active());
				await draftEditor.waitForEditorFocus();
				await draftEditor.waitForTypeInEditor('Keep this unsent lifecycle draft.');
				const draftId = await active().getAttribute('data-untitled-session-id');
				expect(draftId).toBeTruthy();
				page = await agentsWorkbench.reopenAgentsWindow(application, page);
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: copy.code, exact: true })
					.click();
				await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
				await new Editor(active()).waitForEditorContents(text => text === 'Keep this unsent lifecycle draft.');
				const readCatalog = async () =>
					(await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: created.sessionId }))
						.session;
				const persisted = await readCatalog();
				expect(persisted?.threads).toHaveLength(1);
				const durableRows = (): ReturnType<Page['locator']> =>
					page!
						.locator('.ash-sessions-list-item')
						.filter({ has: page!.locator('.ash-sessions-list-management:not([hidden])') });
				await expect(durableRows()).toHaveCount(1);
				await client.request(APP_SERVER_METHODS['session/request'], {
					commandId: 'lifecycle-archive',
					sessionId: created.sessionId,
					request: { type: 'archive' },
				});
				await expect.poll(async () => (await readCatalog())?.status).toBe('archived');
				await expect(durableRows()).toHaveCount(0);
				await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
				await new Editor(active()).waitForEditorContents(text => text === 'Keep this unsent lifecycle draft.');
				await client.request(APP_SERVER_METHODS['session/request'], {
					commandId: 'lifecycle-restore',
					sessionId: created.sessionId,
					request: { type: 'restore' },
				});
				await expect.poll(async () => (await readCatalog())?.status).toBe('active');
				await expect(durableRows()).toHaveCount(1);
				const restored = await readCatalog();
				expect(restored?.threads).toHaveLength(1);
				expect(restored?.threads[0]?.threadId).toBe(root.threadId);
				await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
				await client.request(APP_SERVER_METHODS['session/request'], {
					commandId: 'lifecycle-stop',
					sessionId: created.sessionId,
					request: { type: 'stop' },
				});
				await expect.poll(async () => (await readCatalog())?.status).toBe('archived');
				await expect(durableRows()).toHaveCount(0);
				await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
				await new Editor(active()).waitForEditorContents(text => text === 'Keep this unsent lifecycle draft.');
				await writeFile(
					testInfo.outputPath('lifecycle-evidence.json'),
					JSON.stringify(
						{
							locale,
							created: persisted,
							restored,
							stopped: await readCatalog(),
							invokedModels,
							restoredDraftId: draftId,
						},
						null,
						2,
					),
				);
				await page.screenshot({ path: testInfo.outputPath('restored-lifecycle.png') });
			} finally {
				try {
					await connection?.close();
				} finally {
					modelServer.closeAllConnections();
					await new Promise<void>(resolve => modelServer.close(() => resolve()));
				}
			}
		},
	);
}
