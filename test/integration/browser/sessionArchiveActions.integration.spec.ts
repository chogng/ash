import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	for (const wording of ['archive', 'done'] as const) {
		test(`Session lifecycle commands confirm and restore their canonical root in ${locale} ${wording}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html${locale === 'en' ? '' : '?locale=zh-CN'}`);
			await page.evaluate(wording => window.ashChatTranscriptIntegration.prepareSessionLifecycle(wording), wording);
			await page.evaluate(() => { void window.ashChatTranscriptIntegration.runSessionAction('agentSession.archive'); });
			const dialog = page.getByRole('dialog');
			await expect.poll(async () => { expect(errors).toEqual([]); return dialog.count(); }).toBe(1);
			await expect(dialog).toContainText(locale === 'en' ? 'Running work in this session will be interrupted' : '正在运行的工作将被中断');
			const archive = locale === 'en' ? wording === 'archive' ? 'Archive' : 'Mark as Done' : wording === 'archive' ? '归档' : '标记为完成';
			await dialog.getByRole('button', { name: archive, exact: true }).press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.sessionLifecycleState().sessions[0]?.status)).toBe('archived');
			await page.evaluate(() => { void window.ashChatTranscriptIntegration.runSessionAction('agentSession.restore'); });
			const picker = page.getByRole('dialog');
			await expect(picker.getByRole('option', { name: /Synthetic task$/u })).toBeVisible();
			const all = locale === 'en' ? wording === 'archive' ? 'Unarchive All' : 'Restore All' : wording === 'archive' ? '全部取消归档' : '全部恢复';
			await expect(picker.getByRole('option', { name: all, exact: true })).toBeVisible();
			await picker.screenshot({ path: test.info().outputPath('archived-sessions.png') });
			await picker.getByRole('combobox').fill('Synthetic task');
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.sessionLifecycleState().opened)).toEqual(['lifecycle/lifecycle']);
			const result = await page.evaluate(() => window.ashChatTranscriptIntegration.sessionLifecycleState());
			expect(errors).toEqual([]);
			expect(result).toEqual({
				requests: [{ operation: 'archive', sessionId: 'lifecycle' }, { operation: 'restore', sessionId: 'lifecycle' }],
				opened: ['lifecycle/lifecycle'],
				sessions: [{ id: 'lifecycle', status: 'active', threads: ['lifecycle/active', 'lifecycle-child/archived'] }],
				drafts: ['Preserved synthetic draft'],
			});
		});
	}
}
