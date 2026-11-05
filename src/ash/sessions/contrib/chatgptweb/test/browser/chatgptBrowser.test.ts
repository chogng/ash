import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { expect, type Page } from '@playwright/test';
import { expectVisibleFocusOutline } from '../../../../../../../test/fixtures/browser/focusOutline.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { Color } from '../../../../../base/common/color.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { sessionsConversationBackground } from '../../../../common/theme.js';
import { mockChatGPTRequests } from './chatGPTBrowserTestUtils.js';

suite('ChatGPT conversation in the Ash workspace', () => {
	const browserTests = useBrowserTests();

	async function fillMessage(page: Page, text: string): Promise<void> {
		const input = page.getByRole('textbox', { name: /^(Ask ChatGPT|询问 ChatGPT)$/u });
		await input.focus();
		await page.keyboard.press('Control+a');
		await page.keyboard.insertText(text);
		await expectDraft(page, text);
	}

	async function expectDraft(page: Page, text: string): Promise<void> {
		await expect.poll(() => page.evaluate(() => window.ashChatGPTIntegration.draft())).toBe(text);
	}

	test('a project chat shows its project in the title bar only while visible', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
			json: { items: [{ gizmo: { id: 'g-p-research', display: { name: 'Research' } } }], cursor: null },
		}));
		await page.route('**/service/backend-api/pins?*', route => route.fulfill({
			json: [{ item: { id: 'fixture-chat', title: 'Synthetic conversation', gizmo_id: 'g-p-research' } }],
		}));
		await page.route('**/service/backend-api/conversations?*', route => route.fulfill({
			json: { items: [{ id: 'fixture-chat', title: 'Synthetic conversation', gizmo_id: 'g-p-research' }], total: 1 },
		}));
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const titlebar = page.locator('.ash-sessions-titlebar-page-content');
		const name = titlebar.getByRole('button', { name: 'Research', exact: true });
		await expect(name).toHaveCount(0);
		await page.locator('#navigation').getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
		await expect(name).toBeVisible();
		await expect(page.locator('#editor .ash-project-titlebar')).toHaveCount(0);
		await page.evaluate(() => window.ashChatGPTIntegration.setVisible(false));
		await expect(name).toHaveCount(0);
		await page.evaluate(() => window.ashChatGPTIntegration.setVisible(true));
		await expect(name).toBeVisible();
		await page.evaluate(() => window.ashChatGPTIntegration.newChat());
		await expect(name).toHaveCount(0);
	});

	test('a new Chat can choose a project and a folder independently and upload selected files', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		let uploaded: string | null | undefined;
		let projectMove: unknown;
		await page.route('**/service/backend-api/gizmos/snorlax/sidebar?*', route => route.fulfill({
			json: { items: [{ gizmo: { id: 'g-project', display: { name: 'Research' } } }], cursor: null },
		}));
		await page.route('**/service/backend-api/files', route => route.fulfill({
			json: { file_id: 'file-notes', upload_url: 'https://example.test/upload' },
		}));
		await page.route('**/service/.upload?*', route => {
			uploaded = route.request().postData();
			return route.fulfill({ status: 201 });
		});
		await page.route('**/service/backend-api/files/file-notes/uploaded', route => route.fulfill({ json: { status: 'success' } }));
		await page.route('**/service/backend-api/f/conversation', route => route.fulfill({
			contentType: 'text/event-stream',
			body: 'data: {"conversation_id":"fixture-chat"}\n\ndata: [DONE]\n\n',
		}));
		await page.route('**/service/backend-api/conversation/fixture-chat', route => {
			if (route.request().method() !== 'PATCH') return route.fallback();
			projectMove = route.request().postDataJSON();
			return route.fulfill({ json: {} });
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN&folderPicker');
		const picker = page.locator('.ash-chatgpt-widget .ash-chat-input-footer > .ash-chat-input-workspace-slot button');
		await expect(picker).toHaveAccessibleName('项目或文件夹');
		await expect(picker).toBeEnabled();
		await picker.press('Enter');
		await page.getByText('选择文件夹…', { exact: true }).click();
		await expect(picker).toHaveAccessibleName('项目或文件夹：fixture-folder');
		await expect(picker).toBeFocused();
		expect(uploaded).toBeUndefined();
		await picker.press('Enter');
		await page.getByRole('menu').getByText('Research', { exact: true }).click();
		await expect(picker).toHaveAccessibleName('项目或文件夹：Research · fixture-folder');
		await picker.press('Enter');
		await page.getByText('清除项目', { exact: true }).click();
		await expect(picker).toHaveAccessibleName('项目或文件夹：fixture-folder');
		await picker.press('Enter');
		await page.getByRole('menu').getByText('Research', { exact: true }).click();
		await picker.press('Enter');
		await page.getByText('从文件夹添加附件…', { exact: true }).click();
		await expect.poll(() => uploaded).toBe('fixture notes');
		await expect(page.locator('.ash-chat-staged-file').filter({ hasText: 'notes.txt' })).toContainText('已就绪');
		await picker.press('Enter');
		await page.getByText('清除文件夹', { exact: true }).click();
		await expect(picker).toHaveAccessibleName('项目或文件夹：Research');
		await fillMessage(page, 'Summarize the attachment');
		await page.keyboard.press('Enter');
		await expect.poll(() => projectMove).toEqual({ gizmo_id: 'g-project' });
		await expect(picker).toBeHidden();
	});

	test('ChatGPT reuses the left prompt timeline to navigate the visible conversation', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversation/fixture-chat', route => {
			const turns = [
				['first', 'user', 'First prompt'],
				['first-reply', 'assistant', 'First answer\n\n'.repeat(100)],
				['second', 'user', 'Second prompt'],
				['second-reply', 'assistant', 'Second answer\n\n'.repeat(100)],
			];
			return route.fulfill({
				json: {
					title: 'Synthetic conversation',
					current_node: 'second-reply',
					mapping: Object.fromEntries(turns.map(([id, role, text], index) => [id, {
						parent: turns[index - 1]?.[0] ?? null,
						message: { id, author: { role }, content: { content_type: 'text', parts: [text] } },
					}])),
				},
			});
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const handle = page.getByLabel('显示提问', { exact: true });
		await expect(handle).toBeHidden();
		await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
		const viewport = page.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport');
		await expect(handle).toBeVisible();
		const response = viewport.locator('.ash-chat-item-agentMessage').first();
		const composer = page.locator('.ash-chat-input-container');
		const stickyPrompt = page.locator('.ash-chat-transcript-scrollable > .ash-chat-sticky-prompt');
		let previousWidth = 0;
		for (const width of [660, 799, 800, 869, 870, 1280, 1365]) {
			await page.setViewportSize({ width, height: 720 });
			const [row, card, sticky, pane] = await Promise.all([
				response.boundingBox(),
				composer.boundingBox(),
				stickyPrompt.boundingBox(),
				viewport.boundingBox(),
			]);
			// At intermediate widths, the model popup must not reserve space in the chat column.
			if (pane!.width <= 950) {
				expect(card!.width, `space used at ${width}px`).toBeGreaterThanOrEqual(pane!.width - 80);
			}
			expect(card!.width, `composer width at ${width}px`).toBeGreaterThanOrEqual(previousWidth - 1);
			for (const column of [row!, sticky!]) {
				expect(Math.abs(column.x - card!.x), `left edge at ${width}px`).toBeLessThan(1);
				expect(Math.abs(column.x + column.width - (card!.x + card!.width)), `right edge at ${width}px`).toBeLessThan(1);
			}
			previousWidth = card!.width;
		}
		await page.setViewportSize({ width: 1280, height: 720 });
		await viewport.evaluate(element => { element.scrollTop = 0; });
		const rail = page.locator('.ash-prompt-timeline-gutter');
		const marks = rail.locator('.ash-prompt-timeline-gutter-marks > span');
		await expect(marks.first()).toHaveClass('active');
		const [control, transcript] = await Promise.all([handle.boundingBox(), viewport.boundingBox()]);
		expect(control!.x - transcript!.x).toBe(4);
		expect(Math.abs(control!.y + control!.height / 2 - (transcript!.y + transcript!.height / 2))).toBeLessThan(1);

		await fillMessage(page, 'Draft stays here');
		await handle.press('Enter');
		const firstPrompt = rail.getByRole('button', { name: 'First prompt', exact: true });
		const secondPrompt = rail.getByRole('button', { name: 'Second prompt', exact: true });
		await expect(firstPrompt).toBeFocused();
		await expect(rail.locator('.ash-prompt-timeline-panel')).toHaveCSS('border-radius', '12px');
		await expect(firstPrompt).toHaveCSS('min-height', '28px');
		await firstPrompt.press('ArrowDown');
		await expect(secondPrompt).toBeFocused();
		await secondPrompt.press('Escape');
		await expect(handle).toBeFocused();
		await expect(rail).not.toHaveAttribute('open');
		await handle.press('Enter');
		await firstPrompt.press('End');
		await secondPrompt.press('Enter');
		const secondMessage = viewport.locator('article.ash-chat-item-userMessage').filter({ hasText: 'Second prompt' });
		await expect(secondMessage).toBeFocused();
		await expect(secondMessage).toBeInViewport();
		await expect(marks.last()).toHaveClass('active');
		await expectDraft(page, 'Draft stays here');

		await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chatTimeline.display', 'ruler'));
		const ruler = page.locator('.ash-prompt-timeline-ruler');
		await expect(rail).toHaveCount(0);
		await expect(ruler.getByRole('button', { name: 'Second prompt', exact: true })).toHaveAttribute('aria-current', 'true');
		await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chatTimeline.display', 'off'));
		await expect(ruler).toHaveCount(0);
		await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chatTimeline.display', 'gutter'));
		await expect(handle).toBeVisible();
		await page.evaluate(() => window.ashChatGPTIntegration.newChat());
		await expect(handle).toBeHidden();
	});

	test('ChatGPT response actions are icon-only and address the selected reply', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page, 'memory:fixture\n\n[Local file](file:///workspace/private.ts)\n\n[Web source](https://example.test/source)');
		await page.addInitScript(() => {
			window.Audio = function () { return document.createElement('audio'); } as unknown as typeof Audio;
			HTMLMediaElement.prototype.play = async function () { document.body.dataset.audioPlaying = 'true'; };
			HTMLMediaElement.prototype.pause = function () { document.body.dataset.audioPlaying = 'false'; };
		});
		let read: URLSearchParams | undefined;
		let share: unknown;
		await page.route('**/service/backend-api/synthesize?*', route => {
			read = new URL(route.request().url()).searchParams;
			return route.fulfill({ contentType: 'audio/mpeg', body: 'synthetic' });
		});
		await page.route('**/service/backend-api/share/v2/create', route => {
			share = route.request().postDataJSON();
			return route.fulfill({ json: { share_url: 'https://chatgpt.com/share/fixture-response' } });
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const chat = page.locator('.ash-chatgpt-widget .ash-chat');
		await expect(chat).toBeVisible();
		await expect(chat.locator('[data-untitled-session-id]')).toHaveCount(0);
		expect(await chat.getAttribute('data-untitled-session-id')).toBeNull();
		await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
		await expect(chat.getByText('memory:fixture', { exact: true })).toBeVisible();
		await expect(chat.getByRole('button', { name: /打开.*记忆/ })).toHaveCount(0);
		await expect(chat.getByRole('link', { name: 'Local file' })).toHaveCount(0);
		await chat.getByRole('link', { name: 'Web source' }).click();
		await expect(page.locator('body')).toHaveAttribute('data-opened-external', 'https://example.test/source');
		const toolbar = page.getByRole('toolbar', { name: '回复操作', exact: true });
		const copy = toolbar.getByRole('button', { name: '复制消息' });
		const readAloud = toolbar.getByRole('button', { name: '朗读', exact: true });
		const fork = toolbar.getByRole('button', { name: '在 ChatGPT 中创建分支' });
		const shareResponse = toolbar.getByRole('button', { name: '分享回复' });
		await expect(toolbar.getByRole('button')).toHaveCount(4);
		await expect(toolbar).toHaveText('', { useInnerText: true });
		await copy.focus();
		await page.keyboard.press('ArrowRight');
		await expect(readAloud).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.locator('body')).toHaveAttribute('data-audio-playing', 'true');
		expect(read?.get('conversation_id')).toBe('fixture-chat');
		expect(read?.get('message_id')).toBe('previous-reply');
		await expect(toolbar.getByRole('button', { name: '停止朗读' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.locator('body')).toHaveAttribute('data-audio-playing', 'false');
		await page.keyboard.press('ArrowRight');
		await expect(fork).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.locator('body')).toHaveAttribute('data-opened-external', 'https://chatgpt.com/branch/fixture-chat/previous-reply');
		await page.keyboard.press('ArrowRight');
		await expect(shareResponse).toBeFocused();
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog');
		await expect(dialog).toContainText('截至这条回复');
		expect(share).toBeUndefined();
		await dialog.getByRole('button', { name: '分享', exact: true }).click();
		await expect(page.locator('body')).toHaveAttribute('data-copied-link', 'https://chatgpt.com/share/fixture-response');
		expect(share).toEqual({ conversation_id: 'fixture-chat', current_node_id: 'previous-reply', is_anonymous: true });
	});

	test('ChatGPT saves an offline first message and automatically sends it after reconnection', async () => {
		const { page } = browserTests;
		let posts = 0;
		let deletes = 0;
		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/f/conversation', route => {
			posts++;
			return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"conversation_id":"offline-created"}\n\ndata: [DONE]\n\n' });
		});
		await page.route('**/service/backend-api/conversation/offline-created', route => route.fulfill({
			json: {
				title: 'Cloud title', current_node: 'reply',
				mapping: { reply: { parent: null, message: { id: 'reply', author: { role: 'assistant' }, content: { parts: ['Cloud reply'] } } } },
			}
		}));
		await page.route('**/service/backend-api/conversation/id/fixture-chat', route => {
			if (route.request().method() === 'DELETE') { deletes++; return route.fulfill({ status: 204 }); }
			return route.fallback();
		});
		await page.goto('/chatgptNavigation.html?locale=zh-CN');
		const original = page.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await expect(original).toBeVisible();
		await page.context().setOffline(true);
		const row = page.locator('.ash-chat-navigation-row').filter({ has: original });
		await row.hover();
		await row.getByRole('button', { name: '更多操作', exact: true }).click();
		await page.getByRole('menuitem', { name: '删除', exact: true }).click();
		await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
		await expect(original).toHaveCount(0);
		await fillMessage(page, 'Offline first question');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Offline first question', exact: true })).toBeVisible();
		await expect(page.locator('.ash-chatgpt-widget')).toContainText('已保存到此设备');
		expect(posts).toBe(0);
		expect(deletes).toBe(0);
		await page.context().setOffline(false);
		await expect(page.getByRole('button', { name: 'Cloud title', exact: true })).toBeVisible();
		await expect(page.locator('.ash-chatgpt-widget')).toContainText('Cloud reply');
		expect(posts).toBe(1);
		expect(deletes).toBe(1);
		await expect(original).toHaveCount(0);
	});

	test('ChatGPT welcome announces once per visible draft and honors the verbosity setting', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page);
		await page.goto('/chatgptNavigation.html?locale=en&screenReader');
		const announcement = page.locator('.ash-aria-live');
		await expect(announcement).toContainText('What are we building?\nTo disable this announcement, set accessibility.verbosity.newSessionWelcome to false.');
		await fillMessage(page, 'Draft');
		await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomeName', 'Ash'));
		await expect(page.locator('.ash-chat-welcome h2')).toHaveText('What are we building, Ash?');
		await expect(announcement).not.toContainText('building, Ash');
		await page.evaluate(() => {
			window.ashChatGPTIntegration.setVisible(false);
			window.ashChatGPTIntegration.newChat();
		});
		await expect(announcement).not.toContainText('What\u2019s the move');
		await page.evaluate(() => window.ashChatGPTIntegration.setVisible(true));
		await expect(announcement).toContainText('What\u2019s the move, Ash?');
		await page.evaluate(async () => {
			await window.ashChatGPTIntegration.setConfiguration('accessibility.verbosity.newSessionWelcome', false);
			window.ashChatGPTIntegration.newChat();
		});
		await expect(page.locator('.ash-chat-welcome h2')).toHaveText('Let\u2019s cook, Ash');
		await expect(announcement).not.toContainText('Let\u2019s cook');
	});

	test('ChatGPT long welcome phrases wrap in every theme', async () => {
		const { page } = browserTests;
		await page.setViewportSize({ width: 900, height: 700 });
		await mockChatGPTRequests(page);
		for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
			await page.goto(`/chatgptNavigation.html?locale=zh-CN&theme=${theme}`);
			await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomeMessages', { mode: 'replace', phrases: ['LongWelcome'.repeat(30)] }));
			const title = page.locator('.ash-chat-welcome h2');
			await expect(title).toBeVisible();
			const geometry = await title.evaluate(element => {
				const bounds = element.getBoundingClientRect();
				const parent = element.parentElement!;
				return { width: bounds.width, available: parent.clientWidth, overflow: parent.scrollWidth > parent.clientWidth, wrap: getComputedStyle(element).overflowWrap, color: getComputedStyle(element).color, background: getComputedStyle(element.closest('#editor')!).backgroundColor };
			});
			expect(geometry.wrap).toBe('anywhere');
			expect(geometry.width).toBeLessThanOrEqual(geometry.available);
			expect(geometry.overflow).toBe(false);
			expect(geometry.color).not.toBe(geometry.background);
		}
	});

	test('ChatGPT scrolls a long transcript over the page background', async () => {
		const { page } = browserTests;
		await mockChatGPTRequests(page, 'Synthetic reply.\n\n'.repeat(100));
		for (const [theme, colorTheme] of Object.entries({ light: lightColorTheme, dark: darkColorTheme, hcLight: highContrastLightColorTheme, hcDark: highContrastDarkColorTheme })) {
			await page.goto(`/chatgptNavigation.html?theme=${theme}`);
			await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
			const widget = page.locator('.ash-chatgpt-widget');
			const transcript = widget.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport');
			await expect(widget).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const background = Color.Format.CSS.formatRGB(colorTheme.getColor(sessionsConversationBackground)!);
			await expect(widget.locator('.ash-chat')).toHaveCSS('background-color', background);
			await expect.poll(() => transcript.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
			await transcript.evaluate(element => { element.scrollTop = 0; });
			await transcript.hover();
			await page.mouse.wheel(0, 300);
			await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

			const composer = widget.locator('.ash-sessions-chat-input-card');
			await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
			const lastLine = transcript.locator('.ash-chat-markdown-part p').last();
			await expect.poll(async () => {
				const [lineBounds, composerBounds] = await Promise.all([lastLine.boundingBox(), composer.boundingBox()]);
				return lineBounds!.y + lineBounds!.height - composerBounds!.y;
			}).toBeLessThan(0);
		}
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT welcome rotates on new chats, wraps and survives reload (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const title = page.locator('.ash-chat-welcome h2');
			const phrases = locale === 'en'
				? ['What are we building?', 'What\u2019s the move?', 'Let\u2019s cook', 'Time to lock in', 'Let\u2019s ship something']
				: ['我们来做点什么？', '下一步做什么？', '开始动手吧', '是时候专注了', '一起做出点成果吧'];
			await expect(title).toHaveText(phrases[0]);
			await fillMessage(page, 'Keep my draft');
			await expect(title).toHaveText(phrases[0]);
			for (let index = 1; index <= 5; index++) {
				await page.evaluate(() => window.ashChatGPTIntegration.newChat());
				await expect(title).toHaveText(phrases[index % 5]);
			}
			await page.reload();
			await expect(title).toHaveText(phrases[1]);
			await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
			await expect(title).toBeHidden();
			await page.evaluate(() => window.ashChatGPTIntegration.newChat());
			await expect(title).toHaveText(phrases[2]);
			await page.route('**/service/backend-api/f/conversation', route => route.fulfill({
				contentType: 'text/event-stream',
				body: 'data: {"conversation_id":"fixture-chat","message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Synthetic answer"]}}}\n\ndata: [DONE]\n\n',
			}));
			await fillMessage(page, 'Synthetic question');
			await page.getByRole('textbox', { name: /^(Ask ChatGPT|询问 ChatGPT)$/u }).press('Enter');
			await expect(page.locator('.ash-chat-transcript')).toContainText('Synthetic answer');
			await expect(title).toBeHidden();
		});

		test(`ChatGPT welcome reacts to settings and keeps input focus (${locale})`, async () => {
			const { page } = browserTests;
			await mockChatGPTRequests(page);
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			const title = page.locator('.ash-chat-welcome h2');
			await fillMessage(page, 'Draft');
			await page.evaluate(async () => {
				await window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomeName', 'A$&B');
				await window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomeMessages', { mode: 'replace', phrases: ['Hello ${name}', '<b>Plain text</b>'] });
			});
			await expect(title).toHaveText('Hello A$&B');
			await expect(page.getByRole('textbox', { name: /^(Ask ChatGPT|询问 ChatGPT)$/u })).toBeFocused();
			await page.evaluate(() => window.ashChatGPTIntegration.newChat());
			await expect(title).toHaveText('<b>Plain text</b>');
			await expect(title.locator('b')).toHaveCount(0);
			await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomePhrases', false));
			await expect(title).toBeHidden();
			await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomePhrases', true));
			await expect(title).toHaveText('<b>Plain text</b>');
			await page.evaluate(() => window.ashChatGPTIntegration.setConfiguration('sessions.chat.experimental.welcomeMessages', { mode: 'replace', phrases: [] }));
			await expect(title).toBeHidden();
		});

	}

	async function chatPage(page: Page, answer = 'Synthetic answer'): Promise<void> {
		await mockChatGPTRequests(page, answer);
		await page.goto('/chatgptNavigation.html');
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
		await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
		await expect(page.locator('.ash-chat-item-agentMessage')).toHaveCount(1);
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT model picker matches the two families and five product presets in ${locale}`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.setViewportSize({ width: 1600, height: 900 });
			await mockChatGPTRequests(page);
			const catalog = chatGPTModelCatalog(locale);
			const labels = locale === 'en' ? ['Instant', 'Medium', 'High', 'Extra High', 'Pro'] : ['即时', '中', '高', '极高', 'Pro'];
			await page.route('**/service/backend-api/models?*', route => route.fulfill({ json: catalog }));
			const submitted: { model: string; thinking_effort?: string; }[] = [];
			await page.route('**/service/backend-api/f/conversation/prepare', async route => {
				submitted.push(route.request().postDataJSON());
				await route.fulfill({ json: { conduit_token: 'fixture' } });
			});
			await page.route('**/service/backend-api/f/conversation', async route => {
				submitted.push(route.request().postDataJSON());
				await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Reply"]}}}\n\ndata: [DONE]\n\n' });
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=light`);
			const picker = page.locator('.ash-chat-input-model-action');
			const choose = async (name: string): Promise<void> => {
				const [modelTitle, presetLabel] = name.split(' · ') as [string, string];
				await picker.click();
				const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Choose a chat model' : '选择聊天模型' });
				const modelButton = dialog.locator('.ash-chat-slider-model-button');
				const currentTitle = await modelButton.textContent();
				if (currentTitle !== modelTitle) {
					await modelButton.click();
					await page.getByRole('menuitemradio', { name: modelTitle.trim(), exact: true }).click();
				}
				if (presetLabel) {
					await dialog.getByRole('button', { name: presetLabel.trim(), exact: true }).click();
				}
				await expect(modelButton).toHaveAccessibleName(modelTitle);
				if (presetLabel) {
					await expect(dialog.locator('.ash-chat-slider-effort-label')).toHaveText(presetLabel);
				}
				await page.keyboard.press('Escape');
				await expect(picker).toHaveText(name);
			};
			await expect(picker).toHaveText(`GPT-6 · ${labels[0]}`);
			await picker.press('Enter');
			const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Choose a chat model' : '选择聊天模型' });
			const modelButton = dialog.locator('.ash-chat-slider-model-button');
			const effortLabel = dialog.locator('.ash-chat-slider-effort-label');
			const slider = dialog.getByRole('slider');
			const expectAnchored = async () => {
				await expect(dialog).toHaveCSS('width', '250px');
				await expect(dialog).toBeInViewport({ ratio: 1 });
				await expect.poll(async () => {
					const button = (await picker.boundingBox())!;
					const panel = (await dialog.boundingBox())!;
					const centeredLeft = button.x + (button.width - panel.width) / 2;
					const rightmostLeft = page.viewportSize()!.width - panel.width;
					return Math.abs(panel.x - Math.min(Math.max(centeredLeft, 0), rightmostLeft));
				}).toBeLessThan(1);
				const button = (await picker.boundingBox())!;
				const panel = (await dialog.boundingBox())!;
				expect(panel.y + panel.height).toBeLessThan(button.y);
			};
			await expect(dialog).toHaveClass(/\bash-tabbed-action-list\b/u);
			const cornerRadius = await dialog.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-cornerRadius-large').trim());
			await expect(dialog).toHaveCSS('border-top-left-radius', cornerRadius);
			await expect(modelButton).toHaveAccessibleName('GPT-6');
			await expect(modelButton).toHaveAccessibleDescription(labels[0]!);
			await expect(modelButton).toHaveAttribute('aria-expanded', 'false');
			await expect(modelButton).toBeFocused();
			const [panelBounds, modelBounds, effortBounds, sliderBounds] = await Promise.all([
				dialog.boundingBox(), modelButton.boundingBox(), effortLabel.boundingBox(), slider.boundingBox(),
			]);
			expect(Math.abs(modelBounds!.x + modelBounds!.width / 2 - (panelBounds!.x + panelBounds!.width / 2))).toBeLessThan(1);
			expect(modelBounds!.y + modelBounds!.height).toBeLessThanOrEqual(effortBounds!.y);
			expect(effortBounds!.y + effortBounds!.height).toBeLessThan(sliderBounds!.y);
			await page.keyboard.press('Enter');
			await expect(modelButton).toHaveAttribute('aria-expanded', 'true');
			await expect(dialog.getByRole('combobox')).toHaveCount(0);
			await expect(dialog.getByRole('menuitemradio', { name: 'GPT-6', exact: true })).toBeFocused();
			const alternativeModel = dialog.getByRole('menuitemradio', { name: 'GPT-5.6 Sol', exact: true });
			await expect(alternativeModel).toBeInViewport();
			const [alternativeBounds, expandedButtonBounds] = await Promise.all([
				alternativeModel.boundingBox(), modelButton.boundingBox(),
			]);
			expect(alternativeBounds!.y + alternativeBounds!.height).toBeLessThan(expandedButtonBounds!.y);
			await expectAnchored();
			await modelButton.press('Enter');
			await expect(modelButton).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(slider).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(slider).toHaveAttribute('aria-valuetext', labels[1]!);
			await expect(modelButton).toHaveAccessibleDescription(labels[1]!);
			await expect(effortLabel).toHaveText(labels[1]!);
			await expect(slider).toBeFocused();
			await expect(page.locator('.ash-chat-slider-tick')).toHaveCount(5);
			await expect(dialog.getByRole('toolbar')).toHaveCount(0);
			await expect(dialog.getByText(/^(Faster|Smarter|更快速|更深思)$/u)).toHaveCount(0);
			await expect(page.getByRole('switch')).toHaveCount(0);
			await testInfo.attach('chatgpt-model-families', { body: await dialog.screenshot(), contentType: 'image/png' });
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(picker).toBeFocused();
			for (const width of [1280, 870, 869, 660]) {
				await page.setViewportSize({ width, height: 720 });
				await picker.press('Enter');
				await expectAnchored();
				await page.keyboard.press('Escape');
			}
			await page.setViewportSize({ width: 1280, height: 720 });
			const expected = [
				['gpt-6-instant', undefined], ['gpt-6-thinking', 'standard'], ['gpt-6-thinking', 'extended'],
				['gpt-6-thinking', 'max'], ['gpt-6-pro', undefined],
			] as const;
			for (let index = 0; index < labels.length; index++) {
				await choose(`GPT-6 · ${labels[index]}`);
				await fillMessage(page, `Use ${labels[index]}`);
				await page.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
				await expect.poll(() => submitted.length).toBe((index + 1) * 2);
				expect(submitted.slice(-2).map(body => [body.model, body.thinking_effort])).toEqual([expected[index], expected[index]]);
				if (expected[index]![1] === undefined) { expect(submitted.slice(-2).every(body => !('thinking_effort' in body))).toBe(true); }
				await expect(picker).toBeEnabled();
			}
			await choose(`GPT-5.6 Sol · ${labels[3]}`);
			await fillMessage(page, 'Use GPT-5.6 Sol Extra High');
			await page.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
			await expect.poll(() => submitted.length).toBe(12);
			expect(submitted.slice(-2).map(body => [body.model, body.thinking_effort])).toEqual([['gpt-5-6-thinking', 'max'], ['gpt-5-6-thinking', 'max']]);
		});

		test(`ChatGPT model picker submits the selected catalog model and hides unknown thinking capabilities in ${locale}`, async function () {
			const { page } = browserTests;

			await mockChatGPTRequests(page);
			await page.route('**/service/backend-api/models?*', route => route.fulfill({
				json: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }, { slug: 'second', title: 'Second model' }])
			}));
			let submitted: string | undefined;
			await page.route('**/service/backend-api/f/conversation/prepare', async route => {
				submitted = route.request().postDataJSON().model;
				await route.fulfill({ status: 500, json: {} });
			});
			await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=light`);
			const picker = page.locator('.ash-chat-input-model-action');
			await expect(picker).toBeEnabled();
			await picker.click();
			await expect(page.getByRole('slider')).toHaveCount(0);
			await expect(page.getByRole('menuitemradio', { name: 'Fixture model' })).toHaveAttribute('aria-checked', 'true');
			expect(await page.locator('body').getAttribute('data-native-model-providers-read')).toBeNull();
			await expect(page.getByRole('menuitem', { name: /Add Models|More Models|添加模型|更多模型/ })).toHaveCount(0);
			await expect(page.getByRole('combobox')).toHaveCount(0);
			await expect(page.getByRole('menuitemradio', { name: 'Fixture model' })).toBeFocused();
			await page.getByRole('menuitemradio', { name: 'Second model' }).click();
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
					releaseCatalog = () => route.fulfill({ json: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]) });
				});
				await page.goto(`/chatgptNavigation.html?focus=1&locale=${locale}&theme=${theme}`);
				const composer = page.locator('.ash-chat-input-container');
				const input = composer.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT' });
				const attach = composer.locator('.ash-chat-input-attachment-toolbar button');
				const target = page.getByRole('button', { name: locale === 'en' ? 'Project or folder' : '项目或文件夹', exact: true });
				const model = page.locator('.ash-chat-input-model-action');
				await expect(input).toBeFocused();
				await expect(input).toHaveAttribute('aria-readonly', 'true');
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
				await expect(attach).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(composer.locator('.ash-chat-input-inline-toolbar:not(.ash-chat-input-attachment-toolbar):focus-within')).toBeVisible();
				await page.keyboard.press('Tab');
				await expect(target).toBeFocused();
				await expect(target).toHaveCSS('outline-style', 'solid');
				await page.keyboard.press('Tab');
				await expect(model).toBeFocused();
				await expect(model).toHaveCSS('outline-style', 'solid');
				await expect(model).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
				await page.keyboard.press('Shift+Tab');
				await expect(target).toBeFocused();
				await page.keyboard.press('Shift+Tab');
				await expect(composer.locator('.ash-chat-input-inline-toolbar:not(.ash-chat-input-attachment-toolbar):focus-within')).toBeVisible();
				await page.keyboard.press('Shift+Tab');
				await expect(attach).toBeFocused();
				await page.keyboard.press('Shift+Tab');
				await expect(input).toBeFocused();
				await testInfo.attach('composer-ready-focus', { body: await page.screenshot(), contentType: 'image/png' });
			});

			test(`ChatGPT composer uses the compact Code layout in ${locale} ${theme}`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await mockChatGPTRequests(page);
				await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${theme}`);
				const composer = page.locator('.ash-chat-input-container');
				const input = composer.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT' });
				const editor = composer.locator('.ash-chat-input-editor');
				const attach = composer.locator('.ash-chat-input-attachment-toolbar button');
				const model = page.locator('.ash-chat-input-model-action');
				const voice = composer.getByRole('button', { name: /^(Voice conversation|语音对话)$/u });
				const send = composer.getByRole('button', { name: /^(Send|发送)$/u });
				await expect(input).toBeEnabled();
				await expect(editor).toHaveCSS('height', '20px');
				await expect(composer).toHaveCSS('border-radius', '12px');
				await expect(composer).toHaveCSS('padding', '8px');
				await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(voice).toHaveCSS('height', '28px');
				await expect(voice.locator('.ash-icon')).toHaveCSS('font-size', '18px');
				await expect(voice.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'voice-mode');
				const [editorBounds, attachBounds, modelBounds, sendBounds] = await Promise.all(
					[editor, attach, model, voice].map(control => control.boundingBox()),
				);
				expect(attachBounds!.y + attachBounds!.height / 2).toBeCloseTo(editorBounds!.y + editorBounds!.height / 2);
				expect(attachBounds!.y).toBe(sendBounds!.y);
				expect(modelBounds!.y).toBeGreaterThan(sendBounds!.y + sendBounds!.height);
				await page.mouse.move(1, 1);
				const restingShadow = await composer.evaluate(element => getComputedStyle(element).boxShadow);
				const activeShadow = /0px 2px 8px 0px/u;
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
				await input.focus();
				await input.press('End');
				await input.press('Shift+Enter');
				await page.keyboard.insertText('Another line');
				await expectDraft(page, 'A short prompt\nAnother line');
				await expect(composer).toHaveClass(/\bexpanded\b/u);
				await expect(editor).toHaveCSS('height', '40px');
				await fillMessage(page, 'Long prompt that wraps automatically. '.repeat(20));
				await expect.poll(async () => (await editor.boundingBox())!.height).toBeGreaterThan(40);
				await page.setViewportSize({ width: 580, height: 600 });
				for (const control of [editor, attach, model, send]) {
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
				await expect(composer).not.toHaveClass(/\bexpanded\b/u);
				await page.mouse.move(1, 1);
				await page.locator('.ash-chat-navigation .ash-sessions-list-section-toggle').first().focus();
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
				await expect(composer).toHaveCSS('transition-duration', /^(?:0s|1e-05s)$/u);
				if (locale === 'zh-CN' && theme === 'light') {
					await page.setViewportSize({ width: 1280, height: 800 });
					await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
					await expect(page.locator('.ash-chat-item-agentMessage')).toHaveCount(1);
					await input.focus();
					await testInfo.attach('chatgpt-compact-composer', { body: await page.screenshot(), contentType: 'image/png' });
				}
			});
		}
	}

	test('ChatGPT sidebar and editor share drafts and selection with keyboard navigation and independent sizing', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await mockChatGPTRequests(page);
		await page.route('**/service/backend-api/conversations?**', route => route.fulfill({
			json: {
				items: [{ id: 'fixture-chat', title: 'Synthetic conversation' }, ...Array.from({ length: 30 }, (_, index) => ({ id: `recent-${index}`, title: `Recent conversation ${index + 1} with a long title that stays inside the sidebar` }))],
				total: 31,
			}
		}));
		await page.goto('/chatgptNavigation.html');
		const sidebar = page.locator('.ash-chat-navigation');
		const list = sidebar.getByRole('navigation', { name: '会话', exact: true });
		const viewport = sidebar.locator('.ash-chat-navigation-scrollable > .ash-scrollbar-viewport');
		const conversation = sidebar.getByRole('button', { name: 'Synthetic conversation', exact: true });
		await expect(conversation).toBeEnabled();
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		await expect(sidebar.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
		await conversation.focus();
		await conversation.press('Home');
		await expect(conversation).toBeFocused();
		await conversation.press('Enter');
		await expect(page.locator('.ash-chat-transcript')).toContainText('Synthetic answer');
		await expect(page.locator('.ash-chat-item-agentMessage')).toHaveCount(1);
		await expect(conversation).toHaveAttribute('aria-current', 'page');
		const input = page.getByRole('textbox', { name: '询问 ChatGPT' });
		await fillMessage(page, 'Sidebar switch keeps this draft');
		await page.evaluate(() => window.ashChatGPTIntegration.newChat());
		await expectDraft(page, '');
		await conversation.click();
		await expectDraft(page, 'Sidebar switch keeps this draft');
		await expect(sidebar.getByRole('searchbox')).toHaveCount(0);
		await expect(sidebar.locator('details')).toHaveCount(0);
		await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
		await expect(sidebar.locator('.ash-chat-navigation-item').last()).toBeInViewport();
		await viewport.evaluate(element => { element.scrollTop = 0; });
		await testInfo.attach('chatgpt-restored-web-ui', { body: await page.screenshot(), contentType: 'image/png' });
		const before = await page.locator('#editor').boundingBox();
		await page.locator('#navigation').evaluate(element => { element.style.width = '400px'; });
		await expect.poll(async () => (await page.locator('#editor').boundingBox())!.width).toBe(before!.width - 100);
		await expectDraft(page, 'Sidebar switch keeps this draft');
		await testInfo.attach('chatgpt-sidebar-and-editor', { body: await page.screenshot(), contentType: 'image/png' });
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`ChatGPT execution history groups each turn and keeps failures visible (${locale})`, async function () {
			const { page } = browserTests;

			await mockChatGPTRequests(page);
			const message = (id: string, role: string, text: string, extra = {}) => ({ id, author: { role, name: role === 'tool' ? 'GitHub.fetch_file' : undefined }, content: { parts: [text] }, ...extra });
			const messages = [
				message('user-one', 'user', 'First question'),
				message('call-one', 'assistant', '{"path":"README.md"}', { recipient: 'GitHub.fetch_file' }),
				message('result-one', 'tool', 'File unavailable', { status: 'failed' }),
				message('answer-one', 'assistant', 'The file was unavailable'),
				message('user-two', 'user', 'Second question'),
				message('call-two', 'assistant', '{"path":"package.json"}', { recipient: 'GitHub.fetch_file' }),
				message('answer-two', 'assistant', 'Package answer'),
			];
			await page.route('**/service/backend-api/conversation/fixture-chat', route => route.fulfill({
				json: {
					title: 'Synthetic conversation', current_node: 'answer-two',
					mapping: Object.fromEntries(messages.map((message, index) => [message.id, { parent: messages[index - 1]?.id, message }])),
				}
			}));
			await page.goto(`/chatgptNavigation.html?locale=${locale}`);
			await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
			const activities = page.locator('.ash-chat-item-toolCall > .ash-chat-context');
			await expect(activities).toHaveCount(2);
			await expect(activities.locator(':scope > summary').first()).toHaveText(locale === 'en' ? 'Execution process · Some steps failed' : '执行过程 · 部分步骤失败');
			await expect(activities.locator(':scope > summary').last()).toHaveText(locale === 'en' ? 'Execution process · 1 step' : '执行过程 · 1 个步骤');
			await expect(page.locator('.ash-chat-item-userMessage > pre, .ash-chat-item-agentMessage .ash-chat-markdown-part')).toHaveText(['First question', 'The file was unavailable', 'Second question', 'Package answer']);
			await expect(page.locator('.ash-chat-item-toolCall > .ash-chat-context[open]')).toHaveCount(0);
			await activities.first().locator(':scope > summary').click();
			const result = activities.first().locator(':scope > div > details').last();
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
						if (String(input) !== '/service/backend-api/f/conversation') { return fetcher(input, init); }
						return new Response(new ReadableStream({
							start(controller) {
								Reflect.set(globalThis, 'pushExecution', (message: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ conversation_id: 'fixture-chat', message })}\n\n`)));
								Reflect.set(globalThis, 'endExecution', () => { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); });
							}
						}), { headers: { 'Content-Type': 'text/event-stream' } });
					};
				});
				await mockChatGPTRequests(page);
				await page.goto(`/chatgptNavigation.html?locale=${locale}&theme=${theme}`);
				await page.getByRole('button', { name: 'Synthetic conversation', exact: true }).click();
				await expect(page.locator('.ash-chat-item-userMessage > pre, .ash-chat-item-agentMessage .ash-chat-markdown-part').last()).toHaveText('Synthetic answer');
				await fillMessage(page, 'Read the repository');
				await page.getByRole('button', { name: /^(Send|发送)$/, exact: true }).click();
				await expect.poll(() => page.evaluate(() => typeof Reflect.get(globalThis, 'pushExecution'))).toBe('function');
				const push = (value: unknown) => page.evaluate(message => Reflect.get(globalThis, 'pushExecution')(message), value);
				const call = (id: string, text: string) => ({ id, author: { role: 'assistant' }, recipient: 'GitHub.fetch_file', content: { content_type: 'code', text } });
				const raw = '{"path":"README.md","args":{"text":"<img src=x onerror=alert(1)>"}}';
				await push(call('call-one', raw));
				const activity = page.locator('.ash-chat-item-toolCall > .ash-chat-context');
				const summary = activity.locator(':scope > summary');
				await expect(activity).toHaveCount(1);
				await expect(summary).toContainText(locale === 'en' ? 'Using GitHub.fetch_file' : '正在使用 GitHub.fetch_file');
				await expect(activity).not.toHaveAttribute('open');
				await summary.evaluate(element => { Reflect.set(element, 'retainedExecutionSummary', true); });
				await summary.focus();
				await summary.press('Enter');
				await expect(activity).toHaveAttribute('open');
				const entry = activity.locator(':scope > div > details').first();
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
				await push({ id: 'answer', author: { role: 'assistant' }, channel: 'final', recipient: 'all', content: { parts: ['Repository answer'] } });
				await expect(activity).not.toHaveAttribute('open');
				await expect(summary).toBeFocused();
				await expect(summary).toHaveText(locale === 'en' ? 'Execution process · 2 steps' : '执行过程 · 2 个步骤');
				await expect(page.locator('.ash-chat-item-userMessage > pre, .ash-chat-item-agentMessage .ash-chat-markdown-part').last()).toHaveText('Repository answer');
				await summary.press('Enter');
				await push({ id: 'answer', author: { role: 'assistant' }, channel: 'final', content: { parts: ['Repository answer continues'] } });
				await expect(activity).toHaveAttribute('open');
				await expect(summary).toBeFocused();
				await expectVisibleFocusOutline(summary);
				await testInfo.attach(`execution-${locale}-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
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
				if (String(input) !== '/service/backend-api/f/conversation') { return fetcher(input, init); }
				return new Response(new ReadableStream({
					start(controller) { controller.enqueue(new TextEncoder().encode('data: {"conversation_id":"fixture-chat","message":{"id":"current-reply","author":{"role":"assistant"},"content":{"parts":["Synthetic live reply"]}}}\n\n')); },
					cancel() { Reflect.set(globalThis, 'auditStreamCancelled', true); },
				}), { headers: { 'Content-Type': 'text/event-stream' } });
			};
		});
		await chatPage(page);
		let stop!: () => Promise<void>;
		let messageId: string | undefined;
		await page.route('**/service/backend-api/stop_conversation', route => {
			messageId = route.request().postDataJSON().message_id;
			stop = async () => { await route.fulfill({ json: {} }); };
		});
		await fillMessage(page, 'Synthetic streaming probe');
		await page.getByRole('button', { name: '发送', exact: true }).click();
		await expect(page.locator('.ash-chat-transcript')).toContainText('Synthetic live reply');
		await page.getByRole('button', { name: '停止', exact: true }).click();
		await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, 'auditStreamCancelled'))).toBe(true);
		await expect.poll(() => typeof stop).toBe('function');
		expect(messageId).toBe('current-reply');
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeDisabled();
		await stop();
		await expect(page.getByRole('textbox', { name: '询问 ChatGPT' })).toBeEnabled();
		await expect(page.locator('.ash-chat-status')).toHaveText('已停止回复');
	});

});
