import { expect, test } from '@playwright/test';

test('Execution Trace preserves semantic colors, selection and keyboard focus across four themes', async ({ page }, testInfo) => {
	const errors: string[] = [];
	const evidence: unknown[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/agentTrace.html');
	await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
	const viewer = page.locator('.ash-agent-trace');
	const trace = {
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
			},
			edges: [{ from: 'root', to: 'turn', kind: 'owns' }], warnings: [],
		},
	};
	await viewer.locator('input[type=file]').setInputFiles({ name: 'themes.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(3);
	const selected = viewer.locator('.ash-agent-trace-event[data-key="root:1"]');
	const failure = viewer.locator('.ash-agent-trace-event.failed');
	const details = viewer.getByRole('region', { name: 'Execution event details' });

	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(id => window.agentTraceIntegration.setTheme(id), id);
		await expect(page.locator('#root')).toHaveAttribute('data-color-theme', id);
		await selected.click();
		await page.mouse.move(0, 0);
		await expect(selected).toHaveAttribute('aria-pressed', 'true');
		const expected = await viewer.evaluate(element => {
			const probe = document.createElement('span');
			element.append(probe);
			const color = (variable: string): string => {
				probe.style.color = `var(${variable})`;
				return getComputedStyle(probe).color;
			};
			try {
				const style = getComputedStyle(element);
				const variables = ['--ash-foreground', '--ash-description-foreground', '--ash-error-foreground', '--ash-list-inactiveSelectionBackground', '--ash-focusBorder', '--ash-font-family-monospace', '--ash-button-foreground'];
				probe.style.fontFamily = 'var(--ash-font-family-monospace)';
				return {
					registered: variables.every(variable => style.getPropertyValue(variable).trim().length > 0),
					foreground: color('--ash-foreground'),
					description: color('--ash-description-foreground'),
					error: color('--ash-error-foreground'),
					selection: color('--ash-list-inactiveSelectionBackground'),
					focus: color('--ash-focusBorder'),
					border: style.getPropertyValue('--ash-contrastBorder').trim() ? color('--ash-contrastBorder') : 'rgba(0, 0, 0, 0)',
					font: getComputedStyle(probe).fontFamily,
				};
			} finally { probe.remove(); }
		});
		expect(expected.registered).toBe(true);
		await expect(viewer.locator('.ash-agent-trace-summary')).toHaveCSS('color', expected.description);
		await expect(failure).toHaveCSS('color', expected.error);
		await expect(selected).toHaveCSS('color', expected.foreground);
		await expect(selected).toHaveCSS('background-color', expected.selection);
		await expect(selected).toHaveCSS('border-top-color', expected.border);
		await expect(details).toHaveCSS('font-family', expected.font);
		expect(expected.selection).not.toBe(await viewer.evaluate(element => getComputedStyle(element).backgroundColor));
		expect(expected.error).not.toBe(expected.foreground);
		const reference = page.getByRole('button', { name: 'Reference secondary button', exact: true });
		const buttonStyle = await reference.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderTopColor }));
		const relation = viewer.locator('.ash-agent-trace-relation');
		await expect(relation).toBeEnabled();
		await expect(relation).toHaveCSS('color', buttonStyle.color);
		await expect(relation).toHaveCSS('background-color', buttonStyle.background);
		await expect(relation).toHaveCSS('border-top-color', buttonStyle.border);
		if (id.includes('high-contrast')) {
			expect(expected.border).not.toBe('rgba(0, 0, 0, 0)');
			expect(buttonStyle.color).not.toBe(buttonStyle.background);
		}
		await selected.focus();
		await selected.press('End');
		await expect(failure).toBeFocused();
		await expect(failure).toHaveAttribute('aria-pressed', 'true');
		await expect(failure).toHaveCSS('color', expected.error);
		await expect(failure).toHaveCSS('background-color', expected.selection);
		await expect(failure).toHaveCSS('border-top-color', expected.border);
		await expect(failure).toHaveCSS('outline-style', 'solid');
		await expect(failure).toHaveCSS('outline-color', expected.focus);
		await expect(details).toContainText('Fixture failure');
		const keyboardFocus = await failure.evaluate(element => {
			const style = getComputedStyle(element);
			return { color: style.color, background: style.backgroundColor, border: style.borderTopColor, outline: style.outlineColor, outlineStyle: style.outlineStyle };
		});
		await details.focus();
		await expect(details).toHaveCSS('outline-color', expected.focus);
		await expect(details).toHaveCSS('outline-style', 'solid');
		evidence.push({ id, ...expected, button: buttonStyle, keyboardFocus });
	}
	await testInfo.attach('theme-evidence', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
	await page.evaluate(() => window.agentTraceIntegration.dispose());
	await expect(viewer).toHaveCount(0);
	expect(errors).toEqual([]);
});
