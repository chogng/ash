import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';

suite('chatEditing browser component', () => {
	const browserTests = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) {
		test(`unavailable checkpoints are explained without sending a restore request (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}&unavailable`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
			await expect(page.getByRole('status', { name: 'Review error' })).toContainText(locale === 'en' ? 'No restorable checkpoints are available.' : '没有可恢复的检查点。');
			expect(await page.evaluate(() => window.ashChatEditingIntegration.checkpointState().requests)).toEqual([]);
		});
		test(`checkpoint cancellation keeps the current chat and restoration opens the backend result (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			const restore = page.getByRole('button', { name: 'Restore checkpoint', exact: true });
			await restore.click();
			const picker = page.getByRole('combobox');
			await expect(picker).toHaveAttribute('aria-label', locale === 'en' ? 'Choose a checkpoint to restore into a new chat' : '选择要恢复到新对话的检查点');
			await page.keyboard.press('Escape');
			await expect(restore).toBeFocused();
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.checkpointState())).toEqual({ requests: [], opened: [] });
			await restore.click();
			await picker.fill(locale === 'en' ? 'Before' : '之前');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.checkpointState().opened)).toEqual(['restored']);
			const request = await page.evaluate(() => window.ashChatEditingIntegration.checkpointState().requests[0]);
			expect(request).toMatchObject({
				sessionId: 'session',
				threadId: 'source',
				itemId: 'message',
				boundary: 'before',
			});
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().texts)).toEqual(['first change', 'second change']);
		});
		test(`pending reviews survive a window reload and decisions remain scoped (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.evaluate(() => window.ashChatEditingIntegration.prepareReload());
			await page.goto(`/chatEditing.html?locale=${locale}&reopen`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().entries.length)).toBe(2);
			await page.getByRole('button', { name: 'Reject this chat' }).click();
			await page.getByRole('combobox').fill('first-chat');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot())).toEqual({ entries: [['/workspace/second.txt']], texts: ['original', 'second change'] });
		});
		test(`chat review commands isolate files and restore focus after cancellation (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			const reject = page.getByRole('button', { name: 'Reject this chat' });
			await reject.click();
			const picker = page.getByRole('combobox');
			await expect(picker).toHaveAttribute('aria-label', locale === 'en' ? 'Choose a chat to review its Agent changes' : '选择要审阅智能体更改的对话');
			await expect(picker).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(picker).toHaveCount(0);
			await expect(reject).toBeFocused();
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().entries.length)).toBe(2);
			await reject.click();
			await picker.fill('first-chat');
			await page.keyboard.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot())).toEqual({ entries: [['/workspace/second.txt']], texts: ['original', 'second change'] });
		});

		test(`shared reviews require an explicit combined decision through the keyboard (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}&shared`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.getByRole('button', { name: 'Reject this chat' }).click();
			const picker = page.getByRole('combobox');
			await picker.fill('second-chat');
			await page.keyboard.press('Enter');
			await expect(page.getByRole('status', { name: 'Review error' })).toHaveText(
				locale === 'en' ? 'These changes include edits from other chats. Review the shared file or change set separately.' : '这些更改包含其他对话的编辑。请单独审阅共享文件或更改集。',
			);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().entries.length)).toBe(2);
			await page.getByRole('button', { name: 'Review changes' }).click();
			await picker.fill('first-chat');
			await page.keyboard.press('Enter');
			await expect(page.locator('.ash-quick-pick-row-label')).toHaveText(['first.txt']);
			await expect(page.locator('.ash-quick-pick-row-detail')).toContainText(locale === 'en' ? 'Shared changes from 2 chats' : '来自 2 个对话的共享更改');
			const accept = page.getByRole('button', {
				name: locale === 'en' ? 'Accept changes from 2 chats' : '接受来自 2 个对话的更改',
				exact: true,
			});
			const reject = page.getByRole('button', {
				name: locale === 'en' ? 'Reject changes from 2 chats' : '拒绝来自 2 个对话的更改',
				exact: true,
			});
			await page.keyboard.press('Tab');
			await expect(accept).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(reject).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot())).toEqual({ entries: [['/workspace/second.txt']], texts: ['original', 'second change'] });
		});
	}

	test('a checkpoint result does not steal focus from a chat selected during restoration', async function () {
		const { page } = browserTests;

		await page.goto('/chatEditing.html?restoreSlow');
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
		await page.getByRole('combobox').fill('After');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.checkpointState().requests.length)).toBe(1);
		await page.evaluate(() => {
			window.ashChatEditingIntegration.switchChat();
			window.ashChatEditingIntegration.finishRestore();
		});
		await expect(page.locator('.ash-aria-status').filter({ hasText: 'Checkpoint restored in a new chat.' })).toHaveCount(1);
		expect(await page.evaluate(() => window.ashChatEditingIntegration.checkpointState().opened)).toEqual([]);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`history Undo and Redo preserve the Thread and announce keyboard actions (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			const undo = page.getByRole('button', { name: 'Undo last request', exact: true });
			await undo.focus();
			await page.keyboard.press('Enter');
			await expect(page.locator('.ash-aria-status').filter({ hasText: locale === 'en' ? 'were undone' : '已撤销上一个请求' })).toHaveCount(1);
			await expect(undo).toBeFocused();
			await page.getByRole('button', { name: 'Redo last request', exact: true }).focus();
			await page.keyboard.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashChatEditingIntegration.historyState()))
				.toEqual({
					requests: [
						{ sessionId: 'session', threadId: 'source', expectedSequence: 17, direction: 'undo' },
						{ sessionId: 'session', threadId: 'source', expectedSequence: 18, direction: 'redo' },
					],
					opened: [],
				});
		});
		test(`history protects dirty working copies and explains backend conflicts (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.evaluate(() => window.ashChatEditingIntegration.dirtyFile());
			await page.getByRole('button', { name: 'Undo last request', exact: true }).click();
			await expect(page.getByRole('status', { name: 'Review error' })).toContainText(locale === 'en' ? 'Save or revert unsaved files' : '尚未保存的文件');
			expect(await page.evaluate(() => window.ashChatEditingIntegration.historyState().requests)).toEqual([]);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.snapshot().texts[0])).toBe('unsaved user text');
			await page.goto(`/chatEditing.html?locale=${locale}&historyConflict`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.getByRole('button', { name: 'Undo last request', exact: true }).click();
			await expect(page.getByRole('status', { name: 'Review error' })).toContainText(locale === 'en' ? 'Their changes were kept' : '其更改已保留');
			await page.goto(`/chatEditing.html?locale=${locale}&historyReadConflict`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.getByRole('button', { name: 'Undo last request', exact: true }).click();
			await expect(page.getByRole('status', { name: 'Review error' })).toContainText(locale === 'en' ? 'Their changes were kept' : '其更改已保留');
			expect(await page.evaluate(() => window.ashChatEditingIntegration.historyState().requests)).toEqual([]);
		});
	}

	test('history action waits for idle and does not act on a chat changed during lookup', async function () {
		const { page } = browserTests;

		await page.goto('/chatEditing.html?historyBusy');
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await page.getByRole('button', { name: 'Undo last request', exact: true }).click();
		await expect(page.getByRole('status', { name: 'Review error' })).toContainText('Wait for the current request');
		expect(await page.evaluate(() => window.ashChatEditingIntegration.historyState().requests)).toEqual([]);
		await page.goto('/chatEditing.html?historySlow');
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await page.getByRole('button', { name: 'Undo last request', exact: true }).click();
		await page.evaluate(() => {
			window.ashChatEditingIntegration.switchChat();
			window.ashChatEditingIntegration.finishRestore();
		});
		await expect(page.locator('.ash-aria-status').filter({ hasText: 'were undone' })).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatEditingIntegration.historyState())).toEqual({
			requests: [],
			opened: [],
		});
	});

	test('checkpoint selection cannot restore the source after switching to another chat', async function () {
		const { page } = browserTests;

		await page.goto('/chatEditing.html');
		await page.waitForFunction(() => !!window.ashChatEditingIntegration);
		await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
		await expect(page.getByRole('combobox')).toBeVisible();
		await page.evaluate(() => window.ashChatEditingIntegration.switchChat());
		await page.keyboard.press('Enter');
		await expect(page.getByRole('combobox')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatEditingIntegration.checkpointState())).toEqual({
			requests: [],
			opened: [],
		});
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`a failed rejection survives reload and its keyboard retry reaches the file (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/chatEditing.html?locale=${locale}&saveFailure`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await page.getByRole('button', { name: 'Reject this chat' }).click();
			await page.getByRole('combobox').fill('first-chat');
			await page.keyboard.press('Enter');
			await expect(page.getByRole('status', { name: 'Review error' })).toContainText('Injected review save failure');
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.reviewState()[0])).toEqual({ resource: '/workspace/first.txt', pendingSave: true, hunks: 0 });
			expect(await page.evaluate(() => window.ashChatEditingIntegration.diskTexts())).toEqual(['first change', 'second change']);
			await page.evaluate(() => window.ashChatEditingIntegration.prepareReload());
			await page.goto(`/chatEditing.html?locale=${locale}&reopen`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.reviewState()[0])).toEqual({ resource: '/workspace/first.txt', pendingSave: true, hunks: 0 });
			expect(await page.evaluate(() => window.ashChatEditingIntegration.snapshot().texts)).toEqual(['original', 'second change']);
			expect(await page.evaluate(() => window.ashChatEditingIntegration.diskTexts())).toEqual(['first change', 'second change']);
			await page.getByRole('button', { name: 'Review changes' }).click();
			await page.getByRole('combobox').fill('first-chat');
			await page.keyboard.press('Enter');
			const retry = page.getByRole('button', {
				name: locale === 'en' ? 'Retry saving reviewed changes' : '重试保存已审阅的更改',
				exact: true,
			});
			await expect(retry).toBeVisible();
			await expect(page.locator('.ash-quick-pick-row-detail')).toContainText(locale === 'en' ? 'Rejected changes have not been saved.' : '已撤销的更改尚未保存。');
			await page.keyboard.press('Tab');
			await page.keyboard.press('ArrowRight');
			await expect(retry).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('combobox')).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.diskTexts())).toEqual(['original', 'second change']);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.reviewState())).toEqual([{ resource: '/workspace/second.txt', pendingSave: false, hunks: 1 }]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`pending review actions remain inside a narrow editor and accept through normal pointer input (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/chatEditing.html?locale=${locale}&editor&saveFailure`);
			await page.waitForFunction(() => !!window.ashChatEditingIntegration);
			const container = page.locator('#review-editor');
			const editor = container.locator('.stanza-editor');
			const overlay = editor.locator('.ash-chat-editing-overlay');
			const accept = overlay.getByRole('button', {
				name: locale === 'en' ? 'Accept file changes' : '接受文件修改',
				exact: true,
			});
			const reject = overlay.getByRole('button', {
				name: locale === 'en' ? 'Reject file changes' : '拒绝文件修改',
				exact: true,
			});
			await expect(overlay).toBeVisible();
			await reject.click();
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.reviewState()[0])).toEqual({ resource: '/workspace/first.txt', pendingSave: true, hunks: 0 });
			const retry = overlay.getByRole('button', {
				name: locale === 'en' ? 'Retry saving reviewed changes' : '重试保存已审阅的更改',
				exact: true,
			});
			await expect(retry).toBeEnabled();
			for (const width of [240, 180, 360]) {
				await container.evaluate((element, width) => {
					element.style.width = `${width}px`;
				}, width);
				await expect(async () => {
					const root = await editor.boundingBox();
					if (!root) throw new Error('Missing editor bounds');
					for (const button of [accept, retry]) {
						const bounds = await button.boundingBox();
						if (!bounds) throw new Error('Missing review control bounds');
						expect(bounds.x).toBeGreaterThanOrEqual(root.x);
						expect(bounds.x + bounds.width).toBeLessThanOrEqual(root.x + root.width);
					}
				}).toPass();
				await testInfo.attach(`review-${width}px`, {
					body: await container.screenshot(),
					contentType: 'image/png',
				});
			}
			await container.evaluate(element => {
				element.style.width = '240px';
			});
			await page.evaluate(() => window.ashChatEditingIntegration.setSaveFailure(false));
			await accept.click();
			await expect(overlay).toBeHidden();
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.diskTexts())).toEqual(['original', 'second change']);
			await expect.poll(() => page.evaluate(() => window.ashChatEditingIntegration.reviewState())).toEqual([{ resource: '/workspace/second.txt', pendingSave: false, hunks: 1 }]);
		});
	}
});
