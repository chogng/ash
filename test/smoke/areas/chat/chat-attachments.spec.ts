import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

test(
	'Attachment resource gestures reach the Workbench file, editor and clipboard owners',
	{ tag: ['@browser-ui'] },
	async ({ workbench }) => {
		const page = workbench.page;
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(`chat-resources-${crypto.randomUUID()}`, { create: true });
			const file = await folder.getFileHandle('main.ts', { create: true });
			const writer = await file.createWritable();
			await writer.write('first live line\nsecond live line\nthird live line');
			await writer.close();
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
		const file = page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true });
		await expect(file).toBeVisible();
		const resource = (await file.locator('[data-resource]').getAttribute('data-resource'))!;
		await file.dblclick();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('second live line'));
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.focus();
		await input.evaluate((element, resource) => {
			const text = 'Explain main.ts';
			const transfer = new DataTransfer();
			transfer.setData('text/plain', text);
			transfer.setData(
				'application/vnd.chat.attachment+json',
				JSON.stringify({
					version: 1,
					draft: {
						mode: 'agent',
						text,
						contexts: [
							{
								id: 'source',
								kind: 'file',
								name: 'main.ts',
								resource: `${resource}#2,3-2,7`,
								content: 'Frozen before the live source changed',
								reference: { start: 8, end: text.length },
							},
						],
					},
				}),
			);
			element.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
			);
		}, resource);
		const source = chat.getByRole('button', { name: 'Open main.ts', exact: true });
		await expect(source).toBeVisible();
		await source.dragTo(workbench.editors.groupAt(0).tabs.filter({ hasText: 'main.ts' }));
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('second live line'));
		await expect(page.getByText('Ln 2, Col 7 (4 selected)', { exact: true })).toBeVisible();
		await source.click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: 'Copy Relative Path', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(source).toBeFocused();
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		const previousClipboard = await page.evaluate(() => navigator.clipboard.readText());
		try {
			await source.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'Copy Relative Path', exact: true }).click();
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('main.ts');
		} finally {
			await page.evaluate(value => navigator.clipboard.writeText(value), previousClipboard);
		}
		await source.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Open to the Side', exact: true }).click();
		await expect(workbench.editors.groups).toHaveCount(2);
		await workbench.editors.groupAt(1).editor.waitForEditorContents(text => text.includes('second live line'));
		await source.press('Backspace');
		await expect(source).toHaveCount(0);
		await expect(input).toBeFocused();
		await input.press('ControlOrMeta+z');
		await source.click();
		const saved = workbench.editors.groupAt(1).editor;
		await saved.waitForEditorContents(text => text === 'Frozen before the live source changed');
		await expect(saved.input).toHaveAttribute('aria-readonly', 'true');
		await input.focus();
		await input.press('ControlOrMeta+End');
		await source.dragTo(chat.locator('form.ash-chat-input-container'));
		const received = chat.getByRole('button', { name: 'Open main.ts (2)', exact: true });
		await expect(received).toBeVisible();
		await expect(source).toBeVisible();
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText('Live source changed after receiving the drop');
		await input.focus();
		await input.press('ControlOrMeta+z');
		await expect(received).toHaveCount(0);
		await expect(source).toBeVisible();
		await input.press('ControlOrMeta+Shift+z');
		await received.click();
		const receivedSaved = workbench.editors.groupAt(0).editor;
		await receivedSaved.waitForEditorContents(text => text === 'cond');
		await expect(receivedSaved.input).toHaveAttribute('aria-readonly', 'true');
		await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
	},
);

