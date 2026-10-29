import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('chatTranscript browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN'])
		for (const cowork of [false, true])
			for (const theme of ['dark', 'light', 'hc', 'hcLight'] as const) {
				test(`Chat request editing preserves drafts and keyboard focus in ${cowork ? 'Cowork' : 'Code'} ${locale} ${theme}`, async function () {
					const { page } = browserTests;

					await page.goto(`/chatTranscript.html?locale=${locale}`);
					await page.evaluate(
						({ cowork, theme }) => {
							window.ashChatTranscriptIntegration.setTheme(theme);
							window.ashChatTranscriptIntegration.prepareRequestEditing(cowork);
						},
						{ cowork, theme },
					);
					const chat = page.locator('#app-chat');
					const draft = chat.locator(cowork ? '.stanza-editor-input' : '.ash-chat-textarea-input');
					if (cowork) {
						await draft.focus();
						await page.keyboard.insertText('Unsent private draft');
					} else await draft.fill('Unsent private draft');
					const edit = chat.getByRole('button', {
						name: locale === 'en' ? 'Edit message' : '编辑消息',
						exact: true,
					});
					await edit.focus();
					await page.keyboard.press('Enter');
					const input = chat.getByRole('textbox', {
						name: locale === 'en' ? 'Edit request' : '编辑请求',
						exact: true,
					});
					await expect(input).toBeFocused();
					await expect(input).toHaveValue('Original request');
					await input.fill('Cancelled change');
					await page.keyboard.press('Escape');
					await expect(input).toHaveCount(0);
					await expect(edit).toBeFocused();
					await edit.press('Space');
					await input.fill('Edited\nrequest');
					await chat.screenshot({ path: browserTests.info.outputPath('request-editor.png') });
					await expect(chat.locator('.ash-chat-request-editor')).toHaveJSProperty(
						'scrollWidth',
						await chat.locator('.ash-chat-request-editor').evaluate(element => element.clientWidth),
					);
					await input.press('Control+Enter');
					await expect(chat.locator('.ash-chat-request-editor')).toHaveAttribute('aria-busy', 'true');
					const send = chat.getByRole('button', {
						name: locale === 'en' ? 'Send edited request' : '发送编辑后的请求',
						exact: true,
					});
					await expect(send).toBeDisabled();
					await page.evaluate(() => window.ashChatTranscriptIntegration.finishRequestEdit(true));
					await expect(chat.locator('.ash-chat-request-editor [role="status"]')).toContainText(
						'Synthetic edit failure',
					);
					await expect(input).toBeFocused();
					await expect(input).toHaveValue('Edited\nrequest');
					await input.press('Control+Enter');
					await expect
						.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits().length))
						.toBe(2);
					const edits = await page.evaluate(() => window.ashChatTranscriptIntegration.requestEdits());
					expect(edits[0].itemId).toBe('backend-request');
					expect(edits[0].commandId).toBe(edits[1].commandId);
					await page.evaluate(() => window.ashChatTranscriptIntegration.finishRequestEdit());
					await expect(input).toHaveCount(0);
					await expect(edit).toBeFocused();
					await expect
						.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft()))
						.toBe('Unsent private draft');
					expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
					await chat.screenshot({ path: browserTests.info.outputPath('request-editing.png') });
				});
			}

	for (const locale of ['en', 'zh-CN'])
		for (const theme of ['dark', 'light', 'hc'] as const) {
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
				const button = chat.getByRole('button', {
					name: locale === 'en' ? 'Load earlier messages' : '加载更早的消息',
					exact: true,
				});
				await button.focus();
				await expect(button).toBeFocused();
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(
					true,
				);
				await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
					locale === 'en' ? /Load earlier messages/ : /加载更早的消息/,
				);
				await page.keyboard.press('Escape');
				await expect(button).toBeFocused();
				await page.keyboard.press('Enter');
				const pagination = chat.locator('.ash-chat-history-pagination');
				await expect(pagination).toHaveAttribute('aria-busy', 'true');
				await expect(button).toBeDisabled();
				await page.evaluate(() => window.ashChatTranscriptIntegration.finishHistoryPage());
				const retry = chat.getByRole('button', {
					name: locale === 'en' ? 'Retry earlier messages' : '重试加载更早的消息',
					exact: true,
				});
				await expect(retry).toBeFocused();
				await expect(pagination.getByRole('status')).toContainText('Synthetic page failure');
				const viewport = chat.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
				await viewport.evaluate(element => {
					element.scrollTop = 500;
				});
				const position = () =>
					chat.locator('[data-item-id="recent-10"]').evaluate(element => {
						const viewport = element.closest('.ash-scrollbar-viewport')!;
						return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
					});
				const before = await position();
				await page.keyboard.press('Space');
				await expect(pagination).toHaveAttribute('aria-busy', 'true');
				await page.evaluate(() => window.ashChatTranscriptIntegration.finishHistoryPage());
				await expect(pagination).toBeHidden();
				await expect(chat.locator('.ash-chat-item')).toHaveCount(50);
				await expect.poll(async () => Math.abs((await position()) - before)).toBeLessThan(2);
				await expect(chat.getByRole('log')).toBeFocused();
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
			await expect(
				page.locator('.stanza-editor-completion-label').getByText('description', { exact: true }),
			).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('---\ndescription: \n---\nBody');
			await page.keyboard.press('Home');
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.press('ControlOrMeta+i');
			const help =
				locale === 'en'
					? 'Required. Describe when this Skill should be used, in 1 to 1024 characters.'
					: '必填。用 1 到 1024 个字符描述何时使用此 Skill。';
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
			const insert = block.getByRole('button', {
				name: locale === 'en' ? 'Insert at cursor' : '插入到光标处',
				exact: true,
			});
			const newFile = block.getByRole('button', {
				name: locale === 'en' ? 'Open in new file' : '在新文件中打开',
				exact: true,
			});
			await expect(block).toBeVisible();
			await expect(block.locator('img')).toHaveCount(0);
			await copy.focus();
			await copy.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
				.toBe('const code = "<safe>";\nsecond line');
			await expect(copy).toBeFocused();
			await copy.press('ArrowRight');
			await expect(insert).toBeFocused();
			await insert.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('before const code = "<safe>";\nsecond lineafter');
			await page.keyboard.press('ControlOrMeta+z');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('before after');
			await newFile.click();
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state()))
				.toMatchObject({
					file: 'const code = "<safe>";\nsecond line',
					resource: expect.stringContaining('untitled:'),
				});
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
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().notifications))
			.toContain('Could not perform the code block action: Error: The active file editor is read-only.');
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
			.toBe('before after');
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
			const summary = tool.locator('summary');
			await expect(tool).not.toHaveAttribute('open');
			await expect(summary).toHaveText(locale === 'en' ? 'shell · Awaiting result' : 'shell · 等待结果');
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
			await expect(summary).toHaveText(locale === 'en' ? 'shell · Failed' : 'shell · 失败');
			await expect(summary).toBeFocused();
			await expect(tool).toHaveAttribute('open', '');
			for (const palette of ['dark', 'light', 'hc'] as const) {
				await page.evaluate(value => window.ashChatTranscriptIntegration.setTheme(value), palette);
				await expect(summary).toHaveCSS('outline-style', 'solid');
				expect(
					await summary.evaluate(
						element => getComputedStyle(element).outlineColor === getComputedStyle(element).color,
					),
				).toBe(false);
			}
			await page.evaluate(() => {
				document.querySelector<HTMLElement>('main')!.style.width = '180px';
			});
			expect(await tool.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
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
		await page.evaluate(
			value => window.ashChatTranscriptIntegration.stream(value, false),
			`${first}\nconst second = 2;`,
		);
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
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
			.toBe('const first = 1;\nconst second = 2;');
		await paragraph.evaluate(element => {
			const selection = window.getSelection()!;
			selection.setBaseAndExtent(element.firstChild!, 5, element.firstChild!, 9);
		});
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
		const values = [
			'initial 中文',
			'initial 中文 😀',
			'initial 中文 😀\nnext line',
			'corrected',
			'co',
			'co appended',
		];
		const result = await page.evaluate(
			values => window.ashChatTranscriptIntegration.inspectCodeUpdates(values),
			values,
		);
		expect(result.sameModel).toBe(true);
		expect(result.canUndo).toBe(false);
		expect(result.updates.map(update => update.text)).toEqual(values);
		expect(result.updates.map(update => update.reason)).toEqual(['edit', 'edit', 'edit', 'reset', 'reset', 'edit']);
		expect(result.updates.map(update => update.replacedCharacters)).toEqual([
			0,
			0,
			0,
			values[2].length,
			values[3].length,
			0,
		]);
		await page.locator('.ash-chat-code-block').getByRole('button', { name: 'Copy', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
			.toBe(values.at(-1));
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount)).toBe(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.stream('```typescript\nHidden update 😀', false));
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
		await page.locator('.ash-chat-code-block').getByRole('button', { name: 'Copy', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
			.toBe('Hidden update 😀');
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
		const result = await page.evaluate(
			values => window.ashChatTranscriptIntegration.inspectRawCodeUpdates(values),
			cases.map(value => value.source),
		);
		expect(result.snapshots).toEqual(
			cases.map(value => ({ text: value.text, eol: value.eol, copied: value.source })),
		);
		expect(result.released).toBe(true);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(count);
	});

	test('streaming Markdown large tails preserve complete content through corrections', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		for (const kind of ['hugeParagraph', 'mathCandidates', 'largeList', 'largeTable'] as const) {
			const source = await page.evaluate(
				kind => window.ashChatTranscriptIntegration.markdownWorkload(kind),
				kind,
			);
			const step = Math.ceil(source.length / 16);
			for (let end = step; end < source.length; end += step) {
				const state = await page.evaluate(
					value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, false),
					source.slice(0, end),
				);
				expect(state.actual, `${kind} prefix ${end}`).toBe(state.expected);
			}
			for (const value of [
				source,
				source.replace(/bold/gu, 'corrected'),
				source.slice(0, step),
				'Replaced.',
				'',
			]) {
				const state = await page.evaluate(
					value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true),
					value,
				);
				expect(state.actual, kind).toBe(state.expected);
			}
		}
	});

	test('streaming Markdown large paragraphs preserve inline semantics through corrections', async function () {
		const { page } = browserTests;

		await page.goto('/chatTranscript.html');
		const prose =
			'Streaming **Markdown** with [a link](https://example.com) and `inline code`. 中文内容保持完整。 '.repeat(
				96,
			);
		const source = prose + String.raw`\$escaped\$ \\(escaped\\) $x$ \(y\)` + '\n\nFinal visible marker.';
		for (let end = 512; end < source.length; end += 512) {
			const value = source.slice(0, end);
			const state = await page.evaluate(
				value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, false),
				value,
			);
			expect(state.actual, `prefix ${end}`).toBe(state.expected);
		}
		for (const value of [source, source.replace(/Markdown/gu, 'corrected'), 'Replaced.', '']) {
			const state = await page.evaluate(
				value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true),
				value,
			);
			expect(state.actual).toBe(state.expected);
		}
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
				const state = await page.evaluate(
					value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, false),
					value,
				);
				expect(state.actual, `prefix ${end}: ${value}`).toBe(state.expected);
			}
			for (const value of [
				source,
				`Inserted.\n\n${source}`,
				source.replace(/const|item|indented|first/u, 'corrected'),
				'Replaced.',
				'',
			]) {
				const state = await page.evaluate(
					value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true),
					value,
				);
				expect(state.actual, `correction: ${value}`).toBe(state.expected);
			}
		}
		for (const value of [
			'    first\n\nOutside.',
			'    first\n\n    continued.',
			'- first\n\nOutside.',
			'- first\n\n  ```ts\n  continued\n  ```',
		]) {
			const state = await page.evaluate(
				value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true),
				value,
			);
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
			await strong.evaluate(element =>
				window.getSelection()!.setBaseAndExtent(element.firstChild!, 6, element.firstChild!, 1),
			);
			await link.focus();
			await page.evaluate(prefix => {
				for (let index = 0; index < 8; index++)
					window.ashChatTranscriptIntegration.stream(prefix + `terminal ${index}`, index === 7);
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
			await paragraph.evaluate(element => {
				window.getSelection()!.setBaseAndExtent(element.firstChild!, 9, element.firstChild!, 5);
			});
			await page.evaluate(
				value => window.ashChatTranscriptIntegration.stream('Inserted.\n\n' + value, true),
				source,
			);
			expect(
				await article
					.locator('p')
					.nth(1)
					.evaluate((element, old) => element === old, node),
			).toBe(true);
			expect(
				await page.evaluate(() => {
					const selection = window.getSelection()!;
					return [selection.toString(), selection.anchorOffset, selection.focusOffset];
				}),
			).toEqual(['this', 9, 5]);
			const copy = article.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
			await copy.focus();
			const revised = source.replace('const first = 1;', 'const corrected = 2;');
			await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), revised);
			await expect(copy).toBeFocused();
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
				.toBe('const corrected = 2;');
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
			await page.evaluate(
				value => window.ashChatTranscriptIntegration.stream(value.replace('2;', '3;') + '\n\nDone.', true),
				revised,
			);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount)).toBe(0);
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
			await copy.focus();
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
				.toBe('const corrected = 3;');
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
			const source =
				'# Heading\n\nFirst paragraph with **bold** text.\n\n> Quoted text.\n\n- one\n- two\n\n| Column | Value |\n| --- | --- |\n| a | b |\n\nLast paragraph.';
			for (const value of [source.slice(0, 76), source, `Inserted.\n\n${source}`]) {
				const state = await page.evaluate(
					value => window.ashChatTranscriptIntegration.compareStreamingMarkdown(value, true, true),
					value,
				);
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
			const invalid =
				'---\nname: review\ndescription: [one, two]\nmetadata:\n  owner: [editor]\nmodel: unknown\n---';
			await page.evaluate(value => window.ashChatTranscriptIntegration.setFile(value, 3, 15), invalid);
			await expect
				.poll(() =>
					page.evaluate(() => window.ashChatTranscriptIntegration.diagnostics().map(marker => marker.code)),
				)
				.toEqual(['textField', 'metadataShape', 'unknownField']);
			const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.press('ControlOrMeta+i');
			await expect(
				page
					.getByText(
						locale === 'en'
							? 'The Skill field description requires a text value.'
							: 'Skill 字段 description 需要文本值。',
						{ exact: true },
					)
					.last(),
			).toBeVisible();
			await page.keyboard.press('Escape');
			await page.evaluate(() =>
				window.ashChatTranscriptIntegration.setFile(
					'---\n"name": review\ndescription: >-\n  Review changes.\nmetadata: { owner: editor }\n---',
					2,
					3,
				),
			);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.diagnostics())).toEqual([]);
			await page.evaluate(() =>
				window.ashChatTranscriptIntegration.setFile('---\nname: re\ndescription: Review\n---', 2, 9),
			);
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('Control+Space');
			await expect(
				page.locator('.stanza-editor-completion-label').getByText('review', { exact: true }),
			).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('---\nname: review\ndescription: Review\n---');
			await page.evaluate(() =>
				window.ashChatTranscriptIntegration.setFile(
					'---\nname: review\ndescription: Review\nallowed-tools: re\n---',
					4,
					18,
				),
			);
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('Control+Space');
			await expect(
				page.locator('.stanza-editor-completion-label').getByText('read_file', { exact: true }),
			).toBeVisible();
			await expect(
				page.locator('.stanza-editor-completion-label').getByText('internal_tool', { exact: true }),
			).toHaveCount(0);
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('---\nname: review\ndescription: Review\nallowed-tools: read_file\n---');
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
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource))
				.toContain('/review/SKILL.md');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.referenceReady(5, 11)))
				.toBe(true);
			await page.evaluate(() => window.ashChatTranscriptIntegration.openReference(5, 11));
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('Reference guide.\n\n[Next](nested/checks.md)');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource))
				.toContain('/review/references/guide.md');
			await page.keyboard.insertText('must not edit');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe(
				'Reference guide.\n\n[Next](nested/checks.md)',
			);
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.referenceReady(3, 10)))
				.toBe(true);
			await page.evaluate(() => window.ashChatTranscriptIntegration.openReference(3, 10));
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file))
				.toBe('Nested reference.');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.skillRequests())).toEqual(
				['SKILL.md', 'references/guide.md', 'references/nested/checks.md'].map(path => [
					{
						id: { source: 'user:review', name: 'review' },
						version: { type: 'pinnedDigest', digest: `sha256:${'a'.repeat(64)}` },
					},
					path,
					'reference-session',
				]),
			);
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
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource))
				.toMatch(/^chat-response-resource:/u);
			const resource = await page.evaluate(() => window.ashChatTranscriptIntegration.state().resource);
			expect(await page.evaluate(uri => window.ashChatTranscriptIntegration.readResource(uri), resource)).toEqual(
				[...new TextEncoder().encode(raw)],
			);
			const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
			await editor.locator('.stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.insertText('should not edit');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe(raw);
			await jsonRow.locator('summary').click();
			const original = await jsonRow.elementHandle();
			await jsonRow.getByRole('button', { name: copy }).focus();
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
				.toBe('{"amount":1.0,"text":"<img src=x onerror=alert(1)>"}');
			await page.evaluate(() => window.ashChatTranscriptIntegration.showArtifacts(true));
			expect(await jsonRow.evaluate((element, previous) => element === previous, original)).toBe(true);
			await expect(jsonRow.getByRole('button', { name: copy })).toBeFocused();
			await expect(rows.nth(0).locator('summary')).toHaveText(
				locale === 'en' ? 'Resource: file:///untrusted/report.md' : '资源：file:///untrusted/report.md',
			);
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
			expect(
				await page.evaluate(async uri => {
					try {
						await window.ashChatTranscriptIntegration.readResource(uri);
						return false;
					} catch {
						return true;
					}
				}, resource),
			).toBe(true);
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
			const context = {
				id: 'terminal:saved',
				kind: 'terminal',
				name: 'Terminal: saved',
				content: 'Saved terminal context',
				resource: 'internal://terminal?id=saved',
				terminalSnapshot: { text: 'Saved <script>unsafe()</script>\nTerminal output', columns: 80 },
				reference: { start: 0, end: 15 },
			};
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft()))
				.toEqual({ mode: 'plan', text: 'Terminal: saved ', contexts: [context] });
			await page.evaluate(() => window.ashChatTranscriptIntegration.showChatApp(false, true));
			const chat = page.locator('#app-chat');
			const preview = chat.getByRole('button', {
				name: locale === 'en' ? 'Preview terminal snapshot' : '预览终端快照',
				exact: true,
			});
			await expect(preview).toBeVisible();
			await preview.click();
			const input = page.getByRole('textbox', {
				name: locale === 'en' ? 'Saved terminal output (read only)' : '已保存的终端输出（只读）',
				exact: true,
			});
			await expect(input).toHaveAttribute('readonly', '');
			await expect(page.locator('.ash-chat-terminal-preview-screen .xterm')).toBeVisible();
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft()))
				.toEqual({ mode: 'plan', text: 'Terminal: saved ', contexts: [context] });
			await chat
				.getByRole('button', {
					name: locale === 'en' ? 'Remove Terminal: saved' : '移除 Terminal: saved',
					exact: true,
				})
				.click();
			await expect(page.locator('.ash-chat-terminal-preview-screen')).toHaveCount(0);
			await expect
				.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft()))
				.toBeUndefined();
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const cowork of [false, true]) {
			test(`${cowork ? 'Cowork' : 'Chat'} accepted context is inspectable without execution and preserves keyboard focus in ${locale}`, async function () {
				const { page } = browserTests;

				await page.goto(`/chatTranscript.html?locale=${locale}`);
				const text = '<img src=x onerror=alert(1)>\nExact accepted text 汉字\n' + 'unbroken'.repeat(60);
				await page.evaluate(
					({ text, cowork }) => window.ashChatTranscriptIntegration.showAcceptedContext(text, cowork),
					{ text, cowork },
				);
				const context = page.locator('.ash-chat-context');
				const summary = context.locator('summary');
				const body = context.locator('pre');
				await expect(body).toBeHidden();
				await summary.focus();
				await summary.press('Enter');
				await expect(body).toBeVisible();
				await expect(body).toHaveText(text);
				await expect(context.locator('img')).toHaveCount(0);
				await summary.press('Tab');
				await expect(body).toBeFocused();
				await page.evaluate(() =>
					window.ashChatTranscriptIntegration.updateAcceptedContext('Revised exact body 汉字'),
				);
				await expect(body).toBeFocused();
				await expect(body).toHaveText('Revised exact body 汉字');
				for (const theme of ['dark', 'light', 'hc'] as const) {
					await page.evaluate(theme => {
						window.ashChatTranscriptIntegration.setTheme(theme);
						document.querySelector<HTMLElement>('.ash-chat-context')!.closest('main')!.style.width =
							'220px';
					}, theme);
					await expect(body).toBeFocused();
					expect(await body.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
					expect(await body.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
				}
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(0);
				await summary.focus();
				await summary.press('Space');
				await expect(body).toBeHidden();
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
				await page.evaluate(
					({ text, cowork }) => window.ashChatTranscriptIntegration.showCopiedMessage(text, cowork),
					{ text, cowork },
				);
				const row = page.locator('[data-item-id="copy-response"]');
				const button = row.getByRole('button', {
					name: locale === 'zh-CN' ? '复制消息' : 'Copy message',
					exact: true,
				});
				await expect(
					row.getByRole('button', { name: locale === 'zh-CN' ? '朗读' : 'Read aloud', exact: true }),
				).toHaveCount(0);
				for (const theme of ['dark', 'light', 'hc'] as const) {
					await page.evaluate(theme => {
						window.ashChatTranscriptIntegration.setTheme(theme);
						document
							.querySelector<HTMLElement>('[data-item-id="copy-response"]')!
							.closest('main')!.style.width = '220px';
					}, theme);
					await button.focus();
					await page.keyboard.press('Enter');
					await expect(row.locator('.ash-chat-message-copy-status')).toHaveText(
						locale === 'zh-CN' ? '消息已复制。' : 'Message copied.',
					);
					await expect(button).toBeFocused();
					expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(text);
					expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
				}
				await page.evaluate(() => window.ashChatTranscriptIntegration.holdClipboard());
				await button.focus();
				await page.keyboard.press('Space');
				await expect(button).toHaveAttribute('aria-busy', 'true');
				await expect(button).toBeFocused();
				await page.evaluate(() =>
					window.ashChatTranscriptIntegration.updateCopiedMessage('A corrected response'),
				);
				await page.evaluate(() => window.ashChatTranscriptIntegration.releaseClipboard());
				await expect(row.locator('.ash-chat-message-copy-status')).toHaveText('');
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(text);
				await row
					.getByRole('button', { name: locale === 'zh-CN' ? '复制消息' : 'Copy message', exact: true })
					.click();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied))
					.toBe('A corrected response');
				await page.evaluate(() => window.ashChatTranscriptIntegration.holdClipboard(true));
				await row
					.getByRole('button', { name: locale === 'zh-CN' ? '复制消息' : 'Copy message', exact: true })
					.click();
				await page.evaluate(() => window.ashChatTranscriptIntegration.releaseClipboard());
				await expect(row.locator('.ash-chat-message-copy-status')).toContainText(
					locale === 'zh-CN' ? '无法复制消息' : 'Could not copy message',
				);
				await page.evaluate(() => window.ashChatTranscriptIntegration.clearCopiedMessage());
				await expect(row).toHaveCount(0);
			});
		}
	}

	for (const cowork of [false, true]) {
		for (const locale of ['en', 'zh-CN']) {
			test(`Desktop response read aloud follows the Speech extension and row cancellation (${cowork ? 'Cowork' : 'Chat'}, ${locale})`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto(`/chatTranscript.html?locale=${locale}`);
				await page.evaluate(
					({ cowork }) => window.ashChatTranscriptIntegration.showReadAloudMessage('**Hello** 世界', cowork),
					{ cowork },
				);
				const row = page.locator('[data-item-id="copy-response"]');
				const read = () =>
					row.getByRole('button', { name: locale === 'zh-CN' ? '朗读' : 'Read aloud', exact: true });
				const stop = () =>
					row.getByRole('button', {
						name: locale === 'zh-CN' ? '停止朗读' : 'Stop reading aloud',
						exact: true,
					});
				let count = 0;
				for (const theme of ['dark', 'light', 'hc'] as const) {
					await page.evaluate(theme => {
						window.ashChatTranscriptIntegration.setTheme(theme);
						document
							.querySelector<HTMLElement>('[data-item-id="copy-response"]')!
							.closest('main')!.style.width = '220px';
					}, theme);
					await read().focus();
					await page.keyboard.press('Enter');
					await expect(stop()).toBeFocused();
					await expect
						.poll(() =>
							page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length),
						)
						.toBe(++count);
					expect(
						await page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.at(-1)),
					).toBe('Hello 世界');
					expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
					await page.evaluate(() => window.ashChatTranscriptIntegration.finishReadAloud());
					await expect(read()).toBeFocused();
					await expect
						.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
						.toBe(0);
				}
				await page.evaluate(() =>
					window.ashChatTranscriptIntegration.updateCopiedMessage('Still streaming', true),
				);
				await expect(read()).toBeDisabled();
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateCopiedMessage('Completed reply'));
				await read().click();
				await expect(stop()).toBeVisible();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await stop().click();
				await expect(read()).toBeVisible();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
					.toBe(0);
				await read().click();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await page.evaluate(() => {
					document.body.focus();
					return window.ashChatTranscriptIntegration.stopReadAloudCommand();
				});
				await expect(read()).toBeVisible();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
					.toBe(0);
				await read().focus();
				await page.keyboard.press('Space');
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await page.keyboard.press('Escape');
				await expect(read()).toBeFocused();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
					.toBe(0);
				await read().click();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.finishReadAloud(true));
				await expect(row.locator('.ash-chat-message-read-status')).toContainText(
					locale === 'zh-CN' ? '无法朗读回复' : 'Could not read response aloud',
				);
				await expect(read()).toBeVisible();
				await read().click();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.updateCopiedMessage('Corrected source'));
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
					.toBe(0);
				await expect(row.locator('.ash-chat-message-read-status')).toHaveText('');
				await read().click();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(false));
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
					.toBe(0);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(true));
				await read().click();
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().text.length))
					.toBe(++count);
				await page.evaluate(() => window.ashChatTranscriptIntegration.clearCopiedMessage());
				await expect(row).toHaveCount(0);
				await expect
					.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.readAloudState().open))
					.toBe(0);
				expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
				await page.evaluate(() => {
					window.ashChatTranscriptIntegration.updateCopiedMessage('Provider retired');
					window.ashChatTranscriptIntegration.revokeReadAloudProvider();
				});
				await expect(read()).toHaveCount(0);
				expect(errors).toEqual([]);
			});
		}
	}
});
