import type { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { type IChatContextPickService } from '../../../browser/attachments/chatContextPickService.js';
import { URI } from '../../../../../../base/common/uri.js';
import { SCMHistoryItemUri } from '../../../../scm/common/history.js';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import type { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IQuickAccessController } from '../../../../../../platform/quickinput/common/quickAccess.js';
import type { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';

import type { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import type { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { AttachContextAction } from '../../../browser/actions/chatContextActions.js';
import type { IChatAttachmentResolveService } from '../../../browser/attachments/chatAttachmentResolveService.js';

for (const cancellation of ['Escape', 'toggle', 'dispose'] as const) {
	test(`Attachment search ${cancellation} restores only a surviving composer after shared picker focus restoration`, async () => {
		using resources = new DisposableStore();
		const container = document.createElement('div');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const anchor = document.createElement('button');
		const input = document.createElement('textarea');
		container.append(anchor, input);
		setARIAContainer(container);
		const quickInput = resources.add(new TestQuickInputService({ container }));
		const notifications = resources.add(new TestNotificationService());
		const shown = new DeferredPromise<void>();
		const quickAccess: IQuickAccessController = {
			onDidChangeVisibility: Event.None,
			show: (_value, options) => {
				const picker = resources.add(quickInput.createQuickPick());
				picker.anchor = options?.anchor;
				picker.show();
				void shown.complete();
			},
		};
		Object.defineProperty(quickInput, 'quickAccess', { value: quickAccess });
		// Catalog sources are unrelated to this ownership contract; the shared picker
		// itself remains real so its normal anchor focus restoration precedes the owner.
		const instantiation = {
			createChild: () => Object.assign(new DisposableStore(), { createInstance: () => ({ isEnabled: () => false }) }),
			createInstance: () => ({}),
		} as unknown as IInstantiationService;
		let focused = 0;
		let acquired = 0;
		const action = resources.add(new AttachContextAction({
			container,
			target: {
				attachFiles: async () => { acquired++; },
				acquireContext: async () => { acquired++; return []; },
			},
			focusInput: () => { focused++; input.focus(); },
			supportsImages: () => false,
		}, quickInput, { items: [] } as unknown as IChatContextPickService, instantiation,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
			{ groups: [] } as unknown as IEditorGroupsService,
			{ getActiveConversation: () => undefined } as unknown as IChatSessionNavigationService, notifications, {} as IChatAttachmentResolveService, {} as ICommandService));
		anchor.focus();
		const running = action.run(anchor);
		await Promise.race([shown.p, running.then(() => { throw new Error(`Picker did not open: ${notifications.model.getNotifications().map(item => item.message).join('; ')}`); })]);
		assert.notEqual(document.activeElement, anchor);
		if (cancellation === 'Escape') {
			document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		} else if (cancellation === 'toggle') {
			await action.run(anchor);
		} else {
			action.dispose();
		}
		await running;
		assert.deepEqual({ focused, acquired, notifications: notifications.model.getNotifications(), expanded: anchor.getAttribute('aria-expanded') }, {
			focused: cancellation === 'dispose' ? 0 : 1,
			acquired: 0,
			notifications: [],
			expanded: 'false',
		});
		assert.equal(document.activeElement, cancellation === 'dispose' ? anchor : input);
		assert.equal(quickInput.currentQuickInput, undefined);
	});
}

suite('Attachment source discovery lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cancelling availability releases Add context so another picker can open before the provider responds', async () => {
		using resources = new DisposableStore();
		const container = document.createElement('div');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		resources.add(setARIAContainer(container));
		const anchor = document.createElement('button');
		const input = document.createElement('textarea');
		container.append(anchor, input);
		const quickInput = resources.add(new TestQuickInputService({ container }));
		const notifications = resources.add(new TestNotificationService());
		const checking = new DeferredPromise<void>();
		const availability = new DeferredPromise<boolean>();
		const shown = new DeferredPromise<void>();
		let checks = 0;
		Object.defineProperty(quickInput, 'quickAccess', {
			value: {
				onDidChangeVisibility: Event.None,
				show: () => { const picker = resources.add(quickInput.createQuickPick()); picker.show(); void shown.complete(); },
			} satisfies IQuickAccessController
		});
		const instantiation = {
			createChild: () => Object.assign(new DisposableStore(), { createInstance: () => ({ isEnabled: () => false }) }),
			createInstance: () => ({}),
		} as unknown as IInstantiationService;
		const action = resources.add(new AttachContextAction({
			container, target: { attachFiles: async () => { }, acquireContext: async () => [] }, focusInput: () => input.focus(), supportsImages: () => false,
		}, quickInput, { items: [{ id: 'slow', label: 'Slow', isEnabled: () => { checks++; void checking.complete(); return checks === 1 ? availability.p : false; } }] } as unknown as IChatContextPickService, instantiation,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService, { groups: [] } as unknown as IEditorGroupsService,
			{ getActiveConversation: () => undefined } as unknown as IChatSessionNavigationService, notifications, {} as IChatAttachmentResolveService, {} as ICommandService));
		const first = action.run(anchor);
		await checking.p;
		await action.run(anchor);
		await first;
		assert.equal(anchor.getAttribute('aria-expanded'), 'false');
		assert.equal(document.activeElement, input);
		const second = action.run(anchor);
		await shown.p;
		document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await second;
		await availability.error(new Error('Retired availability failed'));
		assert.equal(checks, 2);
		assert.equal(quickInput.currentQuickInput, undefined);
		assert.equal(notifications.model.getNotifications().length, 0);
		assert.equal(document.activeElement, input);
	});
});

suite('chatContextActions browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) test(`attachment resource menus preserve source drag, focus and undo in ${locale}, ${theme}`, async () => {
		const { page } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&resourceMenus=1&locale=${locale}&theme=${theme}`);
		const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await message.focus();
		const sources = [
			{ id: 'file', kind: 'file', name: 'captured.ts', resource: 'file:///workspace/captured.ts#4,2-5,8', content: 'Frozen source text' },
			{ id: 'image', kind: 'image', name: 'icon.png', resource: 'file:///workspace/icon.png', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==' },
			{ id: 'instruction', kind: 'instruction', name: 'rules.md', resource: 'file:///workspace/rules.md', content: '/authorized/rules.md' },
			{ id: 'symbol', kind: 'symbol', name: 'symbol', resource: 'file:///workspace/edited.ts#2,2-3,4', content: 'Frozen symbol source' },
			{ id: 'directory', kind: 'directory', name: 'folder', resource: 'ash-remote://connection/workspace/folder', content: 'Captured manifest' },
		];
		await message.evaluate((element, sources) => {
			const text = 'Explain ' + sources.map(source => source.name).join(' ');
			const transfer = new DataTransfer();
			transfer.setData('text/plain', text);
			transfer.setData('application/vnd.chat.attachment+json', JSON.stringify({
				version: 1, draft: {
					mode: 'agent', text, contexts: sources.map(source => ({ ...source, reference: { start: text.indexOf(source.name), end: text.indexOf(source.name) + source.name.length } })),
				}
			}));
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, sources);
		const calls: unknown[] = [];
		for (const attachment of sources) {
			const verb = attachment.kind === 'image' ? chinese ? '预览' : 'Preview' : chinese ? '打开' : 'Open';
			const source = page.getByRole('button', { name: `${verb} ${attachment.name}`, exact: true });
			await expect(source).toBeEnabled();
			const transfer = await source.evaluate(element => {
				const dataTransfer = new DataTransfer();
				element.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true, cancelable: true }));
				return Object.fromEntries(dataTransfer.types.map(type => [type, dataTransfer.getData(type)]));
			});
			assert.equal(transfer['text/uri-list'], attachment.resource);
			assert.deepEqual(JSON.parse(transfer.resourceurls!), [attachment.resource]);
			assert.equal(transfer['application/vnd.chat.attachment+json'], undefined);
			assert.ok(!Object.values(transfer).some(value => value.includes(attachment.content)));
			await source.click({ button: 'right' });
			await expect(page.getByRole('menuitem', { name: chinese ? '复制路径' : 'Copy Path', exact: true })).toBeVisible();
			await expect(page.getByRole('menuitem', { name: chinese ? '在侧边打开' : 'Open to the Side', exact: true })).toHaveCount(attachment.kind === 'directory' ? 0 : 1);
			await page.keyboard.press('Escape');
			await expect(source).toBeFocused();
			await source.press('Shift+F10');
			await page.getByRole('menuitem', { name: chinese ? '复制路径' : 'Copy Path', exact: true }).press('Enter');
			calls.push({ command: 'copyFilePath', resource: attachment.resource });
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify(calls));
		}
		await expect(page.getByLabel('Opened saved content')).toHaveText('[]');
		const source = page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} captured.ts`, exact: true });
		const remove = page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} captured.ts`, exact: true });
		await remove.focus();
		await remove.press('Shift+F10');
		await page.keyboard.press('Escape');
		await expect(remove).toBeFocused();
		await remove.press('Backspace');
		await expect(source).toHaveCount(0);
		await expect(message).toBeFocused();
		await message.press('ControlOrMeta+z');
		await expect(source).toBeVisible();
		await source.press('Enter');
		await expect(page.getByLabel('Opened saved content')).toContainText('Frozen source text');
		await expect(page.getByLabel('Submission')).toHaveText('');
	});
	for (const locale of ['en', 'zh-CN']) {
		for (const source of ['workspace', 'editor']) {
			for (const capability of ['image', 'text']) {
				test(`${source} image context uses the resolver and respects ${capability} capability in ${locale}`, async function () {
					const { page } = browserTests;
					const chinese = locale === 'zh-CN';
					await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&imageCapability=${capability}&${source === 'editor' ? 'openImageEditor' : 'workspaceImage'}`);
					await page.evaluate(() => window.ashChatInputIntegration.showModels());
					await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
					const picker = page.getByRole('dialog');
					const editorLabel = chinese ? '已打开的编辑器' : 'Open editors';
					await picker.getByRole('combobox').fill(source === 'editor' ? editorLabel : 'picture.PNG');
					await picker.getByRole('option', { name: source === 'editor' ? editorLabel : /picture.PNG/u }).click();
					const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
					if (capability === 'text') {
						await expect(page.getByLabel('Context error')).toContainText(chinese ? '所选模型不支持图片' : 'The selected model does not support images');
						expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBeUndefined();
						return;
					}
					await expect(input).toBeFocused();
					await expect(page.locator('.ash-chat-image-reference-control img')).toHaveAttribute('src', /^data:image\/png;base64,/u);
					expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('picture.PNG ');
					await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
					await expect(page.getByLabel('Submission')).toContainText('"name":"picture.PNG","content":"data:image/png;base64,');
				});
			}
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`context picker adds unsaved editor text, workspace files and registered sources in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			await add.press('Enter');
			let picker = page.getByRole('dialog');
			await picker.getByRole('combobox').fill(chinese ? '已打开的编辑器' : 'Open editors');
			await page.keyboard.press('Enter');
			const attachments = page.getByRole('list', { name: chinese ? '已添加的上下文' : 'Attached context' });
			await expect(attachments).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts ');
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			await add.press('Enter');
			await picker.getByRole('combobox').fill(chinese ? '文件和文件夹' : 'Files & Folders');
			await page.keyboard.press('Enter');
			await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '按名称搜索文件或文件夹' : 'Search file or folder by name');
			await picker.getByRole('combobox').fill('src/');
			await expect(picker.getByRole('option', { name: /nested.txt/ })).toHaveCount(1);
			await picker.getByRole('combobox').fill('src/*.txt');
			await expect(picker.getByRole('option', { name: /nested.txt/ })).toHaveCount(1);
			await picker.getByRole('option', { name: /nested.txt/ }).click();
			await expect(attachments).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts nested.txt ');
			await add.press('Enter');
			await picker.getByRole('combobox').fill(chinese ? '其他上下文来源' : 'Other context sources');
			await page.keyboard.press('Enter');
			await expect(picker).toContainText('Source context');
			await page.keyboard.press('Enter');
			await expect(attachments).toHaveCount(0);
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
				{ name: 'edited.ts', content: 'Unsaved editor text' },
				{ name: 'nested.txt', content: 'Workspace file content' },
				{ name: 'Source context', content: 'Registered context content' },
			]));
			await expect(attachments).toHaveCount(0);
		});
	}

	for (const variant of [
		{ locale: 'en', theme: 'light', surface: 'code' },
		{ locale: 'en', theme: 'light', surface: 'cowork' },
		{ locale: 'zh-CN', theme: 'dark', surface: 'code' },
		{ locale: 'en', theme: 'hcDark', surface: 'code' },
		{ locale: 'zh-CN', theme: 'hcLight', surface: 'code' },
	]) {
		test(`Add context anchors searchable child menus and restores keyboard focus (${variant.locale}, ${variant.theme}, ${variant.surface})`, async function () {
			const { page } = browserTests;

			await page.setViewportSize({ width: 760, height: 900 });
			await page.goto(`/chatInput.html?locale=${variant.locale}&theme=${variant.theme}&surface=${variant.surface}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('main').evaluate(element => { element.style.marginTop = '480px'; });
			const chinese = variant.locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			const search = picker.getByRole('combobox');
			const assertAbove = async (): Promise<void> => {
				await expect.poll(async () => {
					const button = await add.boundingBox();
					const menu = await picker.boundingBox();
					return button && menu ? Math.round(button.y - menu.y - menu.height) : -1;
				}).toBe(4);
				const button = (await add.boundingBox())!;
				const menu = (await picker.boundingBox())!;
				expect(Math.abs(menu.x - Math.max(8, button.x))).toBeLessThanOrEqual(1);
				expect(menu.width).toBe(380);
			};
			await expect(add).toHaveAttribute('aria-haspopup', 'dialog');
			await expect(add).toHaveAttribute('aria-expanded', 'false');
			await add.press('Space');
			await expect(search).toBeFocused();
			await expect(add).toHaveAttribute('aria-expanded', 'true');
			await assertAbove();
			const menuBounds = (await picker.boundingBox())!;
			const buttonBounds = (await add.boundingBox())!;
			await page.screenshot({ path: browserTests.info.outputPath('attachment-menu.png'), clip: { x: menuBounds.x - 8, y: menuBounds.y - 8, width: 600, height: buttonBounds.y + buttonBounds.height - menuBounds.y + 24 } });
			await expect(picker).toHaveCSS('border-radius', '8px');
			if (variant.theme.startsWith('hc')) await expect(picker).toHaveCSS('border-top-color', variant.theme === 'hcDark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
			await search.fill(chinese ? '会话' : 'Sessions');
			await assertAbove();
			await page.keyboard.press('Enter');
			await expect(search).toHaveAttribute('placeholder', chinese ? '选择会话' : 'Select a session');
			await expect(search).toBeFocused();
			await assertAbove();
			await search.fill(chinese ? '返回' : 'Go back');
			await page.keyboard.press('Enter');
			await expect(search).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
			await search.fill('edited');
			await page.keyboard.press('Control+Enter');
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts ');
			await expect(search).toBeFocused();
			await assertAbove();
			await page.keyboard.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			await expect(add).toHaveAttribute('aria-expanded', 'false');
			await add.press('Enter');
			await search.fill('nested');
			await expect(picker.getByRole('option', { name: /nested.txt/ })).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowUp');
			await page.keyboard.press('Enter');
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts nested.txt ');
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		});
	}

	test('attachment menu flips below Add, fits a narrow viewport, follows resize and toggles closed', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 320, height: 600 });
		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		await add.click();
		await expect(picker.getByRole('combobox')).toBeFocused();
		await expect.poll(async () => {
			const button = await add.boundingBox();
			const menu = await picker.boundingBox();
			return button && menu ? Math.round(menu.y - button.y - button.height) : -1;
		}).toBe(4);
		let menu = (await picker.boundingBox())!;
		expect(menu.x).toBeGreaterThanOrEqual(8);
		expect(menu.x + menu.width).toBeLessThanOrEqual(312);
		expect(menu.y + menu.height).toBeLessThanOrEqual(592);
		await page.locator('main').evaluate(element => { element.style.marginTop = '480px'; });
		await page.setViewportSize({ width: 760, height: 900 });
		await expect.poll(async () => {
			const button = await add.boundingBox();
			const bounds = await picker.boundingBox();
			return button && bounds ? Math.round(button.y - bounds.y - bounds.height) : -1;
		}).toBe(4);
		await add.click();
		await expect(picker).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await expect(add).toHaveAttribute('aria-expanded', 'false');
		await add.press('Enter');
		await expect(picker).toBeVisible();
		const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await message.click({ position: { x: (await message.boundingBox())!.width - 12, y: 12 } });
		await expect(picker).toHaveCount(0);
		await expect(message).toBeFocused();
		await add.press('Enter');
		await picker.getByRole('combobox').press('Tab');
		await expect.poll(() => picker.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await picker.getByRole('combobox').press('Shift+Tab');
		await expect(picker).toHaveCount(0);
		await expect(add).toHaveAttribute('aria-expanded', 'false');
	});

	test('context uploads preview images, retain keyboard focus and remain attached after a failed send', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode=1&sendFailure=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		const upload = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
		await page.keyboard.press('Enter');
		await (await upload).setFiles([
			{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded brief') },
			{ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==', 'base64') },
		]);
		const attachments = page.getByRole('list', { name: 'Attached context' });
		await expect(attachments).toHaveCount(0);
		const thumbnail = page.locator('.ash-chat-image-reference-control').getByRole('img', { name: 'preview.png' });
		await expect(thumbnail).toHaveAttribute('src', /^data:image\/png;base64,/);
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('brief.txt preview.png ');
		await input.press('Home');
		await input.press('Delete');
		await expect(page.locator('.ash-chat-code-reference')).toHaveCount(0);
		await expect(input).toBeFocused();
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toContainText('"kind":"image"');
		await expect(thumbnail).toBeVisible();
		await page.getByRole('button', { name: 'Remove preview.png', exact: true }).press('Enter');
		await expect(thumbnail).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});

	test('cancel and provider failures close the context picker and restore focus', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await page.getByRole('dialog').getByRole('combobox').fill('Other context sources');
		await page.keyboard.press('Enter');
		await page.getByRole('dialog').getByRole('combobox').fill('error');
		await expect(page.getByLabel('Context error')).toContainText('Context source failed');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	});

	test('invalid uploads report an error without adding a partial batch, and a later upload succeeds', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		let chooser = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
		await page.keyboard.press('Enter');
		await (await chooser).setFiles([
			{ name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('Valid content') },
			{ name: 'binary.dat', mimeType: 'application/octet-stream', buffer: Buffer.from([255, 254, 0]) },
		]);
		await expect(page.getByLabel('Context error')).toContainText('binary.dat must be a UTF-8 text file');
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
		await add.press('Enter');
		chooser = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
		await page.keyboard.press('Enter');
		await (await chooser).setFiles({ name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('Valid content') });
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('valid.txt ');
		await expect(page.locator('input[type="file"]')).toHaveCount(0);
	});

	test('closing the composer releases its context picker', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await page.getByRole('dialog').getByRole('combobox').fill('Other context sources');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).toContainText('Source context');
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});

	test('uploaded file references wrap inside a narrow composer and delete from the message', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.goto('/chatInput.html?inlineCode=1&theme=hcDark');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.setViewportSize({ width: 320, height: 600 });
		await page.locator('main').evaluate(element => { element.style.width = '260px'; });
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
		const name = `${'very-long-code-file-name-'.repeat(8)}.ts`;
		await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('const uploaded = true;') });
		const references = page.locator('.ash-chat-code-reference:not(.ash-chat-code-reference-end-space)');
		await expect.poll(async () => (await references.allTextContents()).join('')).toBe(name);
		await expect(page.locator('.ash-chat-code-reference-chip').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
		expect(await page.locator('.ash-chat-input-editor').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
		await expect(input).toBeFocused();
		await page.screenshot({ path: testInfo.outputPath('wrapped-file-reference.png') });
		// The trailing space can wrap after an atomic chip; Home only reaches that visual line.
		await input.press('ControlOrMeta+Home');
		assert.deepEqual(await page.evaluate(() => window.ashChatInputIntegration.inputSelection()), { anchor: 0, active: 0 });
		await input.press('Delete');
		await expect(references).toHaveCount(0);
	});


	test('workspace path queries discard late results and cancel when the picker closes', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?deferFileSearch=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('combobox').fill('nested');
		await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('1');
		await picker.getByRole('combobox').fill('brief');
		await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('2');
		await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(2));
		await expect(picker.getByRole('option')).toHaveCount(1);
		await expect(picker.getByRole('option')).toContainText('brief.txt');
		await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(1));
		await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('2');
		await expect(picker.getByRole('option')).toHaveCount(1);
		await expect(picker.getByRole('option')).toContainText('brief.txt');
		await picker.getByRole('combobox').fill('src/');
		await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('3');
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(3));
		await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('3');
		await expect(picker).toHaveCount(0);
		await expect(page.getByLabel('Context error')).toHaveText('');
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});

	test('disposing the composer cancels an outstanding workspace file scan', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?deferFileSearch=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await page.getByRole('dialog').getByRole('combobox').fill('nested');
		await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('1');
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(1));
		await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('1');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByLabel('Context error')).toHaveText('');
	});

	test('attachment search mixes sources with recent files and accepts repeatedly without opening an editor', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await expect(picker.getByRole('separator', { name: 'Recently opened' })).toHaveCount(1);
		await expect(picker.getByRole('option', { name: /closed.ts/ })).toBeVisible();
		await picker.getByRole('combobox').fill('edited');
		await page.keyboard.press('Control+Enter');
		const attachments = page.getByRole('list', { name: 'Attached context' });
		await expect(attachments).toHaveCount(0);
		await expect(picker.getByRole('combobox')).toBeFocused();
		await picker.getByRole('combobox').fill('nested');
		await expect(picker.getByRole('option', { name: /nested.txt/ })).toBeVisible();
		await page.keyboard.press('Control+Enter');
		await expect(attachments).toHaveCount(0);
		await picker.getByRole('combobox').fill('edited');
		await page.keyboard.press('Control+Enter');
		await expect(attachments).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts nested.txt edited.ts ');
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(page.getByLabel('Opened editor count')).toHaveText('0');
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
			{ name: 'edited.ts', content: 'Unsaved editor text' },
			{ name: 'nested.txt', content: 'Workspace file content' },
			{ name: 'edited.ts', content: 'Unsaved editor text' },
		]));
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`folder attachments carry their scope and manifest and allow going back in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '文件和文件夹…' : 'Files & Folders…', exact: true }).click();
			await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '按名称搜索文件或文件夹' : 'Search file or folder by name');
			await picker.getByRole('option', { name: chinese ? '返回 ↩' : 'Go back ↩', exact: true }).click();
			await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
			await picker.getByRole('option', { name: chinese ? '文件和文件夹…' : 'Files & Folders…', exact: true }).click();
			await expect(picker.getByRole('option', { name: /src \/workspace/ })).toBeVisible();
			await picker.getByRole('option', { name: /src \/workspace/ }).click();
			await expect(picker).toHaveCount(0);
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'src', content: 'Directory: file:///workspace/src\nFiles:\nnested.txt' }]));
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`focused reference deletion preserves the attachment at the text caret in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			await add.press('Enter');
			const chooser = page.waitForEvent('filechooser');
			await page.getByRole('dialog').getByRole('option', { name: chinese ? '添加附件' : 'Attach files', exact: true }).click();
			await (await chooser).setFiles({ name: 'first.ts', mimeType: 'text/plain', buffer: Buffer.from('First captured snapshot') });
			await add.press('Enter');
			await page.getByRole('dialog').getByRole('option', { name: chinese ? '会话…' : 'Sessions…', exact: true }).click();
			await page.getByRole('dialog').getByRole('option', { name: 'Earlier design', exact: true }).click();
			const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await input.press('ControlOrMeta+Home');
			await input.press('Tab');
			const file = page.getByRole('button', { name: chinese ? '打开 first.ts' : 'Open first.ts', exact: true });
			await expect(file).toBeFocused();
			await file.press('Tab');
			const removeFile = page.getByRole('button', { name: chinese ? '移除 first.ts' : 'Remove first.ts', exact: true });
			await expect(removeFile).toBeFocused();
			await removeFile.press('Tab');
			const session = page.getByRole('button', { name: chinese ? '打开 Earlier design' : 'Open Earlier design', exact: true });
			await expect(session).toBeFocused();
			await session.press('Delete');
			await expect(session).toHaveCount(0);
			await expect(file).toBeVisible();
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+z');
			await expect(session).toBeVisible();
			await expect(file).toBeVisible();
			await expect(page.getByLabel('Submission')).toBeEmpty();
		});

		for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) {
			test(`registered session references preserve keyboard actions, geometry and snapshots in ${locale}, ${theme}`, async () => {
				const { page } = browserTests;
				await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const chinese = locale === 'zh-CN';
				await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
				await page.getByRole('dialog').getByRole('option', { name: chinese ? '会话…' : 'Sessions…', exact: true }).click();
				await page.getByRole('dialog').getByRole('option', { name: 'Earlier design', exact: true }).click();
				const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
				const source = page.getByRole('button', { name: chinese ? '打开 Earlier design' : 'Open Earlier design', exact: true });
				const remove = page.getByRole('button', { name: chinese ? '移除 Earlier design' : 'Remove Earlier design', exact: true });
				await expect(source).toBeVisible();
				const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
				assert.match(help!, chinese ? /打开所引用的会话/u : /open the referenced conversation/u);
				await message.press('Tab');
				await expect(source).toBeFocused();
				const geometry = await source.evaluate(button => {
					const chip = button.closest<HTMLElement>('.ash-chat-reference-attachment')!;
					const bounds = chip.getBoundingClientRect();
					const children = [...chip.querySelectorAll('button')].map(child => child.getBoundingClientRect());
					const style = getComputedStyle(button);
					return {
						width: bounds.width, height: bounds.height,
						contained: children.every(child => child.left >= bounds.left - 1 && child.right <= bounds.right + 1 && child.top >= bounds.top - 1 && child.bottom <= bounds.bottom + 1),
						focus: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
						contrast: getComputedStyle(chip).color !== getComputedStyle(chip).backgroundColor,
					};
				});
				assert.ok(geometry.width > 40 && geometry.height > 0);
				assert.deepEqual({ contained: geometry.contained, focus: geometry.focus, contrast: geometry.contrast }, { contained: true, focus: true, contrast: true });
				await source.press('Enter');
				await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([{ sessionId: 'previous-session', threadId: 'previous-thread' }]));
				await expect(page.getByLabel('Submission')).toBeEmpty();
				await source.press('Tab');
				await expect(remove).toBeFocused();
				await remove.press('Delete');
				await expect(source).toHaveCount(0);
				await expect(message).toBeFocused();
				await message.press('ControlOrMeta+z');
				await expect(source).toBeVisible();
				const draft = await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
				assert.equal(draft?.trim(), 'Earlier design');
				await expect(source).toBeVisible();
				await message.press('Home');
				await message.press('Alt+Enter');
				await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify(Array.from({ length: 2 }, () => ({ sessionId: 'previous-session', threadId: 'previous-thread' }))));
				await expect(page.getByLabel('Submission')).toBeEmpty();
				await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
				const submitted = JSON.parse((await page.getByLabel('Submission').textContent())!) as { name: string; content: string; }[];
				assert.deepEqual(submitted, [{ name: 'Earlier design', content: 'Conversation: Earlier design\nSession: previous-session\nThread: previous-thread\n\nUser: Design the attachment picker\n\nAssistant: Use one resource search owner' }]);
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`clipboard, screenshot and session context send snapshots in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}&screenshotFixture=1`);
			await page.waitForFunction(() => !!window.ashChatInputIntegration);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			for (const name of chinese ? ['剪贴板中的图片', '截图…', '会话…'] : ['Image from Clipboard', 'Screenshot…', 'Sessions…']) {
				await add.press('Enter');
				await page.getByRole('dialog').getByRole('option', { name, exact: true }).click();
				if (name === 'Screenshot…' || name === '截图…') {
					const capture = page.frameLocator('iframe').getByRole('dialog', { name: chinese ? '屏幕截图' : 'Screen Capture' });
					await capture.getByRole('button', { name: chinese ? '整个屏幕' : 'Entire screen', exact: true }).click();
					await capture.getByRole('button', { name: chinese ? '加入聊天' : 'Add to Chat', exact: true }).click();
				}
				if (name === 'Sessions…' || name === '会话…') {
					await expect(page.getByRole('dialog').getByRole('option', { name: 'Current session', exact: true })).toHaveCount(0);
					await page.getByRole('dialog').getByRole('option', { name: 'Earlier design', exact: true }).click();
				}
				await expect(page.getByRole('dialog')).toHaveCount(0);
				await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			}
			const attachments = page.getByRole('list', { name: chinese ? '已添加的上下文' : 'Attached context' });
			await expect(attachments).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).not.toBeEmpty();
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { name: string; content: string; kind?: string; }[];
			expect(contexts.slice(0, 2).map(item => item.kind)).toEqual(['image', 'image']);
			expect(contexts[0].content).toMatch(/^data:image\/png;base64,/);
			expect(contexts[1].content).not.toBe(contexts[0].content);
			expect(contexts[2]).toEqual({ name: 'Earlier design', content: 'Conversation: Earlier design\nSession: previous-session\nThread: previous-thread\n\nUser: Design the attachment picker\n\nAssistant: Use one resource search owner' });
		});

		test(`GitHub context selects repositories, pages issues and snapshots a linked PR in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			await add.press('Enter');
			await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
			await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
			await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
			await picker.getByRole('option', { name: chinese ? '加载更多' : 'Load more', exact: true }).click();
			await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
			await picker.getByRole('option', { name: /#13 Follow-up issue/ }).click();
			await expect(picker).toHaveCount(0);
			await add.press('Enter');
			await picker.getByRole('option', { name: 'Pull Request…', exact: true }).click();
			await picker.getByRole('combobox').fill('https://github.com/other/project/pull/27');
			await picker.getByRole('option', { name: 'other/project/pull/27', exact: true }).click();
			await expect(picker).toHaveCount(0);
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { name: string; content: string; }[];
			expect(contexts).toHaveLength(2);
			expect(contexts[0].content).toContain('https://github.com/team/alpha/issues/13');
			expect(contexts[0].content).toContain('Issue body\n\nComment: Issue discussion');
			expect(contexts[1].content).toContain('https://github.com/other/project/pull/27');
			expect(contexts[1].content).toContain('Branches: feature → main\nCommit: abc123');
			expect(contexts[1].content).toContain('modified: picker.ts\n+attach context');
			const reads = JSON.parse((await page.getByLabel('GitHub reads').textContent())!);
			expect(reads.filter((item: { type: string; }) => item.type === 'issues').map((item: { page: number; }) => item.page)).toEqual([1, 2]);
			expect(reads.every((item: { repository: { accountId: string; }; }) => item.repository.accountId === 'account')).toBe(true);
			expect(reads.filter((item: { type: string; }) => item.type === 'pullRequests')).toHaveLength(0);
		});
	}

	test('empty clipboard reports an error and cancelling screenshot restores the message', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?emptyClipboard=1&cancelScreenshot=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		await page.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
		await expect(page.getByLabel('Context error')).toContainText('The clipboard does not contain an image');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await page.getByRole('dialog').getByRole('option', { name: 'Screenshot…', exact: true }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	});

	test('GitHub selection accepts manual repositories and numbers without forwarding mismatched links', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		for (const link of ['https://other.test/team/alpha/issues/12', 'https://github.com/team/alpha/pull/12']) {
			await picker.getByRole('combobox').fill(link);
			await expect(picker.getByRole('option')).toHaveCount(1);
			await expect(picker.getByRole('option', { name: 'Go back ↩', exact: true })).toBeVisible();
			await expect(page.getByLabel('GitHub reads')).toHaveText('[]');
		}
		await picker.getByRole('combobox').fill('other/project');
		await picker.getByRole('option', { name: 'other/project', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search issues or enter #number');
		await picker.getByRole('combobox').fill('#99');
		await picker.getByRole('option', { name: /#99 Attachment issue/ }).click();
		await expect(picker).toHaveCount(0);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toContainText('https://github.com/other/project/issues/99');
	});

	test('GitHub body search retains server matches even when the title does not match', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
		await picker.getByRole('combobox').fill('body:repro');
		await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await page.keyboard.press('Escape');
	});

	test('GitHub account selection keeps the chosen host and grant with a pasted issue', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?multipleGitHubAccounts=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('option', { name: /work-developer github.company.test/ }).click();
		await picker.getByRole('combobox').fill('https://github.company.test/team/project/issues/8');
		await picker.getByRole('option', { name: 'team/project/issues/8', exact: true }).click();
		await expect(picker).toHaveCount(0);
		const reads = JSON.parse((await page.getByLabel('GitHub reads').textContent())!);
		expect(reads).toEqual([{ type: 'issue', repository: { host: 'github.company.test', accountId: 'work-account', owner: 'team', name: 'project' }, number: 8 }]);
	});

	test('GitHub requires an account and a later context selection still succeeds', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?noGitHubAccount=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		await page.getByRole('dialog').getByRole('option', { name: 'Pull Request…', exact: true }).click();
		await expect(page.getByLabel('Context error')).toContainText('Connect a GitHub account in Settings');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await page.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
	});

	test('GitHub query changes and composer disposal cancel reads and discard late results', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?deferGitHubSearch=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
		await picker.getByRole('combobox').fill('older');
		await expect(page.getByLabel('GitHub reads')).toContainText('"query":"older"');
		await picker.getByRole('combobox').fill('newer');
		await expect(page.getByLabel('GitHub reads')).toContainText('"query":"newer"');
		await page.evaluate(() => window.ashChatInputIntegration.releaseGitHubSearch('newer'));
		await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.releaseGitHubSearch('older'));
		await expect(page.getByLabel('GitHub reads')).toContainText('"query":"older","cancelled":true');
		await expect(picker.getByRole('option', { name: /Old result/ })).toHaveCount(0);
		await picker.getByRole('combobox').fill('pending');
		await expect(page.getByLabel('GitHub reads')).toContainText('"query":"pending"');
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await page.evaluate(() => window.ashChatInputIntegration.releaseGitHubSearch('pending'));
		await expect(page.getByLabel('GitHub reads')).toContainText('"query":"pending","cancelled":true');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByLabel('Context error')).toHaveText('');
	});

	for (const capability of ['text', 'image', 'unknown'] as const) {
		test(`context image actions follow the selected model's ${capability} capability`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?imageCapability=${capability}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const add = page.getByRole('button', { name: 'Add context', exact: true });
			await add.press('Enter');
			const picker = page.getByRole('dialog');
			await expect(picker.getByRole('option', { name: 'Image from Clipboard', exact: true })).toHaveCount(capability === 'text' ? 0 : 1);
			await expect(picker.getByRole('option', { name: 'Screenshot…', exact: true })).toHaveCount(capability === 'text' ? 0 : 1);
			if (capability === 'text') {
				const chooser = page.waitForEvent('filechooser');
				await picker.getByRole('option', { name: 'Attach files', exact: true }).click();
				await (await chooser).setFiles({ name: 'unsupported.png', mimeType: 'image/png', buffer: Buffer.from('image') });
				await expect(page.getByLabel('Context error')).toContainText('The selected model does not support images');
				await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
				await add.press('Enter');
				await page.getByRole('dialog').getByRole('option', { name: 'Open editors', exact: true }).click();
				await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
				await expect(page.getByLabel('Submission')).toContainText('Unsaved editor text');
			} else {
				await picker.getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
				await expect(picker).toHaveCount(0);
				await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('text'));
				await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
				await expect(page.getByLabel('Context error')).toContainText('The selected model does not support images');
				await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
				await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('Pasted Image ');
				await expect(page.getByLabel('Submission')).toHaveText('');
				await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('image'));
				await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
				await expect(page.getByLabel('Submission')).toContainText('"kind":"image"');
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) {
		test(`file, image and terminal controls keep native focus, snapshots and geometry in ${locale}, ${theme}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			await add.press('Enter');
			const chooser = page.waitForEvent('filechooser');
			await page.getByRole('dialog').getByRole('option', { name: chinese ? '添加附件' : 'Attach files', exact: true }).click();
			await (await chooser).setFiles({ name: 'saved.ts', mimeType: 'text/plain', buffer: Buffer.from('Captured file') });
			await expect(page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} saved.ts`, exact: true })).toBeVisible();
			await expect(message).toBeFocused();
			await add.press('Enter');
			await page.getByRole('dialog').getByRole('option', { name: chinese ? '剪贴板中的图片' : 'Image from Clipboard', exact: true }).click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(message).toBeFocused();
			await add.press('Enter');
			await page.getByRole('dialog').getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
			await page.getByRole('dialog').getByRole('option', { name: /Shell \/workspace/ }).click();
			const file = page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} saved.ts`, exact: true });
			const removeFile = page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} saved.ts`, exact: true });
			const imageName = chinese ? '粘贴的图片' : 'Pasted Image';
			const image = page.getByRole('button', { name: `${chinese ? '预览' : 'Preview'} ${imageName}`, exact: true });
			const terminalName = chinese ? '终端：Shell' : 'Terminal: Shell';
			const terminal = page.getByRole('button', { name: chinese ? '预览终端快照' : 'Preview terminal snapshot', exact: true });
			await expect(image).toBeEnabled();
			const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
			assert.match(help!, chinese ? /文件、图片和终端引用具有原生的打开或预览按钮/u : /File, image and terminal references have native Open or Preview/u);
			await message.press('Tab');
			await expect(file).toBeFocused();
			await file.press('Enter');
			await expect.poll(async () => JSON.parse((await page.getByLabel('Opened saved content').textContent())!).map((entry: { text: string; readOnly: boolean; }) => [entry.text, entry.readOnly])).toEqual([['Captured file', true]]);
			await file.press('Tab');
			await expect(removeFile).toBeFocused();
			await removeFile.press('Enter');
			await expect(file).toHaveCount(0);
			await expect(message).toBeFocused();
			await message.press('ControlOrMeta+z');
			await expect(file).toBeVisible();
			await expect.poll(async () => JSON.parse((await page.getByLabel('Opened saved content').textContent())!).length).toBe(1);
			for (const source of [file, image, terminal]) {
				await source.focus();
				const geometry = await source.evaluate(button => {
					const chip = button.parentElement!;
					const box = chip.getBoundingClientRect();
					const focus = getComputedStyle(button);
					return {
						visible: box.width > 40 && box.height > 0,
						contained: [...chip.querySelectorAll('button')].every(child => { const bounds = child.getBoundingClientRect(); return bounds.left >= box.left - 1 && bounds.right <= box.right + 1 && bounds.top >= box.top - 1 && bounds.bottom <= box.bottom + 1; }),
						focus: focus.outlineStyle !== 'none' && focus.outlineWidth !== '0px',
						contrast: getComputedStyle(chip).color !== getComputedStyle(chip).backgroundColor,
					};
				});
				assert.deepEqual(geometry, { visible: true, contained: true, focus: true, contrast: true });
			}
			await page.screenshot({ path: browserTests.info.outputPath(`file-image-terminal-${locale}-${theme}.png`) });
			await image.press('Enter');
			const imageDialog = page.getByRole('dialog', { name: `${chinese ? '预览' : 'Preview'} ${imageName}`, exact: true });
			await expect(imageDialog.getByRole('img')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(image).toBeFocused();
			await image.press('Tab');
			const removeImage = page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} ${imageName}`, exact: true });
			await expect(removeImage).toBeFocused();
			await removeImage.press('Tab');
			await expect(terminal).toBeFocused();
			await terminal.press('Enter');
			const terminalDialog = page.getByRole('dialog', { name: `${chinese ? '已保存的终端输出：' : 'Saved terminal output: '}${terminalName}`, exact: true });
			await expect(terminalDialog.locator('.xterm-rows')).toContainText('context terminal ready');
			await terminalDialog.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${terminalName}`, exact: true }).click();
			await expect(terminalDialog).toHaveCount(0);
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([{ command: 'workbench.action.terminal.focus', resource: 'context-shell' }]));
			await terminal.focus();
			await terminal.press('Backspace');
			await expect(terminal).toHaveCount(0);
			await expect(message).toBeFocused();
			await message.press('ControlOrMeta+z');
			await terminal.press('Enter');
			await expect(terminalDialog.locator('.xterm-rows')).toContainText('context terminal ready');
			await page.keyboard.press('Escape');
			await expect(terminal).toBeFocused();
			await expect(page.getByLabel('Submission')).toBeEmpty();
		});
	}

	test('images decode, resize transparently and retain separate references across upload and clipboard', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const large = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 4096; canvas.height = 2048;
			canvas.getContext('2d')!.fillRect(0, 0, 2048, 2048);
			return canvas.toDataURL('image/png').split(',')[1];
		});
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		let chooser = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
		await (await chooser).setFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.from(large, 'base64') });
		const image = page.getByRole('img', { name: 'large.png', exact: true });
		await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([2048, 1024]);
		expect(await image.evaluate(element => {
			const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1024;
			const context = canvas.getContext('2d')!; context.drawImage(element as HTMLImageElement, 0, 0);
			return context.getImageData(1800, 500, 1, 1).data[3];
		})).toBe(0);
		await add.press('Enter');
		await page.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		chooser = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
		await (await chooser).setFiles({ name: 'duplicate.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==', 'base64') });
		await expect(page.locator('.ash-chat-image-reference-control img')).toHaveCount(3);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await expect(page.getByRole('img', { name: 'Pasted Image', exact: true })).toBeVisible();
		await add.press('Enter');
		chooser = page.waitForEvent('filechooser');
		await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
		await (await chooser).setFiles([{ name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('Valid') }, { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('Invalid image') }]);
		await expect(page.getByLabel('Context error')).toContainText('invalid.png could not be decoded as an image');
		await expect(page.locator('.ash-chat-image-reference-control img')).toHaveCount(3);
	});

	for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`other existing attachment controls retain source, focus and undo in ${locale}, ${theme}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '文件和文件夹…' : 'Files & Folders…', exact: true }).click();
			await picker.getByRole('option', { name: /src \/workspace/ }).click();
			await expect(message).toBeFocused();
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '指令…' : 'Instructions…', exact: true }).click();
			await picker.getByRole('option', { name: /API review/ }).click();
			await expect(message).toBeFocused();
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
			await picker.getByRole('combobox').fill('source document');
			await picker.getByRole('option', { name: /read_file/ }).click();
			await expect(message).toBeFocused();
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '搜索结果' : 'Search Results', exact: true }).click();
			await expect(message).toBeFocused();
			const names = ['src', 'API review', chinese ? '工具：read_file' : 'Tool: read_file', chinese ? '搜索结果：needle' : 'Search Results: needle'];
			for (const name of names) {
				const open = page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${name}`, exact: true });
				const remove = page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} ${name}`, exact: true });
				await message.press('ControlOrMeta+Home');
				await open.focus();
				const geometry = await open.evaluate(button => {
					const chip = button.parentElement!;
					const bounds = chip.getBoundingClientRect();
					return {
						visible: bounds.width > 40 && bounds.height > 0,
						contained: [...chip.querySelectorAll('button')].every(child => { const box = child.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1; }),
						focus: getComputedStyle(button).outlineStyle === 'solid',
						contrast: getComputedStyle(chip).color !== getComputedStyle(chip).backgroundColor,
					};
				});
				assert.deepEqual(geometry, { visible: true, contained: true, focus: true, contrast: true });
				await open.press('Enter');
				await expect(open).toBeFocused();
				await open.press('Tab');
				await expect(remove).toBeFocused();
				await remove.press('Delete');
				await expect(open).toHaveCount(0);
				await expect(message).toBeFocused();
				await message.press('ControlOrMeta+z');
				await expect(open).toBeVisible();
			}
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([
				{ command: 'revealInExplorer', resource: 'file:///workspace/src' },
				{ resource: 'file:///workspace/.ash/instructions/review.md', options: { fromUserGesture: true, openExternal: false } },
				{ command: 'workbench.action.openSettings', resource: { section: 'tools' } },
				{ command: 'workbench.action.findInFiles' },
			]));
			await expect(page.getByLabel('Opened saved content')).toHaveText('[]');
			await expect(page.getByLabel('Submission')).toBeEmpty();
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			await page.locator('main').screenshot({ path: browserTests.info.outputPath(`other-attachments-${locale}-${theme}.png`) });
			const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
			assert.match(help!, chinese ? /没有可导航来源的捕获上下文/u : /Captured contexts without a navigable source/u);
		});
	}

	for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`browser element and SCM controls preserve separate sources and captured content in ${locale}, ${theme}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			const names = ['Captured element', 'abc123 · Captured commit', 'src/历史.ts'];
			const sources = [URI.parse('https://example.test/original#element'), SCMHistoryItemUri.toUri({ repositoryId: 'repo:original', revision: 'captured:commit', baseRevision: 'captured:base' }), SCMHistoryItemUri.toUri({ repositoryId: 'repo:original', revision: 'captured:commit', baseRevision: 'captured:base', path: 'src/历史.ts' })];
			const kinds = ['browserElement', 'scmHistoryItem', 'scmHistoryItemChange'];
			let text = 'Explain ';
			const contexts = names.map((name, index) => {
				const start = text.length;
				text += name + ' ';
				return { id: `source-${index}`, kind: kinds[index], name, resource: sources[index]!.toString(), content: `<button onclick="captured()">Saved ${index}</button>`, reference: { start, end: text.length - 1 } };
			});
			await message.focus();
			await message.evaluate((element, draft) => {
				const transfer = new DataTransfer();
				transfer.setData('text/plain', draft.text);
				transfer.setData('application/vnd.chat.attachment+json', JSON.stringify({ version: 1, draft }));
				element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			}, { mode: 'agent', text, contexts });
			const sourceLabels = chinese ? ['打开 Captured element 的来源页面', '打开 abc123 · Captured commit 的提交更改', '打开 src/历史.ts 的历史版本文件'] : ['Open source page for Captured element', 'Open commit changes for abc123 · Captured commit', 'Open revision file for src/历史.ts'];
			for (const [index, name] of names.entries()) {
				const open = page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${name}`, exact: true });
				const origin = page.getByRole('button', { name: sourceLabels[index], exact: true });
				const remove = page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} ${name}`, exact: true });
				await open.focus();
				await open.press('Enter');
				await expect.poll(async () => JSON.parse(await page.getByLabel('Opened saved content').innerText()).length).toBe(index + 1);
				const saved = JSON.parse(await page.getByLabel('Opened saved content').innerText()).at(-1);
				assert.equal(saved.text, contexts[index]!.content);
				assert.equal(saved.readOnly, true);
				await open.press('Tab');
				await expect(origin).toBeFocused();
				const geometry = await origin.evaluate(button => {
					const chip = button.parentElement!;
					const bounds = chip.getBoundingClientRect();
					return { visible: bounds.width > 40 && bounds.height > 0, contained: [...chip.querySelectorAll('button')].every(child => { const box = child.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1; }), focus: getComputedStyle(button).outlineStyle === 'solid', contrast: getComputedStyle(chip).color !== getComputedStyle(chip).backgroundColor };
				});
				assert.deepEqual(geometry, { visible: true, contained: true, focus: true, contrast: true });
				await origin.press('Enter');
				await expect.poll(async () => JSON.parse(await page.getByLabel('Opened sources').innerText()).length).toBe(index + 1);
				await origin.press('Tab');
				await expect(remove).toBeFocused();
				await remove.press('Backspace');
				await expect(open).toHaveCount(0);
				await expect(message).toBeFocused();
				await message.press('ControlOrMeta+z');
				await expect(origin).toBeVisible();
			}
			assert.deepEqual(JSON.parse(await page.getByLabel('Opened sources').innerText()), [
				{ resource: sources[0]!.toString(), options: { fromUserGesture: true, openExternal: true } },
				{ command: 'workbench.scm.action.graph.viewChanges', resource: sources[1]!.toString() },
				{ command: 'workbench.scm.action.graph.openFile', resource: sources[2]!.toString() },
			]);
			assert.equal(JSON.parse(await page.getByLabel('Opened saved content').innerText()).length, 3, 'Source buttons cannot also open snapshots');
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			await message.press('ControlOrMeta+a');
			const copied = await message.evaluate(element => {
				const transfer = new DataTransfer();
				element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
				return transfer.types.map(type => [type, transfer.getData(type)]);
			});
			await message.press('Backspace');
			await message.evaluate((element, values) => {
				const transfer = new DataTransfer();
				for (const [type, value] of values) transfer.setData(type!, value!);
				element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			}, copied);
			for (const label of sourceLabels) await page.getByRole('button', { name: label, exact: true }).click();
			await expect.poll(async () => JSON.parse(await page.getByLabel('Opened sources').innerText()).length).toBe(6);
			const destinations = JSON.parse(await page.getByLabel('Opened sources').innerText());
			assert.deepEqual(destinations.slice(3), destinations.slice(0, 3));
			await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${names[0]}`, exact: true }).click();
			await expect.poll(async () => JSON.parse(await page.getByLabel('Opened saved content').innerText()).length).toBe(4);
			assert.equal(JSON.parse(await page.getByLabel('Opened saved content').innerText()).at(-1).text, contexts[0]!.content);
			await expect(page.locator('.ash-chat-input-container [onclick]')).toHaveCount(0);
			await expect(page.getByLabel('Submission')).toBeEmpty();
			const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
			assert.match(help!, chinese ? /额外的来源按钮/u : /Their extra source button/u);
			await page.locator('main').screenshot({ path: browserTests.info.outputPath(`browser-scm-${locale}-${theme}.png`) });
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`registered attachment sources cannot accept an old query while loading in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&deferContextSearch=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).click();
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '其他上下文来源' : 'Other context sources', exact: true }).click();
			await expect(picker.getByRole('option', { name: 'Source context', exact: true })).toBeVisible();
			await picker.getByRole('combobox').fill('pending');
			await expect(picker.getByRole('option')).toHaveCount(0);
			await picker.getByRole('combobox').press('Enter');
			await expect(picker).toBeVisible();
			await expect(page.locator('.ash-chat-attachment-chip')).toHaveCount(0);
			await picker.getByRole('combobox').fill('ready');
			await expect(picker.getByRole('option', { name: 'Source context: ready', exact: true })).toBeVisible();
			await picker.getByRole('combobox').press('Enter');
			await page.evaluate(() => window.ashChatInputIntegration.releaseContextSearch('pending'));
			await expect(message).toBeFocused();
			const open = page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} Source context: ready`, exact: true });
			await open.hover();
			await expect(page.locator('.ash-hover pre')).toContainText('Registered context content: ready');
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft()), 'Source context: ready ');
			await expect(page.getByLabel('Submission')).toBeEmpty();
		});

		test(`Open editors captures the displayed readonly version instead of another working copy in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&readonlyEditorSnapshot=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).click();
			await page.getByRole('dialog').getByRole('option', { name: chinese ? '已打开的编辑器' : 'Open editors', exact: true }).click();
			await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} edited.ts`, exact: true }).click();
			await expect.poll(async () => JSON.parse(await page.getByLabel('Opened saved content').innerText()).map((input: { text: string; }) => input.text)).toEqual(['Displayed readonly editor version']);
			await page.locator('[data-action-id="ash.chat.input.send"] button').click();
			await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'edited.ts', content: 'Displayed readonly editor version' }]));
		});
	}

	for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`saved attachment pointer and keyboard previews share bounded safe content in ${locale}, ${theme}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			const kinds = ['browserElement', 'scmHistoryItem', 'scmHistoryItemChange', 'debug', 'custom'];
			const names = kinds.map((_, index) => `Captured ${index}`);
			const content = '<img src=x onerror="captured()">\n[run](command:unsafe)\n' + Array.from({ length: 30 }, (_, index) => `Captured line ${index + 1}`).join('\n');
			let text = '';
			const contexts = kinds.map((kind, index) => {
				const start = text.length;
				text += names[index] + ' ';
				const resource = kind === 'browserElement' ? URI.parse('https://example.test/original') : kind.startsWith('scm') ? SCMHistoryItemUri.toUri({ repositoryId: 'repo:opaque', revision: 'revision:opaque', ...(kind === 'scmHistoryItemChange' ? { path: 'source.ts' } : {}) }) : undefined;
				return { id: `context-${index}`, kind, name: names[index], content, resource: resource?.toString(), reference: { start, end: text.length - 1 } };
			});
			await message.focus();
			await message.evaluate((element, draft) => {
				const transfer = new DataTransfer();
				transfer.setData('text/plain', draft.text);
				transfer.setData('application/vnd.chat.attachment+json', JSON.stringify({ version: 1, draft }));
				element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			}, { mode: 'agent', text, contexts });
			for (const [index, name] of names.entries()) {
				const open = page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${name}`, exact: true });
				await open.hover();
				const pointer = page.locator('.ash-hover');
				await expect(pointer.locator('pre')).toContainText('<img src=x onerror="captured()">');
				await expect(pointer.locator('pre')).toContainText('Captured line 10');
				await expect(pointer).not.toContainText('Captured line 11');
				await expect(pointer.locator('img, pre a, a[href^="command:"], [onclick], [onerror]')).toHaveCount(0);
				await expect(pointer).not.toContainText('repo:opaque');
				assert.ok((await pointer.boundingBox())!.width <= 500);
				await message.press('ControlOrMeta+Home');
				for (let step = 0; step < index * 2; step++) await message.press('ArrowRight');
				await message.press('ControlOrMeta+k');
				await message.press('ControlOrMeta+i');
				const keyboard = page.locator('.stanza-editor-hover:not([hidden])');
				await expect(keyboard.locator('.stanza-editor-hover-content')).toBeFocused();
				await expect(keyboard.locator('pre')).toContainText('Captured line 10');
				await expect(keyboard).not.toContainText('Captured line 11');
				await expect(keyboard.locator('img, pre a, a[href^="command:"], [onclick], [onerror]')).toHaveCount(0);
				await page.keyboard.press('Escape');
				await expect(message).toBeFocused();
			}
			await page.getByRole('button', { name: `${chinese ? '移除' : 'Remove'} ${names[0]}`, exact: true }).click();
			await message.press('ControlOrMeta+z');
			await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${names[0]}`, exact: true }).hover();
			await expect(page.locator('.ash-hover pre')).toContainText('Captured line 10');
			await expect(page.getByLabel('Opened saved content')).toHaveText('[]');
			await expect(page.getByLabel('Opened sources')).toHaveText('[]');
			await expect(page.getByLabel('Submission')).toBeEmpty();
			const help = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility().help);
			assert.match(help!, chinese ? /键盘悬停命令显示同一份缩短的预览/u : /keyboard hover command shows the same shortened preview/u);
			await page.screenshot({ path: browserTests.info.outputPath(`saved-attachment-hover-${locale}-${theme}.png`) });
		});
	}

	test('source buttons preserve file, folder, session and GitHub destinations through draft capture and restore', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		let picker = page.getByRole('dialog');
		await picker.getByRole('combobox').fill('edited');
		await page.keyboard.press('Enter');
		await add.press('Enter');
		await picker.getByRole('option', { name: 'Files & Folders…', exact: true }).click();
		await picker.getByRole('option', { name: /src \/workspace/ }).click();
		await add.press('Enter');
		await picker.getByRole('option', { name: 'Sessions…', exact: true }).click();
		await picker.getByRole('option', { name: 'Earlier design', exact: true }).click();
		await add.press('Enter');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('combobox').fill('https://github.com/team/alpha/issues/12');
		await picker.getByRole('option', { name: 'team/alpha/issues/12', exact: true }).click();
		await expect(picker).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('edited.ts src Earlier design team/alpha #12: Attachment issue ');
		for (const name of ['src', 'Earlier design', 'team/alpha #12: Attachment issue']) {
			await page.getByRole('button', { name: `Open ${name}`, exact: true }).press('Enter');
		}
		await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([
			{ command: 'revealInExplorer', resource: 'file:///workspace/src' },
			{ sessionId: 'previous-session', threadId: 'previous-thread' },
			{ resource: 'https://github.com/team/alpha/issues/12', options: { fromUserGesture: true, openExternal: true } },
		]));
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
	});

	test('child context pickers go back one step and continue adding after Ctrl+Enter', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?multipleGitHubAccounts=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Sessions…', exact: true }).click();
		await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await picker.getByRole('option', { name: 'Sessions…', exact: true }).click();
		await picker.getByRole('combobox').fill('Earlier design');
		await expect(picker.getByRole('option', { name: 'Earlier design', exact: true })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: 'Earlier design', exact: true }).getAttribute('id'))!);
		await page.keyboard.press('Control+Enter');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('option', { name: 'developer github.com', exact: true }).click();
		await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
		await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a repository, enter owner/repository, or paste a GitHub link');
		await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a GitHub account');
		await picker.getByRole('option', { name: 'developer github.com', exact: true }).click();
		await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
		await picker.getByRole('combobox').fill('#12');
		await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /#12 Attachment issue/ }).getAttribute('id'))!);
		await page.keyboard.press('Control+Enter');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await expect(picker.getByRole('combobox')).toBeFocused();
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await page.keyboard.press('Escape');
	});

	test('long source attachment buttons fit a narrow composer and remain keyboard accessible', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?inlineCode=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.setViewportSize({ width: 320, height: 600 });
		await page.locator('main').evaluate(element => { element.style.width = '260px'; element.style.setProperty('--ash-contrastBorder', 'rgb(255, 255, 255)'); });
		const owner = 'a'.repeat(160);
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('combobox').fill(`https://github.com/${owner}/project/issues/12`);
		await picker.getByRole('option', { name: `${owner}/project/issues/12`, exact: true }).click();
		const item = page.locator('.ash-chat-input-editor');
		await expect(page.locator('.ash-chat-attachment-chip[data-attachment-kind="issue"]')).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
		expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		const open = item.getByRole('button', { name: `Open ${owner}/project #12: Attachment issue`, exact: true });
		await open.press('Enter');
		await expect(open).toBeFocused();
		await expect(page.getByLabel('Opened sources')).toContainText(`https://github.com/${owner}/project/issues/12`);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal, symbols and search results keep snapshots and source buttons after draft restore in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}`);
			await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashChatInputIntegration)), errors })).toEqual({ ready: true, errors: [] });
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
			await picker.getByRole('combobox').fill('Shell');
			await expect(picker.getByRole('option', { name: /Shell \/workspace/ })).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowUp');
			await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /Shell \/workspace/ }).getAttribute('id'))!);
			await page.keyboard.press('Control+Enter');
			await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
			// Stable terminal identity replaces its snapshot rather than creating a second chip.
			await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
			await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '符号…' : 'Symbols…', exact: true }).click();
			await picker.getByRole('combobox').fill('attach');
			await expect(picker.getByRole('option', { name: /attach/ })).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowUp');
			await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /attach/ }).getAttribute('id'))!);
			await page.keyboard.press('Control+Enter');
			await picker.getByRole('option', { name: chinese ? '搜索结果' : 'Search Results', exact: true }).click();
			await expect(picker).toHaveCount(0);
			await page.evaluate(() => { window.ashChatInputIntegration.changeContextSources(); });
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			const names = [chinese ? '终端：Shell' : 'Terminal: Shell', 'attach', chinese ? '搜索结果：needle' : 'Search Results: needle'];
			// Terminal context opens its captured preview even after the source changes;
			// symbol and search references still navigate to their owning services.
			for (const name of names.slice(1)) await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${name}`, exact: true }).press('Enter');
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([
				{ resource: 'file:///workspace/symbol.ts#2,1-4,2', options: { fromUserGesture: true, openExternal: false } },
				{ command: 'workbench.action.findInFiles' },
			]));
			await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
				{ name: names[0], content: 'Terminal: Shell\nDirectory: /workspace\n\ncontext terminal ready' },
				{ name: names[1], content: 'Symbol: attach\nSource: file:///workspace/symbol.ts#2,1-4,2\n\nfunction attach() {\n  return 42;\n}' },
				{ name: names[2], content: 'Matches: 1\n# Search: needle\n# File: file:///workspace/main.ts\n  2:1-2:7: needle' },
			]));
			await expect(page.getByLabel('Opened editor count')).toHaveText('0');
			await expect(page.getByLabel('Context error')).toHaveText('');
		});
	}

	test('context picker hides unavailable terminal and search sources and lets symbol pickers go back', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		for (const name of ['Terminal…', 'Symbols…', 'Search Results']) await expect(picker.getByRole('option', { name, exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.goto('/chatInput.html?contextSources=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await picker.getByRole('option', { name: 'Symbols…', exact: true }).click();
		await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await expect(page.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
	});

	test('stale indexed symbols never attach the code at an outdated range', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?contextSources=1&staleSymbol=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await page.getByRole('dialog').getByRole('option', { name: 'Symbols…', exact: true }).click();
		await page.getByRole('dialog').getByRole('option', { name: /attach/ }).click();
		await expect(page.getByLabel('Context error')).toContainText('The symbol source changed. Search again to attach its current code.');
		await expect(page.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});

	test('symbol search cancellation discards late provider results after composer disposal', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?contextSources=1&deferSymbolSearch=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Symbols…', exact: true }).click();
		await picker.getByRole('combobox').fill('pending');
		await expect(picker.getByRole('option', { name: /pending/ })).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await page.evaluate(() => window.ashChatInputIntegration.releaseSymbolSearch('pending'));
		await expect(page.getByLabel('Symbol reads')).toContainText('"query":"pending","aborted":true');
		await expect(picker).toHaveCount(0);
		await expect(page.getByLabel('Submission')).toHaveText('');
		await expect(page.getByLabel('Context error')).toHaveText('');
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`instructions retain their authorized reference through background acceptance and draft restore in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '指令…' : 'Instructions…', exact: true }).click();
			await picker.getByRole('combobox').fill('contracts');
			await expect(picker.getByRole('option', { name: /API review/ })).toContainText(chinese ? '目录' : 'Directory');
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowUp');
			await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /API review/ }).getAttribute('id'))!);
			await page.keyboard.press('Control+Enter');
			await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
			await picker.getByRole('option', { name: chinese ? '指令…' : 'Instructions…', exact: true }).click();
			await picker.getByRole('combobox').fill('review.md');
			await picker.getByRole('option', { name: /API review/ }).click();
			const attachments = page.locator('.ash-chat-input-editor');
			await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			await attachments.getByRole('button', { name: chinese ? '打开 API review' : 'Open API review', exact: true }).press('Enter');
			await expect(page.getByLabel('Opened sources')).toContainText('file:///workspace/.ash/instructions/review.md');
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'API review', content: '/workspace/.ash/instructions/review.md', kind: 'instruction' }]));
		});
	}

	test('instruction availability and catalog errors preserve the composer', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?noInstructions=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await expect(page.getByRole('option', { name: 'Instructions…', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.goto('/chatInput.html?instructionFailure=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await page.getByRole('option', { name: 'Instructions…', exact: true }).click();
		await expect(page.getByLabel('Context error')).toContainText('Instruction catalog failed');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});

	test('cancelled instruction catalogs cannot recreate a picker or attachment', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?deferInstructions=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await page.getByRole('option', { name: 'Instructions…', exact: true }).click();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog').getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashChatInputIntegration.releaseInstructions());
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`tools attach catalog metadata, hide internal tools and preserve source navigation in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			await add.press('Enter');
			await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
			await expect(picker.getByRole('option', { name: /internal_broker/ })).toHaveCount(0);
			await picker.getByRole('combobox').fill('docs-server');
			await expect(picker.getByRole('option', { name: /^connector_search(?:\s|$)/ })).toHaveCount(1);
			await picker.getByRole('combobox').fill('mcp/docs-server/connector_search');
			await expect(picker.getByRole('option', { name: /^connector_search(?:\s|$)/ })).toHaveCount(1);
			await picker.getByRole('combobox').fill('connector_search');
			await expect(picker.getByRole('option', { name: /^connector_search(?:\s|$)/ })).toBeVisible();
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowUp');
			await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /^connector_search(?:\s|$)/ }).getAttribute('id'))!);
			await page.keyboard.press('Control+Enter');
			await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
			await picker.getByRole('combobox').fill('source document');
			await picker.getByRole('option', { name: /read_file/ }).click();
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			const attachments = page.locator('.ash-chat-input-editor');
			await expect(attachments.getByRole('button', { name: /^(Remove|移除)/ })).toHaveCount(2);
			await attachments.getByRole('button', { name: chinese ? '打开 工具：read_file' : 'Open Tool: read_file', exact: true }).press('Enter');
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([{ command: 'workbench.action.openSettings', resource: { section: 'tools' } }]));
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!);
			expect(contexts.map((context: { content: string; }) => JSON.parse(context.content))).toEqual([
				{ name: 'connector_search', description: 'Search external references', source: 'mcp', sourceDetails: ['docs-server'], exposure: 'deferred', authority: 'providerDefined' },
				{ name: 'read_file', description: 'Read a source document', source: 'local', sourceDetails: ['directory'], exposure: 'direct', authority: 'directoryRead' },
			]);
		});
	}

	test('unavailable tools stay hidden and catalog failure returns focus without attachments', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?noTools=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await expect(page.getByRole('option', { name: 'Tools…', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.goto('/chatInput.html?toolFailure=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		await page.getByRole('option', { name: 'Tools…', exact: true }).click();
		await expect(page.getByLabel('Context error')).toContainText('Tool catalog failed');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`tool set references resolve to backend members when attached and sent in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
			await picker.getByRole('combobox').fill('local/directory');
			const set = picker.getByRole('option').filter({ hasText: 'local/directory' });
			await expect(set).toHaveCount(1);
			await set.click();
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { content: string; }[];
			expect(contexts.map(context => JSON.parse(context.content))).toEqual([
				{ id: 'local', source: 'local', sourceId: 'directory', tools: ['read_file', 'write_file'] },
			]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`open tool references follow catalog changes while preserving search and keyboard focus in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
			const search = picker.getByRole('combobox');
			await search.fill('source document');
			const read = picker.getByRole('option', { name: /^read_file(?:\s|$)/ });
			await expect(read).toBeVisible();
			await expect(picker.getByRole('option', { name: /^write_file(?:\s|$)/ })).toBeVisible();
			await page.keyboard.press('Control+Home');
			await expect(search).toHaveAttribute('aria-activedescendant', (await read.getAttribute('id'))!);
			await page.evaluate(() => window.ashChatInputIntegration.changeTools());
			await expect(picker.getByRole('option', { name: /^added_tool(?:\s|$)/ })).toBeVisible();
			await expect(picker.getByRole('option', { name: /^write_file(?:\s|$)/ })).toHaveCount(0);
			await expect(search).toHaveValue('source document');
			await expect(search).toBeFocused();
			await expect(search).toHaveAttribute('aria-activedescendant', (await read.getAttribute('id'))!);
			await page.keyboard.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toContainText('read_file');
		});

		test(`open tool configuration follows catalog changes without losing pending selection in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
			await picker.getByRole('option', { name: chinese ? '配置工具…' : 'Configure tools…', exact: true }).click();
			const search = picker.getByRole('combobox');
			await search.fill('read_file');
			const read = picker.getByRole('option', { name: /^read_file(?:\s|$)/ });
			await expect(read).toBeVisible();
			await read.click();
			await search.focus();
			await expect(search).toHaveAttribute('aria-activedescendant', (await read.getAttribute('id'))!);
			await expect(read).toContainText(chinese ? '已禁用' : 'Disabled');
			await page.evaluate(() => window.ashChatInputIntegration.changeTools());
			await expect(search).toHaveValue('read_file');
			await expect(search).toBeFocused();
			await expect(read).toContainText(chinese ? '已禁用' : 'Disabled');
			await search.fill('');
			await expect(picker.getByRole('option', { name: /^added_tool(?:\s|$)/ })).toBeVisible();
			await expect(picker.getByRole('option', { name: /^write_file(?:\s|$)/ })).toHaveCount(0);
			await picker.getByRole('option', { name: chinese ? '应用工具选择' : 'Apply tool selection', exact: true }).click();
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await message.press('End');
			await message.pressSequentially('Use enabled tools');
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			const submitted = JSON.parse((await page.getByLabel('Submission').textContent())!);
			expect(JSON.parse(submitted[0].content)).toEqual(['read_file']);
		});

		test(`tool selection toggles sets and members, discards cancellation and survives send in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			const picker = page.getByRole('dialog');
			const toolsLabel = chinese ? '工具…' : 'Tools…';
			const configureLabel = chinese ? '配置工具…' : 'Configure tools…';
			const applyLabel = chinese ? '应用工具选择' : 'Apply tool selection';
			const attachments = page.locator('.ash-chat-input-editor');
			const openSelection = async (): Promise<void> => {
				await add.press('Enter');
				await picker.getByRole('option', { name: toolsLabel, exact: true }).click();
				await picker.getByRole('option', { name: configureLabel, exact: true }).click();
			};
			await openSelection();
			await picker.getByRole('combobox').fill('read_file');
			await picker.getByRole('option', { name: /^read_file(?:\s|$)/ }).click();
			await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toContainText(chinese ? '已禁用' : 'Disabled');
			await picker.getByRole('combobox').fill('directory');
			await expect(picker.getByRole('option', { name: /directory/ })).toContainText(chinese ? '部分启用' : 'Partly enabled');
			await picker.getByRole('option', { name: /directory/ }).click();
			await expect(picker.getByRole('option', { name: /directory/ })).toContainText(chinese ? '已启用' : 'Enabled');
			await picker.getByRole('option', { name: /directory/ }).click();
			await picker.getByRole('option', { name: applyLabel, exact: true }).click();
			await expect(attachments).toContainText(chinese ? '工具选择：已禁用 2 个' : 'Tool selection: 2 disabled');
			await openSelection();
			await picker.getByRole('combobox').fill('directory');
			await picker.getByRole('option', { name: /directory/ }).click();
			await page.keyboard.press('Escape');
			await expect(attachments).toContainText(chinese ? '工具选择：已禁用 2 个' : 'Tool selection: 2 disabled');
			await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
			await page.keyboard.press('Escape');
			await expect(picker).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await message.press('End');
			await message.pressSequentially('Use only enabled tools');
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toContainText('toolSelection');
			const submitted = JSON.parse((await page.getByLabel('Submission').textContent())!);
			expect(JSON.parse(submitted[0].content)).toEqual(['read_file', 'write_file']);
			await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			await add.press('Enter');
			await picker.getByRole('option', { name: toolsLabel, exact: true }).click();
			await picker.getByRole('combobox').fill('read_file');
			await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toHaveCount(0);
			await page.keyboard.press('Escape');
			await page.keyboard.press('Escape');
			await attachments.getByRole('button', { name: /^(Remove|移除)/ }).click();
			await openSelection();
			await picker.getByRole('combobox').fill('read_file');
			await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toContainText(chinese ? '已启用' : 'Enabled');
			await page.keyboard.press('Escape');
		});
	}

	test('terminal context uses shell cwd in the picker and attachment while retaining launch cwd fallback', async function () {
		const { page } = browserTests;

		await page.goto('/chatInput.html?contextSources=1&terminalCwd=%2Fworkspace%2Fcurrent%3Bfolder');
		await page.waitForFunction(() => Boolean(window.ashChatInputIntegration));
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Terminal…', exact: true }).click();
		await picker.getByRole('combobox').fill('Shell');
		await picker.getByRole('option', { name: /Shell \/workspace\/current;folder/ }).click();
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'Terminal: Shell', content: 'Terminal: Shell\nDirectory: /workspace/current;folder\n\ncontext terminal ready' }]));
	});

	for (const storageDisabled of [false, true]) test(`terminal context retains command text, capability and trust with command storage disabled=${storageDisabled}`, async function () {
		const { page } = browserTests;

		await page.goto(`/chatInput.html?contextSources=1&shellHistory=1${storageDisabled ? '&disableCommandStorage=1' : ''}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: 'Terminal…', exact: true }).click();
		await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('Terminal: Shell ');
		await page.evaluate(() => window.ashChatInputIntegration.changeContextSources());
		await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { content: string; }[];
		const output = 'Terminal: Shell\nDirectory: /workspace\n\ncontext terminal ready';
		expect(contexts[0].content).toBe(output + (storageDisabled ? '' : '\n\n' + JSON.stringify({
			hasRichCommandDetection: true, commands: [
				{ commandId: 'first', status: 'succeeded', exitCode: 0, command: 'echo 中文; "quoted"', isTrusted: true, cwd: '/workspace' },
				{ commandId: 'second', status: 'failed', exitCode: 9, command: 'unverified\ncommand', isTrusted: false, cwd: '/workspace/current' },
			]
		}, null, 2)));
		await expect(page.getByLabel('Context error')).toHaveText('');
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`appending a question preserves the rich terminal reference and its frozen snapshot in ${locale}`, async function () {
			const { page } = browserTests;

			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashChatInputIntegration));
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
			await input.focus();
			await page.keyboard.type('Existing draft ');
			await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
			await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
			const preview = page.getByRole('button', { name: chinese ? '预览终端快照' : 'Preview terminal snapshot', exact: true });
			await expect(preview).toBeVisible();
			await page.evaluate(() => window.ashChatInputIntegration.appendToDraft('Explain the captured output'));
			await expect(preview).toBeVisible();
			await expect(page.getByLabel('Submission')).toHaveText('');
			await input.focus();
			await input.press('ControlOrMeta+z');
			await expect(preview).toBeVisible();
			await page.evaluate(() => window.ashChatInputIntegration.appendToDraft('Explain the captured output'));
			await page.evaluate(() => window.ashChatInputIntegration.changeContextSources());
			expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe(`Existing draft ${chinese ? '终端：Shell' : 'Terminal: Shell'} \n\nExplain the captured output`);
			await expect(preview).toBeVisible();
			await preview.click();
			await expect(page.locator('.ash-chat-terminal-preview-screen .xterm-rows')).toContainText('context terminal ready');
			await page.getByRole('button', { name: chinese ? '关闭终端预览' : 'Close terminal preview', exact: true }).press('Escape');
			await page.getByRole('button', { name: chinese ? '移除 终端：Shell' : 'Remove Terminal: Shell', exact: true }).click();
			await expect(preview).toHaveCount(0);
			await expect(page.getByLabel('Submission')).toHaveText('');
		});

		test(`terminal snapshot preview survives source disposal and draft handoff in ${locale}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}&theme=${chinese ? 'hcLight' : 'dark'}`);
			const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
			await add.press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
			await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
			const previewButton = page.getByRole('button', { name: chinese ? '预览终端快照' : 'Preview terminal snapshot', exact: true });
			await expect(previewButton).toBeVisible();
			await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.disposeContextTerminal());
			await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			await previewButton.focus();
			await previewButton.press('Enter');
			const dialog = page.getByRole('dialog', { name: chinese ? '已保存的终端输出：终端：Shell' : 'Saved terminal output: Terminal: Shell', exact: true });
			const preview = dialog.locator('.ash-chat-terminal-preview-screen');
			await expect(preview.locator('.xterm-rows')).toContainText('context terminal ready');
			const input = preview.getByRole('textbox', { name: chinese ? '已保存的终端输出（只读）' : 'Saved terminal output (read only)', exact: true });
			await expect(input).toHaveAttribute('readonly', '');
			await expect.poll(() => preview.boundingBox().then(box => box?.height)).toBe(160);
			const close = dialog.getByRole('button', { name: chinese ? '关闭终端预览' : 'Close terminal preview', exact: true });
			await expect(close).toBeFocused();
			await expect.poll(() => close.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
			await close.press('Escape');
			await expect(preview).toHaveCount(0);
			await expect(previewButton).toBeFocused();
			await previewButton.press('Enter');
			await expect(dialog.locator('.xterm-rows')).toContainText('context terminal ready');
			await close.click();
			await expect(dialog).toHaveCount(0);
			await expect(previewButton).toBeFocused();
			await page.getByRole('button', { name: chinese ? '移除 终端：Shell' : 'Remove Terminal: Shell', exact: true }).click();
			await expect(previewButton).toHaveCount(0);

			expect(errors).toEqual([]);
		});
	}
});
