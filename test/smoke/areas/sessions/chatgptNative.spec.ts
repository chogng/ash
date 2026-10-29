import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import { simpleChatGPTModelCatalog } from '../../../fixtures/chatGPTModels.js';

declare global {
	var ashNativeFixture: { advance(): void; readonly sends: number };
}

/** Keep the production IPC, transport, verification asset and UI; replace only service I/O. */
async function installService(application: ElectronApplication): Promise<void> {
	await application.evaluate(
		async ({ app, session, webContents }, catalog) => {
			const fs = process.getBuiltinModule('fs/promises');
			const path = process.getBuiltinModule('path');
			const home = path.join(process.env.HOME!, '.codex');
			await fs.mkdir(home, { recursive: true });
			await fs.writeFile(
				path.join(home, 'auth.json'),
				JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-test-login' } }),
			);
			let sends = 0;
			let step = 0;
			let reply: ReadableStreamDefaultController<Uint8Array> | undefined;
			const message = (id: string, role: string, text: string) => ({
				id,
				author: { role },
				content: { content_type: 'text', parts: [text] },
			});
			const live: Record<string, { parent: string | null; message: ReturnType<typeof message> }> = {};
			let head: string | null = null;
			let userId = '';
			const chunk = (text: string) => {
				const id = `reply-live-${sends}`;
				live[id] = { parent: userId, message: message(id, 'assistant', text) };
				head = id;
				return new TextEncoder().encode(
					`data: ${JSON.stringify({ conversation_id: 'fixture-live', message: live[id]!.message })}\n\n`,
				);
			};
			globalThis.ashNativeFixture = {
				get sends() {
					return sends;
				},
				advance() {
					step++;
					reply!.enqueue(
						chunk(step === 1 ? 'First chunk, second chunk' : 'First chunk, second chunk, complete'),
					);
					if (step === 2) {
						// The server continuation can be a hidden leaf after the visible reply.
						const id = `leaf-${sends}`;
						live[id] = { parent: head, message: message(id, 'assistant', '') };
						head = id;
						reply!.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
						reply!.close();
					}
				},
			};
			const installed = new WeakSet<Electron.Session>();
			const install = (storage: Electron.Session) => {
				if (installed.has(storage)) {
					return;
				}
				installed.add(storage);
				storage.protocol.handle('https', request => {
					const url = new URL(request.url);
					if (url.hostname !== 'chatgpt.com') {
						return new Response(null, { status: 404 });
					}
					if (url.pathname === '/sentinel-fixture.js') {
						return new Response(
							'export const api = { finalizeChatRequirements: async () => ({ chatRequirementsToken: "synthetic-proof" }) };',
							{ headers: { 'Content-Type': 'text/javascript' } },
						);
					}
					return new Response(
						'<!doctype html><title>ChatGPT verification fixture</title><script type="module" src="/sentinel-fixture.js"></script>',
						{ headers: { 'Content-Type': 'text/html' } },
					);
				});
				storage.fetch = async (input, init) => {
					const url = new URL(
						typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
					);
					if (url.hostname !== 'chatgpt.com') {
						throw new Error('Unexpected fixture origin');
					}
					if (url.pathname.endsWith('/models')) {
						return Response.json(catalog);
					}
					if (url.pathname.endsWith('/pins')) {
						return Response.json([{ item: { id: 'history-pin', title: 'Pinned native history' } }]);
					}
					if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) {
						return Response.json({ items: [], cursor: null });
					}
					if (url.pathname.endsWith('/conversations')) {
						const items = [
							{ id: 'history-one', title: 'First native history' },
							{ id: 'history-two', title: 'Second native history' },
							...Array.from({ length: 30 }, (_, index) => ({
								id: `history-extra-${index}`,
								title: `Additional history ${index}`,
							})),
						];
						return Response.json({ items, total: items.length });
					}
					if (url.pathname.endsWith('/conversation/fixture-live')) {
						return Response.json({ title: 'Live fixture', current_node: head, mapping: live });
					}
					if (url.pathname.includes('/conversation/history-')) {
						const first = url.pathname.endsWith('history-one');
						return Response.json({
							title: first ? 'First native history' : 'Second native history',
							current_node: 'answer',
							mapping: {
								question: { parent: null, message: message('question', 'user', 'History question') },
								answer: {
									parent: 'question',
									message: message(
										'answer',
										'assistant',
										first ? 'History one answer' : 'History two answer',
									),
								},
							},
						});
					}
					if (url.pathname.endsWith('/prepare')) {
						return Response.json({ conduit_token: 'synthetic-conduit' });
					}
					if (url.pathname.endsWith('/stop_conversation')) {
						return Response.json({ success: true });
					}
					if (url.pathname === '/realtime/vp') {
						return Response.json({ error: 'Synthetic unavailable voice service' }, { status: 404 });
					}
					if (url.pathname.endsWith('/f/conversation') && init?.method === 'POST') {
						const request = JSON.parse(String(init.body));
						if (
							sends &&
							(request.conversation_id !== 'fixture-live' || request.parent_message_id !== head)
						) {
							return Response.json({ error: 'Wrong continuation' }, { status: 400 });
						}
						userId = request.messages[0].id;
						live[userId] = { parent: head, message: request.messages[0] };
						sends++;
						step = 0;
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									reply = controller;
									controller.enqueue(chunk('First chunk'));
								},
							}),
							{ headers: { 'Content-Type': 'text/event-stream' } },
						);
					}
					throw new Error(`Unexpected fixture path: ${url.pathname}`);
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
	test.describe(`ChatGPT entry in ${locale}`, () => {
		test.use({ electronWindowMode: 'active' });
		test(
			'opens by default, retains the existing login, streams followups and restores history and drafts',
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
				await installService(application);
				const page = await workbench.openAgentsWindow(target.kind);
				const commands = new QuickAccess(page);
				await expect(page.locator('[data-action-id="sessions.open.chatgpt"]')).toHaveCount(0);
				await expect(page.locator('[data-action-id="sessions.newSession"] button')).toHaveAttribute(
					'aria-current',
					'page',
				);
				const editor = page.locator('.ash-chatgpt-widget');
				await expect(editor).toBeVisible();
				await expect(page.locator('.ash-chat2-editor, .ash-web-bridge')).toHaveCount(0);
				const input = editor.getByRole('textbox', {
					name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT',
					exact: true,
				});
				const composer = new Editor(editor);
				await expect(input).toBeEditable();
				await composer.waitForEditorFocus();
				await composer.waitForTypeInEditor('Hello from native UI');
				await editor.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
				const answer = editor.locator('.ash-chatgpt-turn.assistant').last();
				await expect(answer).toContainText('First chunk');
				await expect(
					editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true }),
				).toBeVisible();
				await page
					.locator('[data-action-id="sessions.newSession"]')
					.getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true })
					.click();
				await expect(answer).toContainText('First chunk');
				await expect(editor).toBeVisible();
				expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(1);
				await application.evaluate(() => globalThis.ashNativeFixture.advance());
				await expect(answer).toContainText('First chunk, second chunk');
				await application.evaluate(() => globalThis.ashNativeFixture.advance());
				await expect(answer).toContainText('First chunk, second chunk, complete');
				await composer.waitForEditorContents(text => text.trim() === '');
				await expect(
					editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true }),
				).toBeHidden();
				await expect(editor.locator('.ash-chatgpt-error')).toBeHidden();
				for (const mode of ['complete', 'stop', 'voice-recovery'] as const) {
					if (mode === 'voice-recovery') {
						await page.evaluate(() => {
							// A synthetic microphone keeps this failure-path test independent of hardware.
							const context = new AudioContext();
							const stream = context.createMediaStreamDestination().stream;
							navigator.mediaDevices.getUserMedia = async () => stream.clone();
							window.addEventListener(
								'pagehide',
								() => {
									void context.close();
								},
								{ once: true },
							);
						});
						await editor
							.getByRole('button', {
								name: locale === 'en' ? 'Voice conversation' : '语音对话',
								exact: true,
							})
							.click();
						await expect(editor.locator('.ash-chatgpt-error')).toContainText('404');
						await expect(
							editor.getByRole('button', {
								name: locale === 'en' ? 'Stop voice conversation' : '停止语音对话',
								exact: true,
							}),
						).toHaveCount(0);
					}
					await composer.waitForEditorFocus();
					await composer.waitForTypeInEditor(`Follow up after ${mode}`);
					await editor.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
					const count = mode === 'complete' ? 2 : mode === 'stop' ? 3 : 4;
					await expect(editor.locator('.ash-chatgpt-turn.assistant')).toHaveCount(count);
					await expect(answer).toContainText('First chunk');
					if (mode === 'stop') {
						await editor
							.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true })
							.click();
					} else {
						await application.evaluate(() => globalThis.ashNativeFixture.advance());
						await application.evaluate(() => globalThis.ashNativeFixture.advance());
						await expect(answer).toContainText('First chunk, second chunk, complete');
					}
					await expect(
						editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true }),
					).toBeHidden();
					await expect(editor.locator('.ash-chatgpt-error')).toBeHidden();
					await composer.waitForEditorContents(text => text.trim() === '');
				}
				const history = page.locator('.ash-chatgpt-navigation');
				await expect(
					history.getByRole('button', { name: locale === 'en' ? 'New chat' : '新聊天', exact: true }),
				).toHaveCount(0);
				await history.getByRole('button', { name: 'First native history', exact: true }).click();
				await expect(editor).toContainText('History one answer');
				await composer.waitForEditorFocus();
				await composer.waitForTypeInEditor('Draft in first history');
				await history.getByRole('button', { name: 'Second native history', exact: true }).click();
				await expect(editor).toContainText('History two answer');
				await expect(editor).not.toContainText('History one answer');
				await history.getByRole('button', { name: 'First native history', exact: true }).click();
				await expect(editor).toContainText('History one answer');
				await composer.waitForEditorContents(text => text === 'Draft in first history');
				await page
					.locator('[data-action-id="sessions.newSession"]')
					.getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true })
					.click();
				await expect(editor.locator('.ash-chatgpt-turn')).toHaveCount(0);
				await composer.waitForEditorContents(text => text.trim() === '');
				await composer.waitForEditorFocus();
				await expect(editor).toBeVisible();
				await composer.waitForTypeInEditor('Independent new chat draft');
				await history.getByRole('button', { name: 'First native history', exact: true }).click();
				await expect(editor).toContainText('History one answer');
				await composer.waitForEditorContents(text => text === 'Draft in first history');
				await page
					.locator('[data-action-id="sessions.newSession"]')
					.getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true })
					.click();
				await expect(editor.locator('.ash-chatgpt-turn')).toHaveCount(0);
				await composer.waitForEditorContents(text => text === 'Independent new chat draft');
				await history.getByRole('button', { name: 'First native history', exact: true }).click();
				await input.focus();
				await page.keyboard.press('Alt+F1');
				await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
					locale === 'en'
						? /Use New at the top of the sidebar to start a chat/u
						: /使用侧栏顶部的“新建”开始聊天/u,
				);
				await page.keyboard.press('Escape');
				await testInfo.attach(`chatgpt-entry-${locale}`, {
					body: await page.screenshot(),
					contentType: 'image/png',
				});
				const pinned = history.locator('[data-group="pinned"] .ash-pane-view-header-button');
				await pinned.click();
				await expect(pinned).toHaveAttribute('aria-expanded', 'false');
				const retainedHistory = await history.elementHandle();
				const viewport = history.locator('.ash-scrollbar-viewport').first();
				const pages = [
					{ action: 'sessions.open.projects', content: '.ash-projects' },
					{ action: 'sessions.open.creator', content: '.ash-creator-home' },
					{ action: 'sessions.open.customize', content: '.ash-customize' },
				];
				for (const entry of pages) {
					await viewport.evaluate(element => {
						element.scrollTop = 96;
					});
					await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(96);
					await page.locator(`[data-action-id="${entry.action}"] button`).click();
					await expect(page.locator(entry.content)).toBeVisible();
					await expect(editor).toBeHidden();
					await expect(history).toBeVisible();
					expect(await history.evaluate((element, retained) => element === retained, retainedHistory)).toBe(
						true,
					);
					await expect(pinned).toHaveAttribute('aria-expanded', 'false');
					await expect(
						history.getByRole('button', { name: 'First native history', exact: true }),
					).toHaveAttribute('aria-current', 'page');
					await expect(viewport).toHaveJSProperty('scrollTop', 96);
					if (entry.action === 'sessions.open.creator') {
						await page
							.locator('.ash-creator-home')
							.getByRole('button', { name: locale === 'en' ? 'Design' : '设计', exact: true })
							.click();
						await expect(page.locator('.ash-sessions-design-view')).toBeVisible();
						await expect(history).toBeVisible();
						expect(
							await history.evaluate((element, retained) => element === retained, retainedHistory),
						).toBe(true);
					}
					await history.getByRole('button', { name: 'First native history', exact: true }).click();
					await expect(editor).toBeVisible();
					await composer.waitForEditorContents(text => text === 'Draft in first history');
					await composer.waitForEditorFocus();
				}
				await retainedHistory!.dispose();
				await page
					.locator('.ash-window-mode-control')
					.getByRole('button', { name: locale === 'en' ? 'Code' : '代码', exact: true })
					.click();
				await expect(editor).toBeHidden();
				await commands.runCommand('sessions.open.chatgpt');
				await expect(editor).toContainText('History one answer');
				await composer.waitForEditorContents(text => text === 'Draft in first history');
				expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(4);
				let restored = await workbench.reopenAgentsWindow(application, page);
				await expect(restored.locator('.ash-chatgpt-widget')).toContainText('History one answer');
				await expect(restored.locator('[data-action-id="sessions.open.chatgpt"]')).toHaveCount(0);
				await expect(restored.locator('[data-action-id="sessions.newSession"] button')).toHaveAttribute(
					'aria-current',
					'page',
				);
				for (const entry of pages) {
					await restored.locator(`[data-action-id="${entry.action}"] button`).click();
					restored = await workbench.reopenAgentsWindow(application, restored);
					await expect(restored.locator(entry.content)).toBeVisible();
					const restoredHistory = restored.locator('.ash-chatgpt-navigation');
					await expect(restoredHistory).toBeVisible();
					await expect(
						restoredHistory.locator('[data-group="pinned"] .ash-pane-view-header-button'),
					).toHaveAttribute('aria-expanded', 'false');
					await expect(
						restoredHistory.getByRole('button', { name: 'First native history', exact: true }),
					).toHaveAttribute('aria-current', 'page');
					await restoredHistory.getByRole('button', { name: 'First native history', exact: true }).click();
					await expect(restored.locator('.ash-chatgpt-widget')).toContainText('History one answer');
					await new Editor(restored.locator('.ash-chatgpt-widget')).waitForEditorFocus();
				}
				expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(4);
			},
		);
	});
}
