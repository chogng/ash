import { expect, test } from '@playwright/test';

test('Chat bounded history response comparison uses the same decoded content and visible endpoint', async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.prepareHistoryBenchmark(1000, 1024));
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	const samples: unknown[] = [];
	try {
		for (const method of ['read', 'subscribe'] as const) {
			for (const bounded of [false, true]) await page.evaluate(({ method, bounded }) => window.ashChatTranscriptIntegration.runHistoryBenchmark(method, bounded), { method, bounded });
			for (let pair = 0; pair < 5; pair++) for (const bounded of pair % 2 ? [true, false] : [false, true]) {
				await cdp.send('HeapProfiler.collectGarbage');
				const before = await cdp.send('Performance.getMetrics');
				const sample = await page.evaluate(({ method, bounded }) => window.ashChatTranscriptIntegration.runHistoryBenchmark(method, bounded), { method, bounded });
				const after = await cdp.send('Performance.getMetrics');
				const taskMs = (after.metrics.find(metric => metric.name === 'TaskDuration')!.value - before.metrics.find(metric => metric.name === 'TaskDuration')!.value) * 1000;
				expect(sample.items).toBe(bounded ? 20 : 1000);
				expect(sample.lastText).toBe('Answer 1000: ' + 'x'.repeat(1024));
				samples.push({ method, pair, bounded, ...sample, lastText: undefined, taskMs });
			}
		}
		await testInfo.attach('history-response-comparison.json', { body: JSON.stringify({ browser: page.context().browser()?.version(), turns: 1000, textBytes: 1024, pageTurns: 20, scope: 'Controlled browser response JSON.parse, generated schema, production domain adapter and ChatListWidget through two animation frames. No backend, IPC, full Chat model or Desktop measurement. Empty durable replay in both variants.', samples }, null, 2), contentType: 'application/json' });
	} finally { await cdp.detach(); }
});

for (const locale of ['en', 'zh-CN']) for (const cowork of [false, true]) {
	test(`${cowork ? 'Cowork' : 'Chat'} Voice mute and push to talk preserve the composer in ${locale}`, async ({ page }) => {
		await page.goto(`/chatTranscript.html?locale=${locale}`); await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(true, cowork), cowork);
		const chat = page.locator('#app-chat'); await chat.getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true }).click();
		const choices = page.getByRole('combobox', { name: locale === 'en' ? 'Voice conversation options' : '语音对话选项' }); await choices.fill('marin'); await choices.press('Enter');
		const draft = chat.locator(cowork ? '.stanza-editor-input' : '.ash-chat-input-part textarea'); if (cowork) { await draft.focus(); await page.keyboard.insertText('Private draft'); } else await draft.fill('Private draft');
		const controls = chat.locator('.ash-agents-voice'); await controls.getByRole('button', { name: locale === 'en' ? 'Mute microphone' : '静音麦克风', exact: true }).click();
		await controls.getByRole('button', { name: locale === 'en' ? 'Use push to talk' : '使用按住说话', exact: true }).click();
		const held = controls.getByRole('button', { name: locale === 'en' ? 'Hold to speak' : '按住说话', exact: true }); await expect(held).toBeDisabled();
		await controls.getByRole('button', { name: locale === 'en' ? 'Unmute microphone' : '取消麦克风静音', exact: true }).click();
		await held.focus(); await page.keyboard.down('Space'); await expect(held).toHaveAttribute('aria-pressed', 'true'); await page.keyboard.up('Space'); await expect(held).toHaveAttribute('aria-pressed', 'false');
		await held.focus(); await page.keyboard.down('Enter'); await expect(held).toHaveAttribute('aria-pressed', 'true'); await draft.focus(); await expect(held).toHaveAttribute('aria-pressed', 'false'); await page.keyboard.up('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual(['start', 'mute:true', 'mode:pushToTalk', 'mute:false', 'hold', 'release', 'hold', 'release']);
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe('Private draft'); expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
	});
}


