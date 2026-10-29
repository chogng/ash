import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

for (const locale of ['en', 'zh-CN'] as const)
	test.describe(`Chat main canvas (${locale})`, () => {
		test.use({ electronUserSettings: { 'workbench.locale': locale } });

		test(
			'moves the original composer beside a document and restores its draft after restart',
			{ tag: ['@electron-app-server'] },
			async ({ workbench, reloadWorkbench, testWorkspace }, testInfo) => {
				test.setTimeout(120_000);
				let page = workbench.page;
				await workbench.quickaccess.runCommand('workbench.action.chat.new');
				let chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
				await expect(chat).toBeVisible();
				const draftId = await chat.getAttribute('data-untitled-session-id');
				expect(draftId).toBeTruthy();
				const input = chat.locator('.stanza-editor-input');
				await input.focus();
				await page.keyboard.insertText('Keep this unsent canvas draft');
				await chat.locator('.ash-chat-input-container').evaluate(form => {
					const transfer = new DataTransfer();
					transfer.items.add(
						new File(['Captured unsaved source'], 'canvas-draft.txt', { type: 'text/plain' }),
					);
					form.dispatchEvent(
						new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
					);
				});
				await expect(chat.locator('.ash-chat-code-reference')).toContainText('canvas-draft.txt');
				const original = await chat.getAttribute('id');
				await workbench.quickaccess.runCommand('workbench.action.chat.moveToEditor');
				chat = page.locator('.ash-chat-editor .ash-chat:visible');
				await expect(chat).toHaveAttribute('id', original!);
				await expect(chat.locator('.stanza-editor-input')).toBeFocused();
				await expect(chat).toContainText('Keep this unsent canvas draft');
				await expect(chat.locator('.ash-chat-code-reference')).toContainText('canvas-draft.txt');
				await workbench.quickaccess.runCommand('workbench.action.splitEditorRight');
				await expect(page.locator('.ash-editor-group')).toHaveCount(1);
				await expect(chat).toHaveAttribute('id', original!);
				await workbench.quickaccess.open('main.ts');
				await workbench.quickaccess.select('main.ts');
				const document = new Editor(page.locator('[data-part="editor"] .ash-editor-group-content:visible'));
				await document.waitForEditorFocus();
				await document.waitForTypeInEditor('Retained unsaved document');
				await workbench.quickaccess.runCommand('workbench.action.splitEditorRight');
				await page
					.locator('.ash-editor-group')
					.first()
					.getByRole('tab', { name: locale === 'en' ? 'Chat' : '聊天', exact: true })
					.click();
				await expect(chat).toBeVisible();
				await chat.locator('.stanza-editor-input').focus();
				await expect(chat.locator('.stanza-editor-input')).toBeFocused();
				await workbench.quickaccess.open('>workbench.action.chat.moveToSideBar');
				await workbench.quickaccess.close();
				await expect(chat).toBeVisible();
				await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
				await testInfo.attach('chat-editor-side-by-side', {
					body: await page.screenshot(),
					contentType: 'image/png',
				});
				await page.locator('.ash-editor-group').last().locator('.stanza-editor-input').focus();
				await workbench.quickaccess.runCommand('workbench.action.files.save');
				await expect
					.poll(() => readFile(join(testWorkspace.directory, 'main.ts'), 'utf8'))
					.toContain('Retained unsaved document');
				({ workbench } = await reloadWorkbench());
				page = workbench.page;
				chat = page.locator('.ash-chat-editor .ash-chat:visible');
				await expect(chat).toHaveAttribute('data-untitled-session-id', draftId!);
				await expect(chat).toContainText('Keep this unsent canvas draft');
				await expect(chat.locator('.ash-chat-code-reference')).toContainText('canvas-draft.txt');
				await chat.locator('.stanza-editor-input').focus();
				await chat.locator('.stanza-editor-input').press('Alt+F1');
				const help = page.locator('.ash-accessible-view-content');
				await expect(help).toHaveValue(
					locale === 'en'
						? /Move Chat to Editor Area[\s\S]*never sends a message/u
						: /将聊天移到编辑器区域[\s\S]*不会发送消息/u,
				);
				await help.press('Escape');
				await workbench.quickaccess.runCommand('workbench.action.chat.moveToSideBar');
				chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
				await expect(chat).toBeVisible();
				await expect(chat.locator('.stanza-editor-input')).toBeFocused();
				await expect(chat).toContainText('Keep this unsent canvas draft');
				await expect(chat.locator('.ash-chat-code-reference')).toContainText('canvas-draft.txt');
				await expect(chat.locator('.ash-chat-item')).toHaveCount(0);
				await expect(page.locator('[data-part="editor"]')).toContainText('Retained unsaved document');
			},
		);
	});
