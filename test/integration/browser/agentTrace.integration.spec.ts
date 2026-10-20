import { expect, test } from '@playwright/test';

const capture = {
	formatVersion: 3, sessionId: 'theme-fixture', historyPrefixes: [],
	threads: [{
		threadId: 'root', events: [
			{ eventId: 'e-1', sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: 'root', title: 'Theme fixture' } },
			{ eventId: 'e-2', sequence: 2, recordedAt: 2, event: { type: 'turnCompleted', threadId: 'root', turnId: 'turn' } },
			{ eventId: 'e-3', sequence: 3, recordedAt: 3, event: { type: 'turnFailed', threadId: 'root', turnId: 'turn', error: { message: 'Fixture failure' } } },
		]
	}],
	graph: {
		nodes: {
			root: { id: 'root', kind: 'thread', label: 'Theme fixture', threadId: 'root', turnId: null, eventKey: 'root:1' },
			turn: { id: 'turn', kind: 'turn', label: 'Completed turn', threadId: 'root', turnId: 'turn', eventKey: 'root:2' },
		}, edges: [{ from: 'root', to: 'turn', kind: 'owns' }], warnings: ['Missing causal witness fixture']
	},
};

test('Execution Trace uses shared tree, tabs and resizable panes across themes and narrow layouts', async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/agentTrace.html');
	await expect.poll(() => page.locator('body').getAttribute('data-ready')).toBe('true');
	const viewer = page.locator('.ash-agent-trace');
	await viewer.locator('input[type=file]').setInputFiles({ name: 'themes.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(capture)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	await expect(viewer.getByRole('tab')).toHaveCount(5);
	await expect(viewer.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(viewer.getByRole('region', { name: 'Saved execution body', exact: true })).toHaveCount(0);
	const tree = viewer.getByRole('tree');
	const failure = viewer.locator('[role=treeitem]:has([data-key="root:3"])');
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.agentTraceIntegration.setTheme(id), id);
		await expect(page.locator('#root')).toHaveAttribute('data-color-theme', id);
		await failure.click();
		await expect(failure).toHaveCSS('height', '22px');
		await expect(failure).toHaveCSS('line-height', '22px');
		await expect(failure).toHaveAttribute('aria-selected', 'true');
		await expect(viewer.getByRole('tabpanel')).toBeVisible();
		await expect(viewer.getByRole('tabpanel')).toContainText('Fixture failure');
		const colors = await failure.evaluate(row => {
			const span = document.createElement('span'); row.append(span);
			span.style.color = 'var(--ash-error-foreground)'; const error = getComputedStyle(span).color;
			span.style.color = 'var(--ash-list-activeSelectionForeground)'; const selected = getComputedStyle(span).color;
			span.remove();
			return { error, selected };
		});
		await expect(failure.locator('.ash-agent-trace-failure')).toHaveCSS('color', colors.error);
		await tree.focus();
		await tree.press('Home');
		await tree.press('End');
		await expect(failure).toHaveAttribute('aria-selected', 'true');
		await expect(tree).toBeFocused();
		await expect(failure).toHaveCSS('color', colors.selected);
		const overview = viewer.getByRole('tab', { name: 'Overview', exact: true });
		await overview.focus();
		await overview.press('ArrowRight');
		await expect(viewer.getByRole('tab', { name: 'Input', exact: true })).toBeFocused();
		await expect(overview).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
		await expect(viewer.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /-input$/);
		await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
		await expect(viewer.locator('.ash-agent-trace-relation-warning')).toContainText('Missing causal witness');
		await viewer.getByRole('tab', { name: 'Overview', exact: true }).click();
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('no match here');
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await expect(viewer.getByRole('tabpanel')).toContainText('Fixture failure');
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('');
		await page.evaluate(() => window.agentTraceIntegration.layout(900, 650));
		const before = await viewer.locator('.ash-agent-trace-navigation').boundingBox();
		const sash = viewer.getByRole('separator');
		await sash.focus();
		await sash.press('ArrowRight');
		await expect.poll(async () => (await viewer.locator('.ash-agent-trace-navigation').boundingBox())!.width).toBeGreaterThan(before!.width);
		await testInfo.attach(`${id}-wide`, { body: await viewer.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.agentTraceIntegration.layout(500, 650));
		await expect(viewer.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
		await expect(viewer.getByRole('tabpanel')).toBeVisible();
		await testInfo.attach(`${id}-narrow`, { body: await viewer.screenshot(), contentType: 'image/png' });
	}
	expect(errors).toEqual([]);
	await page.evaluate(() => window.agentTraceIntegration.dispose());
	await expect(viewer).toHaveCount(0);
	expect(await page.evaluate(() => window.agentTraceIntegration.resources())).toEqual({ models: 0, editors: 0 });
});

test('Execution Trace keeps long history virtual and exposes offscreen events to Accessible View', async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/agentTrace.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const viewer = page.locator('.ash-agent-trace');
	const events = Array.from({ length: 20000 }, (_, i) => ({ eventId: `event-${i}`, sequence: i + 1, recordedAt: i, event: { type: 'itemCompleted', threadId: 'root', turnId: `turn-${Math.floor(i / 200)}`, item: { type: 'agentMessage', text: `message ${i}` } } }));
	const started = Date.now();
	await viewer.locator('input[type=file]').setInputFiles({ name: 'long.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ formatVersion: 3, sessionId: 'long', historyPrefixes: [], threads: [{ threadId: 'root', events }] })) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	const firstMs = Date.now() - started;
	const mounted = await viewer.locator('.ash-agent-trace-row').count();
	expect(mounted).toBeLessThan(60);
	const search = viewer.getByRole('textbox', { name: 'Filter execution events' });
	const searching = Date.now();
	await search.fill('event-19999');
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(1);
	await viewer.locator('.ash-agent-trace-event').click();
	await expect(viewer.getByRole('tabpanel')).toContainText('event-19999');
	const searchMs = Date.now() - searching;
	await search.fill('');
	const content = await page.evaluate(() => window.agentTraceIntegration.accessibleContent());
	expect(content).toContain('message 0'); expect(content).toContain('message 19999');
	await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
	await expect(viewer.getByRole('region', { name: 'Saved execution body', exact: true })).toHaveCount(1);
	await expect(viewer.getByRole('tabpanel')).toBeVisible();
	await viewer.getByRole('tab', { name: 'Overview', exact: true }).click();
	await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
	await expect(viewer.getByRole('region', { name: 'Saved execution body', exact: true })).toHaveCount(1);
	const beforeClose = await page.evaluate(() => window.agentTraceIntegration.resources());
	expect(beforeClose).toEqual({ models: 1, editors: 1 });
	expect(errors).toEqual([]);
	await testInfo.attach('long-history-measurements', { body: Buffer.from(JSON.stringify({ events: events.length, firstMs, searchMs, mounted, beforeClose })), contentType: 'application/json' });
	await page.evaluate(() => window.agentTraceIntegration.dispose());
	await expect(viewer).toHaveCount(0);
	expect(await page.evaluate(() => window.agentTraceIntegration.resources())).toEqual({ models: 0, editors: 0 });
});

test('Chat Debug shows backend coverage and keeps capture metrics stable across structured filters', async ({ page }, testInfo) => {
	await page.goto('/agentTrace.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const viewer = page.locator('.ash-agent-trace');
	const ledger = (invocationId: string, usage: unknown, outcome: string) => ({ type: 'modelInvocationRecorded', record: { invocationId, outcome, usage } });
	const first = ledger('first', { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }, 'completed');
	const decisions = [
		{ action: 'executeTools', reason: 'toolRequests', stopReason: { type: 'toolUse' }, messagePhases: ['final_answer'], toolCallCount: 1 },
		{ action: 'continue', reason: 'nonterminalMessage', stopReason: { type: 'completed' }, messagePhases: ['partial_answer'], toolCallCount: 0 },
		{ action: 'complete', reason: 'compatibleCompletion', stopReason: { type: 'completed' }, messagePhases: [null], toolCallCount: 0 },
		{ action: 'fail', reason: 'truncatedOutput', stopReason: { type: 'maxOutputTokens' }, messagePhases: ['partial_answer'], toolCallCount: 0 },
		{ action: 'superseded', reason: 'newInput', stopReason: { type: 'completed' }, messagePhases: ['final_answer'], toolCallCount: 0 },
	];
	const events = [
		{ type: 'threadCreated', title: 'Coverage fixture' }, first, first,
		ledger('second', { inputTokens: null, outputTokens: 0, cachedInputTokens: null }, 'failed'),
		{ type: 'itemCompleted', item: { type: 'toolCall', toolCallId: 'call', name: 'shell-command' } },
		{ type: 'itemCompleted', item: { type: 'toolResult', toolCallId: 'call', text: 'private output', isError: true } },
		{ type: 'turnFailed', error: { message: 'Failed Turn' } },
		...decisions.map(decision => ({ type: 'modelResponseEvaluated', sourceThreadSequence: 0, decision })),
	].map((event, index) => ({ eventId: `coverage-${index}`, sequence: index + 1, recordedAt: Date.UTC(2026, 9, 18, 12) + index, event: { ...event, threadId: 'root', turnId: event.type === 'threadCreated' ? undefined : 't' } }));
	const metric = (reported: string | null, reportedCalls: number, missingCalls: number) => ({ reported, reportedCalls, missingCalls });
	const artifact = {
		formatVersion: 3, sessionId: 'coverage', historyPrefixes: [], threads: [{ threadId: 'root', events }],
		overview: {
			formatVersion: 1, threadCursors: { root: 12 }, eventCount: 12, modelCalls: 2, toolCalls: 1, failedModelCalls: 1, cancelledModelCalls: 0, excludedModelCalls: 0,
			inputTokens: metric('100', 1, 1), outputTokens: metric('20', 2, 0), cachedInputTokens: metric('80', 1, 1), totalTokens: metric('120', 1, 1)
		},
		diagnostics: { formatVersion: 2, captureId: null, recordingStatus: 'incomplete', droppedRecords: 2, pendingRecords: 1, events: [] },
	};
	await viewer.locator('input[type=file]').setInputFiles({ name: 'coverage.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(artifact)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	const overview = viewer.locator('.ash-chat-debug-overview');
	const cell = (label: string) => overview.locator('.ash-chat-debug-metrics > div').filter({ has: page.getByText(label, { exact: true }) });
	await expect(cell('Committed model calls').locator('dd')).toHaveText('2');
	await expect(cell('Input tokens').locator('dd')).toHaveText(['100', 'Reported by 1/2 included calls']);
	await expect(cell('Input + output tokens').locator('dd')).toHaveText(['120', 'Reported by 1/2 included calls']);
	await expect(overview).toContainText('2 records omitted');
	const before = await overview.innerText();
	await viewer.getByRole('button', { name: 'Models', exact: true }).focus();
	await page.keyboard.press('Space');
	await expect(viewer.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute('aria-pressed', 'false');
	const search = viewer.getByRole('textbox', { name: 'Filter execution events' });
	await search.fill('thread:root turn:t, !private, after:2026-10-18, before:2026-10-18');
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(2);
	expect(await overview.innerText()).toBe(before);
	await search.fill('after:2026-02-30');
	await expect(search).toHaveAttribute('aria-invalid', 'true');
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(0);
	await viewer.getByRole('button', { name: 'Clear filters', exact: true }).click();
	await expect(search).not.toHaveAttribute('aria-invalid');
	await expect(viewer.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(12);
	const timeline = viewer.locator('.ash-agent-trace-tree');
	await expect(timeline).toContainText('Execute tools · Pending tool requests · stop: Tool use · phases: Final answer');
	await expect(timeline).toContainText('Continue generation · Nonterminal message received');
	await expect(timeline).toContainText('Complete Turn · Completed without a known phase');
	await expect(timeline).toContainText('Superseded by new input · New input arrived during generation');
	await testInfo.attach('chat-debug-overview-wide', { body: await viewer.screenshot(), contentType: 'image/png' });
	await page.evaluate(() => window.agentTraceIntegration.layout(500, 650));
	await expect(overview).not.toHaveAttribute('open');
	await expect(viewer.getByRole('tree')).toBeVisible();
	await overview.locator('summary').focus();
	await page.keyboard.press('Enter');
	await expect(overview).toHaveAttribute('open', '');
	await expect.poll(() => viewer.locator('.ash-agent-trace-tree').evaluate(element => element.clientHeight)).toBeGreaterThan(80);
	await expect(viewer.getByRole('tabpanel')).not.toBeVisible();
	await testInfo.attach('chat-debug-overview-narrow', { body: await viewer.screenshot(), contentType: 'image/png' });
	await viewer.locator('[data-event-id="coverage-4"]').click();
	await expect(overview).not.toHaveAttribute('open');
	await expect(viewer.getByRole('tabpanel')).toBeVisible();
	const content = await page.evaluate(() => window.agentTraceIntegration.accessibleContent());
	expect(content).toContain('Reported by 1/2 included calls');
	await page.evaluate(() => window.agentTraceIntegration.dispose());
});