for (const locale of ['en', 'zh-CN']) {
	test(`persistent user and tool media load in the original Thread and release playback in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showMedia(false));
		const imageRow = page.locator('[data-item-id="image"]');
		const loadImage = imageRow.getByRole('button', { name: locale === 'en' ? 'Load image' : '加载图片' });
		await loadImage.focus();
		await loadImage.press('Enter');
		await expect(imageRow.locator('img')).toBeVisible();
		await expect.poll(() => imageRow.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(2);
		const imageUrl = await imageRow.locator('img').getAttribute('src');
		await expect(imageRow.locator('figure')).toBeFocused();
		const audioRow = page.locator('[data-item-id="audio"]');
		await audioRow.getByRole('button', { name: locale === 'en' ? 'Load audio' : '加载音频' }).click();
		await expect(audioRow.locator('audio')).toBeVisible();
		const audio = await audioRow.locator('audio').elementHandle();
		await audioRow.locator('audio').evaluate(async player => { await (player as HTMLAudioElement).play(); });
		await expect.poll(() => audioRow.locator('audio').evaluate(player => (player as HTMLAudioElement).paused)).toBe(false);
		await page.evaluate(() => window.ashChatTranscriptIntegration.refreshMedia());
		expect(await audioRow.locator('audio').evaluate((player, previous) => player === previous, audio)).toBe(true);
		await expect(imageRow.locator('img')).toHaveAttribute('src', imageUrl!);
		await expect.poll(() => audioRow.locator('audio').evaluate(player => (player as HTMLAudioElement).paused)).toBe(false);
		const tool = page.locator('.ash-chat-tool-invocation');
		await tool.locator(':scope > summary').click();
		await tool.getByRole('button', { name: locale === 'en' ? 'Load image' : '加载图片' }).click();
		await expect(tool.locator('img')).toBeVisible();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests)).toEqual([
			{ sessionId: 'media-session', threadId: 'media-thread', itemId: 'image' },
			{ sessionId: 'media-session', threadId: 'media-thread', itemId: 'audio' },
			{ sessionId: 'media-session', threadId: 'media-thread', itemId: 'result', contentIndex: 1 },
		]);
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		expect(await audio!.evaluate(player => ({ paused: (player as HTMLAudioElement).paused, source: player.getAttribute('src') }))).toEqual({ paused: true, source: null });
		expect(await page.evaluate(async url => { try { await fetch(url!); return false; } catch { return true; } }, imageUrl)).toBe(true);
		await audio?.dispose();
		expect(errors).toEqual([]);
	});
}

test('removing an attachment cancels its read and rejects a late media result', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showMedia(true));
	await page.locator('[data-item-id="image"]').getByRole('button', { name: 'Load image' }).click();
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
	await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().aborted)).toBe(true);
	await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
	await expect(page.locator('.ash-chat-media')).toHaveCount(0);
});

test('streaming Markdown controlled rendering comparison', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/chatTranscript.html');
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	const samples: unknown[] = [];
	try {
		for (const kind of ['prose', 'mixed', 'fence'] as const) {
			await page.evaluate(kind => window.ashChatTranscriptIntegration.runMarkdownBenchmark(kind), kind);
			for (let repetition = 0; repetition < 7; repetition++) {
				await cdp.send('HeapProfiler.collectGarbage');
				const before = await cdp.send('Performance.getMetrics');
				const result = await page.evaluate(kind => window.ashChatTranscriptIntegration.runMarkdownBenchmark(kind), kind);
				const after = await cdp.send('Performance.getMetrics');
				expect(result.finalVisible).toBe(true);
				expect(result.codeBlocks).toBe(kind === 'prose' ? 0 : kind === 'mixed' ? 12 : 1);
				const taskMs = (after.metrics.find(metric => metric.name === 'TaskDuration')!.value - before.metrics.find(metric => metric.name === 'TaskDuration')!.value) * 1000;
				samples.push({ kind, repetition, ...result, taskMs });
			}
		}
		await testInfo.attach('markdown-stream-comparison.json', {
			body: JSON.stringify({
				browser: page.context().browser()?.version(), label: process.env.ASH_MARKDOWN_BENCHMARK_LABEL ?? 'current',
				scope: 'Production ChatListWidget, 128 updates, eight updates per animation frame, final content through two animation frames; one warmup and seven samples per workload. GC outside intervals. Browser component only; no backend, IPC or Desktop.', samples,
			}, null, 2), contentType: 'application/json'
		});
		expect(errors).toEqual([]);
	} finally { await cdp.detach(); }
});

for (const kind of ['hugeParagraph', 'mathCandidates', 'largeList', 'largeTable'] as const) {
	test(`streaming Markdown large tail delivery costs: ${kind}`, async ({ page }, testInfo) => {
		test.setTimeout(180_000);
		await page.goto('/chatTranscript.html');
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Performance.enable');
		const samples: unknown[] = [];
		try {
			const profile = process.env.ASH_MARKDOWN_CPU_PROFILE === kind;
			if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
			await page.evaluate(kind => window.ashChatTranscriptIntegration.runMarkdownBenchmark(kind), kind);
			if (profile) {
				const { profile } = await cdp.send('Profiler.stop');
				await testInfo.attach('markdown-tail.cpuprofile', { body: JSON.stringify(profile), contentType: 'application/json' });
			}
			for (let repetition = 0; repetition < 7; repetition++) {
				await cdp.send('HeapProfiler.collectGarbage');
				const before = await cdp.send('Performance.getMetrics');
				const result = await page.evaluate(kind => window.ashChatTranscriptIntegration.runMarkdownBenchmark(kind), kind);
				const after = await cdp.send('Performance.getMetrics');
				expect(result.finalVisible).toBe(true);
				expect(result.codeBlocks).toBe(0);
				expect(result.updateSamplesMs).toHaveLength(128);
				const taskMs = (after.metrics.find(metric => metric.name === 'TaskDuration')!.value - before.metrics.find(metric => metric.name === 'TaskDuration')!.value) * 1000;
				samples.push({ kind, repetition, ...result, taskMs });
			}
			// Check the complete body outside the measured interval, including all
			// list/table rows and literal incomplete formulas, not only the end marker.
			const state = await page.evaluate(kind => {
				const fixture = window.ashChatTranscriptIntegration;
				return fixture.compareStreamingMarkdown(fixture.markdownWorkload(kind), true);
			}, kind);
			expect(state.actual, kind).toBe(state.expected);
			await testInfo.attach('markdown-tail-costs.json', {
				body: JSON.stringify({ browser: page.context().browser()?.version(), label: process.env.ASH_MARKDOWN_BENCHMARK_LABEL ?? 'current', scope: 'Production ChatListWidget; 128 cumulative updates, eight per animation frame, through final content and two frames. One warmup and seven samples. GC outside intervals. Formula recognition and fallback only; no Rust provider, backend, IPC or Desktop. Nested phase times must not be summed.', samples }, null, 2), contentType: 'application/json'
			});
			expect(errors).toEqual([]);
		} finally { await cdp.detach(); }
	});
}

test('streaming Markdown remaining consumer costs', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/chatTranscript.html');
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	const samples: unknown[] = [];
	try {
		for (const kind of ['fence', 'largeFence', 'largeParagraph'] as const) {
			await page.evaluate(kind => window.ashChatTranscriptIntegration.runMarkdownBenchmark(kind), kind);
			for (let repetition = 0; repetition < 7; repetition++) {
				await cdp.send('HeapProfiler.collectGarbage');
				const before = await cdp.send('Performance.getMetrics');
				const result = await page.evaluate(kind => window.ashChatTranscriptIntegration.runMarkdownBenchmark(kind), kind);
				const after = await cdp.send('Performance.getMetrics');
				expect(result.finalVisible).toBe(true);
				expect(result.codeTextMatches).toBe(true);
				expect(result.codeBlocks).toBe(kind === 'largeParagraph' ? 0 : 1);
				const taskMs = (after.metrics.find(metric => metric.name === 'TaskDuration')!.value - before.metrics.find(metric => metric.name === 'TaskDuration')!.value) * 1000;
				samples.push({ kind, repetition, ...result, taskMs });
			}
		}
		await testInfo.attach('markdown-consumer-costs.json', {
			body: JSON.stringify({ browser: page.context().browser()?.version(), label: process.env.ASH_MARKDOWN_BENCHMARK_LABEL ?? 'current', scope: 'Production ChatListWidget and Stanza; 128 updates, eight per animation frame, final content through two animation frames. One warmup and seven samples. GC outside intervals. Nested phase times must not be summed. Browser component only.', samples }, null, 2), contentType: 'application/json'
		});
		expect(errors).toEqual([]);
	} finally { await cdp.detach(); }
});

test('streamed workspace images reuse one authorized read and preserve a scrolled reading position after decoding', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/chatTranscript.html');
	const text = Array.from({ length: 35 }, (_, index) => `Paragraph ${index}.`).join('\n\n') + '\n\n![Workspace image](file:///workspace/image.png)';
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), text);
	const image = page.locator('[data-item-id="stream"] img');
	await expect.poll(() => image.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(2);
	const viewport = page.locator('.ash-chat-list-widget .ash-scrollbar-viewport');
	await viewport.evaluate(element => { element.scrollTop = 30; });
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(30);
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value + '\n\nMore text.', false), text);
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value + '\n\nMore text.\n\nDone.', true), text);
	await expect.poll(() => image.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(2);
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.imageReadCount())).toBe(1);
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(30);
	const url = await image.getAttribute('src');
	await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
	expect(await page.evaluate(async url => { try { await fetch(url!); return false; } catch { return true; } }, url)).toBe(true);
	expect(errors).toEqual([]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`linked resource opens through agentHost and releases the verified handle in ${locale}`, async ({ page }) => {
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showLink('read'));
		const row = page.locator('.ash-chat-resources details');
		await row.locator('summary').focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests())).toEqual([]);
		const open = row.getByRole('button', { name: locale === 'en' ? 'Open resource' : '打开资源' });
		await page.keyboard.press('Tab');
		await expect(open).toBeFocused();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('# Linked\r\n中文\r\n');
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().resource)).toMatch(/^chat-response-resource:/u);
		const requests = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests());
		expect(requests.map(request => request.method)).toEqual(['tool/resource/open', 'resource/read', 'resource/release']);
		expect(requests[0].params).toEqual({ sessionId: 'link-session', threadId: 'link-thread', itemId: 'linked-result', contentIndex: 0, operationId: expect.any(String) });
		await open.click();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().length)).toBe(3);
	});
}

test('removing a linked resource cancels its original operation and releases a late handle without opening an editor', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showLink('delay'));
	await page.locator('.ash-chat-resources summary').click();
	await page.getByRole('button', { name: 'Open resource', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().length)).toBe(1);
	await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().map(request => request.method))).toEqual(['tool/resource/open', 'tool/resource/cancel']);
	await page.evaluate(() => window.ashChatTranscriptIntegration.finishLink());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().map(request => request.method))).toEqual(['tool/resource/open', 'tool/resource/cancel', 'resource/release']);
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().resource)).not.toMatch(/^chat-response-resource:/u);
	await expect(page.locator('.ash-chat-resources')).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN']) {
	test(`declared MCP App negotiates in the existing isolated Webview and retains local interaction in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		const external: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('request', request => { if (request.url().startsWith('https://example.invalid')) external.push(request.url()); });
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
		await page.locator('.ash-chat-tool-invocation > summary').click();
		const part = page.locator('.ash-chat-mcp-app');
		const open = part.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' });
		await open.focus();
		await page.keyboard.press('Enter');
		const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
		await expect(frame.locator('#input')).toHaveText('{"arguments":{"value":7}}');
		await expect(frame.locator('#result')).toContainText('Report ready');
		await expect(frame.locator('#result')).toContainText('"annotations":{"audience":["user"],"priority":0.8},"_meta":{"private":"text-view-only"}');
		await expect(frame.locator('#result')).toContainText('"structuredContent":{"value":7}');
		await expect(frame.locator('#result')).toContainText('"_meta":{"viewOnly":"metadata"}');
		await expect(frame.locator('#result')).toContainText('"uri":"docs://embedded","mimeType":"text/plain","text":"Embedded content","_meta":{"private":"resource-view-only"}');
		await expect(frame.locator('#context')).toContainText('"locale":"' + locale + '"');
		await expect(page.locator('.ash-chat-mcp-app-viewport')).toHaveCSS('height', '240px');
		await frame.getByRole('button', { name: 'Increment', exact: true }).click();
		await expect(frame.locator('#count')).toHaveText('1');
		await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
		await expect(frame.locator('#count')).toHaveText('1');
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests())).toEqual([]);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setTheme('light'));
		await expect(frame.locator('#context')).toContainText('"theme":"light"');
		await frame.getByRole('button', { name: 'List tools', exact: true }).click();
		await expect(frame.locator('#catalog')).toContainText('"name":"edit","inputSchema":{"type":"object"');
		await expect(frame.locator('#catalog')).toContainText('"_meta":{"ui":{"visibility":["app"]}}');
		const catalogs = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/list'));
		expect(catalogs[0]?.params).toEqual({ sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 2 });
		await frame.getByRole('button', { name: 'Call tool', exact: true }).click();
		await expect(frame.locator('#called')).toContainText('"structuredContent":{"value":8}');
		await expect(frame.locator('#called')).toContainText('"_meta":{"viewOnly":8}');
		await frame.getByRole('button', { name: 'Read resource', exact: true }).click();
		await expect(frame.locator('#resource')).toHaveText('{"contents":[{"uri":"file:///server/report.json","mimeType":"application/vnd.example+json","_meta":{"private":"view-only"},"text":"{\\\"value\\\":8}\\r\\n"}]}');
		await frame.getByRole('button', { name: 'Read binary', exact: true }).click();
		await expect(frame.locator('#binary')).toHaveText('{"contents":[{"uri":"mcp://server/blob","mimeType":"text/plain","_meta":{"private":"view-only"},"blob":"AH//"}]}');
		const resourceCalls = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/resource/open'));
		expect(resourceCalls).toHaveLength(2);
		expect(resourceCalls[0]?.params).toMatchObject({ sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 2, uri: 'file:///server/report.json' });
		expect(await frame.locator('#capabilities').evaluate(element => JSON.parse(element.textContent!))).toMatchObject({ serverTools: {}, serverResources: {}, sandbox: { permissions: {}, csp: { connectDomains: [], resourceDomains: [] } } });
		const calls = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/call'));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.params).toMatchObject({ sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 2, remoteName: 'edit', argumentsJson: '{"value":8}' });
		await frame.getByRole('button', { name: 'Unsupported', exact: true }).click();
		await expect(frame.locator('#error')).toContainText('-32601');
		const sandbox = await frame.locator('body').evaluate(async () => {
			let isolated = false;
			try { void top!.document.body; } catch { isolated = true; }
			let denied = false;
			try { await fetch('https://example.invalid/pwn'); } catch { denied = true; }
			return { isolated, denied };
		});
		expect(sandbox).toEqual({ isolated: true, denied: true });
		expect(external).toEqual([]);
		await part.getByRole('button', { name: locale === 'en' ? 'Close interactive view' : '关闭交互式视图' }).click();
		await expect(open).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appState().views)).toBe(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.appState().messages)).toContainEqual({ jsonrpc: '2.0', id: 'ash-teardown', result: {} });
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		await expect(part).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test('the original agentHost connection event closes an active MCP App', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
	await page.locator('.ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#result')).toContainText('Report ready');
	await page.evaluate(() => window.ashChatTranscriptIntegration.closeConnection());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appState().views)).toBe(0);
	await expect(page.getByRole('button', { name: 'Open interactive view' })).toBeVisible();
});