test('Restored session references use the window widget factory through removal, undo and copy-paste', async ({
	workbench,
}) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.new');
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
	await input.focus();
	await input.evaluate(element => {
		const text = 'Explain Earlier design';
		const transfer = new DataTransfer();
		transfer.setData('text/plain', text);
		transfer.setData(
			'application/vnd.chat.attachment+json',
			JSON.stringify({
				version: 1,
				draft: {
					mode: 'agent',
					text,
					contexts: [
						{
							id: 'previous',
							kind: 'sessionReference',
							name: 'Earlier design',
							resource: 'private://chat-session?sessionId=previous-session&threadId=previous-thread',
							content: 'Captured earlier conversation',
							reference: { start: 8, end: 22 },
						},
					],
				},
			}),
		);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	});
	const source = chat.getByRole('button', { name: 'Open Earlier design', exact: true });
	const remove = chat.getByRole('button', { name: 'Remove Earlier design', exact: true });
	await expect(source).toBeVisible();
	await input.press('Tab');
	await expect(source).toBeFocused();
	await source.press('Tab');
	await expect(remove).toBeFocused();
	await remove.press('Delete');
	await expect(source).toHaveCount(0);
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+z');
	await expect(source).toBeVisible();
	await input.press('ControlOrMeta+a');
	const copied = await input.evaluate(element => {
		const transfer = new DataTransfer();
		element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
		return transfer.types.map(type => [type, transfer.getData(type)]);
	});
	await input.press('Backspace');
	await input.evaluate((element, values) => {
		const transfer = new DataTransfer();
		for (const [type, value] of values) transfer.setData(type!, value!);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	}, copied);
	await expect(source).toBeVisible();
	await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
});

test('Code copied before Chat opens can be pasted as a snapshot after its source changes', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const editor = new Editor(page.locator('[data-part="editor"]'));
	await editor.waitForEditorFocus();
	const text = 'const copied_before_chat = 42;';
	await editor.waitForTypeInEditor(text);
	await editor.input.press('ControlOrMeta+a');
	const copied = await editor.input.evaluate(element => {
		const transfer = new DataTransfer();
		element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
		return transfer.types.map(type => [type, transfer.getData(type)]);
	});
	await editor.input.pressSequentially('changed after code copy');
	await workbench.quickaccess.runCommand('workbench.action.chat.new');
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
	await input.pressSequentially('Explain ');
	await input.evaluate((element, values) => {
		const transfer = new DataTransfer();
		for (const [type, value] of values) transfer.setData(type!, value!);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	}, copied);
	const selector = page.locator('.stanza-editor-post-edit-selector button');
	await selector.click();
	await page.getByRole('menuitem', { name: 'Pasted Code Attachment', exact: true }).click();
	const reference = chat.locator('.ash-chat-code-reference');
	await expect(reference).toHaveText('Untitled-1 (1)');
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+z');
	await expect(reference).toHaveCount(0);
	await input.press('ControlOrMeta+Shift+z');
	await expect(reference).toHaveText('Untitled-1 (1)');
	await reference.click();
	await editor.waitForEditorContents(contents => contents === text);
	await expect(editor.input).toHaveAttribute('aria-readonly', 'true');
	await chat.getByRole('button', { name: 'Remove Untitled-1 (1)', exact: true }).click();
	await expect(reference).toHaveCount(0);
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+z');
	await expect(reference).toHaveText('Untitled-1 (1)');
	await reference.click();
	await editor.waitForEditorContents(contents => contents === text);
	await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
});

