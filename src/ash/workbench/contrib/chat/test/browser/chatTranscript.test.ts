import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('chatTranscript browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		test(`active request progress follows streamed messages inside the transcript in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatTranscript.html?richInput&sessions&locale=${locale}`);
			await page.evaluate(() => {
				window.ashChatTranscriptIntegration.prepareRequestEditing(false, 'Review the workspace', true);
				window.ashChatTranscriptIntegration.setResponseWorking(true);
			});
			const chat = page.locator('#app-chat');
			const transcript = chat.getByRole('log');
			const progress = transcript.locator('.ash-chat-transcript-working');
			const sticky = chat.locator('.ash-chat-transcript-working-sticky');
			const viewport = chat.locator('.ash-chat-transcript-viewport > .ash-scrollbar-viewport');
			await expect(progress).toBeVisible();
			await expect(progress).toHaveText(locale === 'en' ? 'Working on your request…' : '正在处理你的请求…');
			await expect(chat.locator('.ash-chat-input-part .ash-chat-working-logo')).toHaveCount(0);
			await page.evaluate(() => window.ashChatTranscriptIntegration.appendChatItem({
				id: 'working-reply', type: 'agentMessage', text: 'A streamed reply\n\n'.repeat(45), transient: true,
			}));
			await expect(transcript.locator('[data-item-id="working-reply"] + .ash-chat-transcript-working')).toBeVisible();
			await chat.scrollIntoViewIfNeeded();
			const scroll = (latest: boolean) => viewport.evaluate((element, latest) => { element.scrollTop = latest ? element.scrollHeight : 0; }, latest);
			await scroll(true);
			await expect.poll(async () => {
				const row = (await progress.boundingBox())!;
				const bounds = (await viewport.boundingBox())!;
				return row.y >= bounds.y && row.y + row.height <= bounds.y + bounds.height;
			}).toBe(true);
			await expect(sticky).toBeHidden();
			await scroll(false);
			await expect(sticky).toBeVisible();
			await expect(sticky).toHaveText(locale === 'en' ? 'Working on your request…' : '正在处理你的请求…');
			await expect(sticky).toHaveAttribute('aria-hidden', 'true');
			expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);
			await scroll(true);
			await expect(sticky).toBeHidden();
			await scroll(false);
			await expect(sticky).toBeVisible();
			await page.evaluate(() => window.ashChatTranscriptIntegration.setResponseWorking(false));
			await expect(progress).toBeHidden();
			await expect(sticky).toBeHidden();
			expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);
		});

		test(`reply turn changes appear in place and keep the source and keyboard focus in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatTranscript.html?locale=${locale}&turnChanges`);
			const feedbackSource = { sessionId: 'session', threadId: 'thread', turnId: 'earlier-turn', itemId: 'turn-reply' };
			const reply = { id: 'turn-reply', type: 'agentMessage', text: 'Earlier reply', transient: false, feedbackSource } as const;
			const render = (turnChanges?: { files: number; additions: number; deletions: number; }) => page.evaluate(({ reply, turnChanges }) =>
				window.ashChatTranscriptIntegration.renderItems([{ ...reply, turnChanges }]), { reply, turnChanges });
			await render();
			const row = page.locator('[data-item-id="turn-reply"]');
			const name = locale === 'en' ? 'Open Turn Changes: 2 files, added 3, removed 1' : '打开本轮变更：2 个文件，新增 3 行，删除 1 行';
			const changes = row.getByRole('button', { name, exact: true });
			await expect(changes).toHaveCount(0);
			const body = await row.locator('.ash-chat-markdown-part').elementHandle();
			await render({ files: 2, additions: 3, deletions: 1 });
			await expect(changes).toContainText('+3');
			await expect(changes).toContainText('−1');
			await changes.press('Space');
			await expect(page.locator('main[data-opened-turn]')).toHaveAttribute('data-opened-turn', JSON.stringify(feedbackSource));
			expect(await row.locator('.ash-chat-markdown-part').evaluate((node, previous) => node === previous, body)).toBe(true);
			await body?.dispose();
			await render();
			await expect(changes).toHaveCount(0);
			await expect(row).toBeFocused();
		});

		test(`queue, redo and feedback buttons forward the latest row identity in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			const source = { sessionId: 'session', threadId: 'thread' };
			const feedbackSource = { ...source, turnId: 'turn', itemId: 'feedback-reply' };
			const queueTarget = { ...source, commandId: 'queued', expectedRevision: 3 };
			const historyRedoTarget = { ...source, expectedSequence: 12 };
			const rows = [
				{ id: 'feedback-reply', type: 'agentMessage', text: 'Same reply', transient: false, feedbackSource },
				{ id: 'redo', type: 'historyRedo', text: '', transient: false, historyRedoTarget },
				{ id: 'queued', type: 'queuedMessage', text: 'Queued input', transient: false, queueTarget: { ...queueTarget, expectedRevision: 2 } },
			] as const;
			await page.evaluate(rows => {
				window.ashChatTranscriptIntegration.captureMessageRowCommands();
				window.ashChatTranscriptIntegration.renderItems(rows);
			}, rows);
			const action = (en: string, zh: string) => page.getByRole('button', { name: locale === 'en' ? en : zh, exact: true });
			const feedback = page.getByRole('menuitem', { name: locale === 'en' ? 'Give model feedback' : '提供模型反馈', exact: true });
			await expect(feedback).toHaveCount(0);
			const reply = page.locator('[data-item-id="feedback-reply"]');
			const retained = await reply.elementHandle();
			const completed = { ...rows[0], canGiveModelFeedback: true };
			await page.evaluate(({ completed, rows, queueTarget }) => window.ashChatTranscriptIntegration.renderItems([
				completed, rows[1], { ...rows[2], queueTarget },
			]), { completed, rows, queueTarget });
			const more = reply.getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true });
			await more.press('Enter');
			await feedback.click();
			expect(await reply.evaluate((node, previous) => node === previous, retained)).toBe(true);
			await retained?.dispose();
			await action('Edit queued message', '编辑排队消息').press('Space');
			await action('Send queued message immediately', '立即发送排队消息').click();
			await action('Remove queued message', '移除排队消息').click();
			await action('Redo last request', '重做上一条请求').click();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.messageRowCommands())).toEqual([
				{ id: 'workbench.action.chat.openModelFeedbackSurvey', args: [completed] },
				{ id: 'workbench.action.chat.editPendingRequest', args: [queueTarget] },
				{ id: 'workbench.action.chat.sendPendingImmediately', args: [queueTarget] },
				{ id: 'workbench.action.chat.removePendingRequest', args: [queueTarget] },
				{ id: 'workbench.action.chat.redoEdit', args: [historyRedoTarget] },
			]);
		});

		test(`Agent Window sent messages expose only Copy and Edit in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatTranscript.html?sessions&locale=${locale}`);
			const text = 'First line 汉字\n[original](file:///fixture.txt)';
			await page.evaluate(text => window.ashChatTranscriptIntegration.prepareRequestEditing(false, text, true, true), text);
			const row = page.locator('[data-item-id="presentation-entry"]');
			const toolbar = row.getByRole('toolbar', { name: locale === 'en' ? 'Message actions' : '消息操作', exact: true });
			const copy = toolbar.getByRole('button', { name: locale === 'en' ? 'Copy message' : '复制消息', exact: true });
			const edit = toolbar.getByRole('button', { name: locale === 'en' ? 'Edit message' : '编辑消息', exact: true });
			await expect(row.locator('.ash-chat-message-actions').getByRole('button')).toHaveCount(2);
			const copyIcon = copy.locator('[data-ash-icon-id="copy"]');
			const checkIcon = copy.locator('[data-ash-icon-id="check"]');
			await expect(copyIcon).toBeVisible();
			await expect(edit.locator('[data-ash-icon-id="edit"]')).toBeVisible();
			await copy.focus();
			const copyBounds = await copy.boundingBox();
			const editBounds = await edit.boundingBox();
			const iconColor = await copyIcon.evaluate(icon => getComputedStyle(icon).color);
			await page.clock.install();
			await page.clock.pauseAt(new Date());
			await copy.press('Enter');
			await expect(checkIcon).toBeVisible();
			await expect(checkIcon).toHaveCSS('color', iconColor);
			await expect(row.locator('.ash-chat-message-copy-status')).toBeEmpty();
			await expect(copy).toBeFocused();
			expect(await copy.boundingBox()).toEqual(copyBounds);
			expect(await edit.boundingBox()).toEqual(editBounds);
			await page.clock.runFor(1199);
			await expect(checkIcon).toBeVisible();
			await expect(page.locator('.ash-aria-status').filter({ hasText: locale === 'en' ? 'Message copied.' : '消息已复制。' })).toHaveCount(1);
			await page.clock.runFor(1);
			await expect(copyIcon).toBeVisible();
			await page.clock.resume();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(text);
			await page.keyboard.press('ArrowRight');
			await expect(edit).toBeFocused();
			await page.keyboard.press('Space');
			const input = row.getByRole('textbox', { name: locale === 'en' ? 'Edit request' : '编辑请求', exact: true });
			await expect(input).toBeFocused();
			await expect(input).toHaveValue(text);
			await page.keyboard.press('Escape');
			await expect(edit).toBeFocused();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits())).toEqual([]);
		});

		test(`message checkpoint restore targets its request and returns focus on cancel in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatTranscriptIntegration.prepareMessageCheckpoint());
			const action = { name: locale === 'en' ? 'Restore checkpoint' : '恢复检查点', exact: true };
			await expect(page.locator('[data-item-id="request-1"]').getByRole('button', action)).toHaveCount(0);
			const restore = page.locator('[data-item-id="request-2"]').getByRole('button', action);
			await restore.press('Enter');
			const picker = page.getByRole('combobox', { name: locale === 'en' ? 'Choose a checkpoint to restore into a new chat' : '选择要恢复到新对话的检查点' });
			await expect(picker).toBeFocused();
			await expect(page.getByRole('option')).toHaveCount(2);
			await picker.press('Escape');
			await expect(restore).toBeFocused();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.messageCheckpointState())).toEqual({ requests: [], opened: [] });
			await restore.press('Space');
			await picker.fill(locale === 'en' ? 'After this message' : '此消息之后');
			await picker.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.messageCheckpointState().opened)).toEqual(['restored']);
			const { requests } = await page.evaluate(() => window.ashChatTranscriptIntegration.messageCheckpointState());
			expect(requests).toMatchObject([{ sessionId: 'source', threadId: 'original', itemId: 'item-2', boundary: 'after' }]);
		});

		test(`message Fork keeps its focus and click target through progress and failure in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(locale => {
				window.ashChatTranscriptIntegration.setTheme(locale === 'en' ? 'light' : 'hc');
				window.ashChatTranscriptIntegration.prepareMessageFork();
			}, locale);
			const label = locale === 'en' ? 'Fork conversation from this point' : '从此处创建分支对话';
			const fork = page.getByRole('button', { name: label, exact: true });
			await page.evaluate(() => window.ashChatTranscriptIntegration.setMessageForkEnabled(false));
			await expect(fork).toHaveCount(0);
			await page.evaluate(() => window.ashChatTranscriptIntegration.setMessageForkEnabled(true));
			await fork.focus();
			const bounds = await fork.boundingBox();
			await page.keyboard.press('Enter');
			await expect(fork).toHaveAttribute('aria-busy', 'true');
			await expect(fork).toBeFocused();
			expect(await fork.boundingBox()).toEqual(bounds);
			const spinner = await fork.locator('.ash-pixel-spinner').boundingBox();
			expect(Math.abs((spinner!.x + spinner!.width / 2) - (bounds!.x + bounds!.width / 2))).toBeLessThan(1);
			await page.keyboard.press('Enter');
			const source = { sessionId: 'source', threadId: 'original', beforeItemId: 'item-2' };
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.messageForks())).toEqual([{ ...source, toSide: false }]);
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishMessageFork(true));
			await expect(fork).toBeEnabled();
			await expect(fork).toBeFocused();
			await fork.click({ modifiers: ['Alt'] });
			await expect(fork).toHaveAttribute('aria-busy', 'true');
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishMessageFork());
			await expect(fork).toBeEnabled();
			await fork.press('Alt+Enter');
			await expect(fork).toHaveAttribute('aria-busy', 'true');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.messageForks())).toEqual([
				{ ...source, toSide: false }, { ...source, toSide: true }, { ...source, toSide: true },
			]);
			await page.evaluate(async () => {
				window.ashChatTranscriptIntegration.renderItems([]);
				await window.ashChatTranscriptIntegration.finishMessageFork();
			});
			await expect(fork).toHaveCount(0);
		});
	}
	for (const locale of ['en', 'zh-CN']) for (const cowork of [false, true]) for (const theme of ['dark', 'light', 'hc', 'hcLight'] as const) {
		test(`Chat request editing preserves drafts and keyboard focus in ${cowork ? 'Cowork' : 'Code'} ${locale} ${theme}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(({ cowork, theme }) => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				window.ashChatTranscriptIntegration.prepareRequestEditing(cowork);
			}, { cowork, theme });
			const chat = page.locator('#app-chat');
			const composer = chat.locator(':scope > .ash-chat-input-part');
			const draft = composer.locator(cowork ? '.stanza-editor-input' : '.ash-chat-textarea-input');
			const draftClickTarget = cowork ? composer.locator('.stanza-editor-line-text') : draft;
			if (cowork) { await draft.focus(); await page.keyboard.insertText('Unsent private draft'); }
			else await draft.fill('Unsent private draft');
			const card = chat.locator('.ash-chat-user-message > pre');
			const editor = chat.locator('.ash-chat-request-editor');
			const edit = chat.getByRole('button', { name: locale === 'en' ? 'Edit message' : '编辑消息', exact: true });
			await expect(card).toHaveText('Original request');
			await edit.focus();
			await page.keyboard.press('Enter');
			const input = chat.getByRole('textbox', { name: locale === 'en' ? 'Edit request' : '编辑请求', exact: true });
			const expectEditText = async (value: string): Promise<void> => {
				if (cowork) {
					await expect.poll(async () => (await editor.locator('.stanza-editor-line-text').allTextContents()).join('\n').replaceAll('\u00a0', ' ')).toBe(value);
				} else {
					await expect(input).toHaveValue(value);
				}
			};
			const replaceEditText = async (value: string): Promise<void> => {
				await input.press('ControlOrMeta+a');
				await page.keyboard.insertText(value);
			};
			await expect(input).toBeFocused();
			const description = locale === 'en' ? 'Sending creates a new chat from before this request.' : '发送后将从此请求之前创建新聊天';
			await expect(input).toHaveAccessibleDescription(new RegExp(description));
			await expect(editor.getByText(description)).toBeHidden();
			await expectEditText('Original request');
			await expect(card).toBeHidden();
			const send = editor.getByRole('button', { name: locale === 'en' ? 'Send edited request' : '发送编辑后的请求', exact: true });
			if (!cowork) {
				await expect(send).toBeEnabled();
				await expect(send).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				const composerSend = composer.locator('.ash-chat-input-send-action');
				await expect(send.locator('.ash-icon')).toHaveClass((await composerSend.locator('.ash-icon').getAttribute('class'))!);
				await chat.evaluate(element => {
					element.classList.add('ash-sessions-window');
					element.querySelector(':scope > .ash-chat-input-part')!.classList.add('ash-sessions-chat-input');
				});
				await expect(composerSend).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect.poll(() => send.evaluate(button => {
					const { width, height } = button.getBoundingClientRect();
					const radius = parseFloat(getComputedStyle(button).borderTopLeftRadius);
					return width === height && radius > 0 && radius < width / 2;
				})).toBe(true);
				await input.press('ControlOrMeta+a');
				await input.press('Backspace');
				await expect(send).toBeDisabled();
				await expect(send).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			}
			await replaceEditText('Cancelled change');
			await page.keyboard.press('Escape');
			await expect(input).toHaveCount(0);
			await expect(edit).toBeFocused();
			await card.evaluate(element => {
				const selection = element.ownerDocument.getSelection()!;
				selection.selectAllChildren(element);
				element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			});
			await expect(editor).toHaveCount(0);
			expect(await page.evaluate(() => document.getSelection()!.toString())).toBe('Original request');
			await page.evaluate(() => document.getSelection()!.removeAllRanges());
			const cardTop = (await card.boundingBox())!.y;
			await card.click();
			await expect(input).toBeFocused();
			await expectEditText('Original request');
			await expect(card).toBeHidden();
			expect(Math.abs((await editor.boundingBox())!.y - cardTop)).toBeLessThan(1);
			const textArea = editor.locator('.ash-chat-input-editor-host');
			const toolbar = editor.locator('.ash-chat-input-toolbars');
			const toolbarOffset = async (): Promise<number> => {
				const text = (await textArea.boundingBox())!;
				return (await toolbar.boundingBox())!.y - text.y - text.height;
			};
			if (cowork) await expect.poll(toolbarOffset).toBeLessThan(0);
			else await expect.poll(toolbarOffset).toBeGreaterThan(0);
			await replaceEditText('Review the sample workspace and summarize the changes. '.repeat(12));
			await expect.poll(toolbarOffset).toBeGreaterThan(0);
			await expect(input).toBeFocused();
			await expect(editor.getByRole('button', { name: locale === 'en' ? 'Cancel edit' : '取消编辑', exact: true })).toHaveCount(0);
			await replaceEditText('Discarded by outside click');
			if (cowork) await expect.poll(toolbarOffset).toBeLessThan(0);
			else await expect.poll(toolbarOffset).toBeGreaterThan(0);
			await editor.click({ position: { x: 3, y: 3 } });
			await expect(editor).toBeVisible();
			await draftClickTarget.click();
			await expect(editor).toHaveCount(0);
			await expect(draft).toBeFocused();
			await expect(card).toHaveText('Original request');
			await card.click();
			await expectEditText('Original request');
			await replaceEditText('Edited');
			await input.press('Enter');
			await page.keyboard.insertText('request');
			await expectEditText('Edited\nrequest');
			await chat.screenshot({ path: browserTests.info.outputPath('request-editor.png') });
			await expect(chat.locator('.ash-chat-request-editor')).toHaveJSProperty('scrollWidth', await chat.locator('.ash-chat-request-editor').evaluate(element => element.clientWidth));
			await input.press('Control+Enter');
			await expect(chat.locator('.ash-chat-request-editor')).toHaveAttribute('aria-busy', 'true');
			await expect(send).toBeDisabled();
			await draftClickTarget.click();
			await expect(editor).toHaveAttribute('aria-busy', 'true');
			await input.focus();
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishRequestEdit(true));
			await expect(chat.locator('.ash-chat-request-editor > [role="status"]')).toContainText('Synthetic edit failure');
			await expect(input).toBeFocused();
			await expectEditText('Edited\nrequest');
			await input.press('Control+Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits().length)).toBe(2);
			const edits = await page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits());
			expect(edits[0].itemId).toBe('backend-request');
			expect(edits[0].commandId).toBe(edits[1].commandId);
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishRequestEdit());
			await expect(input).toHaveCount(0);
			await expect(edit).toBeFocused();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe('Unsent private draft');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
			if (!cowork) {
				await card.click();
				await expect(editor.locator('.ash-chat-input-part')).toHaveCount(1);
				await expect(editor.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文' })).toBeVisible();
				await input.evaluate(element => {
					const data = new DataTransfer();
					data.items.add(new File(['Synthetic attachment content'], 'sample.txt', { type: 'text/plain' }));
					element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
				});
				await expect.poll(() => input.inputValue()).toContain('sample.txt');
				await input.press('Control+Enter');
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits().length)).toBe(3);
				const [attached] = (await page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits()))[2].contexts ?? [];
				expect(attached).toMatchObject({ name: 'sample.txt', content: 'Synthetic attachment content' });
				await page.evaluate(() => window.ashChatTranscriptIntegration.finishRequestEdit());
				await expect(editor).toHaveCount(0);
				await expect(draft).toHaveValue('Unsent private draft');
			}
			await chat.screenshot({ path: browserTests.info.outputPath('request-editing.png') });
		});
	}

	test('A long request keeps its bubble position when its actions give way to the editor', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?richInput&sessions');
		await page.evaluate(() => window.ashChatTranscriptIntegration.prepareRequestEditing(false,
			Array.from({ length: 20 }, (_, index) => `Review the sample workspace and summarize its changes. Request line ${index + 1}.`).join('\n')));
		const chat = page.locator('#app-chat');
		const row = chat.locator('.ash-chat-user-message');
		const bubble = row.locator(':scope > pre');
		const following = chat.getByText('Following response', { exact: true });
		await following.scrollIntoViewIfNeeded();
		await expect(following).toBeInViewport();
		const original = (await bubble.boundingBox())!;
		const originalRowHeight = (await row.boundingBox())!.height;
		const followingTop = (await following.boundingBox())!.y;
		await page.mouse.click(original.x + original.width / 2, original.y + original.height / 2);
		const edit = chat.locator('.ash-chat-request-editor');
		await expect(edit.getByRole('textbox', { name: 'Edit request' })).toBeFocused();
		await expect(row.getByRole('toolbar', { name: 'Message actions' })).toBeHidden();
		await expect.poll(async () => {
			const bounds = (await edit.boundingBox())!;
			const rowHeightChange = (await row.boundingBox())!.height - originalRowHeight;
			const followingShift = (await following.boundingBox())!.y - followingTop;
			return {
				leftShift: Math.round(bounds.x - original.x),
				topShift: Math.round(bounds.y - original.y),
				widthChange: Math.round(bounds.width - original.width),
				grewDownward: bounds.height > original.height,
				responseFollowsRow: Math.abs(followingShift - rowHeightChange) < 1,
			};
		}).toEqual({ leftShift: 0, topShift: 0, widthChange: 0, grewDownward: true, responseFollowsRow: true });
		await page.keyboard.press('Escape');
		await expect(chat.getByRole('button', { name: 'Edit message', exact: true })).toBeFocused();
		await expect.poll(async () => Math.round((await bubble.boundingBox())!.y - original.y)).toBe(0);
	});

	test('Editing the unanswered last request preserves the bottom layout', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?richInput&sessions');
		await page.evaluate(() => window.ashChatTranscriptIntegration.prepareRequestEditing(false,
			'Inspect the sample workspace and summarize its changes. 请检查示例工作区并总结改动。'.repeat(22), true));
		const chat = page.locator('#app-chat');
		const viewport = chat.locator('.ash-chat-transcript-viewport > .ash-scrollbar-viewport');
		const bubble = chat.locator('.ash-chat-user-message > pre');
		const edit = chat.locator('.ash-chat-request-editor');
		const scrollToBottom = () => viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
		const metrics = () => viewport.evaluate(element => {
			const bubble = element.querySelector('.ash-chat-request-editor, .ash-chat-user-message > pre:not([hidden])')!;
			return {
				top: element.scrollTop,
				maximum: element.scrollHeight - element.clientHeight,
				bubbleTop: Math.round(bubble.getBoundingClientRect().top - element.getBoundingClientRect().top),
				gap: Math.round(element.getBoundingClientRect().bottom - bubble.getBoundingClientRect().bottom),
			};
		});
		// Simulate the read-only layout wrapping into a taller block than the editor.
		await bubble.evaluate(element => { element.style.lineHeight = '36px'; });
		await chat.scrollIntoViewIfNeeded();
		await scrollToBottom();
		await expect.poll(async () => {
			const { top, maximum } = await metrics();
			return top > 0 && top === maximum;
		}).toBe(true);
		const original = await metrics();
		for (const scrollWhileEditing of [false, true]) {
			const bounds = (await bubble.boundingBox())!;
			const visible = (await viewport.boundingBox())!;
			await page.mouse.click(bounds.x + bounds.width / 2, (Math.max(bounds.y, visible.y, 0) + Math.min(bounds.y + bounds.height, visible.y + visible.height)) / 2);
			await expect(edit.getByRole('textbox', { name: 'Edit request' })).toBeFocused();
			await expect.poll(async () => (await metrics()).bubbleTop).toBe(original.bubbleTop);
			if (scrollWhileEditing) {
				await scrollToBottom();
				await chat.locator(':scope > .ash-chat-input-part .ash-chat-input-container').click({ position: { x: 7, y: 7 } });
				await expect(edit).toHaveCount(0);
			} else {
				await page.keyboard.press('Escape');
				await expect(chat.getByRole('button', { name: 'Edit message', exact: true })).toBeFocused();
			}
			await expect.poll(metrics).toEqual(original);
		}
	});

	for (const locale of ['en', 'zh-CN']) test(`Chat follows replies only when enabled, at the bottom, and outside an inline edit (${locale})`, async function () {
		const { page } = browserTests;
		await page.goto(`/chatTranscript.html?richInput&sessions&locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.prepareRequestEditing(false, 'Edit this request', true));
		const chat = page.locator('#app-chat');
		const viewport = chat.locator('.ash-chat-transcript-viewport > .ash-scrollbar-viewport');
		const jump = chat.getByRole('button', { name: locale === 'zh-CN' ? '跳到最新输出' : 'Scroll to Latest', exact: true });
		await chat.scrollIntoViewIfNeeded();
		const scroll = (offset: number) => viewport.evaluate((element, offset) => {
			element.scrollTop = element.scrollHeight - element.clientHeight - offset;
		}, offset);
		const position = () => viewport.evaluate(element => ({ top: element.scrollTop, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
		const reply = async (index: number) => {
			await page.evaluate(index => window.ashChatTranscriptIntegration.appendChatItem({
				id: `live-${index}`, type: 'agentMessage', text: `New reply ${index}\n\n` + 'More response text.\n\n'.repeat(8), transient: true,
			}), index);
			await expect(chat.getByText(`New reply ${index}`, { exact: true })).toBeAttached();
		};
		await scroll(0);
		await reply(1);
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		await expect(jump).toBeHidden();
		await scroll(20);
		await expect(jump).toBeVisible();
		await scroll(20);
		await expect.poll(async () => (await position()).gap).toBe(20);
		const reading = await position();
		await reply(2);
		await expect.poll(position).toMatchObject({ top: reading.top });
		await expect.poll(async () => (await position()).gap).toBeGreaterThan(20);
		await expect(jump).toBeVisible();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setConversationChanges(true));
		const changes = chat.locator('.ash-chat-input-changes');
		await expect(changes.locator('.ash-chat-changes-pill')).toBeVisible();
		await expect(changes.locator('.ash-chat-scroll-to-latest')).toBeVisible();
		await jump.press('Enter');
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		await expect(jump).toBeHidden();
		const latestReply = chat.locator('[data-item-id="live-2"]');
		await expect(latestReply).toBeFocused();
		await expect(latestReply).toHaveCSS('outline-style', 'solid');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setConversationChanges(false));
		await expect(changes).toBeHidden();
		await chat.locator('.ash-chat-user-message > pre').click();
		const edit = chat.locator('.ash-chat-request-editor');
		await expect(edit).toBeVisible();
		await scroll(0);
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		const editing = await position();
		await reply(3);
		await expect.poll(position).toMatchObject({ top: editing.top });
		await expect.poll(async () => (await position()).gap).toBeGreaterThan(20);
		await scroll(0);
		await page.keyboard.press('Escape');
		await expect(edit).toHaveCount(0);
		await reply(4);
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setAutoFollowReplies(false));
		const disabled = await position();
		await reply(5);
		await expect.poll(position).toMatchObject({ top: disabled.top });
		await expect.poll(async () => (await position()).gap).toBeGreaterThan(20);
		await expect(changes.locator('.ash-chat-changes-pill')).toBeHidden();
		await expect(changes.locator('.ash-chat-scroll-to-latest')).toBeVisible();
		await jump.click();
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		const manuallyRevealed = await position();
		await reply(6);
		await expect.poll(position).toMatchObject({ top: manuallyRevealed.top });
		await expect(jump).toBeVisible();
	});

	test('Chat keeps its reading position and bottom following as file changes come and go', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?richInput&sessions');
		await page.evaluate(() => window.ashChatTranscriptIntegration.prepareRequestEditing(false, 'Review the workspace', true));
		const chat = page.locator('#app-chat');
		const list = chat.locator('.ash-chat-transcript-viewport');
		const viewport = list.locator(':scope > .ash-scrollbar-viewport');
		const composer = chat.locator(':scope > .ash-chat-input-part .ash-chat-input-container');
		const row = chat.locator('.ash-chat-input-changes');
		const summary = row.locator('.ash-chat-changes-pill');
		const jump = row.getByRole('button', { name: 'Scroll to Latest' });
		const edgeFade = () => list.evaluate(element => getComputedStyle(element, '::after').backgroundImage);
		const position = () => viewport.evaluate(element => ({ top: element.scrollTop, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
		const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const changes = async (visible: boolean) => {
			await page.evaluate(visible => window.ashChatTranscriptIntegration.setConversationChanges(visible), visible);
			if (visible) await expect(summary).toBeVisible();
			else await expect(summary).toBeHidden();
			await settle();
		};
		const reply = (id: string) => page.evaluate(id => window.ashChatTranscriptIntegration.appendChatItem({
			id, type: 'agentMessage', text: 'Streaming reply text.\n\n'.repeat(20), transient: true,
		}), id);

		await chat.scrollIntoViewIfNeeded();
		await reply('before-toggle');
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		await viewport.evaluate(element => { element.scrollTop -= 140; });
		await expect(jump).toBeVisible();
		await composer.getByRole('textbox').focus();
		const gradient = await edgeFade();
		expect(gradient).toContain('linear-gradient');
		await viewport.focus();
		await expect(viewport).toBeFocused();
		expect(await edgeFade()).toBe(gradient);
		await settle();
		const fadeEdge = await list.evaluate(element => {
			const style = getComputedStyle(element, '::after');
			return { height: parseFloat(style.blockSize), bottom: element.getBoundingClientRect().bottom - parseFloat(style.bottom) };
		});
		const readingTop = (await position()).top;
		const rowTop = (await row.boundingBox())!.y;
		const composerTop = (await composer.boundingBox())!.y;
		expect(fadeEdge.height).toBe(16);
		expect(Math.abs(fadeEdge.bottom - composerTop)).toBeLessThan(1);
		for (const visible of [true, false, true, false]) {
			await changes(visible);
			await expect(jump).toBeVisible();
			expect(Math.abs((await position()).top - readingTop)).toBeLessThan(1);
			expect(Math.abs((await row.boundingBox())!.y - rowTop)).toBeLessThan(1);
			expect(Math.abs((await composer.boundingBox())!.y - composerTop)).toBeLessThan(1);
		}
		await jump.click();
		await expect(row).toBeHidden();
		expect(await edgeFade()).toBe('none');
		for (const [index, visible] of [true, false, true, false].entries()) {
			await page.evaluate(({ index, visible }) => {
				window.ashChatTranscriptIntegration.setConversationChanges(visible);
				window.ashChatTranscriptIntegration.appendChatItem({
					id: `follow-during-toggle-${index}`, type: 'agentMessage', text: 'Another streaming update.\n\n'.repeat(20), transient: true,
				});
			}, { index, visible });
			await settle();
			await expect.poll(async () => (await position()).gap).toBeLessThan(1);
			await expect(jump).toBeHidden();
		}
		await reply('follow-after-toggles');
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);

		await page.evaluate(() => window.ashChatTranscriptIntegration.setAutoFollowReplies(false));
		await viewport.evaluate(element => { element.scrollTop -= 140; });
		await expect(jump).toBeVisible();
		await changes(true);
		await changes(false);
		await jump.click();
		await expect(row).toBeHidden();
		await expect.poll(async () => (await position()).gap).toBeLessThan(1);
		const manuallyRevealed = (await position()).top;
		await reply('remain-paused-after-toggles');
		await expect(jump).toBeVisible();
		await expect.poll(async () => (await position()).top).toBe(manuallyRevealed);
	});

	test('Chat blocks another inline editor while the current edit is submitting', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?richInput&sessions');
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.prepareRequestEditing(false);
			window.ashChatTranscriptIntegration.appendChatItem({
				id: 'second-request', type: 'userMessage', text: 'Second request', transient: false,
				requestSource: { sessionId: 'app-session', threadId: 'app-thread', turnId: 'second-turn', itemId: 'second-item' },
			});
		});
		const chat = page.locator('#app-chat');
		const edit = chat.locator('.ash-chat-request-editor');
		const first = chat.getByRole('button', { name: 'Original request', exact: true });
		const second = chat.getByRole('button', { name: 'Second request', exact: true });
		await first.click();
		await edit.getByRole('textbox').press('Control+Enter');
		await expect(edit).toHaveAttribute('aria-busy', 'true');
		await second.click();
		await expect(edit).toHaveCount(1);
		await expect(second).toBeVisible();
		await page.evaluate(() => window.ashChatTranscriptIntegration.finishRequestEdit(true));
		await expect(edit).not.toHaveAttribute('aria-busy', 'true');
		await second.click();
		await expect(edit).toHaveCount(1);
		await expect(first).toBeVisible();
		await expect(second).toHaveCount(0);
	});

	for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light', 'hc'] as const) {
		test(`Chat bounded history pagination preserves keyboard focus, draft and reading position in ${locale} ${theme}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(theme => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				window.ashChatTranscriptIntegration.showHistoryPagination(true);
			}, theme);
			const chat = page.locator('#app-chat');
			const draft = chat.locator('textarea');
			await draft.fill('Keep this draft');
			const button = chat.getByRole('button', { name: locale === 'en' ? 'Load earlier messages' : '加载更早的消息', exact: true });
			await button.focus();
			await expect(button).toBeFocused();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(true);
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(locale === 'en' ? /Load earlier messages/ : /加载更早的消息/);
			await page.keyboard.press('Escape');
			await expect(button).toBeFocused();
			await page.keyboard.press('Enter');
			const pagination = chat.locator('.ash-chat-history-pagination');
			await expect(pagination).toHaveAttribute('aria-busy', 'true');
			await expect(button).toBeDisabled();
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishHistoryPage());
			const retry = chat.getByRole('button', { name: locale === 'en' ? 'Retry earlier messages' : '重试加载更早的消息', exact: true });
			await expect(retry).toBeFocused();
			await expect(pagination.getByRole('status')).toContainText('Synthetic page failure');
			const viewport = chat.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
			await viewport.evaluate(element => { element.scrollTop = 500; });
			const position = () => chat.locator('[data-item-id="recent-10"]').evaluate(element => {
				const viewport = element.closest('.ash-scrollbar-viewport')!;
				return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
			});
			const before = await position();
			await page.keyboard.press('Space');
			await expect(pagination).toHaveAttribute('aria-busy', 'true');
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishHistoryPage());
			await expect(pagination).toBeHidden();
			await expect(chat.locator('.ash-chat-item')).toHaveCount(50);
			await expect.poll(async () => Math.abs(await position() - before)).toBeLessThan(2);
			const focusedMessage = chat.locator('.ash-chat-item:focus-visible');
			await expect(focusedMessage).toBeFocused();
			await expect(focusedMessage).toBeInViewport();
			await expect(focusedMessage).toHaveCSS('outline-style', 'solid');
			await expect(draft).toHaveValue('Keep this draft');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.historyPageLoads())).toBe(2);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Skill file editing completes header keys and shows their description in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatTranscript.html?prompt=1&locale=${locale}`);
			const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.insertText('de');
			await page.keyboard.press('Control+Space');
			await expect(page.locator('.stanza-editor-completion-label').getByText('description', { exact: true })).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('---\ndescription: \n---\nBody');
			await page.keyboard.press('Home');
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.press('ControlOrMeta+i');
			const help = locale === 'en' ? 'Required. Describe when this Skill should be used, in 1 to 1024 characters.' : '必填。用 1 到 1024 个字符描述何时使用此 Skill。';
			await expect(page.getByText(help, { exact: true }).last()).toBeVisible();
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Response code blocks copy safely, insert with undo and open an unsaved file in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			expect(errors).toEqual([]);
			const block = page.locator('.ash-chat-code-block');
			const copy = block.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
			const insert = block.getByRole('button', { name: locale === 'en' ? 'Insert at cursor' : '插入到光标处', exact: true });
			const apply = block.getByRole('button', { name: locale === 'en' ? 'Apply to editor' : '应用到编辑器', exact: true });
			await expect(apply).toBeVisible();
			const newFile = block.getByRole('button', { name: locale === 'en' ? 'Open in new file' : '在新文件中打开', exact: true });
			await expect(block).toBeVisible();
			await expect(block.locator('img')).toHaveCount(0);
			await copy.focus();
			await copy.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const code = "<safe>";\nsecond line');
			await expect(copy).toBeFocused();
			await copy.press('ArrowRight');
			await expect(apply).toBeFocused();
			await apply.press('ArrowRight');
			await expect(insert).toBeFocused();
			await insert.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('before const code = "<safe>";\nsecond lineafter');
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('before after');
			await newFile.click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state())).toMatchObject({ file: 'const code = "<safe>";\nsecond line', resource: expect.stringContaining('untitled:') });
			await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
			await expect(block).toHaveCount(0);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
			expect(errors).toEqual([]);
		});
	}

	test('Response code blocks preserve nodes and selections through wrapping and theme updates and stay read-only', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const block = page.locator('.ash-chat-code-block');
		const editor = block.locator('.stanza-editor');
		await editor.click();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText('must not replace response');
		await expect(editor.locator('.stanza-editor-line-text')).toHaveText(['const code = "<safe>";', 'second line']);
		const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
		const original = await editor.elementHandle();
		await page.evaluate(() => window.ashChatTranscriptIntegration.refresh());
		expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setWrap(true));
		for (const palette of ['dark', 'light', 'hc'] as const) {
			await page.evaluate(value => window.ashChatTranscriptIntegration.setTheme(value), palette);
			await expect(block).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(block).toHaveCSS('border-top-width', '1px');
		}
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
		await block.getByRole('button', { name: 'Copy', exact: true }).focus();
		await expect(block.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
		await page.evaluate(() => window.ashChatTranscriptIntegration.setReadonly(true));
		await block.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().notifications)).toContain('Could not perform the code block action: Error: The active file editor is read-only.');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('before after');
		await original?.dispose();
	});

	test('Response code blocks cap their viewport while copying the complete long source', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setCodeLineHeight(24));
		const code = await page.evaluate(() => window.ashChatTranscriptIntegration.showLongCode());
		const editor = page.locator('.ash-chat-code-block-editor');
		await expect.poll(() => editor.evaluate(element => element.getBoundingClientRect().height)).toBe(496);
		await page.locator('.ash-chat-code-block').getByRole('button', { name: 'Copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(code);
	});


	for (const locale of ['en', 'zh-CN']) {
		test(`agentHost tool progress retains keyboard focus, expansion and safe content in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatTranscriptIntegration.showTool());
			const tool = page.locator('.ash-chat-tool-invocation');
			const summary = tool.locator(':scope > summary');
			await expect(tool).not.toHaveAttribute('open');
			await expect(summary).toHaveText(locale === 'en' ? 'Run echo "<safe>" · Awaiting result' : '运行 echo "<safe>" · 等待结果');
			await summary.focus();
			await summary.press('Enter');
			await expect(tool).toHaveAttribute('open', '');
			const original = await tool.elementHandle();
			await page.evaluate(() => window.ashChatTranscriptIntegration.updateTool(false));
			expect(await tool.evaluate((element, previous) => element === previous, original)).toBe(true);
			await expect(summary).toBeFocused();
			await expect(tool).toContainText('/remote/project');
			await expect(tool).toContainText('<img src=x onerror=alert(1)>');
			await expect(tool).toContainText('warning');
			await expect(tool.locator('img, script')).toHaveCount(0);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(false))).toBe(true);
			const accessibleText = page.locator('.ash-accessible-view-content');
			await expect(accessibleText).toHaveValue(/<img src=x onerror=alert\(1\)>/);
			await expect(accessibleText).toHaveAttribute('readonly', '');
			await page.evaluate(() => window.ashChatTranscriptIntegration.updateTool(true));
			await expect(accessibleText).toHaveValue(/Denied <script>/);
			await page.keyboard.press('Escape');
			await expect(accessibleText).toHaveCount(0);
			await expect(summary).toBeFocused();
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(true);
			await expect(accessibleText).toHaveValue(locale === 'en' ? /tool summary/ : /工具摘要/);
			await page.keyboard.press('Escape');
			await expect(accessibleText).toHaveCount(0);
			await expect(summary).toHaveText(locale === 'en' ? 'Run echo "<safe>" · Failed' : '运行 echo "<safe>" · 失败');
			await expect(summary).toBeFocused();
			await expect(tool).toHaveAttribute('open', '');
			for (const palette of ['dark', 'light', 'hc'] as const) {
				await page.evaluate(value => window.ashChatTranscriptIntegration.setTheme(value), palette);
				await expect(summary).toHaveCSS('outline-style', 'solid');
				expect(await summary.evaluate(element => getComputedStyle(element).outlineColor === getComputedStyle(element).color)).toBe(false);
			}
			await page.evaluate(() => { document.querySelector<HTMLElement>('main')!.style.width = '180px'; });
			expect(await tool.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			const copyCommand = tool.getByRole('button', { name: locale === 'en' ? 'Copy command and arguments' : '复制命令与参数', exact: true });
			const copyLabel = copyCommand.locator('.ash-button-label');
			await expect(copyCommand).toBeVisible();
			expect(await copyLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await summary.press('Space');
			await expect(tool).not.toHaveAttribute('open');
			await summary.press('Space');
			await expect(tool).toHaveAttribute('open', '');
			await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
			await expect(tool).toHaveCount(0);
			await page.evaluate(() => window.ashChatTranscriptIntegration.dispose());
			await original?.dispose();
			expect(errors).toEqual([]);
		});
	}


	test('streaming Markdown coalesces short active-row appends and supersedes them on correction or removal', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const result = await page.evaluate(async () => {
			const fixture = window.ashChatTranscriptIntegration;
			const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			const history = { id: 'history', type: 'agentMessage', text: 'Earlier reply.', transient: false } as const;
			const reply = { id: 'stream', type: 'agentMessage', text: 'Read [this](https://example.com).\n\nFirst.', transient: true } as const;
			const row = () => document.querySelector('[data-item-id="stream"]');
			const render = (text: string, transient: boolean) => fixture.renderItems([history, { ...reply, text, transient }]);
			const append = (previousText: string, text: string) => fixture.queueStreamingResponse({ previousText, item: { ...reply, text } });
			render(reply.text, true);
			const firstWasSynchronous = row()?.textContent?.includes('First.') === true;
			const earlier = document.querySelector('[data-item-id="history"]');
			const link = row()!.querySelector('a')!;
			link.focus();
			const selection = window.getSelection()!;
			selection.setBaseAndExtent(link.firstChild!, 4, link.firstChild!, 0);
			const next = reply.text + ' Next.';
			const latest = next + ' Latest.';
			const queued = [append(reply.text, next), append(next, latest), append(reply.text, latest + ' Stale.')];
			const stayedQueued = !row()?.textContent?.includes('Next.');
			await frame();
			const displayed = row()?.textContent?.includes('Latest.') && !row()?.textContent?.includes('Stale.');
			const retained = earlier === document.querySelector('[data-item-id="history"]') && link === row()?.querySelector('a');
			const interaction = { focused: document.activeElement === link, selection: selection.toString() };
			append(latest, latest + ' Discarded.');
			render(reply.text + ' Corrected.', false);
			await frame();
			const corrected = row()?.textContent?.includes('Corrected.') && !row()?.textContent?.includes('Discarded.');
			render(reply.text, true);
			append(reply.text, next);
			fixture.setTranscriptVisible(false);
			await frame();
			const stayedHidden = !row()?.textContent?.includes('Next.');
			fixture.setTranscriptVisible(true);
			await frame();
			const shown = row()?.textContent?.includes('Next.') === true;
			append(next, latest);
			fixture.remove();
			await frame();
			return { firstWasSynchronous, queued, stayedQueued, displayed, retained, interaction, corrected, stayedHidden, shown, removed: row() === null };
		});
		expect(result).toEqual({ firstWasSynchronous: true, queued: [true, true, false], stayedQueued: true, displayed: true, retained: true, interaction: { focused: true, selection: 'this' }, corrected: true, stayedHidden: true, shown: true, removed: true });
	});

	test('streaming Markdown retains completed text, one code model, selection and focus through completion', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/chatTranscript.html');
		const first = 'Read this paragraph.\n\n```typescript\nconst first = 1;';
		await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), first);
		const article = page.locator('[data-item-id="stream"]');
		const paragraph = article.locator('p').first();
		const editor = article.locator('.ash-chat-code-block .stanza-editor');
		const original = await editor.elementHandle();
		const paragraphNode = await paragraph.elementHandle();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+A');
		const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
		await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), `${first}\nconst second = 2;`);
		expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
		await expect(editor.locator('.stanza-editor-input')).toBeFocused();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
		const complete = `${first}\nconst second = 2;\n\x60\x60\x60\n\nDone.`;
		await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, true), complete);
		expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
		expect(await paragraph.evaluate((element, previous) => element === previous, paragraphNode)).toBe(true);
		await expect(editor.locator('.stanza-editor-input')).toBeFocused();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(2);
		await article.getByRole('button', { name: 'Copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const first = 1;\nconst second = 2;');
		await paragraph.evaluate(element => { const selection = window.getSelection()!; selection.setBaseAndExtent(element.firstChild!, 5, element.firstChild!, 9); });
		await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, true), `${complete} More.`);
		expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('this');
		await page.evaluate(() => window.ashChatTranscriptIntegration.stream('Rewritten reply.', true));
		await expect(article.locator('.ash-chat-code-block')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
		await original?.dispose();
		await paragraphNode?.dispose();
		expect(errors).toEqual([]);
	});

	test('streaming code updates append without replacing the prefix and reset corrections', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const values = ['initial 中文', 'initial 中文 😀', 'initial 中文 😀\nnext line', 'corrected', 'co', 'co appended'];
		const result = await page.evaluate(values => window.ashChatTranscriptIntegration.inspectCodeUpdates(values), values);
		expect(result.sameModel).toBe(true);
		expect(result.canUndo).toBe(false);
		expect(result.updates.map(update => update.text)).toEqual(values);
		expect(result.updates.map(update => update.reason)).toEqual(['edit', 'edit', 'edit', 'reset', 'reset', 'edit']);
		expect(result.updates.map(update => update.replacedCharacters)).toEqual([0, 0, 0, values[2].length, values[3].length, 0]);
		await page.locator('.ash-chat-code-block').getByRole('button', { name: 'Copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(values.at(-1));
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount)).toBe(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.stream('```typescript\nHidden update 😀', false));
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
		await page.locator('.ash-chat-code-block').getByRole('button', { name: 'Copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('Hidden update 😀');
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
	});

	test('streaming code updates preserve EOL detection, normalized model text and original copied source', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const cases = [
			{ source: '', text: '', eol: '\n' },
			{ source: 'first\r\nsecond', text: 'first\r\nsecond', eol: '\r\n' },
			{ source: 'first\r\nsecond\r\nthird\nfourth', text: 'first\r\nsecond\r\nthird\r\nfourth', eol: '\r\n' },
			{ source: 'first\nsecond\nthird\nfourth', text: 'first\nsecond\nthird\nfourth', eol: '\n' },
			{ source: '', text: '', eol: '\n' },
			{ source: 'first\r\nsecond', text: 'first\r\nsecond', eol: '\r\n' },
			{ source: 'first\nsecond', text: 'first\nsecond', eol: '\n' },
			{ source: 'first\nsecond\nthird', text: 'first\nsecond\nthird', eol: '\n' },
		];
		const count = await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount);
		const result = await page.evaluate(values => window.ashChatTranscriptIntegration.inspectRawCodeUpdates(values), cases.map(value => value.source));
		expect(result.snapshots).toEqual(cases.map(value => ({ text: value.text, eol: value.eol, copied: value.source })));
		expect(result.released).toBe(true);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(count);
	});

	test('streaming Markdown large tails preserve complete content through corrections', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		for (const kind of ['hugeParagraph', 'mathCandidates', 'largeList', 'largeTable'] as const) {
			const source = await page.evaluate(kind => window.ashChatTranscriptIntegration.markdownWorkload(kind), kind);
			const step = Math.ceil(source.length / 16);
			for (let end = step; end < source.length; end += step) {
				const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, false), source.slice(0, end));
				expect(state.actual, `${kind} prefix ${end}`).toBe(state.expected);
			}
			for (const value of [source, source.replace(/bold/gu, 'corrected'), source.slice(0, step), 'Replaced.', '']) {
				const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true), value);
				expect(state.actual, kind).toBe(state.expected);
			}
		}
	});

	test('streaming Markdown large paragraphs preserve inline semantics through corrections', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const prose = 'Streaming **Markdown** with [a link](https://example.com) and `inline code`. 中文内容保持完整。 '.repeat(96);
		const source = prose + String.raw`\$escaped\$ \\(escaped\\) $x$ \(y\)` + '\n\nFinal visible marker.';
		for (let end = 512; end < source.length; end += 512) {
			const value = source.slice(0, end);
			const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, false), value);
			expect(state.actual, `prefix ${end}`).toBe(state.expected);
		}
		for (const value of [source, source.replace(/Markdown/gu, 'corrected'), 'Replaced.', '']) {
			const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true), value);
			expect(state.actual).toBe(state.expected);
		}
	});

	test('streaming Markdown checkpoints retain stable children and reparse changed structure', async function () {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		for (const [kind, rows] of [['hugeParagraph'], ['largeList', 32], ['largeList'], ['largeTable']] as const) {
			const label = rows ? `${kind} at ${rows} items` : kind;
			const result = await page.evaluate(async ({ kind, rows }) => {
				const fixture = window.ashChatTranscriptIntegration;
				const root = () => document.querySelector('[data-item-id="stream"] .ash-chat-markdown-part')!;
				const body = fixture.markdownWorkload(kind).split('\n\n')[0];
				const prefix = rows ? body.split('\n', rows).join('\n') : body;
				const [selector, addition, structuralChange] = {
					hugeParagraph: ['strong', ' New **tail**.', '\n---'],
					largeList: ['li', '\n- New item.', '\n\n- Loose item.'],
					largeTable: ['tbody tr', '\n| New | **cell** | Tail |', '\nA row | without | a leading pipe'],
				}[kind];
				fixture.remove();
				await fixture.compareStreamingMarkdown(prefix, false);
				const stable = root().querySelector(selector);
				const appended = prefix + addition;
				const afterAppend = await fixture.compareStreamingMarkdown(appended, false);
				const retained = stable !== null && root().querySelector(selector) === stable;
				const afterCompletion = await fixture.compareStreamingMarkdown(appended + '\n \t\nA new final paragraph.', true);
				const retainedOnCompletion = stable !== null && root().querySelector(selector) === stable;
				fixture.remove();
				await fixture.compareStreamingMarkdown(appended, false);
				const afterStructure = await fixture.compareStreamingMarkdown(appended + structuralChange, false);
				const corrected = appended.replace(kind === 'hugeParagraph' ? 'Markdown' : kind === 'largeList' ? 'Item 0' : 'Row 0', 'Corrected');
				const afterCorrection = await fixture.compareStreamingMarkdown(corrected, true);
				return { retained, retainedOnCompletion, afterAppend, afterCompletion, afterStructure, afterCorrection };
			}, { kind, rows });
			expect(result.retained, label).toBe(true);
			expect(result.retainedOnCompletion, `${label} completion`).toBe(true);
			expect(result.afterAppend.actual, `${label} append`).toBe(result.afterAppend.expected);
			expect(result.afterCompletion.actual, `${label} completion`).toBe(result.afterCompletion.expected);
			expect(result.afterStructure.actual, `${label} structure change`).toBe(result.afterStructure.expected);
			expect(result.afterCorrection.actual, `${label} correction`).toBe(result.afterCorrection.expected);
			expect(result.afterCorrection.actual).toContain('Corrected');
		}
	});

	test('streaming Markdown resolves a final reference definition in committed list items', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		const result = await page.evaluate(async () => {
			const fixture = window.ashChatTranscriptIntegration;
			const source = fixture.markdownWorkload('largeList').split('\n\n')[0].replace('Item 0:', 'Item 0: [reference][target]');
			await fixture.compareStreamingMarkdown(source, false);
			return fixture.compareStreamingMarkdown(source + '\n\n[target]: https://example.org/target\n\nDone.', true);
		});
		expect(result.actual).toBe(result.expected);
		expect(result.actual).toContain('href="https://example.org/target"');
	});

	test('streaming Markdown fences, lists and corrections match a complete render at every boundary', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const sources = [
			'Before.\n\n```typescript\nconst value = "中文 😀";\nconst next = 2;\n```\n\nAfter.',
			'````typescript\nconst x = 1;\n```\nkeep\n````\n\nAfter.',
			'```ts\nx\n```oops\n```\nTail.',
			'~~~js\nconst a = 1;\n~~~~\nTail.',
			'   ```typescript\n    x\n   ```\n\nTail.',
			'Before.\n\n- item\n  ```ts\n  code\n  ```\n\nTail.',
			'Before.\n\n    indented\n\n    continued\n\nTail.',
			'```math\nx^2\n```\n\nTail.',
			'- [ ] first\n- [x] second\n\nTail.',
		];
		for (const source of sources) {
			await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
			for (let end = 1; end <= source.length; end++) {
				const value = source.slice(0, end);
				const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, false), value);
				expect(state.actual, `prefix ${end}: ${value}`).toBe(state.expected);
			}
			for (const value of [source, `Inserted.\n\n${source}`, source.replace(/const|item|indented|first/u, 'corrected'), 'Replaced.', '']) {
				const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true), value);
				expect(state.actual, `correction: ${value}`).toBe(state.expected);
			}
		}
		for (const value of ['    first\n\nOutside.', '    first\n\n    continued.', '- first\n\nOutside.', '- first\n\n  ```ts\n  continued\n  ```']) {
			const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true), value);
			expect(state.actual, `merge correction: ${value}`).toBe(state.expected);
		}
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`streaming Markdown large tail jobs retain selection and focus and retire hidden work in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatTranscript.html?locale=${locale}`);
			const prefix = 'Read **stable** [Open](https://example.com) &lt;literal&gt; content. '.repeat(128);
			await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value + 'initial', false), prefix);
			const article = page.locator('[data-item-id="stream"]');
			await expect(article).toContainText('initial');
			const strong = article.locator('strong').first();
			const retained = await strong.elementHandle();
			const link = article.locator('a').first();
			await strong.evaluate(element => window.getSelection()!.setBaseAndExtent(element.firstChild!, 6, element.firstChild!, 1));
			await link.focus();
			await page.evaluate(prefix => {
				let appended = prefix + 'initial';
				for (let index = 0; index < 8; index++) {
					appended += ` terminal ${index}`;
					window.ashChatTranscriptIntegration.stream(appended, index === 7);
				}
			}, prefix);
			await expect(article).toContainText('terminal 7');
			expect(await strong.evaluate((element, old) => element === old, retained)).toBe(true);
			expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('table');
			await expect(link).toBeFocused();
			await page.evaluate(prefix => {
				window.ashChatTranscriptIntegration.stream(prefix + 'hidden final', true);
				window.ashChatTranscriptIntegration.setTranscriptVisible(false);
			}, prefix);
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
			await expect(article).not.toContainText('hidden final');
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
			await expect(article).toContainText('hidden final');
			await page.evaluate(prefix => {
				window.ashChatTranscriptIntegration.stream(prefix + 'retired', true);
				window.ashChatTranscriptIntegration.remove();
			}, prefix);
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
			await expect(page.locator('[data-item-id="stream"]')).toHaveCount(0);
			await retained?.dispose();
		});

		test(`streaming Markdown corrections preserve backward selection, toolbar focus and hidden code in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatTranscript.html?locale=${locale}`);
			const source = 'Read this paragraph.\n\n```typescript\nconst first = 1;\n```\n\nTail.';
			await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, true), source);
			const article = page.locator('[data-item-id="stream"]');
			const paragraph = article.locator('p').first();
			const node = await paragraph.elementHandle();
			await paragraph.evaluate(element => { window.getSelection()!.setBaseAndExtent(element.firstChild!, 9, element.firstChild!, 5); });
			await page.evaluate(value => window.ashChatTranscriptIntegration.stream('Inserted.\n\n' + value, true), source);
			expect(await article.locator('p').nth(1).evaluate((element, old) => element === old, node)).toBe(true);
			expect(await page.evaluate(() => { const selection = window.getSelection()!; return [selection.toString(), selection.anchorOffset, selection.focusOffset]; })).toEqual(['this', 9, 5]);
			const copy = article.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
			await copy.focus();
			const revised = source.replace('const first = 1;', 'const corrected = 2;');
			await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), revised);
			await expect(copy).toBeFocused();
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const corrected = 2;');
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
			await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value.replace('2;', '3;') + '\n\nDone.', true), revised);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount)).toBe(0);
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
			await copy.focus();
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const corrected = 3;');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(2);
			await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
			await node?.dispose();
		});
	}

	for (const theme of ['dark', 'light', 'hc', 'hcLight'] as const) {
		test(`streaming Markdown block layout matches a complete render in ${theme}`, async function () {
			const { page } = browserTests;

			await page.goto('/chatTranscript.html');
			await page.evaluate(theme => window.ashChatTranscriptIntegration.setTheme(theme), theme);
			const source = '# Heading\n\nFirst paragraph with **bold** text.\n\n> Quoted text.\n\n- one\n- two\n\n| Column | Value |\n| --- | --- |\n| a | b |\n\nLast paragraph.';
			for (const value of [source.slice(0, 76), source, `Inserted.\n\n${source}`]) {
				const state = await page.evaluate(value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true, true), value);
				expect(state.actual).toBe(state.expected);
				expect(state.layoutError, JSON.stringify(state.layout)).toBeLessThan(1);
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Skill YAML editing shows precise draft diagnostics, repairs them and completes the directory name in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?prompt=1&locale=${locale}`);
			const invalid = '---\nname: review\ndescription: [one, two]\nmetadata:\n  owner: [editor]\nmodel: unknown\n---';
			await page.evaluate(value => window.ashChatTranscriptIntegration.setFile(value, 3, 15), invalid);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.diagnostics().map(marker => marker.code))).toEqual(['textField', 'metadataShape', 'unknownField']);
			const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.press('ControlOrMeta+i');
			await expect(page.getByText(locale === 'en' ? 'The Skill field description requires a text value.' : 'Skill 字段 description 需要文本值。', { exact: true }).last()).toBeVisible();
			await page.keyboard.press('Escape');
			await page.evaluate(() => window.ashChatTranscriptIntegration.setFile('---\n"name": review\ndescription: >-\n  Review changes.\nmetadata: { owner: editor }\n---', 2, 3));
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.diagnostics())).toEqual([]);
			await page.evaluate(() => window.ashChatTranscriptIntegration.setFile('---\nname: re\ndescription: Review\n---', 2, 9));
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('Control+Space');
			await expect(page.locator('.stanza-editor-completion-label').getByText('review', { exact: true })).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('---\nname: review\ndescription: Review\n---');
			await page.evaluate(() => window.ashChatTranscriptIntegration.setFile('---\nname: review\ndescription: Review\nallowed-tools: re\n---', 4, 18));
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('Control+Space');
			await expect(page.locator('.stanza-editor-completion-label').getByText('read_file', { exact: true })).toBeVisible();
			await expect(page.locator('.stanza-editor-completion-label').getByText('internal_tool', { exact: true })).toHaveCount(0);
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('---\nname: review\ndescription: Review\nallowed-tools: read_file\n---');
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Skill reference commands resolve nested files with their original authority and readonly model in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?prompt=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatTranscriptIntegration.openSkill());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource)).toContain('/review/SKILL.md');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.referenceReady(5, 11))).toBe(true);
			await page.evaluate(() => window.ashChatTranscriptIntegration.openReference(5, 11));
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('Reference guide.\n\n[Next](nested/checks.md)');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource)).toContain('/review/references/guide.md');
			await page.keyboard.insertText('must not edit');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('Reference guide.\n\n[Next](nested/checks.md)');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.referenceReady(3, 10))).toBe(true);
			await page.evaluate(() => window.ashChatTranscriptIntegration.openReference(3, 10));
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('Nested reference.');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.skillRequests())).toEqual(['SKILL.md', 'references/guide.md', 'references/nested/checks.md'].map(path => [{ id: { source: 'user:review', name: 'review' }, version: { type: 'pinnedDigest', digest: `sha256:${'a'.repeat(64)}` } }, path, 'reference-session']));
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`MCP resources retain exact bytes, readonly editors and safe keyboard disclosure in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatTranscriptIntegration.showArtifacts(false));
			const tool = page.locator('.ash-chat-tool-invocation');
			await tool.locator(':scope > summary').click();
			const rows = tool.locator('.ash-chat-resources details');
			await expect(rows).toHaveCount(3);
			const textRow = rows.nth(0);
			const jsonRow = rows.nth(1);
			await textRow.locator('summary').focus();
			await page.keyboard.press('Enter');
			await expect(textRow).toHaveAttribute('open', '');
			await expect(textRow.locator('pre')).toContainText('<script>window.compromised = true</script>');
			await expect(tool.locator('script,img')).toHaveCount(0);
			const open = locale === 'en' ? 'Open resource' : '打开资源';
			const copy = locale === 'en' ? 'Copy content' : '复制内容';
			await textRow.getByRole('button', { name: copy }).click();
			const raw = '<script>window.compromised = true</script>\r\n中文';
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(raw);
			await textRow.getByRole('button', { name: open }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource)).toMatch(/^chat-response-resource:/u);
			const resource = await page.evaluate(() => window.ashChatTranscriptIntegration.state().resource);
			expect(await page.evaluate(uri => window.ashChatTranscriptIntegration.readResource(uri), resource)).toEqual([...new TextEncoder().encode(raw)]);
			const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.insertText('should not edit');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe(raw);
			await jsonRow.locator('summary').click();
			const original = await jsonRow.elementHandle();
			await jsonRow.getByRole('button', { name: copy }).focus();
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('{"amount":1.0,"text":"<img src=x onerror=alert(1)>"}');
			await page.evaluate(() => window.ashChatTranscriptIntegration.showArtifacts(true));
			expect(await jsonRow.evaluate((element, previous) => element === previous, original)).toBe(true);
			await expect(jsonRow.getByRole('button', { name: copy })).toBeFocused();
			await expect(rows.nth(0).locator('summary')).toHaveText(locale === 'en' ? 'Resource: file:///untrusted/report.md' : '资源：file:///untrusted/report.md');
			await rows.nth(0).locator('summary').click();
			await expect(rows.nth(0)).toContainText(locale === 'en' ? 'Truncated content' : '内容已截断');
			await page.keyboard.press('Tab');
			await jsonRow.getByRole('button', { name: copy }).focus();
			for (const palette of ['dark', 'light', 'hc'] as const) {
				await page.evaluate(value => window.ashChatTranscriptIntegration.setTheme(value), palette);
				await expect(jsonRow).toHaveCSS('border-left-width', '1px');
				await expect(jsonRow.getByRole('button', { name: copy })).toHaveCSS('outline-style', 'solid');
			}
			await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
			await expect(rows).toHaveCount(0);
			expect(await page.evaluate(async uri => { try { await window.ashChatTranscriptIntegration.readResource(uri); return false; } catch { return true; } }, resource)).toBe(true);
			await original?.dispose();
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Cowork reopens the original immutable terminal preview from its persisted draft in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatTranscriptIntegration.showChatApp(false, true));
			await page.evaluate(() => window.ashChatTranscriptIntegration.addTerminalContext());
			const context = { id: 'terminal:saved', kind: 'terminal', name: 'Terminal: saved', content: 'Saved terminal context', resource: 'internal://terminal?id=saved', terminalSnapshot: { text: 'Saved <script>unsafe()</script>\nTerminal output', columns: 80 }, reference: { start: 0, end: 15 } };
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft())).toEqual({ mode: 'plan', text: 'Terminal: saved ', contexts: [context] });
			await page.evaluate(() => window.ashChatTranscriptIntegration.showChatApp(false, true));
			const chat = page.locator('#app-chat');
			const preview = chat.getByRole('button', { name: locale === 'en' ? 'Preview terminal snapshot' : '预览终端快照', exact: true });
			await expect(preview).toBeVisible();
			await preview.click();
			const input = page.getByRole('textbox', { name: locale === 'en' ? 'Saved terminal output (read only)' : '已保存的终端输出（只读）', exact: true });
			await expect(input).toHaveAttribute('readonly', '');
			await expect(page.locator('.ash-chat-terminal-preview-screen .xterm')).toBeVisible();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft())).toEqual({ mode: 'plan', text: 'Terminal: saved ', contexts: [context] });
			await chat.getByRole('button', { name: locale === 'en' ? 'Remove Terminal: saved' : '移除 Terminal: saved', exact: true }).click();
			await expect(page.locator('.ash-chat-terminal-preview-screen')).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft())).toBeUndefined();
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const cowork of [false, true]) {
			test(`${cowork ? 'Cowork' : 'Chat'} accepted context is inspectable without execution and preserves keyboard focus in ${locale}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatTranscript.html?locale=${locale}`);
				const text = '<img src=x onerror=alert(1)>\nExact accepted text 汉字\n' + 'unbroken'.repeat(60);
				await page.evaluate(({ text, cowork }) => window.ashChatTranscriptIntegration.showAcceptedContext(text, cowork), { text, cowork });
				const context = page.locator('.ash-chat-context');
				const summary = context.locator('summary'); const body = context.locator('pre');
				await expect(body).toBeHidden(); await summary.focus(); await summary.press('Enter');
				await expect(body).toBeVisible(); await expect(body).toHaveText(text); await expect(context.locator('img')).toHaveCount(0);
				await summary.press('Tab'); await expect(body).toBeFocused();
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateAcceptedContext('Revised exact body 汉字'));
				await expect(body).toBeFocused(); await expect(body).toHaveText('Revised exact body 汉字');
				for (const theme of ['dark', 'light', 'hc'] as const) {
					await page.evaluate(theme => { window.ashChatTranscriptIntegration.setTheme(theme); document.querySelector<HTMLElement>('.ash-chat-context')!.closest('main')!.style.width = '220px'; }, theme);
					await expect(body).toBeFocused();
					expect(await body.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
					expect(await body.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
				}
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(0);
				await summary.focus(); await summary.press('Space'); await expect(body).toBeHidden();
				await expect(summary).toBeFocused();
			});
		}
	}

	for (const cowork of [false, true]) {
		for (const locale of ['en', 'zh-CN']) {
			test(`message copy uses exact current source and owns asynchronous feedback (${cowork ? 'Cowork' : 'Chat'}, ${locale})`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatTranscript.html?locale=${locale}`);
				const text = '**Hello** 汉字\n\n[link](https://example.com)\n\n<unsafe>raw source</unsafe>';
				await page.evaluate(({ text, cowork }) => window.ashChatTranscriptIntegration.showCopiedMessage(text, cowork), { text, cowork });
				const row = page.locator('[data-item-id="copy-response"]');
				await expect(row).toHaveAccessibleName('Ash');
				await expect(row.getByText('Ash', { exact: true })).toHaveCount(0);
				const footer = row.getByRole('toolbar', { name: locale === 'zh-CN' ? '回复操作' : 'Response actions', exact: true });
				const button = footer.getByRole('button', { name: locale === 'zh-CN' ? '复制消息' : 'Copy message', exact: true });
				await expect(button).toHaveText('', { useInnerText: true });
				await expect(row.getByRole('button', { name: locale === 'zh-CN' ? '朗读' : 'Read aloud', exact: true })).toHaveCount(0);
				for (const theme of ['dark', 'light', 'hc'] as const) {
					await page.evaluate(theme => { window.ashChatTranscriptIntegration.setTheme(theme); document.querySelector<HTMLElement>('[data-item-id="copy-response"]')!.closest('main')!.style.width = '220px'; }, theme);
					await button.focus(); await page.keyboard.press('Enter');
					await expect(row.locator('.ash-chat-message-copy-status')).toBeEmpty();
					await expect(button.locator('[data-ash-icon-id="check"]')).toBeVisible();
					await expect(button).toBeFocused();
					expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(text);
					expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
				}
				await page.evaluate(() => window.ashChatTranscriptIntegration.holdClipboard());
				await button.focus(); await page.keyboard.press('Space'); await expect(button).toHaveAttribute('aria-busy', 'true'); await expect(button).toBeFocused();
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateCopiedMessage('A corrected response'));
				await page.evaluate(() => window.ashChatTranscriptIntegration.releaseClipboard());
				await expect(row.locator('.ash-chat-message-copy-status')).toHaveText('');
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(text);
				await row.getByRole('button', { name: locale === 'zh-CN' ? '复制消息' : 'Copy message', exact: true }).click();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('A corrected response');
				await page.evaluate(() => window.ashChatTranscriptIntegration.holdClipboard(true));
				await row.getByRole('button', { name: locale === 'zh-CN' ? '复制消息' : 'Copy message', exact: true }).click();
				await page.evaluate(() => window.ashChatTranscriptIntegration.releaseClipboard());
				await expect(row.locator('.ash-chat-message-copy-status')).toContainText(locale === 'zh-CN' ? '无法复制消息' : 'Could not copy message');
				await page.evaluate(() => window.ashChatTranscriptIntegration.clearCopiedMessage());
				await expect(row).toHaveCount(0);
			});
		}
	}

	for (const cowork of [false, true]) {
		for (const locale of ['en', 'zh-CN']) {
			test(`Desktop response read aloud follows the Speech extension and row cancellation (${cowork ? 'Cowork' : 'Chat'}, ${locale})`, async function () {
				const { page } = browserTests;

				const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
				await page.goto(`/chatTranscript.html?locale=${locale}`);
				await page.evaluate(({ cowork }) => window.ashChatTranscriptIntegration.showReadAloudMessage('**Hello** 世界', cowork), { cowork });
				const row = page.locator('[data-item-id="copy-response"]');
				const footer = row.getByRole('toolbar', { name: locale === 'zh-CN' ? '回复操作' : 'Response actions', exact: true });
				const copy = footer.getByRole('button', { name: locale === 'zh-CN' ? '复制消息' : 'Copy message', exact: true });
				const read = () => footer.getByRole('button', { name: locale === 'zh-CN' ? '朗读' : 'Read aloud', exact: true });
				const stop = () => footer.getByRole('button', { name: locale === 'zh-CN' ? '停止朗读' : 'Stop reading aloud', exact: true });
				let count = 0;
				for (const theme of ['dark', 'light', 'hc'] as const) {
					await page.evaluate(theme => { window.ashChatTranscriptIntegration.setTheme(theme); document.querySelector<HTMLElement>('[data-item-id="copy-response"]')!.closest('main')!.style.width = '220px'; }, theme);
					await expect(footer.getByRole('button').first()).toHaveAccessibleName(locale === 'zh-CN' ? '复制消息' : 'Copy message');
					await copy.focus();
					await page.keyboard.press('ArrowRight');
					await expect(read()).toBeFocused();
					await page.keyboard.press('Enter'); await expect(stop()).toBeFocused();
					await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
					expect(await page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.at(-1))).toBe('Hello 世界');
					expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
					await page.evaluate(() => window.ashChatTranscriptIntegration.finishReadAloud());
					await expect(read()).toBeFocused();
					await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				}
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateCopiedMessage('Still streaming', true));
				await expect(read()).toBeDisabled();
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateCopiedMessage('Completed reply'));
				await read().click(); await expect(stop()).toBeVisible();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await stop().click(); await expect(read()).toBeVisible();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				await read().click();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await page.evaluate(() => { document.body.focus(); return window.ashChatTranscriptIntegration.stopReadAloudCommand(); });
				await expect(read()).toBeVisible();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				await read().focus(); await page.keyboard.press('Space');
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await page.keyboard.press('Escape'); await expect(read()).toBeFocused();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				await read().click();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.finishReadAloud(true));
				await expect(row.locator('.ash-chat-message-read-status')).toContainText(locale === 'zh-CN' ? '无法朗读回复' : 'Could not read response aloud');
				await expect(read()).toBeVisible();
				await read().click();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateCopiedMessage('Corrected source'));
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				await expect(row.locator('.ash-chat-message-read-status')).toHaveText('');
				await read().click();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(false));
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(true));
				await read().click();
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length)).toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.clearCopiedMessage());
				await expect(row).toHaveCount(0);
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open)).toBe(0);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
				await page.evaluate(() => { window.ashChatTranscriptIntegration.updateCopiedMessage('Provider retired'); window.ashChatTranscriptIntegration.revokeReadAloudProvider(); });
				await expect(read()).toHaveCount(0);
				expect(errors).toEqual([]);
			});
		}
	}

});