for (const operation of ['tool', 'resource']) for (const action of ['cancel', 'close', 'disconnect']) {
	test(`MCP App ${operation} ${action} cancels its original agentHost operation and rejects late results`, async ({ page }) => {
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('delay'));
		await page.locator('.ash-chat-tool-invocation > summary').click();
		await page.getByRole('button', { name: 'Open interactive view' }).click();
		const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
		await expect(frame.locator('#input')).toContainText('"value":7');
		await frame.getByRole('button', { name: operation === 'tool' ? 'Call tool' : 'Read resource', exact: true }).click();
		await expect.poll(() => page.evaluate(method => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === method).length, operation === 'tool' ? 'tool/app/call' : 'tool/app/resource/open')).toBe(1);
		if (action === 'cancel') await frame.getByRole('button', { name: 'Cancel call', exact: true }).click();
		else if (action === 'close') await page.getByRole('button', { name: 'Close interactive view' }).click();
		else await page.evaluate(() => window.ashChatTranscriptIntegration.closeConnection());
		await expect.poll(() => page.evaluate(method => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === method).length, operation === 'tool' ? 'tool/app/cancel' : 'tool/resource/cancel')).toBe(1);
		await page.evaluate(() => window.ashChatTranscriptIntegration.finishLink());
		if (action === 'cancel') {
			await expect(frame.locator(operation === 'tool' ? '#called' : '#resource')).toHaveText('');
			await expect(frame.locator('#error')).toHaveText('');
		} else {
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appState().views)).toBe(0);
			await expect(page.getByRole('button', { name: 'Open interactive view' })).toBeVisible();
		}
	});
}

