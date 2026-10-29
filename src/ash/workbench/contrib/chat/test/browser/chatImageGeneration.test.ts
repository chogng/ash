import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Chat image generation', () => {
	const browserTests = useBrowserTests();
	async function pauseAnimationTimers(): Promise<void> {
		await browserTests.page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await browserTests.page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
	}

	test('live image generation hands its painted loading surface to a visible result without replacing tool focus', async () => {
		const { page, info } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('pending'));
		const tool = page.locator('.ash-chat-tool-invocation');
		const summary = tool.locator('summary');
		await expect(summary).toHaveText('Generating image');
		await expect(tool).not.toHaveAttribute('open');
		const loading = page.locator('.ash-chat-image-generation-placeholder');
		await expect(loading).toHaveAttribute('aria-busy', 'true');
		await expect.poll(() => loading.locator('canvas').evaluate(canvas => {
			const element = canvas as HTMLCanvasElement;
			return element.width > 0 && element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data.some((value, index) => index % 4 === 3 && value > 0);
		})).toBe(true);
		const surface = await loading.locator('canvas').elementHandle();
		expect(await loading.evaluate(element => { const bounds = element.getBoundingClientRect(); return { width: bounds.width, height: bounds.height }; })).toEqual({ width: 200, height: 200 });
		await pauseAnimationTimers();
		await summary.focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success'));
		const result = page.getByRole('region', { name: 'Generated images (1)', exact: true });
		await expect(summary).toBeFocused();
		await expect(summary).toHaveText('Generated image');
		await expect(result).toBeVisible();
		await expect(tool).not.toHaveAttribute('open');
		const frame = result.locator('.ash-chat-image-frame');
		await expect(frame).toHaveClass(/revealing/);
		expect(await frame.locator('canvas').evaluate((canvas, previous) => canvas === previous, surface)).toBe(true);
		// The browser's Web Animation timeline is separate from Playwright's timer clock.
		const animation = await frame.locator('canvas').evaluateHandle(canvas => {
			const animation = canvas.getAnimations()[0]!;
			animation.pause();
			return animation;
		});
		try {
			const geometry = [];
			for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
				await animation.evaluate((animation, progress) => { animation.currentTime = Number(animation.effect!.getTiming().duration) * progress; }, progress);
				await page.clock.runFor(32);
				geometry.push(await frame.evaluate(element => { const bounds = element.getBoundingClientRect(); return { width: bounds.width, height: bounds.height }; }));
			}
			expect(geometry[0]).toEqual({ width: 200, height: 200 });
			expect(geometry[2]).toEqual({ width: 280, height: 210 });
			expect(geometry[4]).toEqual({ width: 360, height: 220 });
			expect(geometry.every(({ width, height }) => width >= 200 && width <= 360 && height >= 200 && height <= 220)).toBe(true);
		} finally {
			await animation.dispose();
		}
		await expect(result.getByRole('button', { name: 'Open image', exact: true })).toBeVisible();
		await expect(result.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
		await page.clock.runFor(700);
		await expect(frame.locator('canvas')).toHaveCount(0);
		await expect(result.locator('img')).toHaveCSS('opacity', '1');
		expect(await result.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(360);
		await page.screenshot({ path: info.outputPath('generated-image.png') });
		await surface?.dispose();
	});

	for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light', 'hc', 'hcLight'] as const) {
		test(`restored images expose readonly preview, download and help without replay in ${locale} ${theme}`, async () => {
			const { page, info } = browserTests;
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(theme => { window.ashChatTranscriptIntegration.setTheme(theme); window.ashChatTranscriptIntegration.showImageGeneration('success'); }, theme);
			const result = page.locator('.ash-chat-generated-image-result');
			await expect(result).toHaveAttribute('aria-label', locale === 'en' ? 'Generated images (1)' : '生成的图片（1）');
			await expect(result.locator('img')).toBeVisible();
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			const open = result.getByRole('button', { name: locale === 'en' ? 'Open image' : '打开图片', exact: true });
			await open.focus();
			await open.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().resource)).toMatch(/^chat-response-resource:/);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaPreviewState())).toMatchObject({ readonly: true });
			await page.evaluate(() => window.ashChatTranscriptIntegration.closeMediaPreview());
			const download = page.waitForEvent('download');
			await result.getByRole('button', { name: locale === 'en' ? 'Download' : '下载', exact: true }).click();
			expect((await download).suggestedFilename()).toMatch(/\.png$/);
			await page.locator('.ash-chat-tool-invocation summary').focus();
			await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true));
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(locale === 'en' ? /Generated images appear outside/ : /生成的图片会显示在工具详情之外/);
			await page.keyboard.press('Escape');
			await page.evaluate(() => { document.querySelector<HTMLElement>('main')!.style.width = '180px'; window.ashChatTranscriptIntegration.recreateTranscript(); });
			await expect(result.locator('img')).toBeVisible();
			expect(await result.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			expect(await result.locator('img').evaluate(image => { const bounds = image.getBoundingClientRect(); return bounds.width <= image.parentElement!.clientWidth && Math.abs(bounds.width / bounds.height - 360 / 220) < 0.01; })).toBe(true);
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await page.screenshot({ path: info.outputPath(`image-${locale}-${theme}.png`) });
		});
	}

	test('multiple stored images read canonical coordinates from a Thread source and release pending reads on removal', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => { window.ashChatTranscriptIntegration.delayAttachments(true); window.ashChatTranscriptIntegration.showImageGeneration('pending'); });
		await expect(page.locator('.ash-chat-image-glyphs')).toBeVisible();
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success', 2, true));
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests)).toEqual([
			{ sessionId: 'session', threadId: 'thread', itemId: 'image-result', contentIndex: 1 },
			{ sessionId: 'session', threadId: 'thread', itemId: 'image-result', contentIndex: 2 },
		]);
		await expect(page.locator('.ash-chat-image-generation-placeholder')).toBeVisible();
		await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
		await expect.poll(() => page.locator('.ash-chat-generated-image-result img').evaluateAll(images => images.map(image => (image as HTMLImageElement).naturalWidth))).toEqual([360, 360]);
		await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		await expect(page.locator('.ash-chat-generated-image-result')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().aborted)).toBe(true);
	});

	for (const state of ['failure', 'stopped'] as const) {
		test(`${state} ends progress without presenting an image or inferring success`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('pending'));
			await expect(page.locator('.ash-chat-image-glyphs')).toBeVisible();
			await page.evaluate(state => window.ashChatTranscriptIntegration.showImageGeneration(state), state);
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await expect(page.locator('.ash-chat-generated-image-result')).toHaveCount(0);
			await expect(page.locator('.ash-chat-tool-invocation summary')).toHaveText(state === 'failure' ? 'Image generation failed' : 'Image generation stopped');
		});
	}

	for (const reduced of [false, true]) {
		test(`hidden completions and reduced motion (${reduced}) leave final images without retained effects`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			await page.evaluate(async reduced => { await window.ashChatTranscriptIntegration.setReducedMotion(reduced); window.ashChatTranscriptIntegration.showImageGeneration('pending'); }, reduced);
			await expect(page.locator('.ash-chat-image-generation-placeholder')).toBeVisible();
			await pauseAnimationTimers();
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
			await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success'));
			await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
			await expect(page.locator('.ash-chat-generated-image-result img')).toBeVisible();
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await expect(page.locator('.ash-chat-image-generation-placeholder')).toHaveCount(0);
			await page.evaluate(() => { window.ashChatTranscriptIntegration.remove(); window.ashChatTranscriptIntegration.showImageGeneration('pending'); });
			await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success'));
			await expect(page.locator('.ash-chat-generated-image-result img')).toBeVisible();
			if (reduced) await expect(page.locator('.ash-chat-image-reveal.revealing')).toHaveCount(0);
			else {
				await expect(page.locator('.ash-chat-image-reveal.revealing')).toHaveCount(1);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(false));
				await expect(page.locator('.ash-chat-image-reveal.revealing')).toHaveCount(0);
				await page.evaluate(() => window.ashChatTranscriptIntegration.setTranscriptVisible(true));
			}
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await expect(page.locator('.ash-chat-generated-image-result img')).toHaveCSS('opacity', '1');
		});
	}

	for (const theme of ['hc', 'hcLight'] as const) {
		test(`live results finish immediately in ${theme}`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			await page.evaluate(theme => { window.ashChatTranscriptIntegration.setTheme(theme); window.ashChatTranscriptIntegration.showImageGeneration('pending'); }, theme);
			await expect(page.locator('.ash-chat-image-generation-placeholder')).toBeVisible();
			await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success'));
			await expect(page.locator('.ash-chat-generated-image-result img')).toBeVisible();
			await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
			await expect(page.locator('.ash-chat-image-reveal.revealing')).toHaveCount(0);
		});
	}

	test('changing reduced motion during a reveal removes its canvas and restores the original image', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('pending'));
		await expect(page.locator('.ash-chat-image-generation-placeholder')).toBeVisible();
		await pauseAnimationTimers();
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success'));
		await expect(page.locator('.ash-chat-image-reveal.revealing')).toHaveCount(1);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setReducedMotion(true));
		await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
		await expect(page.locator('.ash-chat-generated-image-result img')).toHaveCSS('opacity', '1');
	});

	test('late image reads cannot revive a removed generation result', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => { window.ashChatTranscriptIntegration.delayAttachments(true); window.ashChatTranscriptIntegration.showImageGeneration('pending'); });
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('success', 1, true));
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
		await page.evaluate(() => { window.ashChatTranscriptIntegration.remove(); window.ashChatTranscriptIntegration.finishMedia(); });
		await expect(page.locator('.ash-chat-generated-image-result, .ash-chat-image-glyphs')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().aborted)).toBe(true);
	});

	for (const url of ['data:image/png;base64,AA==', 'file:///tmp/generated.png']) test(`unavailable image (${url}) ends progress and offers no empty preview or download`, async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.showImageGeneration('pending'));
		await page.evaluate(url => {
			window.ashChatTranscriptIntegration.renderItems([{
				id: 'image-call', type: 'toolCall', text: '', transient: false, toolInvocation: {
					call: { type: 'toolCall', itemId: 'image-call', turnId: 'image-turn', toolCallId: 'image-tool', name: 'imagegen', argumentsJson: '{}' },
					result: { type: 'toolResult', itemId: 'image-result', turnId: 'image-turn', toolCallId: 'image-tool', text: '', isError: false, content: [{ type: 'imageUrl', detail: 'auto', url }] }, output: [], stopped: false,
				}
			}]);
		}, url);
		await expect(page.locator('.ash-chat-generated-image-result figcaption')).toHaveText('This media could not be loaded.');
		await expect(page.locator('.ash-chat-image-glyphs')).toHaveCount(0);
		await expect(page.locator('.ash-chat-generated-image-result').getByRole('button', { name: 'Open image', exact: true })).toBeHidden();
		await expect(page.locator('.ash-chat-generated-image-result').getByRole('button', { name: 'Download', exact: true })).toBeHidden();
	});
});
