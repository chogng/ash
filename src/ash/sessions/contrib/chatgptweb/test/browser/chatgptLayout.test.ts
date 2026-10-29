import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { expect, type Page } from '@playwright/test';
import { expectVisibleFocusOutline } from '../../../../../../../test/fixtures/browser/focusOutline.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('chatgptweb browser component', () => {
	const browserTests = useBrowserTests();

	async function fillMessage(page: Page, text: string): Promise<void> {
		const input = page.getByRole('textbox', { name: /^(Ask ChatGPT|询问 ChatGPT)$/u });
		await input.focus();
		await input.press('ControlOrMeta+a');
		await page.keyboard.insertText(text);
		await expectDraft(page, text);
	}

	async function expectDraft(page: Page, text: string): Promise<void> {
		await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.draft())).toBe(text);
	}

	/** Exercise the actual page and client with synthetic HTTP boundaries, without a real account. */
	async function mockChatGPTRequests(page: Page, answer = 'Synthetic answer'): Promise<void> {
		await page.route('**/service/**', async route => {
			const path = new URL(route.request().url()).pathname;
			const message = (id: string, role: string, text: string): object => ({
				id,
				author: { role },
				content: { content_type: 'text', parts: [text] },
			});
			if (path.endsWith('/models')) {
				await route.fulfill({ json: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]) });
			} else if (path.endsWith('/pins')) {
				await route.fulfill({ json: [] });
			} else if (path.endsWith('/gizmos/snorlax/sidebar')) {
				await route.fulfill({ json: { items: [], cursor: null } });
			} else if (path.endsWith('/conversations')) {
				await route.fulfill({
					json: { items: [{ id: 'fixture-chat', title: 'Synthetic conversation' }], total: 1 },
				});
			} else if (path.endsWith('/conversation/fixture-chat')) {
				await route.fulfill({
					json: {
						title: 'Synthetic conversation',
						current_node: 'previous-reply',
						mapping: {
							question: { parent: null, message: message('question', 'user', 'Synthetic question') },
							empty: { parent: 'question', message: message('empty', 'assistant', '') },
							recap: {
								parent: 'empty',
								message: {
									id: 'recap',
									author: { role: 'assistant' },
									content: { content_type: 'reasoning_recap', content: 'Thought for a few seconds' },
								},
							},
							whitespace: { parent: 'recap', message: message('whitespace', 'assistant', ' \n\t ') },
							'previous-reply': {
								parent: 'whitespace',
								message: message('previous-reply', 'assistant', answer),
							},
						},
					},
				});
			} else if (path.endsWith('/prepare')) {
				await route.fulfill({ json: { conduit_token: 'fixture-conduit' } });
			} else if (path.includes('/.headers/')) {
				await route.fulfill({ json: { 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-verification' } });
			} else {
				await route.fulfill({ status: 500, json: {} });
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT group hover fills follow list inset changes (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${locale === 'en' ? 'light' : 'hcDark'}`);
			const list = page.locator('.ash-chatgpt-navigation-list');
			const header = list.locator('.ash-pane-view-header').first();
			await expect(header).toBeVisible();
			const expectInsets = async (inset: number): Promise<void> => {
				await expect
					.poll(() =>
						header.evaluate(node => {
							const bounds = node.getBoundingClientRect();
							const list = node.closest('.ash-chatgpt-navigation-list')!.getBoundingClientRect();
							return { left: bounds.left - list.left, right: list.right - bounds.right };
						}),
					)
					.toEqual({ left: inset, right: inset });
			};
			await expectInsets(8);
			await list.evaluate(node => {
				node.style.paddingInline = '12px';
			});
			await expectInsets(12);
			await list.evaluate(node => node.style.removeProperty('padding-inline'));
			await expectInsets(8);
			await header.hover();
			await expect(header).toHaveCSS('border-radius', '8px');
		});

		test(`ChatGPT history and conversation show independent skeletons (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			let releaseHistory!: () => void;
			const history = new Promise<void>(resolve => {
				releaseHistory = resolve;
			});
			await page.route('**/service/backend-api/conversations?*', async route => {
				await history;
				await route.fallback();
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const navigation = page.locator('.ash-chatgpt-navigation');
			const editor = page.locator('.ash-chatgpt-widget');
			try {
				await expect(navigation.locator('.ash-sessions-loading')).toBeVisible();
				await expect(editor.locator('.ash-sessions-loading')).toBeHidden();
				await expect(editor.locator('.ash-chatgpt-welcome')).toBeVisible();
			} finally {
				releaseHistory();
			}
			const conversation = navigation.getByRole('button', { name: 'Synthetic conversation', exact: true });
			await expect(conversation).toBeVisible();
			await expect(navigation.locator('.ash-sessions-loading')).toBeHidden();
			let releaseConversation!: () => void;
			const pending = new Promise<void>(resolve => {
				releaseConversation = resolve;
			});
			await page.route('**/service/backend-api/conversation/fixture-chat', async route => {
				await pending;
				await route.fallback();
			});
			try {
				await conversation.click();
				await expect(editor.locator('.ash-sessions-loading')).toBeVisible();
				await expect(navigation.locator('.ash-sessions-loading')).toBeHidden();
				await expect(conversation).toBeEnabled();
				await expect(editor.locator('.ash-chatgpt-welcome')).toBeHidden();
				await page.screenshot({ path: browserTests.info.outputPath(`chat-independent-loading-${locale}.png`) });
			} finally {
				releaseConversation();
			}
			await expect(editor.locator('.ash-chatgpt-messages')).toContainText('Synthetic answer');
			await expect(editor.locator('.ash-sessions-loading')).toBeHidden();
		});

		test(`ChatGPT conversations load more on scroll and keyboard navigation (${locale})`, async function () {
			const { page } = browserTests;

			// Keep the first page outside the prefetch threshold until navigation scrolls it.
			await page.setViewportSize({ width: 1000, height: 400 });
			await mockChatGPTRequests(page);
			const offsets: number[] = [];
			let releasePage: (() => Promise<void>) | undefined;
			await page.route('**/service/backend-api/conversations?*', async route => {
				const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
				offsets.push(offset);
				const fulfill = () =>
					route.fulfill({
						json: {
							items: Array.from({ length: 20 }, (_, index) => ({
								id: `chat-${offset + index}`,
								title: `Conversation ${offset + index}`,
							})),
							total: 60,
						},
					});
				if (offset === 20) {
					releasePage = fulfill;
				} else {
					await fulfill();
				}
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const list = page.locator('.ash-chatgpt-navigation-list');
			const items = list.locator('.ash-chatgpt-conversation:visible');
			const viewport = page.locator('.ash-chatgpt-navigation-scrollable > .ash-scrollbar-viewport');
			await expect(items).toHaveCount(20);
			await expect(page.getByRole('button', { name: /^(Load more|加载更多)$/ })).toHaveCount(0);
			expect(offsets).toEqual([0]);
			await items.last().focus();
			await expect(list).toHaveAttribute('aria-busy', 'true');
			await list.hover();
			await page.mouse.wheel(0, 1000);
			await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
			const scrollTop = await viewport.evaluate(element => element.scrollTop);
			expect(offsets).toEqual([0, 20]);
			await releasePage!();
			await expect(items).toHaveCount(40);
			await expect(items.nth(19)).toBeFocused();
			expect(await viewport.evaluate(element => element.scrollTop)).toBe(scrollTop);
			await items.nth(19).press('End');
			await expect(items).toHaveCount(60);
			await expect(items.nth(39)).toBeFocused();
			await items.nth(39).press('End');
			await list.hover();
			await page.mouse.wheel(0, 1000);
			await expect(list).toHaveAttribute('aria-busy', 'false');
			expect(offsets).toEqual([0, 20, 40]);
		});
	}

	test('ChatGPT floating conversation actions preserve keyboard focus outlines across themes and directions', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await mockChatGPTRequests(page);
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			await page.goto(`/chatgptNavigation.html?locale=zh-CN&theme=${theme}`);
			const row = page.locator('.ash-chatgpt-navigation-row[data-conversation="fixture-chat"]');
			const title = row.locator('.ash-chatgpt-conversation');
			await expect(title).toBeVisible();
			for (const direction of ['ltr', 'rtl']) {
				await page.locator('#navigation').evaluate((element, dir) => {
					element.setAttribute('dir', dir);
				}, direction);
				await page.keyboard.press('Tab');
				await title.focus();
				await title.hover();
				await expect(row.getByRole('toolbar')).toHaveCSS('opacity', '1');
				await testInfo.attach(`conversation-focused-${theme}-${direction}`, {
					body: await row.screenshot(),
					contentType: 'image/png',
				});
				await expectVisibleFocusOutline(title);
				await row.getByRole('toolbar').getByRole('button').first().click({ trial: true });
				await page.keyboard.press('Tab');
				await expect(row.getByRole('toolbar').getByRole('button').first()).toBeFocused();
			}
		}
	});

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`ChatGPT conversations use the shared scrollbar without a sidebar search field (${theme})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.setViewportSize({ width: 1000, height: 600 });
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route =>
				route.fulfill({
					json: {
						items: Array.from({ length: 40 }, (_, index) => ({
							id: `chat-${index}`,
							title: `Conversation ${index} ${'long title '.repeat(8)}`,
						})),
						total: 40,
					},
				}),
			);
			await page.goto(`/chatgptNavigation.html?locale=zh-CN&theme=${theme}`);
			const list = page.locator('.ash-chatgpt-navigation-list');
			await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(40);
			const scrollable = page.locator('.ash-chatgpt-navigation-scrollable');
			const viewport = scrollable.locator(':scope > .ash-scrollbar-viewport');
			const scrollbar = scrollable.getByRole('scrollbar', { name: 'Vertical scrollbar' });
			await expect(scrollbar).toHaveAttribute('aria-disabled', 'false');
			expect(await viewport.evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe('none');
			expect(await list.evaluate(element => getComputedStyle(element).overflowY)).toBe('visible');
			await expect(page.locator('.ash-chatgpt-navigation').getByRole('searchbox')).toHaveCount(0);
			await list.hover();
			await page.mouse.wheel(0, 300);
			await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			await expect(scrollbar).toHaveCSS('opacity', '1');
			const thumb = scrollbar.locator('.ash-scrollbar-thumb');
			expect(await thumb.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
			const geometry = await viewport.evaluate(element => ({
				width: element.clientWidth,
				contentWidth: element.scrollWidth,
			}));
			expect(geometry.contentWidth).toBe(geometry.width);
			await scrollbar.focus();
			await scrollbar.press('End');
			await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(0);
			await testInfo.attach(`chatgpt-sidebar-scrollbar-${theme}`, {
				body: await page.locator('#navigation').screenshot(),
				contentType: 'image/png',
			});
		});
	}

	test('ChatGPT conversation pagination fills the viewport after resize and pauses while collapsed', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 1000, height: 400 });
		await mockChatGPTRequests(page);
		const offsets: number[] = [];
		await page.route('**/service/backend-api/conversations?*', async route => {
			const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
			offsets.push(offset);
			const count = offset === 0 ? 2 : 20;
			await route.fulfill({
				json: {
					items: Array.from({ length: count }, (_, index) => ({
						id: `chat-${offset + index}`,
						title: `Conversation ${offset + index}`,
					})),
					total: 42,
				},
			});
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const list = page.locator('.ash-chatgpt-navigation-list');
		await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(22);
		expect(offsets).toEqual([0, 2]);
		const recent = list.getByRole('button', { name: '最近', exact: true });
		await recent.click();
		await page.setViewportSize({ width: 1000, height: 1600 });
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		await expect(recent).toHaveAttribute('aria-expanded', 'false');
		await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(0);
		expect(offsets).toEqual([0, 2]);
		await page.setViewportSize({ width: 1000, height: 400 });
		await recent.click();
		await page.setViewportSize({ width: 1000, height: 1600 });
		await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(42);
		expect(offsets).toEqual([0, 2, 22]);
	});

	test('ChatGPT conversation pagination retries a failure only after another scroll', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 1000, height: 400 });
		await mockChatGPTRequests(page);
		const offsets: number[] = [];
		await page.route('**/service/backend-api/conversations?*', async route => {
			const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
			offsets.push(offset);
			if (offset > 0 && offsets.length === 2) {
				await route.fulfill({ status: 500, json: {} });
				return;
			}
			await route.fulfill({
				json: {
					items: Array.from({ length: 20 }, (_, index) => ({
						id: `chat-${offset + index}`,
						title: `Conversation ${offset + index}`,
					})),
					total: 40,
				},
			});
		});
		await page.goto('/chatgptNavigation.html?locale=en');
		const list = page.locator('.ash-chatgpt-navigation-list');
		await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(20);
		await list.hover();
		await page.mouse.wheel(0, 2000);
		await expect(page.locator('.ash-chatgpt-error')).toBeVisible();
		await expect(list).toHaveAttribute('aria-busy', 'false');
		expect(offsets).toEqual([0, 20]);
		await page.mouse.wheel(0, -100);
		await page.mouse.wheel(0, 200);
		await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(40);
		expect(offsets).toEqual([0, 20, 20]);
	});

	async function chatPage(page: Page, answer = 'Synthetic answer'): Promise<void> {
		await mockChatGPTRequests(page, answer);
		await page.goto('/chatgptNavigation.html');
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
		await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
		await expect(page.locator('.ash-chatgpt-turn.assistant')).toHaveCount(1);
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT model picker matches the two families and five product presets in ${locale}`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await mockChatGPTRequests(page);
			const catalog = chatGPTModelCatalog(locale);
			const labels = locale === 'en' ? ['Instant', 'Medium', 'High', 'Extra High', 'Pro'] : ['即时', '中', '高', '极高', 'Pro'];
			await page.route('**/service/backend-api/models?*', route => route.fulfill({ json: catalog }));
			const submitted: { model: string; thinking_effort?: string }[] = [];
			await page.route('**/service/backend-api/f/conversation/prepare', async route => {
				submitted.push(route.request().postDataJSON());
				await route.fulfill({ json: { conduit_token: 'fixture' } });
			});
			await page.route('**/service/backend-api/f/conversation', async route => {
				submitted.push(route.request().postDataJSON());
				await route.fulfill({
					contentType: 'text/event-stream',
					body: 'data: {"message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Reply"]}}}\n\ndata: [DONE]\n\n',
				});
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=light`);
			const picker = page.locator('.ash-sessions-model-picker');
			const openModels = async (): Promise<void> => {
				await picker.click();
				await page.getByRole('button', { name: locale === 'en' ? 'Choose model' : '选择模型', exact: true }).click();
			};
			await expect(picker).toHaveText(labels[0]!);
			await openModels();
			await expect(page.getByRole('menuitemradio')).toHaveText(['GPT-6', 'GPT-5.6 Sol']);
			await testInfo.attach('chatgpt-model-families', {
				body: await page.getByRole('menu').screenshot(),
				contentType: 'image/png',
			});
			const popupId = await page.getByRole('menu').getAttribute('id');
			await page.getByRole('menuitemradio', { name: 'GPT-6', exact: true }).click();
			await expect(page.getByRole('dialog')).toHaveAttribute('id', popupId!);
			await page.keyboard.press('Escape');
			const expected = [
				['gpt-6-instant', undefined],
				['gpt-6-thinking', 'standard'],
				['gpt-6-thinking', 'extended'],
				['gpt-6-thinking', 'max'],
				['gpt-6-pro', undefined],
			] as const;
			for (let index = 0; index < labels.length; index++) {
				await picker.click();
				const slider = page.getByRole('slider');
				await expect(slider).toHaveAttribute('max', '4');
				await slider.press('Home');
				for (let step = 0; step < index; step++) {
					await slider.press('ArrowRight');
				}
				await expect(slider).toHaveAttribute('aria-valuetext', labels[index]!);
				await expect(picker).toHaveText(labels[index]!);
				await expect(page.locator('.ash-sessions-model-picker-track')).toHaveAttribute('data-emphasized', String(index === 4));
				if (index === 4) {
					await expect(page.locator('.ash-sessions-model-picker-maximum-effects')).toHaveCSS('opacity', '1');
					await expect
						.poll(() =>
							page
								.locator('.ash-sessions-model-picker-maximum-effects')
								.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length),
						)
						.toBeGreaterThan(1);
					await testInfo.attach('chatgpt-pro', {
						body: await page.getByRole('dialog').screenshot(),
						contentType: 'image/png',
					});
				}
				if (index === 3) {
					await testInfo.attach('chatgpt-extra-high', {
						body: await page.getByRole('dialog').screenshot(),
						contentType: 'image/png',
					});
				}
				await page.keyboard.press('Escape');
				await fillMessage(page, `Use ${labels[index]}`);
				await page.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
				await expect.poll(() => submitted.length).toBe((index + 1) * 2);
				expect(submitted.slice(-2).map(body => [body.model, body.thinking_effort])).toEqual([expected[index], expected[index]]);
				if (expected[index]![1] === undefined) {
					expect(submitted.slice(-2).every(body => !('thinking_effort' in body))).toBe(true);
				}
				await expect(picker).toBeEnabled();
			}
			await openModels();
			await page.getByRole('menuitemradio', { name: 'GPT-5.6 Sol', exact: true }).click();
			await expect(picker).toHaveText('Pro');
			await expect(page.getByRole('dialog')).toBeVisible();
			await page.getByRole('slider').press('ArrowLeft');
			await expect(picker).toHaveText(labels[3]!);
			await page.keyboard.press('Escape');
			await fillMessage(page, 'Use GPT-5.6 Sol Extra High');
			await page.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
			await expect.poll(() => submitted.length).toBe(12);
			expect(submitted.slice(-2).map(body => [body.model, body.thinking_effort])).toEqual([
				['gpt-5-6-thinking', 'max'],
				['gpt-5-6-thinking', 'max'],
			]);
		});

		test(`ChatGPT model picker submits the selected catalog model and hides unknown thinking capabilities in ${locale}`, async function () {
			const { page } = browserTests;

			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/models?*', route =>
				route.fulfill({
					json: simpleChatGPTModelCatalog([
						{ slug: 'fixture', title: 'Fixture model' },
						{ slug: 'second', title: 'Second model' },
					]),
				}),
			);
			let submitted: string | undefined;
			await page.route('**/service/backend-api/f/conversation/prepare', async route => {
				submitted = route.request().postDataJSON().model;
				await route.fulfill({ status: 500, json: {} });
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=light`);
			const picker = page.locator('.ash-sessions-model-picker');
			await expect(picker).toBeEnabled();
			await picker.click();
			await expect(page.getByRole('slider')).toHaveCount(0);
			await expect(page.getByRole('menuitemradio', { name: 'Fixture model' })).toHaveAttribute('aria-checked', 'true');
			await expect(page.getByRole('menu')).toBeFocused();
			await page.keyboard.press('End');
			await page.keyboard.press('Enter');
			await expect(picker).toHaveText('Second model');
			await expect(picker).toBeFocused();
			await picker.click();
			await expect(page.getByRole('menuitemradio', { name: 'Second model' })).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('Escape');
			await fillMessage(page, 'Use the selected model');
			await page.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
			await expect.poll(() => submitted).toBe('second');
		});

		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			test(`ChatGPT startup focus stays in the editor through loading in ${locale} ${theme}`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await mockChatGPTRequests(page);
				let releaseCatalog!: () => Promise<void>;
				await page.route('**/service/backend-api/models?*', route => {
					releaseCatalog = () =>
						route.fulfill({
							json: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]),
						});
				});
				await page.goto(`/chatgptNavigation.html?focus=1&locale=${locale}&theme=${theme}`);
				const composer = page.locator('.ash-chatgpt-composer');
				const input = composer.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT' });
				const model = composer.locator('.ash-sessions-model-picker');
				await expect(input).toBeFocused();
				await expect(input).toBeDisabled();
				await expect(composer).toHaveCSS('outline-style', 'none');
				await expect(composer.locator('.stanza-editor')).toHaveCSS('outline-style', 'none');
				await page.keyboard.insertText('Ignored while loading');
				await expectDraft(page, '');
				await expect.poll(() => typeof releaseCatalog).toBe('function');
				await releaseCatalog();
				await expect(input).toBeEnabled();
				await expect(input).toBeFocused();
				await page.keyboard.insertText('Ready to type');
				await expectDraft(page, 'Ready to type');
				await composer.locator('.view-line').click();
				await expect(composer).toHaveCSS('outline-style', 'none');
				await input.press('Tab');
				await expect(model).toBeFocused();
				await expect(model).toHaveCSS('outline-style', 'solid');
				await expect(model).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
				await page.keyboard.press('Shift+Tab');
				await expect(input).toBeFocused();
				await testInfo.attach('composer-ready-focus', {
					body: await page.screenshot(),
					contentType: 'image/png',
				});
			});

			test(`ChatGPT composer grows from one line and retains inline controls in ${locale} ${theme}`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await mockChatGPTRequests(page);
				await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${theme}`);
				const composer = page.locator('.ash-chatgpt-composer');
				const input = composer.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT' });
				const editor = composer.locator('.ash-chat-input-editor');
				const model = composer.getByRole('button', {
					name: locale === 'en' ? 'Choose model: Fixture model' : '选择模型：Fixture model',
				});
				const send = composer.locator('.ash-chatgpt-send');
				await expect(input).toBeEnabled();
				await expect(editor).toHaveCSS('height', '20px');
				await expect(composer).toHaveCSS('border-radius', '9999px');
				await expect(model).toHaveCSS('border-radius', '9999px');
				await expect(send).toHaveCSS('border-radius', '9999px');
				await expect(send.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'voice-mode');
				const bounds = await composer.boundingBox();
				expect(bounds!.height).toBeLessThanOrEqual(50);
				const modelBounds = await model.boundingBox();
				const sendBounds = await send.boundingBox();
				expect(modelBounds!.y).toBe(sendBounds!.y);
				await page.mouse.move(1, 1);
				const restingShadow = await composer.evaluate(element => getComputedStyle(element).boxShadow);
				const activeShadow = `color(srgb 0 0 0 / ${theme === 'light' ? '0.0482353' : '0.12'}) 0px 2px 8px 0px`;
				await fillMessage(page, 'A short prompt');
				await expectDraft(page, 'A short prompt');
				await expect(send).toHaveAttribute('aria-label', locale === 'en' ? 'Send' : '发送');
				await expect(send.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'arrow-up');
				await expect(editor).toHaveCSS('height', '20px');
				if (!theme.startsWith('hc')) {
					await expect(composer).toHaveCSS('box-shadow', activeShadow);
				} else {
					await expect(composer).toHaveCSS('box-shadow', 'none');
					await expect(composer).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
				}
				await input.press('Tab');
				await expect(model).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(send).toBeFocused();
				await page.keyboard.press('Shift+Tab');
				await page.keyboard.press('Shift+Tab');
				await expect(input).toBeFocused();
				await input.press('End');
				await input.press('Shift+Enter');
				await page.keyboard.insertText('Another line');
				await expectDraft(page, 'A short prompt\nAnother line');
				await expect(editor).toHaveCSS('height', '40px');
				await fillMessage(page, 'Long prompt that wraps automatically. '.repeat(20));
				await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(40);
				await page.setViewportSize({ width: 580, height: 600 });
				for (const control of [editor, model, send]) {
					const controlBounds = await control.boundingBox();
					const composerBounds = await composer.boundingBox();
					expect(controlBounds!.x).toBeGreaterThanOrEqual(composerBounds!.x);
					expect(controlBounds!.x + controlBounds!.width).toBeLessThanOrEqual(composerBounds!.x + composerBounds!.width);
				}
				await expect(input).toBeFocused();
				await fillMessage(page, Array.from({ length: 30 }, (_, index) => `Line ${index}`).join('\n'));
				await expect(editor).toHaveCSS('height', '240px');
				await fillMessage(page, 'Hi');
				await expect(editor).toHaveCSS('height', '20px');
				await page.mouse.move(1, 1);
				await page.locator('.ash-chatgpt-navigation .ash-pane-view-header-button').first().focus();
				await expect.poll(() => composer.evaluate(element => getComputedStyle(element).boxShadow)).toBe(restingShadow);
				await composer.hover();
				if (!theme.startsWith('hc')) {
					await expect(composer).toHaveCSS('box-shadow', activeShadow);
				}
				await input.focus();
				await page.mouse.move(1, 1);
				await expect(input).toBeFocused();
				await expect(editor).toHaveCSS('height', '20px');
				await page.emulateMedia({ reducedMotion: 'reduce' });
				await expect(composer).toHaveCSS('transition-duration', '0s');
				if (locale === 'zh-CN' && theme === 'light') {
					await page.setViewportSize({ width: 1280, height: 800 });
					await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
					await expect(page.locator('.ash-chatgpt-turn.assistant')).toHaveCount(1);
					await input.focus();
					await testInfo.attach('chatgpt-single-line-composer', {
						body: await page.screenshot(),
						contentType: 'image/png',
					});
				}
			});
		}
	}

	test('ChatGPT sidebar and editor share drafts and selection with keyboard navigation and independent sizing', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversations?**', route =>
			route.fulfill({
				json: {
					items: [
						{ id: 'fixture-chat', title: 'Synthetic conversation' },
						...Array.from({ length: 30 }, (_, index) => ({
							id: `recent-${index}`,
							title: `Recent conversation ${index + 1} with a long title that stays inside the sidebar`,
						})),
					],
					total: 31,
				},
			}),
		);
		await page.goto('/chatgptNavigation.html');
		const sidebar = page.locator('.ash-chatgpt-navigation');
		const list = sidebar.getByRole('navigation', { name: '会话', exact: true });
		const viewport = sidebar.locator('.ash-chatgpt-navigation-scrollable > .ash-scrollbar-viewport');
		const conversation = sidebar.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await expect(conversation).toBeEnabled();
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		await expect(sidebar.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
		await conversation.focus();
		await conversation.press('Home');
		await expect(conversation).toBeFocused();
		await conversation.press('Enter');
		await expect(page.locator('.ash-chatgpt-messages')).toContainText('Synthetic answer');
		await expect(page.locator('.ash-chatgpt-turn.assistant')).toHaveCount(1);
		await expect(conversation).toHaveAttribute('aria-current', 'page');
		const input = page.getByRole('textbox', { name: '询问 ChatGPT' });
		await fillMessage(page, 'Sidebar switch keeps this draft');
		await page.evaluate(() => window.ashChatGPTIntegration.newChat());
		await expectDraft(page, '');
		await conversation.click();
		await expectDraft(page, 'Sidebar switch keeps this draft');
		await expect(sidebar.getByRole('searchbox')).toHaveCount(0);
		await expect(sidebar.locator('details')).toHaveCount(0);
		await viewport.evaluate(element => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(sidebar.locator('.ash-chatgpt-conversation').last()).toBeInViewport();
		await viewport.evaluate(element => {
			element.scrollTop = 0;
		});
		await testInfo.attach('chatgpt-restored-web-ui', { body: await page.screenshot(), contentType: 'image/png' });
		const before = await page.locator('#editor').boundingBox();
		await page.locator('#navigation').evaluate(element => {
			element.style.width = '400px';
		});
		await expect.poll(async () => (await page.locator('#editor').boundingBox())!.width).toBe(before!.width - 100);
		await expectDraft(page, 'Sidebar switch keeps this draft');
		await testInfo.attach('chatgpt-sidebar-and-editor', {
			body: await page.screenshot(),
			contentType: 'image/png',
		});
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT execution history groups each turn and keeps failures visible (${locale})`, async function () {
			const { page } = browserTests;

			await mockChatGPTRequests(page);
			const message = (id: string, role: string, text: string, extra = {}) => ({
				id,
				author: { role, name: role === 'tool' ? 'GitHub.fetch_file' : undefined },
				content: { parts: [text] },
				...extra,
			});
			const messages = [
				message('user-one', 'user', 'First question'),
				message('call-one', 'assistant', '{"path":"README.md"}', { recipient: 'GitHub.fetch_file' }),
				message('result-one', 'tool', 'File unavailable', { status: 'failed' }),
				message('answer-one', 'assistant', 'The file was unavailable'),
				message('user-two', 'user', 'Second question'),
				message('call-two', 'assistant', '{"path":"package.json"}', { recipient: 'GitHub.fetch_file' }),
				message('answer-two', 'assistant', 'Package answer'),
			];
			await page.route('**/service/backend-api/conversation/fixture-chat', route =>
				route.fulfill({
					json: {
						title: 'Synthetic conversation',
						current_node: 'answer-two',
						mapping: Object.fromEntries(messages.map((message, index) => [message.id, { parent: messages[index - 1]?.id, message }])),
					},
				}),
			);
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
			const activities = page.locator('.ash-chatgpt-activity');
			await expect(activities).toHaveCount(2);
			await expect(activities.locator(':scope > summary').first()).toHaveText(locale === 'en' ? 'Execution process · Some steps failed' : '执行过程 · 部分步骤失败');
			await expect(activities.locator(':scope > summary').last()).toHaveText(locale === 'en' ? 'Execution process · 1 step' : '执行过程 · 1 个步骤');
			await expect(page.locator('.ash-chatgpt-message-body')).toHaveText(['First question', 'The file was unavailable', 'Second question', 'Package answer']);
			await expect(page.locator('.ash-chatgpt-activity[open]')).toHaveCount(0);
			await activities.first().locator(':scope > summary').click();
			const result = activities.first().locator('.ash-chatgpt-activity-entry').last();
			await result.locator('summary').click();
			await expect(result.locator('pre')).toHaveText('File unavailable');
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
			test(`ChatGPT execution activity stays in one row and collapses when answering (${locale}, ${theme})`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await page.addInitScript(() => {
					const fetcher = globalThis.fetch.bind(globalThis);
					globalThis.fetch = async (input, init) => {
						if (String(input) !== '/service/backend-api/f/conversation') {
							return fetcher(input, init);
						}
						return new Response(
							new ReadableStream({
								start(controller) {
									Reflect.set(globalThis, 'pushExecution', (message: unknown) =>
										controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ conversation_id: 'fixture-chat', message })}\n\n`)),
									);
									Reflect.set(globalThis, 'endExecution', () => {
										controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
										controller.close();
									});
								},
							}),
							{ headers: { 'Content-Type': 'text/event-stream' } },
						);
					};
				});
				await mockChatGPTRequests(page);
				await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${theme}`);
				await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
				await expect(page.locator('.ash-chatgpt-message-body').last()).toHaveText('Synthetic answer');
				await fillMessage(page, 'Read the repository');
				await page.getByRole('button', { name: /^(Send|发送)$/, exact: true }).click();
				await expect.poll(() => page.evaluate(() => typeof Reflect.get(globalThis, 'pushExecution'))).toBe('function');
				const push = (value: unknown) => page.evaluate(message => Reflect.get(globalThis, 'pushExecution')(message), value);
				const call = (id: string, text: string) => ({
					id,
					author: { role: 'assistant' },
					recipient: 'GitHub.fetch_file',
					content: { content_type: 'code', text },
				});
				const raw = '{"path":"README.md","args":{"text":"<img src=x onerror=alert(1)>"}}';
				await push(call('call-one', raw));
				const activity = page.locator('.ash-chatgpt-activity');
				const summary = activity.locator(':scope > summary');
				await expect(activity).toHaveCount(1);
				await expect(summary).toContainText(locale === 'en' ? 'Using GitHub.fetch_file' : '正在使用 GitHub.fetch_file');
				await expect(activity).not.toHaveAttribute('open');
				await summary.evaluate(element => {
					Reflect.set(element, 'retainedExecutionSummary', true);
				});
				await summary.focus();
				await summary.press('Enter');
				await expect(activity).toHaveAttribute('open');
				const entry = activity.locator('.ash-chatgpt-activity-entry').first();
				await entry.locator('summary').focus();
				await entry.locator('summary').press('Space');
				await expect(entry.locator('pre')).toHaveText(raw);
				await expect(activity.locator('img')).toHaveCount(0);
				await push(call('call-one', raw + ' '));
				await expect(entry.locator('summary')).toBeFocused();
				await push(call('call-two', '{"path":"src/index.ts"}'));
				await expect(activity).toHaveCount(1);
				await expect(summary).toContainText(locale === 'en' ? '2 steps' : '2 个步骤');
				await expect.poll(() => summary.evaluate(element => Reflect.get(element, 'retainedExecutionSummary'))).toBe(true);
				await push({
					id: 'answer',
					author: { role: 'assistant' },
					channel: 'final',
					recipient: 'all',
					content: { parts: ['Repository answer'] },
				});
				await expect(activity).not.toHaveAttribute('open');
				await expect(summary).toBeFocused();
				await expect(summary).toHaveText(locale === 'en' ? 'Execution process · 2 steps' : '执行过程 · 2 个步骤');
				await expect(page.locator('.ash-chatgpt-message-body').last()).toHaveText('Repository answer');
				await summary.press('Enter');
				await push({
					id: 'answer',
					author: { role: 'assistant' },
					channel: 'final',
					content: { parts: ['Repository answer continues'] },
				});
				await expect(activity).toHaveAttribute('open');
				await expect(summary).toBeFocused();
				await expectVisibleFocusOutline(summary);
				await testInfo.attach(`execution-${locale}-${theme}`, {
					body: await page.screenshot(),
					contentType: 'image/png',
				});
				await page.evaluate(() => Reflect.get(globalThis, 'endExecution')());
				await expect(page.getByRole('button', { name: /^(Stop|停止)$/, exact: true })).toHaveCount(0);
			});
		}
	}

	test('ChatGPT Stop cancels an active stream immediately and fences a delayed remote stop', async function () {
		const { page } = browserTests;

		await page.addInitScript(() => {
			const fetcher = globalThis.fetch.bind(globalThis);
			Object.assign(globalThis, { auditStreamCancelled: false });
			globalThis.fetch = async (input, init) => {
				if (String(input) !== '/service/backend-api/f/conversation') {
					return fetcher(input, init);
				}
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'data: {"conversation_id":"fixture-chat","message":{"id":"current-reply","author":{"role":"assistant"},"content":{"parts":["Synthetic live reply"]}}}\n\n',
								),
							);
						},
						cancel() {
							Reflect.set(globalThis, 'auditStreamCancelled', true);
						},
					}),
					{ headers: { 'Content-Type': 'text/event-stream' } },
				);
			};
		});
		await chatPage(page);
		let stop!: () => Promise<void>;
		let messageId: string | undefined;
		await page.route('**/service/backend-api/stop_conversation', route => {
			messageId = route.request().postDataJSON().message_id;
			stop = async () => {
				await route.fulfill({ json: {} });
			};
		});
		await fillMessage(page, 'Synthetic streaming probe');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.locator('.ash-chatgpt-messages')).toContainText('Synthetic live reply');
		await page.getByRole('button', { name: '停止', exact: true }).click();
		await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, 'auditStreamCancelled'))).toBe(true);
		await expect.poll(() => typeof stop).toBe('function');
		expect(messageId).toBe('current-reply');
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeDisabled();
		await stop();
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
		await expect(page.locator('.ash-chatgpt-status')).toHaveText('已停止回复');
	});

	test('ChatGPT migrates the previous group collapse choice into the pane container once', async function () {
		const { page } = browserTests;

		await mockChatGPTRequests(page);
		await page.goto('/chatgptNavigation.html?locale=en&legacyCollapsed=1');
		const recent = page.getByRole('group', { name: 'Recent', exact: true });
		const heading = recent.locator('.ash-pane-view-header-button');
		await expect(heading).toHaveAttribute('aria-expanded', 'false');
		const storageKeys = () => page.evaluate(() => window.ashChatGPTIntegration.storageKeys());
		const previousKeys = (keys: readonly string[]) => keys.filter(key => key.startsWith('sessions.chatgpt.navigation.collapsed.'));
		expect(previousKeys(await storageKeys())).toEqual([]);
		expect(await storageKeys()).toContain('workbench.viewContainer.sessions.chatgpt.navigation.sessions.chatgpt.navigation.g-p-unloaded.collapsed');
		expect((await storageKeys()).some(key => key.endsWith('.projects.collapsed'))).toBe(false);
		await expect(recent.getByRole('button', { name: 'Synthetic conversation', exact: true })).toBeHidden();
		await heading.click();
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		await heading.press('ArrowLeft');
		await expect(heading).toHaveAttribute('aria-expanded', 'false');
		await heading.press('ArrowRight');
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		expect(previousKeys(await storageKeys())).toEqual([]);
		await page.goto('/chatgptNavigation.html?locale=en&workspace=another-workspace');
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		expect(previousKeys(await storageKeys())).toEqual([]);
		await expect(recent.getByRole('button', { name: 'Synthetic conversation', exact: true })).toBeVisible();
		// A stale legacy value must never override the pane container's newer choice.
		await page.goto('/chatgptNavigation.html?locale=en&workspace=third-workspace&legacyCollapsed=1');
		await expect(heading).toHaveAttribute('aria-expanded', 'true');
		expect(previousKeys(await storageKeys())).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT group collapse persists independently across reload and project renames (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const zh = locale === 'zh-CN';
			let projectTitle = 'Project One';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route =>
				route.fulfill({
					json: {
						items: [
							{ id: 'recent', title: 'Recent chat' },
							{ id: 'one', title: 'First project chat', gizmo_id: 'g-p-one' },
							{ id: 'two', title: 'Second project chat', gizmo_id: 'g-p-two' },
						],
						total: 3,
					},
				}),
			);
			await page.route('**/service/backend-api/pins?*', route => route.fulfill({ json: [{ item: { id: 'pin', title: 'Pinned chat' } }] }));
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route =>
				route.fulfill({
					json: {
						items: [{ gizmo: { id: 'g-p-one', display: { name: projectTitle } } }, { gizmo: { id: 'g-p-two', display: { name: 'Project Two' } } }],
						cursor: null,
					},
				}),
			);
			await page.route('**/service/backend-api/conversation/two', route => route.fulfill({ json: { success: true } }));
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${zh ? 'hcDark' : 'light'}`);
			const list = page.locator('.ash-chatgpt-navigation-list');
			const pinned = list.getByRole('group', { name: zh ? '置顶' : 'Pinned', exact: true });
			const recent = list.getByRole('group', { name: zh ? '最近' : 'Recent', exact: true });
			const first = list.locator('[data-group="g-p-one"]');
			const second = list.locator('[data-group="g-p-two"]');
			const toggle = (group: typeof first) => group.locator(':scope > .ash-pane-view-header > .ash-pane-view-header-button');
			await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveCount(4);
			for (const group of [pinned, first, second, recent]) {
				await expect(toggle(group)).toHaveCSS('height', '32px');
			}
			await toggle(pinned).focus();
			await page.keyboard.press('ArrowDown');
			await expect(toggle(first)).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(toggle(second)).toBeFocused();
			await page.keyboard.press('End');
			await expect(toggle(recent)).toBeFocused();
			await page.keyboard.press('Home');
			await expect(toggle(pinned)).toBeFocused();
			await toggle(first).click();
			await expect(toggle(first)).toHaveAttribute('aria-expanded', 'false');
			await expect(toggle(second)).toHaveAttribute('aria-expanded', 'true');
			await toggle(pinned).focus();
			await page.keyboard.press('ArrowLeft');
			await toggle(recent).focus();
			await page.keyboard.press('Space');
			await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveText(['Second project chat']);
			await testInfo.attach('collapsed-sidebar-groups', {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
			projectTitle = 'Renamed project';
			await page.goto(`/chatgptNavigation.html?locale=${locale}&workspace=second-workspace&theme=${zh ? 'hcDark' : 'light'}`);
			await expect(toggle(first)).toHaveText('Renamed project');
			for (const group of [pinned, first, recent]) {
				await expect(toggle(group)).toHaveAttribute('aria-expanded', 'false');
			}
			await expect(toggle(second)).toHaveAttribute('aria-expanded', 'true');
			await expect(list.locator('.ash-chatgpt-conversation:visible')).toHaveText(['Second project chat']);
			await toggle(recent).focus();
			await page.keyboard.press('ArrowRight');
			await expect(toggle(recent)).toHaveAttribute('aria-expanded', 'true');
			await page.keyboard.press('Tab');
			await expect(recent.getByRole('button', { name: 'Recent chat', exact: true })).toBeFocused();
			await toggle(first).focus();
			await page.keyboard.press('Enter');
			await expect(first.getByRole('button', { name: 'First project chat', exact: true })).toBeVisible();
			await toggle(first).click();

			await page.reload();
			await expect(toggle(first)).toHaveAttribute('aria-expanded', 'false');
			await expect(toggle(recent)).toHaveAttribute('aria-expanded', 'true');
			const row = second.locator('.ash-chatgpt-navigation-row');
			await row.hover();
			await row.getByRole('button', { name: zh ? '置顶聊天' : 'Pin chat', exact: true }).click();
			await expect(toggle(pinned)).toHaveAttribute('aria-expanded', 'false');
			await expect(toggle(pinned)).toBeFocused();
			await expect(pinned.getByRole('button', { name: 'Second project chat', exact: true })).toBeHidden();
		});

		test(`ChatGPT sidebar groups pins, projects and recent chats without duplicates (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const zh = locale === 'zh-CN';
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route =>
				route.fulfill({
					json: {
						items: [
							{ id: 'recent', title: 'Recent chat' },
							{ id: 'project-chat', title: 'Project chat', gizmo_id: 'g-p-one' },
							{ id: 'pinned-project', title: 'Pinned project chat', gizmo_id: 'g-p-one' },
							{ id: 'custom-gpt', title: 'Custom GPT chat', gizmo_id: 'g-custom' },
						],
						total: 4,
					},
				}),
			);
			await page.route('**/service/backend-api/pins?*', route =>
				route.fulfill({
					json: [{ item: { id: 'old-pin', title: 'Old pinned chat' } }, { item: { id: 'pinned-project', title: 'Pinned project chat', gizmo_id: 'g-p-one' } }],
				}),
			);
			await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route =>
				route.fulfill({
					json: {
						items: [{ gizmo: { id: 'g-p-one', display: { name: 'Project One' } } }],
						cursor: null,
					},
				}),
			);
			await page.route('**/service/backend-api/conversation/pinned-project', route => route.fulfill({ json: { success: true } }));
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${zh ? 'hcDark' : 'light'}`);
			const list = page.locator('.ash-chatgpt-navigation-list');
			const pinned = list.getByRole('group', { name: zh ? '置顶' : 'Pinned', exact: true });
			const project = list.getByRole('group', { name: 'Project One', exact: true });
			const projectInstance = await project.elementHandle();
			const recent = list.getByRole('group', { name: zh ? '最近' : 'Recent', exact: true });
			await expect(pinned.locator('.ash-chatgpt-conversation')).toHaveText(['Pinned project chat', 'Old pinned chat']);
			await expect(project.locator('.ash-chatgpt-conversation')).toHaveText(['Project chat']);
			await expect(recent.locator('.ash-chatgpt-conversation')).toHaveText(['Recent chat', 'Custom GPT chat']);
			expect(await list.locator('.ash-chatgpt-navigation-group').evaluateAll(sections => sections.map(section => (section as HTMLElement).dataset.group))).toEqual([
				'pinned',
				'g-p-one',
				'recent',
			]);
			await expect(list.locator('.ash-chatgpt-navigation-group:not(.ash-view-pane)')).toHaveCount(0);
			await expect(list.locator('[data-group="projects"]')).toHaveCount(0);
			await expect(list.locator('.ash-chatgpt-conversation')).toHaveCount(5);
			await testInfo.attach('grouped-sidebar', { body: await page.screenshot(), contentType: 'image/png' });

			const row = list.locator('.ash-chatgpt-navigation-row[data-conversation="pinned-project"]');
			await row.hover();
			await row.getByRole('button', { name: zh ? '取消置顶聊天' : 'Unpin chat', exact: true }).click();
			await expect(project.locator('.ash-chatgpt-conversation')).toHaveText(['Project chat', 'Pinned project chat']);
			await expect(project.getByRole('button', { name: 'Pinned project chat', exact: true })).toBeFocused();
			await expect(pinned.locator('.ash-chatgpt-conversation')).toHaveText(['Old pinned chat']);

			const first = project.getByRole('button', { name: 'Project chat', exact: true });
			await first.focus();
			await page.keyboard.press('ArrowDown');
			await expect(project.getByRole('button', { name: 'Pinned project chat', exact: true })).toBeFocused();
			await page.keyboard.press('ArrowUp');
			await expect(first).toBeFocused();

			expect(await project.evaluate((element, previous) => element === previous, projectInstance)).toBe(true);
			await expect(list.locator('.ash-chatgpt-conversation')).toHaveCount(5);
		});

		test(`ChatGPT row actions manage the addressed chat and project submenu (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const zh = locale === 'zh-CN';
			const labels = zh
				? {
						more: '更多操作',
						pin: '置顶聊天',
						unpin: '取消置顶聊天',
						rename: '重命名',
						share: '分享',
						archive: '归档',
						delete: '删除',
						move: '移至项目',
						cancel: '取消',
					}
				: {
						more: 'More actions',
						pin: 'Pin chat',
						unpin: 'Unpin chat',
						rename: 'Rename',
						share: 'Share',
						archive: 'Archive',
						delete: 'Delete',
						move: 'Move to project',
						cancel: 'Cancel',
					};
			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/conversations?*', route =>
				route.fulfill({
					json: {
						items: [
							{ id: 'other', title: 'Other chat' },
							{ id: 'fixture-chat', title: 'Synthetic conversation' },
							{ id: 'third', title: 'Third chat' },
						],
						total: 3,
					},
				}),
			);
			const writes: { method: string; path: string; body?: Record<string, unknown> }[] = [];
			await page.route('**/service/backend-api/**', async route => {
				const request = route.request();
				const url = new URL(request.url());
				if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) {
					const next = url.searchParams.has('cursor');
					await route.fulfill({
						json: {
							items: [
								{
									gizmo: {
										id: next ? 'g-p-two' : 'g-p-one',
										display: { name: next ? 'Project Two' : 'Project One' },
									},
								},
							],
							cursor: next ? null : 'next',
						},
					});
				} else if (request.method() !== 'GET') {
					writes.push({
						method: request.method(),
						path: url.pathname,
						...(request.postData() ? { body: request.postDataJSON() } : {}),
					});
					await route.fulfill({
						json: url.pathname.endsWith('/share/v2/create') ? { share_url: 'https://chatgpt.com/share/fixture-link' } : { success: true },
					});
				} else {
					await route.fallback();
				}
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${zh ? 'hcDark' : 'light'}`);
			const row = page.locator('.ash-chatgpt-navigation-row[data-conversation="fixture-chat"]');
			const title = row.locator('.ash-chatgpt-conversation');
			const toolbar = row.getByRole('toolbar');
			const more = row.getByRole('button', { name: labels.more, exact: true });
			const openMore = async () => {
				await row.hover();
				await more.click();
			};
			await expect(title).toBeVisible();
			for (const forcedColors of ['none', 'active'] as const) {
				await page.emulateMedia({ forcedColors });
				expect((await row.boundingBox())!.height).toBe(32);
				for (const action of [more, row.getByRole('button', { name: labels.pin, exact: true })]) {
					await expect(action).toHaveCSS('width', '28px');
					await expect(action).toHaveCSS('height', '28px');
					const bounds = (await action.boundingBox())!;
					const rowBounds = (await row.boundingBox())!;
					expect(bounds).toMatchObject({ width: 28, height: 28 });
					expect(bounds.y + bounds.height / 2).toBe(rowBounds.y + rowBounds.height / 2);
				}
			}
			await page.emulateMedia({ forcedColors: 'none' });
			await page.locator('#editor').hover();
			await expect(toolbar).toHaveCSS('opacity', '0');
			await row.hover();
			await expect(toolbar).toHaveCSS('opacity', '1');
			await title.focus();
			await page.keyboard.press('Tab');
			await expect(more).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(row.getByRole('button', { name: labels.pin, exact: true })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(row.getByRole('button', { name: labels.unpin, exact: true })).toHaveAttribute('aria-pressed', 'true');
			await expect(page.locator('.ash-chatgpt-conversation').first()).toHaveText('Synthetic conversation');
			await expect(page.locator('.ash-chatgpt-turn')).toHaveCount(0);
			await openMore();
			for (const label of [labels.rename, labels.share, labels.archive, labels.delete, labels.move]) {
				await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
			}
			await page.keyboard.press('Escape');
			await expect(more).toBeFocused();
			await openMore();
			await page.getByRole('menuitem', { name: labels.move, exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			await expect(page.getByRole('menuitemcheckbox', { name: 'Project One', exact: true })).toBeVisible();
			await testInfo.attach('conversation-project-submenu', {
				body: await page.screenshot(),
				contentType: 'image/png',
			});
			await page.getByRole('menuitemcheckbox', { name: 'Project Two', exact: true }).click();
			await expect.poll(() => writes.some(write => write.body?.gizmo_id === 'g-p-two')).toBe(true);
			await openMore();
			await page.getByRole('menuitem', { name: labels.rename, exact: true }).click();
			const name = page.getByRole('textbox', { name: labels.rename, exact: true });
			await name.fill('Renamed conversation');
			await name.press('Enter');
			await expect(title).toHaveText('Renamed conversation');
			await openMore();
			await page.getByRole('menuitem', { name: labels.share, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: labels.share, exact: true }).click();
			await expect(page.locator('body')).toHaveAttribute('data-copied-link', 'https://chatgpt.com/share/fixture-link');
			await openMore();
			await page.getByRole('menuitem', { name: labels.delete, exact: true }).click();
			await dialog.getByRole('button', { name: labels.cancel, exact: true }).click();
			expect(writes.some(write => write.method === 'DELETE')).toBe(false);
			await expect(title).toBeVisible();
			await openMore();
			await page.getByRole('menuitem', { name: labels.archive, exact: true }).click();
			await expect(row).toHaveCount(0);
			const third = page.locator('.ash-chatgpt-navigation-row[data-conversation="third"]');
			await third.hover();
			await third.getByRole('button', { name: labels.more, exact: true }).click();
			await page.getByRole('menuitem', { name: labels.delete, exact: true }).click();
			await dialog.getByRole('button', { name: labels.delete, exact: true }).click();
			await expect(third).toHaveCount(0);
			await expect(page.locator('.ash-chatgpt-conversation')).toHaveText(['Other chat']);
			expect(writes.map(write => [write.method, write.path])).toEqual([
				['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['POST', '/service/backend-api/conversation/id/fixture-chat/rename'],
				['POST', '/service/backend-api/share/v2/create'],
				['PATCH', '/service/backend-api/conversation/fixture-chat'],
				['DELETE', '/service/backend-api/conversation/id/third'],
			]);
		});
	}
});