test('MCP App tool failures return a standard error without pretending to have a result', async ({ page }) => {
	await page.goto('/chatTranscript.html?locale=zh-CN');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('error'));
	await page.locator('.ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: '打开交互式视图' }).click();
	const frame = page.frameLocator('iframe[title="交互式 MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#input')).toContainText('"value":7');
	await frame.getByRole('button', { name: 'Call tool', exact: true }).click();
	await expect(frame.locator('#error')).toContainText('-32000');
	await expect(frame.locator('#error')).toContainText('App 请求失败');
	await expect(frame.locator('#called')).toHaveText('');
});

test('MCP App source CSP allows declared API and static origins while denying all undeclared access', async ({ page }) => {
	const requests: string[] = [];
	await page.route('https://**.example.invalid/**', async route => {
		requests.push(route.request().url());
		await route.fulfill({ contentType: route.request().url().includes('cdn.') ? 'text/javascript' : 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: route.request().url().includes('cdn.') ? 'window.declaredScriptLoaded = true;' : 'declared API response' });
	});
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('read', true));
	await page.locator('.ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#input')).toContainText('"value":7');
	expect(await frame.locator('#capabilities').evaluate(element => JSON.parse(element.textContent!))).toMatchObject({ sandbox: { permissions: {}, csp: { connectDomains: ['https://api.example.invalid'], resourceDomains: ['https://cdn.example.invalid'] } } });
	const network = await frame.locator('body').evaluate(async () => {
		const allowed = await (await fetch('https://api.example.invalid/data')).text();
		let denied = false;
		try { await fetch('https://undeclared.example.invalid/secret'); } catch { denied = true; }
		await new Promise<void>((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://cdn.example.invalid/app.js'; script.onload = () => resolve(); script.onerror = () => reject(new Error('declared script blocked')); document.body.append(script); });
		return { allowed, denied, script: (window as unknown as { declaredScriptLoaded: boolean; }).declaredScriptLoaded };
	});
	expect(network).toEqual({ allowed: 'declared API response', denied: true, script: true });
	expect(requests.sort()).toEqual(['https://api.example.invalid/data', 'https://cdn.example.invalid/app.js']);
	expect(await page.locator('iframe[title="Interactive MCP App"]').getAttribute('allow')).toContain("microphone 'none'");
});

test('MCP App delivers original stored image and audio bytes and does not reread unchanged results', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('read', false, true));
	await page.locator('.ash-chat-tool-invocation > summary').click();
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests)).toEqual([]);
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#result')).toContainText('"type":"image","mimeType":"image/png","data":"iVBOR');
	await expect(frame.locator('#result')).toContainText('"type":"audio","mimeType":"audio/wav","data":"UklG');
	await expect(frame.locator('#result')).toContainText('"_meta":{"private":"image-view-only"}');
	await expect(frame.locator('#result')).toContainText('"annotations":{"priority":0.4}');
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests)).toEqual([
		{ sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 4 },
		{ sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 5 },
	]);
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('read', false, true));
	await expect(frame.locator('#result')).toContainText('"type":"audio"');
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests)).toEqual([]);
});

test('MCP App close aborts original result media reads and ignores their late completion', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('delay', false, true));
	await page.locator('.ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#input')).toContainText('"value":7');
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
	await page.getByRole('button', { name: 'Close interactive view' }).click();
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().aborted)).toBe(true);
	await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appState().views)).toBe(0);
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
});