test('Chat copies an unsaved editor snapshot through paste, undo and redo without sending', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const editor = new Editor(page.locator('[data-part="editor"]'));
	await editor.waitForEditorFocus();
	const text = 'ash_attachment_unsaved_snapshot_fixture';
	await editor.waitForTypeInEditor(text);
	await workbench.quickaccess.runCommand('workbench.action.chat.new');
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await expect(chat).toBeVisible();
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog', { name: 'Search attachments', exact: true });
	await picker.getByRole('combobox').fill('Open editors');
	await picker.getByRole('option', { name: 'Open editors', exact: true }).click();
	const reference = chat.locator('.ash-chat-code-reference').filter({ hasText: 'Untitled-1' });
	await expect(reference).toHaveCount(1);
	const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+a');
	const copied = await input.evaluate(element => {
		const transfer = new DataTransfer();
		element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
		return transfer.types.map(type => [type, transfer.getData(type)]);
	});
	await editor.input.focus();
	await editor.input.press('ControlOrMeta+a');
	await editor.input.pressSequentially('changed_source_after_copy');
	await input.focus();
	await input.press('ControlOrMeta+a');
	await input.press('Backspace');
	await input.pressSequentially('Keep ');
	await input.evaluate((element, values) => {
		const transfer = new DataTransfer();
		for (const [type, value] of values) transfer.setData(type!, value!);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	}, copied);
	await expect(reference).toHaveCount(1);
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+z');
	await expect(reference).toHaveCount(0);
	await input.press('ControlOrMeta+Shift+z');
	await expect(reference).toHaveCount(1);
	await reference.click();
	await expect(page.getByRole('tab', { name: 'Untitled-1 — Saved content', exact: true })).toBeVisible();
	await editor.waitForEditorContents(contents => contents === text);
	await expect(editor.input).toHaveAttribute('aria-readonly', 'true');
	await expect(reference).toHaveCount(1);
	await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
	// Browser transfers may carry an image file name without any MIME information.
	await input.focus();
	await input.evaluate(element => {
		const bytes = Uint8Array.from(
			atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg=='),
			char => char.charCodeAt(0),
		);
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], 'capture.PNG'));
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	});
	const preview = chat.getByRole('button', { name: 'Preview capture.PNG', exact: true });
	await expect(preview).toBeVisible();
	await preview.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Preview capture.PNG', exact: true });
	await expect(dialog.getByRole('img', { name: 'capture.PNG', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(preview).toBeFocused();
	await chat.getByRole('button', { name: 'Remove capture.PNG', exact: true }).press('Enter');
	await expect(preview).toHaveCount(0);
	await expect(input).toBeFocused();
	await expect(reference).toHaveCount(1);
	await input.press('ControlOrMeta+z');
	await expect(preview).toBeEnabled();
	await preview.press('Enter');
	await expect(dialog.getByRole('img', { name: 'capture.PNG', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(preview).toBeFocused();
	await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
	await input.focus();
	await input.press('ControlOrMeta+End');
	await input.evaluate(element => {
		const text = 'broken.png';
		const transfer = new DataTransfer();
		transfer.setData('text/plain', text);
		transfer.setData(
			'application/vnd.chat.attachment+json',
			JSON.stringify({
				version: 1,
				draft: {
					mode: 'agent',
					text,
					contexts: [
						{
							id: 'broken',
							kind: 'image',
							name: text,
							content: 'data:image/png;base64,Y2FwdHVyZWQ=',
							reference: { start: 0, end: text.length },
						},
					],
				},
			}),
		);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	});
	const failed = chat.getByRole('button', { name: 'Preview unavailable: broken.png', exact: true });
	await expect(failed).toBeDisabled();
	await expect(failed.locator('img')).toBeHidden();
	await expect(dialog).toHaveCount(0);
	await chat.getByRole('button', { name: 'Remove broken.png', exact: true }).press('Delete');
	await expect(failed).toHaveCount(0);
	await input.press('ControlOrMeta+z');
	await expect(failed).toBeDisabled();
	await expect(preview).toBeEnabled();
	await preview.press('Enter');
	await expect(dialog.getByRole('img', { name: 'capture.PNG', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('Terminal attachment controls retain a frozen snapshot through preview, removal, undo and copy-paste', async ({
	workbench,
}) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.new');
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
	await input.focus();
	await input.evaluate(element => {
		const text = 'Explain Saved terminal';
		const transfer = new DataTransfer();
		transfer.setData('text/plain', text);
		transfer.setData(
			'application/vnd.chat.attachment+json',
			JSON.stringify({
				version: 1,
				draft: {
					mode: 'agent',
					text,
					contexts: [
						{
							id: 'terminal',
							kind: 'terminal',
							name: 'Saved terminal',
							content: 'captured before source closed',
							reference: { start: 8, end: 22 },
							terminalSnapshot: { text: 'captured before source closed\r\n', columns: 80 },
						},
					],
				},
			}),
		);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	});
	const preview = chat.getByRole('button', { name: 'Preview terminal snapshot', exact: true });
	await expect(preview).toBeVisible();
	await input.press('End');
	await input.press('Alt+Enter');
	const dialog = page.getByRole('dialog', { name: 'Saved terminal output: Saved terminal', exact: true });
	await expect(dialog.locator('.xterm-rows')).toContainText('captured before source closed');
	await expect(
		dialog.getByRole('textbox', { name: 'Saved terminal output (read only)', exact: true }),
	).toHaveAttribute('readonly', '');
	await page.keyboard.press('Escape');
	await expect(preview).toBeFocused();
	await preview.press('Tab');
	const remove = chat.getByRole('button', { name: 'Remove Saved terminal', exact: true });
	await expect(remove).toBeFocused();
	await remove.press('Delete');
	await expect(preview).toHaveCount(0);
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+z');
	await expect(preview).toBeVisible();
	await input.press('ControlOrMeta+a');
	const copied = await input.evaluate(element => {
		const transfer = new DataTransfer();
		element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
		return transfer.types.map(type => [type, transfer.getData(type)]);
	});
	await input.press('Backspace');
	await input.evaluate((element, values) => {
		const transfer = new DataTransfer();
		for (const [type, value] of values) transfer.setData(type!, value!);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	}, copied);
	await preview.press('Enter');
	await expect(dialog.locator('.xterm-rows')).toContainText('captured before source closed');
	await dialog.getByRole('button', { name: 'Close terminal preview', exact: true }).click();
	await expect(preview).toBeFocused();
	await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
});

test('Other captured contexts use native controls and retain readonly content after removal and copy-paste', async ({
	workbench,
}) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.new');
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
	await input.focus();
	await input.evaluate(element => {
		const name = 'Captured commit';
		const text = `Explain ${name}`;
		const transfer = new DataTransfer();
		transfer.setData('text/plain', text);
		transfer.setData(
			'application/vnd.chat.attachment+json',
			JSON.stringify({
				version: 1,
				draft: {
					mode: 'agent',
					text,
					contexts: [
						{
							id: 'commit',
							kind: 'scmHistoryItem',
							name,
							content: 'Commit captured before repository closed\n+ original change',
							reference: { start: 8, end: text.length },
						},
					],
				},
			}),
		);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	});
	const source = chat.getByRole('button', { name: 'Open Captured commit', exact: true });
	const remove = chat.getByRole('button', { name: 'Remove Captured commit', exact: true });
	await expect(source).toBeVisible();
	await input.press('Tab');
	await expect(source).toBeFocused();
	await source.press('Enter');
	const editor = new Editor(page.locator('[data-part="editor"]'));
	await editor.waitForEditorContents(
		contents => contents === 'Commit captured before repository closed\n+ original change',
	);
	await expect(editor.input).toHaveAttribute('aria-readonly', 'true');
	await expect(source).toBeVisible();
	await remove.focus();
	await remove.press('Backspace');
	await expect(source).toHaveCount(0);
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+z');
	await expect(source).toBeVisible();
	await input.press('ControlOrMeta+a');
	const copied = await input.evaluate(element => {
		const transfer = new DataTransfer();
		element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
		return transfer.types.map(type => [type, transfer.getData(type)]);
	});
	await input.press('Backspace');
	await input.evaluate((element, values) => {
		const transfer = new DataTransfer();
		for (const [type, value] of values) transfer.setData(type!, value!);
		element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		);
	}, copied);
	await expect(source).toBeVisible();
	await input.press('End');
	await input.press('Alt+Enter');
	await editor.waitForEditorContents(
		contents => contents === 'Commit captured before repository closed\n+ original change',
	);
	await expect(editor.input).toHaveAttribute('aria-readonly', 'true');
	await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
});

for (const kind of ['browserElement', 'scmHistoryItemChange'])
	test(`${kind} dedicated controls keep captured content and source identity through clipboard, undo and readonly opening`, async ({
		workbench,
	}) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.new');
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		const input = chat.getByRole('textbox', { name: 'Chat message', exact: true });
		const name = kind === 'browserElement' ? 'Captured element' : 'src/captured.ts';
		const content =
			kind === 'browserElement'
				? '<button onclick="captured()">Original element</button>\ncolor: red;'
				: 'History file captured before repository closed\n+ original change';
		const resource =
			kind === 'browserElement'
				? 'https://example.test/original#element'
				: `private://scm-history/change?${encodeURIComponent(JSON.stringify({ repositoryId: 'closed:repository', revision: 'captured:commit', baseRevision: 'captured:parent', path: name }))}`;
		await input.focus();
		await input.evaluate(
			(element, attachment) => {
				const text = `Explain ${attachment.name}`;
				const transfer = new DataTransfer();
				transfer.setData('text/plain', text);
				transfer.setData(
					'application/vnd.chat.attachment+json',
					JSON.stringify({
						version: 1,
						draft: {
							mode: 'agent',
							text,
							contexts: [{ id: 'captured', ...attachment, reference: { start: 8, end: text.length } }],
						},
					}),
				);
				element.dispatchEvent(
					new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
				);
			},
			{ kind, name, content, resource },
		);
		const open = chat.getByRole('button', { name: `Open ${name}`, exact: true });
		const origin = chat.getByRole('button', {
			name: kind === 'browserElement' ? `Open source page for ${name}` : `Open revision file for ${name}`,
			exact: true,
		});
		const remove = chat.getByRole('button', { name: `Remove ${name}`, exact: true });
		await expect(origin).toBeVisible();
		await input.press('Tab');
		await expect(open).toBeFocused();
		await open.press('Tab');
		await expect(origin).toBeFocused();
		await origin.press('Tab');
		await expect(remove).toBeFocused();
		await remove.press('Delete');
		await expect(open).toHaveCount(0);
		await expect(input).toBeFocused();
		await input.press('ControlOrMeta+z');
		await expect(origin).toBeVisible();
		await input.press('ControlOrMeta+a');
		const copied = await input.evaluate(element => {
			const transfer = new DataTransfer();
			element.dispatchEvent(
				new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
			);
			return transfer.types.map(type => [type, transfer.getData(type)]);
		});
		await input.press('Backspace');
		await input.evaluate((element, values) => {
			const transfer = new DataTransfer();
			for (const [type, value] of values) transfer.setData(type!, value!);
			element.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
			);
		}, copied);
		await expect(origin).toBeVisible();
		await open.hover();
		await expect(page.getByRole('tooltip').locator('pre')).toContainText(content);
		await expect(page.getByRole('tooltip').locator('[onclick], [onerror]')).toHaveCount(0);
		await input.press('Home');
		for (let step = 0; step < 8; step++) await input.press('ArrowRight');
		await input.press('ControlOrMeta+k');
		await input.press('ControlOrMeta+i');
		const hover = page.locator('.stanza-editor-hover:not([hidden])');
		await expect(hover.locator('.stanza-editor-hover-content')).toBeFocused();
		await expect
			.poll(async () => (await hover.locator('pre').innerText()).replace(/\u00a0/gu, ' ').trim())
			.toBe(content);
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await input.press('End');
		await input.press('Alt+Enter');
		const editor = new Editor(page.locator('[data-part="editor"]'));
		await editor.waitForEditorContents(contents => contents === content);
		await expect(editor.input).toHaveAttribute('aria-readonly', 'true');
		await expect(chat.locator('[onclick]')).toHaveCount(0);
		await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
	});
