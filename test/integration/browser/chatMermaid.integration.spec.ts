import { expect, test } from '@playwright/test';
import { startMarkdownExtension } from '../../fixtures/markdownExtension.js';

test('Chat renders complete Mermaid fences using the Rust extension and retains accessible source', async ({ page }) => {
	const backend = await startMarkdownExtension('zh-CN', [], {}, [], undefined, false);
	const requests: { source: string; theme: string; }[] = [];
	const source = 'flowchart LR\nA[输入] --> B[输出]';
	const fence = '```mermaid\n' + source;
	await page.route('**/__chat_mermaid', async route => {
		if (route.request().method() === 'GET') {
			await route.fulfill({ json: { generation: 1, extensions: [{ id: 'ash.markdown-language-features', activationGeneration: 1, incarnation: 1, lifecycle: 'ready', registrations: backend.registrations }] } });
			return;
		}
		const payload = route.request().postDataJSON();
		requests.push(payload);
		await route.fulfill({ json: await backend.invoke('markdown.mermaid.render.v1', 'receiveData', payload) });
	});
	try {
		await page.goto('/chatTranscript.html?locale=zh-CN&mermaid&sentImageViewer');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTheme('light'));
		const stream = (value: string, complete: boolean) => page.evaluate(({ value, complete }) => window.ashChatTranscriptIntegration.stream(value, complete), { value, complete });
		const preview = page.getByRole('img', { name: 'Mermaid 图表', exact: true });
		await stream(fence, false);
		await expect(page.locator('.ash-chat-code-block')).toBeVisible();
		await expect(preview).toHaveCount(0);
		expect(requests).toHaveLength(0);
		await stream(fence + '\n```', true);
		await expect(preview).toBeVisible();
		await expect(preview).toHaveAttribute('src', /^blob:/u);
		expect(await preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
		const trigger = page.getByRole('button', { name: '预览 Mermaid 图表', exact: true });
		await trigger.press('Enter');
		const dialog = page.getByRole('dialog', { name: '预览 Mermaid 图表', exact: true });
		const viewer = dialog.locator('.ash-image-viewer');
		const image = viewer.locator('img');
		await expect(image).toBeVisible();
		await viewer.press('1');
		const originalWidth = (await image.boundingBox())!.width;
		await viewer.press('Equal');
		await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(originalWidth);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		expect(requests.map(request => ({ source: request.source.trimEnd(), theme: request.theme }))).toEqual([{ source, theme: 'light' }]);
		const disclosure = page.locator('summary').filter({ hasText: 'Mermaid 源码' });
		await expect(page.locator('.ash-chat-code-block')).toBeHidden();
		await disclosure.focus();
		await disclosure.press('Enter');
		await expect(page.locator('.ash-chat-code-block')).toBeVisible();
		await expect(disclosure).toBeFocused();
		const lightImage = await preview.getAttribute('src');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTheme('dark'));
		await expect.poll(() => requests.at(-1)?.theme).toBe('dark');
		await expect(preview).not.toHaveAttribute('src', lightImage!);
		await expect(trigger).toHaveCount(1);
		await stream('~~~mermaid\nunsupported diagram\n~~~', true);
		await expect.poll(() => requests.at(-1)?.source.trimEnd()).toBe('unsupported diagram');
		await expect(preview).toHaveCount(0);
		await expect(page.locator('.ash-chat-code-block')).toBeVisible();
	} finally {
		await backend.dispose();
	}
});