for (const locale of ['en', 'zh-CN']) {
	for (const cowork of [false, true]) {
		test(`${cowork ? 'Cowork' : 'Chat'} MCP App context and messages use the original Chat owner and preserve its draft in ${locale}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(false, cowork), cowork);
			const chat = page.locator('#app-chat');
			await chat.locator('.ash-chat-tool-invocation > summary').click();
			await chat.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
			const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
			await expect(frame.locator('#input')).toContainText('"value":7');
			if (cowork) { await chat.locator('.stanza-editor-input').focus(); await page.keyboard.insertText('Unsent user draft'); } else await chat.locator('.ash-chat-input-part textarea').fill('Unsent user draft');
			await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
			const userDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
			await frame.getByRole('button', { name: 'Update context', exact: true }).click();
			await expect(frame.locator('#context-ack')).toHaveText('{}');
			await frame.getByRole('textbox', { name: 'App context text' }).fill('Latest context');
			await frame.getByRole('button', { name: 'Update context', exact: true }).click();
			await frame.getByRole('button', { name: 'Send Chat message', exact: true }).click();
			await expect(frame.locator('#message-ack')).toHaveText('{}');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([{ text: 'Follow-up from App', mode: 'plan', commandId: undefined, source: { sessionId: 'app-session', threadId: 'app-thread' }, contexts: [{ name: locale === 'en' ? 'App context' : 'App 上下文', content: 'Latest context\n\n{"value":8}' }] }]);
			// Captured drafts exclude live App references; their separating spaces
			// do not change the user's text or the retained private file reference.
			await expect.poll(async () => (await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft()))?.trimEnd()).toBe(userDraft?.trimEnd());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual(['private.txt']);
			await frame.getByRole('button', { name: 'Invalid role', exact: true }).click();
			await expect(frame.locator('#error')).toContainText('-32602');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(1);
			await chat.getByRole('button', { name: locale === 'en' ? 'Close interactive view' : '关闭交互式视图' }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual(['private.txt']);
			await expect.poll(async () => (await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft()))?.trimEnd()).toBe(userDraft?.trimEnd());
			expect(errors).toEqual([]);
		});
	}

}

test('MCP App cannot submit messages after its original Chat identity has been replaced', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showChatApp());
	await page.locator('#app-chat .ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#input')).toContainText('"value":7');
	await page.evaluate(() => window.ashChatTranscriptIntegration.retireChat());
	await frame.getByRole('button', { name: 'Send Chat message', exact: true }).click();
	await expect(frame.locator('#error')).toContainText('conversation is no longer available');
	await frame.getByRole('button', { name: 'Update context', exact: true }).click();
	await expect(frame.locator('#error')).toContainText('conversation is no longer available');
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`MCP App external links use the original opener and deny local commands in ${locale}`, async ({ page }) => {
		await page.goto('/chatTranscript.html?locale=' + locale);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
		await page.locator('.ash-chat-tool-invocation > summary').click();
		await page.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
		const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
		await frame.getByRole('button', { name: 'Open external link' }).click();
		await expect(frame.locator('#link-result')).toHaveText('{"isError":false}');
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openedAppLinks())).toEqual([{ uri: 'https://example.com/report?view=8#result', options: { openExternal: true, allowCommands: false, allowContributedOpeners: false } }]);
		for (const url of ['command:workbench.action.reloadWindow', 'file:///secret', 'javascript:alert(1)', 'https://user:password@example.com/', '//example.com/relative', 'https://example.com/\u007funsafe']) {
			await frame.getByRole('textbox', { name: 'App link URL' }).fill(url);
			await frame.locator('#link-result').evaluate(node => node.textContent = '');
			await frame.getByRole('button', { name: 'Open external link' }).click();
			await expect(frame.locator('#link-result')).toHaveText('{"isError":true}');
		}
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openedAppLinks())).toHaveLength(1);
	});
}

test('MCP App display mode follows the actual document fullscreen owner and close releases it', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
	await page.locator('.ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#context')).toContainText('"availableDisplayModes":["inline","fullscreen"]');
	await frame.getByRole('button', { name: 'Fullscreen', exact: true }).click();
	await expect(frame.locator('#mode-result')).toHaveText('{"mode":"fullscreen"}');
	await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('ash-chat-mcp-app');
	await expect(frame.locator('#context')).toContainText('"displayMode":"fullscreen"');
	await frame.getByRole('button', { name: 'Inline', exact: true }).click();
	await expect(frame.locator('#mode-result')).toHaveText('{"mode":"inline"}');
	await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
	await frame.getByRole('button', { name: 'Picture in picture', exact: true }).click();
	await expect(frame.locator('#mode-result')).toHaveText('{"mode":"inline"}');
	await frame.getByRole('button', { name: 'Fullscreen', exact: true }).click();
	await expect(frame.locator('#mode-result')).toHaveText('{"mode":"fullscreen"}');
	await page.getByRole('button', { name: 'Close interactive view' }).click();
	await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test('MCP App frame and base URI CSP declarations take effect in the actual sandbox', async ({ page }) => {
	const requests: string[] = [];
	await page.route('https://**.example.invalid/**', async route => { requests.push(route.request().url()); await route.fulfill({ contentType: 'text/html', body: '<p>Declared frame</p>' }); });
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showApp('read', true));
	await page.locator('.ash-chat-tool-invocation > summary').click();
	await page.getByRole('button', { name: 'Open interactive view' }).click();
	const frame = page.frameLocator('iframe[title="Interactive MCP App"]').frameLocator('iframe');
	await expect(frame.locator('#input')).toContainText('"value":7');
	const state = await frame.locator('body').evaluate(async body => {
		const blocked: string[] = [];
		document.addEventListener('securitypolicyviolation', event => blocked.push(event.violatedDirective));
		const base = document.createElement('base'); base.href = 'https://base.example.invalid/files/'; document.head.append(base);
		const permittedBase = document.baseURI;
		base.href = 'https://undeclared.example.invalid/files/';
		const deniedBase = document.baseURI;
		const permitted = document.createElement('iframe'); permitted.title = 'Declared nested frame'; permitted.src = 'https://frame.example.invalid/content'; body.append(permitted);
		const denied = document.createElement('iframe'); denied.src = 'https://undeclared.example.invalid/content'; body.append(denied);
		await new Promise(resolve => setTimeout(resolve, 150));
		return { permittedBase, deniedBase, blocked };
	});
	expect(state.permittedBase).toBe('https://base.example.invalid/files/');
	expect(state.deniedBase).not.toContain('undeclared.example.invalid');
	expect(state.blocked).toContain('base-uri');
	expect(state.blocked).toContain('frame-src');
	await expect(frame.frameLocator('iframe[title="Declared nested frame"]').locator('p')).toHaveText('Declared frame');
	expect(requests).toContain('https://frame.example.invalid/content');
	expect(requests.some(request => request.includes('undeclared.'))).toBe(false);
});

for (const locale of ['en', 'zh-CN']) {
	test(`MCP App downloads preserve exact inline and linked bytes after confirmation in ${locale}`, async ({ page }) => {
		await page.goto(`/chatTranscript.html?locale=${locale}`); await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
		const tool = page.locator('.ash-chat-tool-invocation'); await tool.locator(':scope > summary').click();
		await tool.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
		const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
		await expect(frame.locator('#capabilities')).toContainText('"downloadFile":{}');
		const requestsBefore = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().length);
		const inlineDownload = page.waitForEvent('download'); await frame.getByRole('button', { name: 'Download inline', exact: true }).click();
		const dialog = page.getByRole('dialog'); await expect(dialog.getByText('export.txt', { exact: true })).toBeVisible();
		const confirm = dialog.getByRole('button', { name: locale === 'en' ? 'Download' : '下载', exact: true }); await confirm.press('Enter');
		const inline = await inlineDownload; expect(inline.suggestedFilename()).toBe('export.txt');
		const stream = await inline.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk as Buffer);
		expect(Buffer.concat(chunks).toString('utf8')).toBe('中文\r\n<safe>\r\n');
		await expect(frame.locator('#download-result')).toHaveText('{}');
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().length)).toBe(requestsBefore);
		const linkedDownload = page.waitForEvent('download'); await frame.getByRole('button', { name: 'Download linked', exact: true }).click();
		await expect(dialog.getByText('_report.bin', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: locale === 'en' ? 'Download' : '下载', exact: true }).click();
		const linked = await linkedDownload; expect(linked.suggestedFilename()).toBe('_report.bin');
		const binaryStream = await linked.createReadStream(); const binary: Buffer[] = []; for await (const chunk of binaryStream!) binary.push(chunk as Buffer);
		expect([...Buffer.concat(binary)]).toEqual([0, 127, 255]);
		const reads = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/resource/open'));
		expect(reads.at(-1)?.params).toEqual({ sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 2, uri: 'mcp://report/blob.bin', operationId: expect.any(String) });
	});

	test(`MCP App download cancellation and invalid data produce no download in ${locale}`, async ({ page }) => {
		const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
		await page.goto(`/chatTranscript.html?locale=${locale}`); await page.evaluate(() => window.ashChatTranscriptIntegration.showApp());
		const tool = page.locator('.ash-chat-tool-invocation'); await tool.locator(':scope > summary').click(); await tool.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
		const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
		await frame.getByRole('button', { name: 'Download inline', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
		await expect(frame.locator('#download-result')).toHaveText('{"isError":true}');
		await frame.getByRole('button', { name: 'Invalid download', exact: true }).click(); await expect(frame.locator('#error')).toContainText('-32602'); await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.delayAppResources());
		await frame.getByRole('button', { name: 'Download linked', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Download' : '下载', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/resource/open').length)).toBe(1);
		await frame.getByRole('button', { name: 'Cancel download', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/resource/cancel').length)).toBe(1);
		await page.evaluate(() => window.ashChatTranscriptIntegration.finishLink());
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'resource/release').length)).toBe(2);
		expect(downloads).toEqual([]);
		await frame.getByRole('button', { name: 'Download inline', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
		await page.evaluate(() => window.ashChatTranscriptIntegration.closeConnection()); await expect(page.getByRole('dialog')).toHaveCount(0); expect(downloads).toEqual([]);
	});
	for (const cowork of [false, true]) {
		test(`${cowork ? 'Cowork' : 'Chat'} Voice conversation uses the original Chat source and preserves drafts in ${locale}`, async ({ page }) => {
			const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(true, cowork), cowork);
			const chat = page.locator('#app-chat');
			const start = chat.getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true });
			await expect(start).toBeEnabled(); await start.focus(); await start.press('Enter');
			const options = page.getByRole('combobox', { name: locale === 'en' ? 'Voice conversation options' : '语音对话选项', exact: true });
			await expect(options).toBeFocused(); await options.fill('marin'); await options.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceSelection())).toEqual({ connectionId: 'fixture', modelId: 'speech', voice: 'marin' });
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual(['start']);
			await expect(chat.getByRole('button', { name: locale === 'en' ? 'Stop voice conversation' : '停止语音对话', exact: true })).toBeFocused();
			const draft = chat.locator(cowork ? '.stanza-editor-input' : '.ash-chat-input-part textarea');
			if (cowork) { await draft.focus(); await page.keyboard.insertText('Unsent user draft'); } else await draft.fill('Unsent user draft');
			await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
			const userDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
			await page.evaluate(() => window.ashChatTranscriptIntegration.proposeVoiceTask());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([{
				text: locale === 'en' ? 'Handle the request I just spoke.' : '处理我刚才说出的请求。', mode: 'plan', contexts: [{ name: locale === 'en' ? 'Voice request' : '语音请求', content: 'run tests <script>unsafe()</script>' }], commandId: 'voice-command', source: { sessionId: 'app-session', threadId: 'app-thread' },
			}]);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe(userDraft);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual(['private.txt']);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContexts())).toEqual([expect.objectContaining({ name: 'private.txt', content: 'private file body' })]);
			await expect(chat.getByText('run tests <script>unsafe()</script>', { exact: true })).toBeVisible();
			await expect(chat.locator('script')).toHaveCount(0);
			await chat.getByRole('button', { name: locale === 'en' ? 'Interrupt voice reply' : '打断语音回复', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual(['start', 'interrupt']);
			await page.evaluate(() => window.ashChatTranscriptIntegration.retireChat());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual(['start', 'interrupt', 'stop']);
			if (cowork) await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBeUndefined(); else await expect(draft).toHaveValue(userDraft!); expect(errors).toEqual([]);
		});
	}

}

for (const locale of ['en', 'zh-CN']) {
	test(`MCP App logs use the existing diagnostic sink without changing Chat in ${locale}`, async ({ page }) => {
		// Keep the diagnostic rate-limit window fixed while the test crosses frame and protocol boundaries.
		await page.clock.setFixedTime(new Date('2026-10-17T00:00:00Z'));
		await page.goto(`/chatTranscript.html?locale=${locale}`); await page.evaluate(() => window.ashChatTranscriptIntegration.showChatApp());
		const chat = page.locator('#app-chat'); await chat.locator('.ash-chat-tool-invocation > summary').click(); await chat.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
		const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
		await expect(frame.locator('#capabilities')).toContainText('"logging":{}'); await frame.getByRole('button', { name: 'Send logs', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appLogs().filter(entry => entry.category === 'chat.mcpApp').length)).toBe(8);
		const logs = await page.evaluate(() => window.ashChatTranscriptIntegration.appLogs().filter(entry => entry.category === 'chat.mcpApp'));
		expect(logs.map(entry => entry.level)).toEqual(['debug', 'information', 'information', 'warning', 'error', 'error', 'error', 'error']);
		for (const entry of logs) { expect(entry.message).not.toContain('\n'); expect(JSON.parse(entry.message)).toEqual({ source: { sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 2 }, logger: 'report', data: { value: 8, text: '<script>unsafe()</script>\nnext line' } }); }
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
		await frame.getByRole('button', { name: 'Invalid log', exact: true }).click(); await frame.getByRole('button', { name: 'Large log', exact: true }).click();
		await frame.getByRole('button', { name: 'Flood logs', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appLogs().filter(entry => entry.category === 'chat.mcpApp').length)).toBe(10);
		await chat.getByRole('button', { name: locale === 'en' ? 'Close interactive view' : '关闭交互式视图', exact: true }).click();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Voice choice cancellation and Chat replacement create no media in ${locale}`, async ({ page }) => {
		const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`); await page.evaluate(() => window.ashChatTranscriptIntegration.showChatApp(true));
		const button = page.locator('#app-chat').getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true });
		const picker = page.getByRole('combobox', { name: locale === 'en' ? 'Voice conversation options' : '语音对话选项', exact: true });
		await button.click(); await expect(picker).toBeFocused(); await picker.press('Escape'); await expect(picker).toBeHidden();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual([]); await expect(button).toBeEnabled();
		await button.click(); await expect(picker).toBeFocused(); await page.evaluate(() => window.ashChatTranscriptIntegration.retireChat()); await expect(picker).toBeHidden();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual([]); expect(errors).toEqual([]);
	});
}

for (const locale of ['en', 'zh-CN']) {
	for (const cowork of [false, true]) {
		test(`${cowork ? 'Cowork' : 'Chat'} MCP App image context uses the original image input and retires stale decoding in ${locale}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}&richInput=1`);
			await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(false, cowork), cowork);
			const chat = page.locator('#app-chat');
			await chat.locator('.ash-chat-tool-invocation > summary').click();
			await chat.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
			const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
			await expect(frame.locator('#capabilities')).toContainText('"updateModelContext":{"text":{},"image":{},"resource":{},"resourceLink":{},"structuredContent":{}}');
			await chat.locator('.stanza-editor-input').focus();
			await page.keyboard.insertText('Private draft');
			await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
			const userDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
			await frame.getByRole('button', { name: 'Image context', exact: true }).click();
			await expect(frame.locator('#image-ack')).toHaveText('{}');
			const removeImage = chat.getByRole('button', { name: locale === 'en' ? 'Remove App image 1' : '移除 App 图片 1', exact: true });
			await expect(removeImage).toBeVisible();
			if (cowork) {
				await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft())).toMatchObject({ contexts: [{ id: 'private-file', kind: 'file', name: 'private.txt', content: 'private file body' }] });
				await expect.poll(async () => (await page.evaluate(() => window.ashChatTranscriptIntegration.persistedChatDraft()))?.text.trimEnd()).toBe(userDraft?.trimEnd());
			}

			await expect(chat.locator('img[alt="' + (locale === 'en' ? 'App image 1' : 'App 图片 1') + '"]')).toBeVisible();
			await frame.getByRole('button', { name: 'Send Chat message', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([{
				text: 'Follow-up from App', mode: 'plan', commandId: undefined, source: { sessionId: 'app-session', threadId: 'app-thread' }, contexts: [
					{ name: locale === 'en' ? 'App context' : 'App 上下文', content: 'Image context' },
					{ name: locale === 'en' ? 'App image 1' : 'App 图片 1', kind: 'image', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=' },
				],
			}]);
			await removeImage.click();
			await frame.getByRole('button', { name: 'Invalid image context', exact: true }).click();
			await expect(frame.locator('#error')).toContainText('-32602');
			await frame.getByRole('button', { name: 'Undecodable image context', exact: true }).click();
			await expect(frame.locator('#error')).toContainText('-32000');
			await expect(removeImage).toHaveCount(0);
			await frame.getByRole('button', { name: 'Unsupported audio context', exact: true }).click();
			await expect(frame.locator('#error')).toContainText('-32602');
			await page.evaluate(() => window.ashChatTranscriptIntegration.delayAppImages());
			await frame.getByRole('button', { name: 'Image context', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appImagePending())).toBe(true);
			await frame.getByRole('button', { name: 'Send Chat message', exact: true }).click();
			await frame.getByRole('button', { name: 'Clear context', exact: true }).click();
			await expect(frame.locator('#image-ack')).toHaveText('{}');
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishAppImages());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(2);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().at(-1))).toMatchObject({ contexts: [] });
			await expect(removeImage).toHaveCount(0);
			await expect.poll(async () => (await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft()))?.trimEnd()).toBe(userDraft?.trimEnd());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual(['private.txt']);
			await page.evaluate(() => window.ashChatTranscriptIntegration.delayAppImages());
			await frame.getByRole('button', { name: 'Image context', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appImagePending())).toBe(true);
			await chat.getByRole('button', { name: locale === 'en' ? 'Close interactive view' : '关闭交互式视图' }).click();
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishAppImages());
			await expect(removeImage).toHaveCount(0);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(2);
			expect(errors).toEqual([]);
		});
	}
}


for (const locale of ['en', 'zh-CN']) {
	for (const cowork of [false, true]) {
		test(`${cowork ? 'Cowork' : 'Chat'} MCP App resource context stays with its frozen server and cancels late reads in ${locale}`, async ({ page }) => {
			const errors: string[] = [];
			const fetched: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			page.on('request', request => { if (request.url().startsWith('https://server/') || request.url().startsWith('file:///ignored/')) fetched.push(request.url()); });
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(false, cowork), cowork);
			const chat = page.locator('#app-chat');
			await chat.locator('.ash-chat-tool-invocation > summary').click();
			await chat.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
			const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
			await frame.getByRole('button', { name: 'Resource context', exact: true }).click();
			await expect(frame.locator('#resource-context-ack')).toHaveText('{}');
			const source = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/resource/open'));
			expect(source).toEqual([{ method: 'tool/app/resource/open', params: { sessionId: 'app-session', threadId: 'app-thread', itemId: 'app-result', contentIndex: 2, uri: 'https://server/report/data', operationId: expect.any(String) } }]);
			await frame.getByRole('button', { name: 'Send Chat message', exact: true }).click();
			const heading = (uri: string, text: string) => locale === 'en' ? `Resource ${uri}:\n${text}` : `资源 ${uri}：\n${text}`;
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([{ text: 'Follow-up from App', mode: 'plan', commandId: undefined, source: { sessionId: 'app-session', threadId: 'app-thread' }, contexts: [{ name: locale === 'en' ? 'App context' : 'App 上下文', content: [heading('file:///ignored/source', 'Embedded <safe>'), heading('file:///ignored/binary', 'hello'), heading('https://server/report/data', '{"value":8}\r\n')].join('\n\n') }] }]);
			await frame.getByRole('button', { name: 'Binary resource context', exact: true }).click();
			await expect(frame.locator('#error')).toContainText('-32000');
			await page.evaluate(() => window.ashChatTranscriptIntegration.delayAppResources());
			const releases = await page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'resource/release').length);
			await frame.getByRole('button', { name: 'Resource context', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/resource/open').length)).toBe(3);
			await frame.getByRole('button', { name: 'Cancel resource context', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/resource/cancel').length)).toBe(1);
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishLink());
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'resource/release').length)).toBe(releases + 1);
			await frame.getByRole('button', { name: 'Resource context', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.linkRequests().filter(request => request.method === 'tool/app/resource/open').length)).toBe(4);
			await chat.getByRole('button', { name: locale === 'en' ? 'Close interactive view' : '关闭交互式视图' }).click();
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishLink());
			await expect(chat.getByRole('button', { name: locale === 'en' ? 'Remove App context' : '移除 App 上下文', exact: true })).toHaveCount(0);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(1);
			expect(fetched).toEqual([]);
			expect(errors).toEqual([]);
		});
	}
}


for (const locale of ['en', 'zh-CN']) {
	for (const cowork of [false, true]) {
		test(`${cowork ? 'Cowork' : 'Chat'} MCP App mixed image messages submit once without changing the draft or source context in ${locale}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(false, cowork), cowork);
			const chat = page.locator('#app-chat');
			await chat.locator('.ash-chat-tool-invocation > summary').click();
			await chat.getByRole('button', { name: locale === 'en' ? 'Open interactive view' : '打开交互式视图' }).click();
			const frame = page.frameLocator('iframe[title="' + (locale === 'en' ? 'Interactive MCP App' : '交互式 MCP App') + '"]').frameLocator('iframe');
			await expect(frame.locator('#capabilities')).toContainText('"message":{"text":{},"image":{},"resource":{},"resourceLink":{}}');
			if (cowork) { await chat.locator('.stanza-editor-input').focus(); await page.keyboard.insertText('Private draft'); } else await chat.locator('.ash-chat-input-part textarea').fill('Private draft');
			await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
			const userDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
			await frame.getByRole('button', { name: 'Update context', exact: true }).click();
			await expect(frame.locator('#context-ack')).toHaveText('{}');
			await frame.getByRole('button', { name: 'Send image message', exact: true }).click();
			await expect(frame.locator('#message-ack')).toHaveText('{}');
			const sourceContext = { name: locale === 'en' ? 'App context' : 'App 上下文', content: 'First context\n\n{"value":8}' };
			const image = { name: locale === 'en' ? 'App image 1' : 'App 图片 1', kind: 'image', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=' };
			const source = { sessionId: 'app-session', threadId: 'app-thread' };
			const text = locale === 'en' ? 'Read image\n\nResource file:///message/report:\nMessage report' : 'Read image\n\n资源 file:///message/report：\nMessage report';
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([{ text, mode: 'plan', commandId: undefined, source, contexts: [sourceContext, image] }]);
			await frame.getByRole('button', { name: 'Send image only', exact: true }).click();
			await expect(frame.locator('#message-ack')).toHaveText('{}');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([{ text, mode: 'plan', commandId: undefined, source, contexts: [sourceContext, image] }, { text: '', mode: 'plan', commandId: undefined, source, contexts: [sourceContext, image] }]);
			await expect(chat.getByRole('button', { name: locale === 'en' ? 'Remove App image 1' : '移除 App 图片 1', exact: true })).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContextNames())).toEqual(['private.txt']);
			await expect.poll(async () => (await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft()))?.trimEnd()).toBe(userDraft?.trimEnd());
			await page.evaluate(() => window.ashChatTranscriptIntegration.delayAppImages());
			await frame.getByRole('button', { name: 'Send image message', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appImagePending())).toBe(true);
			await frame.getByRole('button', { name: 'Cancel image message', exact: true }).click();
			await expect.poll(() => page.evaluate(() => JSON.stringify(window.ashChatTranscriptIntegration.appState().messages))).toContain('"requestId":216');
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishAppImages());
			await page.evaluate(() => window.ashChatTranscriptIntegration.delayAppImages());
			await frame.getByRole('button', { name: 'Send image message', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.appImagePending())).toBe(true);
			await page.evaluate(() => window.ashChatTranscriptIntegration.retireChat());
			await page.evaluate(() => window.ashChatTranscriptIntegration.finishAppImages());
			await expect(frame.locator('#error')).toContainText('-32000');
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages().length)).toBe(2);
			expect(errors).toEqual([]);
		});
	}
}


for (const locale of ['en', 'zh-CN']) {
	test(`Persistent Chat image and audio open in the original read-only media editor in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showMedia(false));
		const images = page.locator('.ash-chat-media').filter({ has: page.getByRole('button', { name: locale === 'en' ? 'Load image' : '加载图片', exact: true }) });
		await images.first().getByRole('button', { name: locale === 'en' ? 'Load image' : '加载图片', exact: true }).click();
		const openImage = page.getByRole('button', { name: locale === 'en' ? 'Open image' : '打开图片', exact: true }).first();
		await openImage.focus(); await openImage.press('Enter');
		await expect(page.locator('.ash-image-preview-image')).toBeVisible();
		await expect(page.locator('.ash-image-preview-viewport')).toBeFocused();
		const image = await page.evaluate(() => window.ashChatTranscriptIntegration.mediaPreviewState());
		expect(image).toMatchObject({ readonly: true, resource: expect.stringMatching(/^chat-response-resource:.*\.png$/) });
		expect(image.content).toContain('2 × 1');
		expect(image.content).toContain('image/png');
		await page.evaluate(() => window.ashChatTranscriptIntegration.closeMediaPreview());
		const audio = page.locator('.ash-chat-media').filter({ has: page.locator('audio') }).first();
		await audio.getByRole('button', { name: locale === 'en' ? 'Load audio' : '加载音频', exact: true }).click();
		await audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).play());
		await expect.poll(() => audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
		await audio.getByRole('button', { name: locale === 'en' ? 'Open audio' : '打开音频', exact: true }).click();
		await expect.poll(() => audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
		await expect(page.locator('.ash-media-preview-player')).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaPreviewState())).toMatchObject({ readonly: true, resource: expect.stringMatching(/^chat-response-resource:.*\.wav$/), content: expect.stringContaining('1') });
		const resource = (await page.evaluate(() => window.ashChatTranscriptIntegration.mediaPreviewState())).resource;
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		await expect(page.locator('.ash-chat-media')).toHaveCount(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.closeMediaPreview());
		const retired = await page.evaluate(async uri => { try { await window.ashChatTranscriptIntegration.readResource(uri); return false; } catch { return true; } }, resource);
		expect(retired).toBe(true);
		await expect(page.locator('.ash-media-preview-player')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}


for (const locale of ['en', 'zh-CN']) {
	for (const cowork of [false, true]) {
		test(`${cowork ? 'Cowork' : 'Chat'} retained tab hiding stops only its voice and transcript audio in ${locale}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/chatTranscript.html?locale=${locale}`);
			await page.evaluate(cowork => window.ashChatTranscriptIntegration.showChatApp(true, cowork, true), cowork);
			const chat = page.locator('#app-chat');
			await chat.getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true }).click();
			const options = page.getByRole('combobox', { name: locale === 'en' ? 'Voice conversation options' : '语音对话选项', exact: true });
			await options.fill('marin'); await options.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual(['start']);
			if (cowork) { await chat.locator('.stanza-editor-input').focus(); await page.keyboard.insertText('Retained draft'); } else await chat.locator('.ash-chat-input-part textarea').fill('Retained draft');
			await page.evaluate(() => window.ashChatTranscriptIntegration.addUserContext());
			await chat.locator('.ash-chat-tool-invocation > summary').click();
			const audio = chat.locator('.ash-chat-media').filter({ has: page.locator('audio') }).first();
			await audio.getByRole('button', { name: locale === 'en' ? 'Load audio' : '加载音频', exact: true }).click();
			await expect.poll(() => audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
			await audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).play());
			await expect.poll(() => audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
			const original = await audio.locator(':scope > audio').getAttribute('src');
			await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(false));
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.voiceState())).toEqual(['start', 'stop']);
			await expect.poll(() => audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
			await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(true));
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe('Retained draft private.txt ');
			await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraftContexts())).toEqual([expect.objectContaining({ name: 'private.txt', content: 'private file body' })]);
			await expect(audio.locator(':scope > audio')).toHaveAttribute('src', original!);
			await expect.poll(() => audio.locator(':scope > audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
			expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
			expect(errors).toEqual([]);
		});
	}
}

for (const locale of ['en', 'zh-CN']) for (const cowork of [false, true]) {
	test(`${cowork ? 'Cowork' : 'Chat'} dictation commands target their retained input and cancel on navigation in ${locale}`, async ({ page }) => {
		await page.goto(`/chatTranscript.html?locale=${locale}&richInput`);
		await page.evaluate(cowork => window.ashChatTranscriptIntegration.prepareDictation(cowork), cowork);
		const input = page.locator('#app-chat .ash-chat-input-part .stanza-editor-input');
		await input.focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runDictation(true));
		expect((await page.evaluate(() => window.ashChatTranscriptIntegration.dictationState())).starts).toBe(1);
		const originalFile = (await page.evaluate(() => window.ashChatTranscriptIntegration.dictationState())).file;
		await page.evaluate(() => window.ashChatTranscriptIntegration.dictationEvent('spoken draft'));
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe('spoken draft');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.dictationState())).toMatchObject({ widgets: 1, focused: true, busy: true, file: originalFile });
		await page.evaluate(() => window.ashChatTranscriptIntegration.retireChat());
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.dictationState())).toMatchObject({ cancels: 1, busy: false });
		const replacementDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
		await page.evaluate(() => window.ashChatTranscriptIntegration.dictationEvent('late old speech'));
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe(replacementDraft);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(false));
		await page.evaluate(() => window.ashChatTranscriptIntegration.runDictation());
		expect((await page.evaluate(() => window.ashChatTranscriptIntegration.dictationState())).starts).toBe(1);
	});
}

for (const locale of ['en', 'zh-CN']) for (const cowork of [false, true]) for (const backend of ['local', 'cloud'] as const) {
	test(`${cowork ? 'Cowork' : 'Chat'} built-in ${backend} ASR flushes before final writeback and cancels a stalled stop in ${locale}`, async ({ page }) => {
		await page.goto(`/chatTranscript.html?locale=${locale}&richInput&builtinBackend=${backend}`);
		await page.evaluate(({ cowork, backend }) => window.ashChatTranscriptIntegration.prepareBuiltinDictation(cowork, backend), { cowork, backend });
		const input = page.locator('#app-chat .ash-chat-input-part .stanza-editor-input');
		await input.focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runDictation());
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.builtinDictationEvent('interim only');
			window.ashChatTranscriptIntegration.builtinAudioTail();
		});
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBeUndefined();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runDictation());
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe('built-in final');
		expect((await page.evaluate(() => window.ashChatTranscriptIntegration.builtinDictationState())).operations.slice(0, 3)).toEqual(['start', 'audio:6', 'stop']);
		await page.evaluate(() => window.ashChatTranscriptIntegration.runDictation());
		await page.evaluate(() => window.ashChatTranscriptIntegration.holdBuiltinStop());
		const stopping = page.evaluate(() => window.ashChatTranscriptIntegration.runDictation());
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.builtinDictationState())).toMatchObject({ state: 'transcribing' });
		await page.evaluate(() => window.ashChatTranscriptIntegration.retireChat());
		await stopping;
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.builtinDictationState())).toMatchObject({ busy: false });
		await input.focus();
		await page.evaluate(() => window.ashChatTranscriptIntegration.runDictation());
		const replacementDraft = await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft());
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.builtinDictationEvent('late retired transcript', true);
			window.ashChatTranscriptIntegration.finishBuiltinStop();
		});
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.builtinDictationState())).toMatchObject({ state: 'recording', busy: true });
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatDraft())).toBe(replacementDraft);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.chatMessages())).toEqual([]);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setChatVisible(false));
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.builtinDictationState())).toMatchObject({ busy: false });
	});
}
