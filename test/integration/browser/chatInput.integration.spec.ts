import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`Inline files and selected code use the message cursor and preserve snapshots in ${locale} ${theme}`, async ({ page }) => {
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
			await input.focus();
			await page.keyboard.type('Explain  please');
			await input.press('Home');
			for (let index = 0; index < 8; index++) await input.press('ArrowRight');
			await page.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('combobox').fill('edited');
			await picker.getByRole('option', { name: /edited.ts/ }).click();
			const wholeFile = page.locator('.ash-chat-code-reference').filter({ hasText: /^edited.ts$/ });
			await expect(wholeFile).toHaveText('edited.ts');
			await expect(input).toBeFocused();
			await page.locator('#add-code-selection').click();
			const reference = page.locator('.ash-chat-code-reference').filter({ hasText: /^example.ts \(3-4\)$/ });
			await expect(reference).toHaveText('example.ts (3-4)');
			await expect(wholeFile).toHaveText('edited.ts');
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			await expect(page.locator('.ash-aria-status').filter({ hasText: locale === 'en' ? 'Inserted example.ts (3-4) at the message cursor' : '已在消息光标处插入 example.ts (3-4)' })).toHaveCount(1);
			const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			expect(accessibility.help).toContain(locale === 'en' ? 'Add Selection to Chat' : '将选中代码加入聊天');
			expect(accessibility.content).toContain('example.ts (3-4)');
			const restored = await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
			expect(restored).toBe('Explain edited.ts example.ts (3-4) please');
			await expect(reference).toHaveText('example.ts (3-4)');
			await input.press('Home');
			for (let index = 0; index < 8; index++) await input.press('ArrowRight');
			await input.press('ArrowRight');
			await input.press('ArrowRight');
			await input.press('Delete');
			await expect(reference).toHaveCount(0);
			await input.press('ControlOrMeta+z');
			await expect(reference).toHaveText('example.ts (3-4)');
			const referenceStyle = () => reference.evaluate(element => {
				const { backgroundColor, color, outlineStyle } = getComputedStyle(element);
				const luminance = (value: string) => {
					const channels = value.match(/\d+/g)!.slice(0, 3).map(channel => Number(channel) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
					return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
				};
				const foreground = luminance(color);
				const background = luminance(backgroundColor);
				return { foreground: color, background: backgroundColor, outline: outlineStyle, contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
			});
			const selectedStyle = await referenceStyle();
			await input.press('ArrowRight');
			for (const style of [selectedStyle, await referenceStyle()]) {
				expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
				expect(style.contrast, JSON.stringify(style)).toBeGreaterThanOrEqual(4.5);
				if (theme.startsWith('hc')) expect(style.outline).toBe('solid');
			}
			await page.locator('main').screenshot({ path: test.info().outputPath('inline-file-references.png') });
			await input.press('Enter');
			await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'edited.ts', content: 'Unsaved editor text' }, { name: 'example.ts (3-4)', content: 'Source: file:///workspace/example.ts#3,1-5,1\n\nconst unsaved = 42;\nreturn unsaved;\n' }]));
			await expect(reference).toHaveCount(0);
			await expect(wholeFile).toHaveCount(0);
		});
	}
}

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'hcDark']) {
		for (const newChat of [true, false]) {
			test(`Stacked Sessions retain a growing ${newChat ? 'new' : 'existing'} chat input in ${locale} ${theme}`, async ({ page }) => {
				await page.goto(`/chatInput.html?sessionsLayout=1${newChat ? '&newChat=1' : ''}&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const body = page.locator('main');
				const host = page.locator('.ash-chat-pane-host');
				const sidebar = page.locator('.ash-chat-sessions-sidebar');
				const input = page.locator('.ash-chat-textarea-input');
				await expect(input).toBeVisible();
				await sidebar.getByRole('button').focus();
				await page.keyboard.press('Tab');
				await expect(input).toBeFocused();
				const draft = Array.from({ length: 10 }, (_, index) => `Keep draft line ${index + 1}`).join('\n');
				await input.fill(draft);
				await expect.poll(async () => {
					const bounds = await body.boundingBox();
					const chat = await host.boundingBox();
					const composer = await page.locator('.ash-chat-input-part').boundingBox();
					const sessions = await sidebar.boundingBox();
					return !!bounds && !!chat && !!composer && !!sessions && chat.height >= 116 && chat.height > bounds.height / 2
						&& composer.y >= chat.y && composer.y + composer.height <= bounds.y + bounds.height + 1
						&& composer.y + composer.height <= chat.y + chat.height + 1
						&& sessions.y + sessions.height <= chat.y + 1;
				}).toBe(true);
				await expect(input).toBeFocused();
				await expect(input).toHaveValue(draft);
				for (const width of [800, 240, 600]) {
					await page.locator('.ash-chat-view').evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
					await expect(body).toHaveClass(/sessions-stacked/u);
					await expect(input).toBeVisible();
					await expect(input).toHaveValue(draft);
					await expect(input).toBeFocused();
				}
				await page.locator('.ash-chat-view').evaluate(element => { (element as HTMLElement).style.width = '380px'; });
				if (locale === 'en' && theme === 'light' && !newChat) {
					await body.screenshot({ path: test.info().outputPath('sessions-stacked.png') });
				}
				await body.evaluate(element => { element.classList.remove('sessions-sidebar-visible'); });
				await sidebar.evaluate(element => { element.setAttribute('hidden', ''); });
				await expect(input).toBeVisible();
				await expect(input).toHaveValue(draft);
				await expect(input).toBeFocused();
			});
		}
	}
}

test('Closed Sessions keep the full Chat transcript and composer at every width', async ({ page }) => {
	await page.goto('/chatInput.html?sessionsLayout=closed');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	for (const width of [800, 380, 240, 600]) {
		await page.locator('.ash-chat-view').evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
		await expect(page.locator('.ash-chat-sessions-sidebar')).toBeHidden();
		await expect(page.locator('.ash-chat-list-widget')).toBeVisible();
		await expect(page.locator('.ash-chat-textarea-input')).toBeVisible();
		const bounds = await page.locator('.ash-chat-pane-host').boundingBox();
		expect(bounds!.width).toBe(width);
	}
});

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`Editor changes leave the composer without an attachment bar in ${locale} ${theme}`, async ({ page }) => {
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
			for (const file of ['file:///workspace/edited.ts', 'file:///workspace/other.ts']) {
				await page.evaluate(path => window.ashChatInputIntegration.setActiveFile(path), file);
				await expect(page.locator('.ash-chat-suggested-context')).toHaveCount(0);
				await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
			}
			await page.evaluate(() => window.ashChatInputIntegration.setActiveDiff('git-change:/staged/example.ts?side=original', 'git-change:/staged/example.ts?side=modified', 'Staged version'));
			await expect(page.locator('.ash-chat-suggested-context')).toHaveCount(0);
			await input.focus();
			const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
			expect(help).not.toContain(locale === 'en' ? 'The current editor file is suggested above the message.' : '消息上方会显示当前编辑文件的上下文建议。');
			await page.keyboard.type('Without context');
			await input.press('Enter');
			await expect(page.getByLabel('Submission', { exact: true })).toHaveText('[]');
			await page.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true }).press('Enter');
			const picker = page.getByRole('dialog');
			await picker.getByRole('combobox').fill('edited');
			await picker.getByRole('option', { name: /edited.ts/ }).click();
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-chat-code-reference')).toHaveText('edited.ts');
			await expect(page.locator('.ash-chat-suggested-context')).toHaveCount(0);
			await input.press('Enter');
			await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'edited.ts', content: 'Unsaved editor text' }]));
		});
	}
}

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`Context usage hover keeps two lines in ${locale} ${theme}`, async ({ page }) => {
			await page.goto(`/chatInput.html?contextHover=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('main').evaluate(element => { element.style.width = '450px'; element.style.marginTop = '420px'; });
			const context = page.locator('.ash-chat-context-usage-button');
			await context.hover();
			const hover = page.getByRole('tooltip').locator('.ash-chat-context-usage-hover');
			for (const known of [true, false]) {
				if (!known) await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true));
				await expect(hover).toBeVisible();
				const lines = known
					? locale === 'en' ? ['Context budget: 25%', 'Estimated input tokens: 200 / 800'] : ['上下文预算：25%', '估算输入 token 数：200 / 800']
					: locale === 'en' ? ['Estimated context: 200 tokens', 'Context capacity unavailable.'] : ['上下文估算：200 个 token', '容量未知'];
				await expect(hover).toHaveText(lines.join('\n'));
				await expect(hover).toHaveCSS('white-space', 'pre-line');
				const linePositions = await hover.evaluate(element => {
					const text = element.firstChild!;
					const split = element.textContent!.indexOf('\n');
					const first = element.ownerDocument.createRange();
					first.setStart(text, 0);
					first.setEnd(text, split);
					const second = element.ownerDocument.createRange();
					second.setStart(text, split + 1);
					second.setEnd(text, text.textContent!.length);
					return { first: first.getBoundingClientRect().top, second: second.getBoundingClientRect().top };
				});
				expect(linePositions.second).toBeGreaterThan(linePositions.first);
				if (!known) await expect(hover).not.toContainText('%');
			}
			await context.click();
			await expect(page.getByRole('tooltip')).toBeHidden();
			await expect(page.getByRole('dialog', { name: locale === 'en' ? 'Context usage' : '上下文用量' })).toBeVisible();
		});
	}
}

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`Chat footer actions stay below the input and accept keyboard commands in ${locale} ${theme}`, async ({ page }) => {
			await page.goto(`/chatInput.html?footerStatus=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('main').evaluate(element => {
				element.classList.add('ash-chat');
				const view = element.ownerDocument.createElement('div');
				view.className = 'ash-chat-view';
				const host = element.ownerDocument.createElement('div');
				host.className = 'ash-chat-pane-host';
				element.before(view);
				view.append(host);
				host.append(element);
				element.style.height = 'auto';
				element.style.marginTop = '420px';
			});
			const input = page.locator('.ash-chat-textarea-input');
			await input.fill('Keep my draft');
			const footer = page.locator('.ash-chat-secondary-toolbar');
			const add = footer.getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true });
			await expect(page.locator('.ash-chat-input-container').getByRole('button', { name: locale === 'en' ? 'Add context' : '添加上下文', exact: true })).toHaveCount(0);
			await expect(add).toBeVisible();
			const permissions = footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Manual' : '权限：手动' });
			const context = footer.locator('.ash-chat-context-usage-button');
			const status = footer.getByRole('button', { name: 'Extension status' });
			await expect(footer.getByRole('button', { name: locale === 'en' ? 'Report an issue' : '报告问题' })).toHaveCount(0);
			await expect(permissions).toBeVisible();
			await expect(permissions).toHaveText(locale === 'en' ? 'Manual' : '手动');
			await expect(context).toBeVisible();
			await expect(context).toHaveText('');
			await expect(context).toHaveAttribute('aria-label', locale === 'en' ? 'Context budget: 25%, estimated input 200 of 800 tokens' : '上下文预算：25%，估算输入 200 / 800 个 token');
			await context.hover();
			await expect(context).toHaveAttribute('title', locale === 'en' ? 'Context budget: 25%\nEstimated input tokens: 200 / 800' : '上下文预算：25%\n估算输入 token 数：200 / 800');
			const ring = context.locator('svg');
			const ringBounds = await ring.boundingBox();
			expect([ringBounds!.width, ringBounds!.height]).toEqual([16, 16]);
			expect(await context.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
			expect(await ring.locator('.ash-chat-context-usage-track').evaluate(element => getComputedStyle(element).stroke)).not.toBe('none');

			await expect(footer.getByText('Models & providers', { exact: true })).toHaveCount(0);
			await expect(status).toHaveCount(0);
			const composerBackground = {
				light: 'rgb(255, 255, 255)', dark: 'rgb(49, 49, 49)',
				hcLight: 'rgb(255, 255, 255)', hcDark: 'rgb(0, 0, 0)',
			}[theme]!;
			await expect(page.locator('.ash-chat-input-container')).toHaveCSS('background-color', composerBackground);
			const conversationBackground = { light: 'rgb(248, 248, 248)', dark: 'rgb(37, 37, 38)', hcLight: 'rgb(255, 255, 255)', hcDark: 'rgb(0, 0, 0)' }[theme]!;
			await expect(page.locator('main')).toHaveCSS('background-color', conversationBackground);
			await expect(page.locator('.ash-chat-view')).toHaveCSS('background-color', conversationBackground);
			await page.locator('main').evaluate(element => { element.style.setProperty('--ash-auxiliaryBar-background', 'rgb(250, 245, 240)'); });
			await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(250, 245, 240)');
			await expect(page.locator('.ash-chat-input-container')).toHaveCSS('background-color', composerBackground);
			await page.locator('main').evaluate(element => { element.style.removeProperty('--ash-auxiliaryBar-background'); });

			const composer = await page.locator('.ash-chat-input-container').boundingBox();
			const footerBounds = await footer.boundingBox();
			expect(footerBounds!.y).toBeGreaterThanOrEqual(composer!.y + composer!.height);
			const addBounds = (await add.boundingBox())!;
			const permissionBounds = (await permissions.boundingBox())!;
			expect(permissionBounds.x - (addBounds.x + addBounds.width)).toBe(4);
			await add.focus();
			await page.keyboard.press('ArrowRight');
			await expect(permissions).toBeFocused();
			await page.keyboard.press('Enter');
			const picker = page.locator('.ash-action-widget');
			await expect(picker).toBeVisible();
			await expect(picker.locator('input')).toHaveCount(0);
			await expect(page.getByRole('combobox', { name: locale === 'en' ? 'Permissions' : '权限' })).toHaveCount(0);
			await expect(permissions).toHaveAttribute('aria-expanded', 'true');
			await expect(picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Manual' : '手动', exact: true })).toHaveAttribute('aria-checked', 'true');
			const pickerBounds = (await picker.boundingBox())!;
			const permissionsBounds = (await permissions.boundingBox())!;
			expect(pickerBounds.y + pickerBounds.height).toBeLessThanOrEqual(permissionsBounds.y);
			if (locale === 'en' && theme === 'light') {
				await page.screenshot({ path: test.info().outputPath('chat-permission-menu.png') });
			}
			await page.keyboard.press('Escape');
			await expect(picker).toBeHidden();
			await expect(permissions).toBeFocused();
			await expect(permissions).toHaveAttribute('aria-expanded', 'false');
			await permissions.click();
			await picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Auto' : '自动', exact: true }).click();
			await expect(footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Auto' : '权限：自动' })).toBeVisible();
			await expect(footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Auto' : '权限：自动' })).toHaveText(locale === 'en' ? 'Auto' : '自动');
			await expect(picker).toBeHidden();
			await expect(page.getByLabel('Opened sources')).toHaveText('[{"approvalMode":"auto"}]');
			const updatedPermissions = footer.getByRole('button', { name: locale === 'en' ? 'Permissions: Auto' : '权限：自动' });
			await updatedPermissions.focus();
			await page.keyboard.press('Space');
			const autoOption = picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Auto' : '自动', exact: true });
			await expect(autoOption).toBeFocused();
			await expect(autoOption).toHaveAttribute('aria-checked', 'true');
			await page.keyboard.press('ArrowDown');
			await expect(picker.getByRole('menuitemradio', { name: locale === 'en' ? 'Manual' : '手动', exact: true })).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(updatedPermissions).toBeFocused();
			await updatedPermissions.click();
			await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
			await expect(picker).toBeHidden();
			await page.evaluate(() => window.ashChatInputIntegration.setVisible(true));
			await context.focus();
			await page.keyboard.press('Enter');
			const details = page.getByRole('dialog', { name: locale === 'en' ? 'Context usage' : '上下文用量' });
			await expect(details).toBeVisible();
			await expect(details).toBeFocused();
			await expect(context).toHaveAttribute('aria-expanded', 'true');
			await expect(details.locator('.ash-chat-context-details-summary')).toHaveText(locale === 'en' ? 'Estimated input: 200 / 800 tokens · 25%' : '估算输入：200 / 800 个 token · 25%');
			const accessibleDetails = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			expect(accessibleDetails.content).toContain(locale === 'en' ? 'Estimated input: 200 / 800 tokens · 25%' : '估算输入：200 / 800 个 token · 25%');
			expect(accessibleDetails.help).toContain('Escape');
			await expect(details.getByRole('rowheader', { name: locale === 'en' ? 'Remaining input budget' : '剩余输入预算' }).locator('..')).toContainText('600');
			const detailsBounds = (await details.boundingBox())!;
			const contextBounds = (await context.boundingBox())!;
			expect(detailsBounds.y + detailsBounds.height).toBeLessThanOrEqual(contextBounds.y);
			await page.keyboard.press('Escape');
			await expect(details).toBeHidden();
			await expect(context).toBeFocused();
			await expect(context).toHaveAttribute('aria-expanded', 'false');
			await context.click();
			await page.keyboard.press('Tab');
			await expect(details.getByRole('button', { name: locale === 'en' ? 'Close context usage details' : '关闭上下文用量明细' })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(details).toBeHidden();
			await context.focus();
			await page.evaluate(() => window.ashChatInputIntegration.setFooterStatus(true));
			await expect(status).toBeVisible();
			await page.keyboard.press('Tab');
			await expect(status).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.getByLabel('Opened sources')).toContainText('test.chat.status');
			await expect(input).toHaveValue('Keep my draft');
			for (const width of [240, 450]) {
				await page.locator('main').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
				await expect(context).toBeVisible();
				await expect(status).toBeVisible();
				const bounds = await footer.boundingBox();
				for (const button of [add, updatedPermissions, context, status]) {
					const buttonBounds = await button.boundingBox();
					expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
				}
			}
			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('submitting'));
			await expect(footer.locator('.ash-chat-status-summary')).toHaveText(locale === 'en' ? 'Working…' : '正在运行…');
			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('error', 'Connection was lost'));
			await expect(footer.locator('.ash-chat-status-summary')).toHaveText('Connection was lost');
			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('ready'));
			await expect(footer.locator('.ash-chat-status-summary')).toBeHidden();
			if (locale === 'en' && theme === 'light') {
				await footer.screenshot({ path: test.info().outputPath('chat-footer.png') });
			}
			await page.evaluate(() => window.ashChatInputIntegration.removeFooterStatus());
			await expect(status).toHaveCount(0);
			await context.click();
			await expect(details).toBeVisible();
			await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
			await expect(details).toHaveCount(0);
			await expect(context).toBeHidden();
			await page.evaluate(() => window.ashChatInputIntegration.setVisible(true));
			await expect(context).toBeVisible();
			await context.click();
			await expect(details).toBeVisible();
			await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(false));
			await expect(details).toHaveCount(0);
			await expect(context).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true));
			await expect(context).toHaveAttribute('aria-label', locale === 'en' ? 'Context usage: 200 tokens, capacity unavailable' : '上下文用量：200 个 token，容量未知');
			await expect(ring.locator('.ash-chat-context-usage-track')).toHaveCSS('stroke-dasharray', 'none');
			await expect(ring.locator('.ash-chat-context-usage-value')).toHaveAttribute('stroke-dasharray', '0 100');
			await expect(ring.locator('.ash-chat-context-usage-value')).toBeHidden();
			await expect(context).toHaveAttribute('title', locale === 'en' ? 'Estimated context: 200 tokens\nContext capacity unavailable.' : '上下文估算：200 个 token\n容量未知');
			await expect(context).not.toHaveAttribute('aria-label', /%/);
			await context.click();
			await expect(details).toBeVisible();
			await expect(details.locator('.ash-chat-context-details-summary')).toHaveText(locale === 'en' ? '200 tokens · Capacity unavailable' : '200 个 token · 容量未知');
			await expect(details).not.toContainText('%');
			await expect(details.getByRole('columnheader')).toHaveCount(2);
			await expect(details.locator('.ash-chat-context-details-bar').locator('span')).toHaveCount(0);
			await expect(details.getByRole('rowheader', { name: locale === 'en' ? 'Remaining input budget' : '剩余输入预算' })).toHaveCount(0);
			await page.keyboard.press('Escape');
			await context.focus();
			const retainedButton = await context.elementHandle();
			await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 500));
			await expect(context).toHaveAttribute('aria-label', /50%/);
			await expect(context).toBeFocused();
			expect(await retainedButton!.evaluate(element => element.isConnected)).toBe(true);
			await expect(ring.locator('.ash-chat-context-usage-value')).toHaveAttribute('stroke-dasharray', '50 50');
			await context.click();
			await expect(details).toBeVisible();
			const close = details.getByRole('button', { name: locale === 'en' ? 'Close context usage details' : '关闭上下文用量明细' });
			await close.focus();
			await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 600));
			await expect(details.locator('.ash-chat-context-details-summary')).toContainText('60%');
			await expect(close).toBeFocused();
			await close.click();
			await expect(details).toBeHidden();
			await expect(context).toBeFocused();
			await context.click();
			await context.click();
			await expect(details).toBeHidden();
			await context.click();
			await input.click({ position: { x: 8, y: 8 } });
			await expect(details).toBeHidden();
			await expect(input).toBeFocused();
			await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 0));
			await expect(context).toHaveAttribute('aria-label', /0%/);
			await expect(ring.locator('.ash-chat-context-usage-value')).toBeHidden();
			await page.evaluate(() => window.ashChatInputIntegration.setContextUsage(true, 1000, 1500));
			await expect(context).toHaveAttribute('aria-label', /150%/);
			await expect(ring.locator('.ash-chat-context-usage-value')).toHaveAttribute('stroke-dasharray', '100 0');
			expect(await context.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);

			await page.evaluate(() => window.ashChatInputIntegration.openModels());
			await expect(page.getByRole('switch', { name: locale === 'en' ? 'Auto' : '自动', exact: true })).not.toBeChecked();
			await page.getByRole('menuitem', { name: locale === 'en' ? 'Add Models' : '添加模型' }).click();
			await expect(page.getByLabel('Opened sources')).toContainText('"settings":"models"');
			await context.click();
			await expect(details).toBeVisible();
			await page.evaluate(() => window.ashChatInputIntegration.dispose());
			await expect(footer).toHaveCount(0);
			await expect(details).toHaveCount(0);
		});
	}
}

test('Input history pages older records and restores draft selection, attachments and pinned skills', async ({ page }) => {
	await page.goto('/chatInput.html?history=1');
	const input = page.locator('.ash-chat-textarea-input');
	await input.fill('$commit draft ');
	await page.evaluate(() => { window.ashChatInputIntegration.addHistoryContext(); window.ashChatInputIntegration.setHistorySkill('original'); });
	const draft = await input.inputValue();
	expect(draft).toContain('draft.txt');
	await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
	await input.press('ArrowUp');
	await expect(input).toHaveValue('third input');
	await expect(input).not.toHaveValue(/draft\.txt/);
	await input.press('ArrowUp');
	await expect(input).toHaveValue('second input\nsecond line');
	await input.press('ArrowUp');
	await expect(input).toHaveValue('first input');
	await input.press('ArrowDown');
	await expect(input).toHaveValue('second input\nsecond line');
	await page.evaluate(() => window.ashChatInputIntegration.setHistorySkill('updated'));
	await input.press('Escape');
	await expect(input).toHaveValue(draft);
	expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 0]);
	await input.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
		writes: [draft], submissions: [{ text: draft, skills: [{ version: { type: 'pinnedDigest', digest: 'original' } }] }],
	});
	await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'draft.txt', content: 'synthetic context' }]));
});

for (const locale of ['en', 'zh-CN']) {
	test(`Input history search pages and fills text without sending in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?history=1&locale=${locale}`);
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('keep this draft');
		await input.press('Control+r');
		const search = page.getByRole('combobox', { name: locale === 'en' ? 'Search input history' : '搜索输入历史记录' });
		await expect(search).toBeVisible();
		await page.getByText(locale === 'en' ? 'Load more inputs' : '加载更多输入', { exact: true }).click();
		await page.getByText('first input', { exact: true }).first().click();
		await expect(search).toBeHidden();
		await expect(input).toHaveValue('first input');
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ writes: [], submissions: [] });
		await input.press('Escape');
		await expect(input).toHaveValue('keep this draft');
		await input.press('Control+r');
		await search.fill('second');
		await expect(page.getByText('second input', { exact: true })).toBeVisible();
		await search.press('Escape');
		await expect(input).toHaveValue('keep this draft');
		await expect(input).toBeFocused();
	});
}

test('Input history discards outdated search replies and safely closes a pending search', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/chatInput.html?history=1');
	const input = page.locator('.ash-chat-textarea-input');
	await input.fill('untouched draft');
	await input.press('Control+r');
	const search = page.getByRole('combobox', { name: 'Search input history' });
	await search.fill('wait-old');
	await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ reads: expect.arrayContaining([expect.objectContaining({ text: 'wait-old' })]) });
	await search.fill('third');
	await expect(page.getByText('third input', { exact: true }).first()).toBeVisible();
	await page.evaluate(() => window.ashChatInputIntegration.releaseHistorySearch('wait-old'));
	await expect(page.getByText('third input', { exact: true }).first()).toBeVisible();
	await search.fill('wait-dispose');
	await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ reads: expect.arrayContaining([expect.objectContaining({ text: 'wait-dispose' })]) });
	await page.evaluate(() => { window.ashChatInputIntegration.dispose(); window.ashChatInputIntegration.releaseHistorySearch('wait-dispose'); });
	await expect(search).toBeHidden();
	expect(errors).toEqual([]);
});

test('Input history never overwrites a draft edited while recall is pending', async ({ page }) => {
	await page.goto('/chatInput.html?history=1');
	const input = page.locator('.ash-chat-textarea-input');
	await input.fill('original');
	await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
	await page.evaluate(() => window.ashChatInputIntegration.holdNextHistoryRead());
	await input.press('ArrowUp');
	await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ reads: [expect.objectContaining({ text: '' })] });
	await input.fill('edited while loading');
	await page.evaluate(() => window.ashChatInputIntegration.releaseHistorySearch(''));
	await input.press('Escape');
	await expect(input).toHaveValue('edited while loading');
	await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
	await input.press('ArrowUp');
	await expect(input).toHaveValue('third input');
	await input.press('Escape');
	await expect(input).toHaveValue('edited while loading');
});

test('Chat textarea fallback starts compact and resizes with multiline content without losing focus', async ({ page }) => {
	await page.goto('/chatInput.html');
	const composer = page.locator('.ash-chat-input-container');
	const input = composer.locator('.ash-chat-textarea-input');
	await expect(composer).toHaveCSS('height', '84px');
	await input.focus();
	await page.keyboard.insertText('First line\nSecond line');
	await expect(input).toHaveCSS('height', '40px');
	await page.keyboard.press('Shift+Enter');
	await page.keyboard.insertText('Third line');
	await expect(input).toHaveCSS('height', '60px');
	await expect(composer).toHaveCSS('height', '104px');
	await expect(input).toBeFocused();
	await page.keyboard.insertText('\n' + Array.from({ length: 50 }, (_, index) => `Line ${index}`).join('\n'));
	await expect(input).toHaveCSS('height', '314px');
	await expect(input).toBeFocused();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(composer).toHaveCSS('height', '84px');
	await expect(input).toBeFocused();
});

for (const locale of ['en', 'zh-CN']) {
	test(`model and mode menus share primary option typography in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const typography = [];
		for (const [trigger, popup] of [
			['.ash-chat-input-mode-action', '.ash-chat-input-mode-menu'],
			['.ash-chat-input-model-action', '.ash-chat-model-picker'],
		]) {
			await page.locator(trigger).press('ArrowDown');
			const option = page.locator(popup).getByRole('menuitemradio').first();
			await expect(option).toBeVisible();
			typography.push(await option.evaluate(element => {
				const style = getComputedStyle(element);
				return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight };
			}));
			await page.keyboard.press('Escape');
			await expect(page.locator(trigger)).toBeFocused();
		}
		expect(typography[0].fontSize).toBe('13px');
		expect(typography[1]).toEqual(typography[0]);
	});

	test(`model and effort buttons share typography, pill corners and adjacent spacing in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const mode = page.locator('.ash-chat-input-mode-action');
		const model = page.locator('.ash-chat-input-model-action');
		const effort = page.locator('.ash-chat-input-configuration-action');
		for (const width of [800, 400, 280]) {
			await page.setViewportSize({ width, height: 600 });
			await expect.poll(async () => {
				const metrics = await Promise.all([mode, model, effort].map(trigger => trigger.evaluate(element => {
					const style = getComputedStyle(element);
					const bounds = element.getBoundingClientRect();
					return {
						left: bounds.left, right: bounds.right, height: bounds.height,
						fontSize: style.fontSize, fontWeight: style.fontWeight,
						radius: style.borderRadius, padding: style.padding,
					};
				})));
				const [modeMetrics, modelMetrics, effortMetrics] = metrics;
				return {
					matchingTypography: modelMetrics.fontSize === effortMetrics.fontSize && modelMetrics.fontWeight === effortMetrics.fontWeight,
					matchingPillCorners: modelMetrics.radius === effortMetrics.radius && parseFloat(effortMetrics.radius) >= effortMetrics.height / 2,
					matchingPadding: modelMetrics.padding === effortMetrics.padding,
					matchingSpacing: Math.abs((modelMetrics.left - modeMetrics.right) - (effortMetrics.left - modelMetrics.right)) < 1,
					fits: effortMetrics.right <= width,
				};
			}).toEqual({ matchingTypography: true, matchingPillCorners: true, matchingPadding: true, matchingSpacing: true, fits: true });
		}
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`mode menu fits its contents and retains keyboard selection in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('[data-action-id="ash.chat.input.mode"] button');
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-input-mode-menu');
		await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
		const geometry = await menu.evaluate(element => ({
			width: element.getBoundingClientRect().width,
			overflow: element.scrollWidth - element.clientWidth,
		}));
		expect(geometry.width).toBeGreaterThanOrEqual(100);
		expect(geometry.width).toBeLessThan(240);
		expect(geometry.overflow).toBe(0);
		await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(menu.getByRole('menuitemradio').nth(1)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`approval targets and keyboard decisions use ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(locale === 'en' ? '/chatInput.html' : `/chatInput.html?locale=${locale}`);
		expect(errors).toEqual([]);
		const chinese = locale === 'zh-CN';
		const targets = page.getByRole('list', { name: chinese ? '请求的操作与目标' : 'Requested actions and targets' });
		await expect(targets.getByRole('listitem')).toHaveCount(10);
		await expect(targets.locator('code')).toHaveText(['/workspace/file with spaces.ts', String.raw`C:\Users\name\file.ts`, String.raw`\\server\share\file.ts`, 'pnpm test <script>', 'https://api.example.test', 'provider-key', 'issue:42', 'git.user.email', 'current window', `/workspace/${'a'.repeat(160)}.ts`]);
		await expect(targets.getByRole('listitem').first()).toHaveText(chinese ? '读取文件: /workspace/file with spaces.ts' : 'Read file: /workspace/file with spaces.ts');
		const decline = page.getByRole('button', { name: chinese ? '拒绝' : 'Decline', exact: true });
		const approve = page.getByRole('button', { name: chinese ? '批准一次' : 'Approve once', exact: true });
		await decline.focus();
		await page.evaluate(() => window.ashChatInputIntegration.refresh());
		await expect(decline).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('decline');
		await page.keyboard.press('Tab');
		await expect(approve).toBeFocused();
		await page.keyboard.press('Space');
		await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('approveOnce');
		await page.setViewportSize({ width: 320, height: 600 });
		expect(await targets.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(errors).toEqual([]);
	});
}


test('question controls resolve the editor background variable for each palette', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showQuestions());
	for (const background of ['rgb(30, 30, 30)', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)']) {
		await page.locator('main').evaluate((element, value) => element.style.setProperty('--ash-editor-background', value), background);
		await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCSS('background-color', background);
		await expect(page.getByRole('combobox', { name: 'Your choice' })).toHaveCSS('background-color', background);
	}
});

for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
	test(`model picker shows the catalog description and retains keyboard state in ${surface} ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-model-action');
		await trigger.press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		const search = picker.getByRole('combobox');
		await expect(picker.getByRole('menuitemradio', { name: 'Test Model', exact: true })).toHaveText('Test Model');
		await expect(picker).toHaveClass(/ash-action-widget/);
		expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(320);
		await expect(picker.locator('.ash-quick-pick-row-description')).toHaveCount(0);
		await expect(picker).not.toContainText('A model for everyday tasks');
		await search.press('ArrowRight');
		const card = picker.locator('.ash-chat-model-card');
		const description = 'A model for everyday tasks';
		await expect(card.locator('.ash-chat-model-card-description')).toHaveText(description);
		await expect(card).toHaveAttribute('aria-description', description);
		await expect(card).toBeFocused();
		await expect(card.locator('input, button')).toHaveCount(0);
		await page.setViewportSize({ width: 320, height: 600 });
		const explanation = card.locator('.ash-chat-model-card-description');
		expect(await explanation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await card.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});
}

for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
	test(`thinking levels retain catalog descriptions and keyboard selection in ${surface} ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-configuration-action');
		const lowCopy = locale === 'zh-CN' ? '较轻的推理，更快的响应' : 'Fast responses with lighter reasoning';
		const highCopy = locale === 'zh-CN' ? '为复杂问题提供更深入的推理' : 'Greater reasoning depth for complex problems';
		await expect(trigger).toHaveAttribute('aria-description', lowCopy);
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		const low = menu.locator('[data-action-id="ash.chat.input.effort.low"] button');
		const high = menu.locator('[data-action-id="ash.chat.input.effort.high"] button');
		await expect(low).toBeFocused();
		await expect(low).toHaveAttribute('aria-description', lowCopy);
		await page.keyboard.press('ArrowDown');
		await expect(high).toBeFocused();
		await expect(high).toHaveAttribute('aria-description', highCopy);
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveAttribute('aria-description', highCopy);
	});
}

for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
	test(`model options select effort and context independently in ${surface} ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const trigger = page.locator('.ash-chat-input-configuration-action');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		await expect(trigger).toHaveText(chinese ? '低' : 'Low');
		await trigger.press('ArrowDown');
		await expect(menu.locator('.ash-chat-model-configuration-heading')).toHaveText(chinese ? ['推理强度', '上下文大小'] : ['Thinking Level', 'Context Size']);
		await expect(menu.getByRole('separator')).toHaveCount(1);
		const contextDefault = menu.locator('[data-action-id="ash.chat.input.context.false"] button');
		const expanded = menu.locator('[data-action-id="ash.chat.input.context.true"] button');
		await expect(contextDefault).toHaveAttribute('aria-checked', 'true');
		await expect(contextDefault).toHaveText(chinese ? '关闭长上下文' : 'Long context off');
		await expect(expanded).toHaveText(chinese ? '开启长上下文' : 'Long context on');
		const high = menu.locator('[data-action-id="ash.chat.input.effort.high"] button');
		await page.keyboard.press('ArrowDown');
		await expect(high).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveText(chinese ? '高' : 'High');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(high).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(contextDefault).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(expanded).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveText(chinese ? '高' : 'High');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(high).toHaveAttribute('aria-checked', 'true');
		await expect(expanded).toHaveAttribute('aria-checked', 'true');
		await expect(contextDefault).toHaveAttribute('aria-checked', 'false');
		await expect(menu.getByRole('menuitemradio')).toHaveCount(4);
		const geometry = await menu.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
		expect(geometry.overflow).toBe(0);
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width);
		await contextDefault.click();
		await expect(trigger).toHaveText(chinese ? '高' : 'High');
		await trigger.press('ArrowDown');
		await menu.locator('[data-action-id="ash.chat.input.effort.low"] button').click();
		await expect(trigger).toHaveText(chinese ? '低' : 'Low');
		await trigger.press('ArrowDown');
		await page.keyboard.press('Escape');
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	});
}

for (const { modelOptions, surface } of ['effort', 'context', 'none'].flatMap(modelOptions => ['chat', 'cowork'].map(surface => ({ modelOptions, surface })))) {
	test(`model options only show supported ${modelOptions} controls in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?modelOptions=${modelOptions}&surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-configuration-action');
		if (modelOptions === 'none') {
			await expect(trigger).toBeHidden();
			return;
		}
		await expect(trigger).toHaveText(modelOptions === 'effort' ? 'Low' : 'Model options');
		await expect(trigger).toHaveAccessibleName(modelOptions === 'effort' ? 'Model options: Low' : 'Model options');
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		await expect(menu.locator('.ash-chat-model-configuration-heading')).toHaveText(modelOptions === 'effort' ? 'Thinking Level' : 'Context Size');
		await expect(menu.getByRole('separator')).toHaveCount(0);
		await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveText(modelOptions === 'effort' ? 'High' : 'Model options');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(menu.getByRole('menuitemradio').last()).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
	});
}


test('Mode picker keeps its Tab stop and shares menu activation, placement and dismissal', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => {
		window.ashChatInputIntegration.showModels();
		document.querySelector<HTMLElement>('main')!.style.marginTop = '300px';
	});
	const mode = page.locator('.ash-chat-input-mode-action');
	const model = page.locator('.ash-chat-input-model-action');
	const menu = page.locator('.ash-chat-input-mode-menu');
	await expect(mode).toHaveAttribute('tabindex', '0');
	await mode.focus();
	await page.keyboard.press('Tab');
	await expect(model).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(mode).toBeFocused();
	await mode.hover();
	await page.mouse.down();
	await expect(menu).toBeVisible();
	await page.mouse.up();
	await expect(menu).toBeVisible();
	const trigger = (await mode.boundingBox())!;
	const popup = (await menu.boundingBox())!;
	expect(popup.y + popup.height).toBeLessThanOrEqual(trigger.y);
	await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
	await page.keyboard.press('Escape');
	await expect(mode).toBeFocused();
	await expect(mode).toHaveAttribute('aria-expanded', 'false');
	for (const key of ['Enter', 'Space']) {
		await page.keyboard.down(key);
		await expect(menu).toBeVisible();
		await page.keyboard.up(key);
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(mode).toBeFocused();
	}
	await mode.press('ArrowDown');
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
	await expect(menu).toBeHidden();
});

for (const surface of ['chat', 'cowork']) {
	test(`Picker focus rings follow keyboard and pointer input in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const model = page.locator('.ash-chat-input-model-action');
		const options = page.locator('.ash-chat-input-configuration-action');
		await model.focus();
		await page.keyboard.press('Tab');
		await expect(options).toBeFocused();
		await expect(options).toHaveCSS('outline-style', 'solid');
		await options.press('Enter');
		await page.keyboard.press('Escape');
		await expect(options).toBeFocused();
		await expect(options).toHaveCSS('outline-style', 'solid');
		await page.mouse.click(0, 0);
		await options.focus();
		await expect(options).toHaveCSS('outline-style', 'none');
		await page.keyboard.press('Shift+Tab');
		await expect(model).toBeFocused();
		await expect(model).toHaveCSS('outline-style', 'solid');
	});

	test(`model picker preserves width, Auto state and popup ownership in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}&modelSet=multiple`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-model-action');
		await trigger.press('ArrowDown');
		const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
		const search = picker.getByRole('combobox');
		const width = await picker.evaluate(element => element.getBoundingClientRect().width);
		expect(width).toBeGreaterThan(320);
		expect(width).toBeLessThanOrEqual(page.viewportSize()!.width * 0.8);
		await search.fill('test-model');
		await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
		await expect(picker.getByRole('menuitemradio')).toHaveText('Test Model');
		expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
		await search.press('ArrowRight');
		const card = picker.getByRole('region', { name: 'Test Model', exact: true });
		await expect(card).toBeFocused();
		await expect(card).toHaveAttribute('aria-description', 'A model for everyday tasks');
		await expect(search).toHaveValue('test-model');
		expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
		await card.press('Alt+ArrowLeft');
		await expect(search).toBeFocused();
		await search.fill('extended-model');
		await search.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(trigger).toHaveText('Extended model with a longer display name for coding');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(picker.getByRole('menuitemradio', { name: 'Extended model with a longer display name for coding', exact: true })).toBeChecked();
		const auto = picker.getByRole('switch', { name: 'Auto', exact: true });
		await auto.press('Space');
		await expect(auto).toBeChecked();
		await expect(auto).toBeFocused();
		await expect(search).toBeHidden();
		await expect(picker.getByRole('menuitemradio')).toHaveCount(0);
		await expect(picker.getByRole('menuitem', { name: 'Add Models' })).toHaveCount(0);
		await auto.press('ControlOrMeta+f');
		await expect(auto).toBeFocused();
		await auto.press('Space');
		await expect(auto).not.toBeChecked();
		await expect(auto).toBeFocused();
		await expect(search).toBeVisible();
		await expect(picker.getByRole('menuitemradio')).toHaveCount(2);
		await page.locator('.ash-chat-input-configuration-action').click();
		await expect(picker).toHaveCount(0);
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await trigger.click();
		await expect(picker).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await expect(page.locator('.ash-action-widget')).toHaveCount(0);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`model card refreshes provider descriptions without writing preferences in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&acceleration=multiple`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const initial = await page.evaluate(() => window.ashChatInputIntegration.modelState());
		await page.locator('.ash-chat-input-model-action').press('ArrowDown');
		const search = page.getByRole('combobox');
		await search.press('ArrowRight');
		const card = page.locator('.ash-chat-model-card');
		await expect(card).toBeFocused();
		await page.evaluate(() => window.ashChatInputIntegration.setDescription('Updated provider description'));
		await expect(card).toHaveText('Updated provider description');
		await expect(card).toHaveAttribute('aria-description', 'Updated provider description');
		await expect(card).toBeFocused();
		expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(initial);
		await page.evaluate(() => window.ashChatInputIntegration.setDescription(null));
		await expect(page.locator('.ash-chat-model-picker-details-menu')).toBeHidden();
		await expect(search).toBeFocused();
		await page.evaluate(() => window.ashChatInputIntegration.setDescription('Restored provider description'));
		await search.press('ArrowRight');
		await expect(card).toHaveText('Restored provider description');
		await expect(card).toBeFocused();
		expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(initial);
		await card.press('Escape');
		await expect(page.locator('.ash-chat-model-picker')).toHaveCount(0);
	});
}


for (const locale of ['en', 'zh-CN']) {
	test(`model card removes retired catalog entries without changing selection in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const initial = await page.evaluate(() => window.ashChatInputIntegration.modelState());
		await page.locator('.ash-chat-input-model-action').press('ArrowDown');
		const search = page.getByRole('combobox');
		await search.press('ArrowRight');
		await expect(page.locator('.ash-chat-model-card')).toBeFocused();
		await page.evaluate(() => window.ashChatInputIntegration.setModelsAvailable(false));
		await expect(page.locator('.ash-chat-model-picker-details-menu')).toBeHidden();
		await expect(page.getByRole('menuitemradio')).toHaveCount(0);
		await expect(search).toBeFocused();
		expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ selectedModel: { provider: 'openai', model: 'test-model' }, automatic: false, preferenceWrites: [] });
		await page.evaluate(() => window.ashChatInputIntegration.setModelsAvailable(true));
		await search.press('ArrowRight');
		await expect(page.locator('.ash-chat-model-card')).toBeFocused();
		expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(initial);
	});
}


for (const surface of ['chat', 'cowork']) {
	test(`Split picker activates on mouse down and keyboard press without a second activation in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const control = page.locator('.ash-chat-model-picker-control');
		await expect(control).toHaveAttribute('role', 'group');
		await expect(control.locator(':scope > a[role="button"]')).toHaveCount(2);
		await page.evaluate(() => window.ashChatInputIntegration.openModels());
		await expect(page.getByRole('dialog', { name: 'Choose a chat model' })).toBeVisible();
		await page.keyboard.press('Escape');
		for (const { trigger, popup } of [
			{ trigger: control.locator('.ash-chat-input-model-action'), popup: page.getByRole('dialog', { name: 'Choose a chat model' }) },
			{ trigger: control.locator('.ash-chat-input-configuration-action'), popup: page.getByRole('menu', { name: 'Model options', exact: true }) },
		]) {
			await trigger.hover();
			await page.mouse.down({ button: 'right' });
			await expect(popup).toBeHidden();
			await page.mouse.up({ button: 'right' });
			await page.mouse.down();
			await expect(popup).toBeVisible();
			await page.mouse.up();
			await expect(popup).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(trigger).toBeFocused();
			for (const key of ['Enter', 'Space']) {
				await page.keyboard.down(key);
				await expect(popup).toBeVisible();
				await page.keyboard.up(key);
				await expect(popup).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
			}
		}
	});

	test(`Split picker handles touch and pen taps and rejects drags and cancelled touches in ${surface}`, async ({ browser, baseURL }) => {
		const context = await browser.newContext({ baseURL, hasTouch: true });
		try {
			const page = await context.newPage();
			await page.goto(`/chatInput.html?surface=${surface}&gestureAncestor=1`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const control = page.locator('.ash-chat-model-picker-control');
			const model = control.locator('.ash-chat-input-model-action');
			const options = control.locator('.ash-chat-input-configuration-action');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
			const menu = page.getByRole('menu', { name: 'Model options', exact: true });
			const triggers = [{ trigger: model, popup: picker }, { trigger: options, popup: menu }];
			if (surface === 'chat') { triggers.push({ trigger: page.locator('.ash-chat-input-mode-action'), popup: page.locator('.ash-chat-input-mode-menu') }); }
			for (const { trigger, popup } of triggers) {
				await trigger.tap();
				await expect(popup).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
			}
			await expect(page.locator('output[aria-label="Decision"]')).toBeEmpty();
			const bounds = (await model.boundingBox())!;
			const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
			const input = await context.newCDPSession(page);
			await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + 30 }] });
			await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
			await expect(picker).toBeHidden();
			await model.tap();
			await expect(picker).toBeVisible();
			await page.keyboard.press('Escape');
			await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, pointerType: 'pen' });
			await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, pointerType: 'pen', button: 'left', clickCount: 1 });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, pointerType: 'pen', button: 'left', clickCount: 1 });
			await expect(picker).toBeVisible();
			await input.detach();
		} finally {
			await context.close();
		}
	});

	test(`Model widget highlights only the hovered trigger in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const control = page.locator('.ash-chat-model-picker-control');
		const model = control.locator('.ash-chat-input-model-action');
		const options = control.locator('.ash-chat-input-configuration-action');
		await page.mouse.move(0, 0);
		await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		for (const background of ['rgb(45, 45, 45)', 'rgb(225, 225, 225)', 'rgb(255, 255, 0)']) {
			await control.evaluate((element, value) => element.style.setProperty('--ash-toolbar-hoverBackground', value), background);
			await model.hover();
			await expect(model).toHaveCSS('background-color', background);
			await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await options.hover();
			await expect(options).toHaveCSS('background-color', background);
			await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const modelBounds = (await model.boundingBox())!;
			const optionsBounds = (await options.boundingBox())!;
			expect(optionsBounds.x - modelBounds.x - modelBounds.width).toBeGreaterThan(0);
			await page.mouse.move((modelBounds.x + modelBounds.width + optionsBounds.x) / 2, modelBounds.y + modelBounds.height / 2);
			await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.mouse.move(0, 0);
			await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
	});

	test(`Both model triggers retain independent Tab stops and toolbar navigation in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}&modelSet=multiple`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const control = page.locator('.ash-chat-model-picker-control');
		const model = control.locator('.ash-chat-input-model-action');
		const options = control.locator('.ash-chat-input-configuration-action');
		const retainedModel = await model.elementHandle();
		const retainedOptions = await options.elementHandle();
		await expect(control.getByRole('button')).toHaveCount(2);
		await expect(model).toHaveAttribute('tabindex', '0');
		await expect(options).toHaveAttribute('tabindex', '0');
		await model.focus();
		await page.keyboard.press('Tab');
		await expect(options).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(model).toBeFocused();
		await model.press('ArrowRight');
		await expect(options).toBeFocused();
		await expect(options).toHaveAttribute('tabindex', '0');
		await expect(model).toHaveAttribute('tabindex', '0');
		await expect(options).toHaveAccessibleName('Model options: Low');
		await options.press('ArrowDown');
		await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
		await expect(options).toHaveText('High');
		await expect(options).toBeFocused();
		expect(await options.evaluate((current, retained) => current === retained, retainedOptions)).toBe(true);
		expect(await model.evaluate((current, retained) => current === retained, retainedModel)).toBe(true);
		await options.press('ArrowLeft');
		await expect(model).toBeFocused();
		await expect(model).toHaveAttribute('tabindex', '0');
		await expect(options).toHaveAttribute('tabindex', '0');
		await model.press('ArrowDown');
		const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
		await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
		await expect(options).toBeHidden();
		await expect(options).toHaveAttribute('tabindex', '-1');
		await page.keyboard.press('Escape');
		await expect(model).toBeFocused();
		await model.press('ArrowDown');
		await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
		await page.keyboard.press('Escape');
		await expect(options).toBeVisible();
		await expect(options).toHaveAttribute('tabindex', '0');
		await page.setViewportSize({ width: 280, height: 600 });
		const geometry = await control.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, right: element.getBoundingClientRect().right }));
		expect(geometry.overflow).toBe(0);
		expect(geometry.right).toBeLessThanOrEqual(280);
		await retainedModel?.dispose();
		await retainedOptions?.dispose();
	});

}

for (const locale of ['en', 'zh-CN']) {
	test(`retirement announcements update the open model menu and remain selectable in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-model-action');
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-model-picker');
		const row = menu.getByRole('menuitemradio', { name: 'Test Model', exact: true });
		await expect(row.locator('.ash-menu-badge')).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.setRetirement({}));
		const announced = locale === 'zh-CN' ? '即将退役' : 'Retiring soon';
		await expect(row.locator('.ash-menu-badge')).toHaveText(announced);
		await expect(row).toHaveAttribute('aria-description', new RegExp(announced));
		await page.evaluate(() => window.ashChatInputIntegration.setRetirement({ shutdownDate: '2027-01-31' }));
		const scheduled = locale === 'zh-CN' ? '将于 2027-01-31 退役' : 'Retires on 2027-01-31';
		await expect(row.locator('.ash-menu-badge')).toHaveText(scheduled);
		expect(await row.locator('.ash-menu-badge').evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(28);
		await expect(row).toHaveAttribute('aria-description', new RegExp(scheduled));
		await page.setViewportSize({ width: 280, height: 600 });
		expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		const search = menu.getByRole('combobox');
		await search.fill('2027-01-31');
		await expect(row).toBeVisible();
		await search.fill('');
		await page.evaluate(() => window.ashChatInputIntegration.setRetirement(undefined));
		await expect(row.locator('.ash-menu-badge')).toHaveCount(0);
		await expect(row).not.toHaveAttribute('aria-description', /2027-01-31/);
		await page.evaluate(() => window.ashChatInputIntegration.setRetirement({ shutdownDate: '2027-01-31' }));
		await search.press('ArrowDown');
		await expect(row).toBeFocused();
		expect(await row.evaluate(element => getComputedStyle(element.querySelector('.ash-menu-badge')!).color === getComputedStyle(element).color)).toBe(true);
		await row.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});
}

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		for (const surface of ['code', 'cowork']) {
			test(`Chat changes button shows statistics above the input in ${locale} ${theme} ${surface}`, async ({ page }) => {
				await page.goto(`/chatInput.html?locale=${locale}&theme=${theme}&surface=${surface}`);
				await page.evaluate(() => window.ashChatInputIntegration.showModels());
				const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
				await input.fill('Keep my draft');
				const changes = page.locator('.ash-chat-changes-pill');
				await expect(changes).toBeHidden();
				await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 3, additions: 677, deletions: 31 }));
				await expect(changes).toBeVisible();
				await expect(changes).toHaveText(locale === 'en' ? '3 files+677−31' : '3 个文件+677−31');
				await expect(changes).toHaveAccessibleName(locale === 'en' ? 'Open Conversation Changes: 3 files, 677 lines added, 31 lines removed' : '打开会话变更：3 个文件，新增 677 行，删除 31 行');
				for (const width of [240, 450]) {
					await page.locator('main').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
					const button = (await changes.boundingBox())!;
					const composer = (await page.locator('.ash-chat-input-container').boundingBox())!;
					expect(button.y + button.height).toBeLessThanOrEqual(composer.y);
					expect(button.x + button.width).toBeLessThanOrEqual(composer.x + composer.width);
				}
				if (locale === 'en' && theme === 'light' && surface === 'code') {
					await page.locator('main').screenshot({ path: test.info().outputPath('chat-changes-button.png') });
				}
				await changes.focus();
				await page.keyboard.press('Enter');
				await expect(page.getByLabel('Opened sources')).toHaveText('[{"changes":true}]');
				await expect(input).toHaveValue('Keep my draft');
				await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 1, additions: 2, deletions: 0 }));
				await expect(changes).toHaveText(locale === 'en' ? '1 file+2−0' : '1 个文件+2−0');
				await expect(changes).toBeFocused();
				await page.keyboard.press('Space');
				await expect(page.getByLabel('Opened sources')).toHaveText('[{"changes":true},{"changes":true}]');
				await page.evaluate(() => window.ashChatInputIntegration.setChanges(undefined));
				await expect(changes).toBeHidden();
				await expect(input).toBeFocused();
				await expect(input).toHaveValue('Keep my draft');
			});
		}
	}
}


for (const locale of ['en', 'zh-CN']) {
	test(`File paste waits for preparation and preserves a newer draft in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('Original pasted request');
		const prevented = await input.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Pasted file contents'], 'pasted.txt', { type: 'text/plain' }));
			const prevented = !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			(element as HTMLTextAreaElement).value = 'Next draft';
			element.dispatchEvent(new Event('input', { bubbles: true }));
			return prevented;
		});
		expect(prevented).toBe(true);
		await expect(input).toHaveValue('Next draft pasted.txt ');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText('');
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [] });
		await input.press('Enter');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'pasted.txt', content: 'Pasted file contents' }]));
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'Next draft pasted.txt ' }] });
	});

	test(`Pending file-only mouse Send waits for the real reader in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-textarea-input');
		const send = page.locator('[data-action-id="ash.chat.input.send"] button');
		await expect(input).toHaveValue('');
		const prevented = await input.evaluate(element => {
			const Reader = globalThis.FileReader;
			const reads: (() => void)[] = [];
			globalThis.FileReader = class extends Reader {
				override readAsArrayBuffer(blob: Blob): void { reads.push(() => super.readAsArrayBuffer(blob)); }
			};
			(window as Window & { ashInputReadTest?: { release(): void; restore(): void; count(): number; }; }).ashInputReadTest = {
				release: () => { for (const read of reads.splice(0)) read(); },
				count: () => reads.length,
				restore: () => { globalThis.FileReader = Reader; },
			};
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Actual held reader contents'], 'held-mouse.txt', { type: 'text/plain' }));
			const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		});
		try {
			expect(prevented).toBe(true);
			await expect.poll(() => page.evaluate(() => (window as Window & { ashInputReadTest?: { count(): number; }; }).ashInputReadTest!.count())).toBe(1);
			await expect(send).toBeVisible();
			await expect(send).toBeEnabled();
			await expect(page.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
			await page.locator('main').screenshot({ path: test.info().outputPath(`pending-mouse-send-${locale}.png`) });
			await send.click();
			await expect(send).toBeDisabled();
			expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [] });
			await page.evaluate(() => (window as Window & { ashInputReadTest?: { release(): void; }; }).ashInputReadTest!.release());
			await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'held-mouse.txt', content: 'Actual held reader contents' }]));
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'held-mouse.txt ' }] });
			await expect(input).toHaveValue('');
		} finally {
			await page.evaluate(() => {
				const owner = window as Window & { ashInputReadTest?: { restore(): void; }; };
				owner.ashInputReadTest?.restore(); delete owner.ashInputReadTest;
			});
		}
	});

	test(`Invalid pasted context blocks sending and keeps the draft in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('Keep this draft');
		await input.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array([0xff])], 'invalid.bin'));
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		});
		await expect(page.getByLabel('Context error', { exact: true })).toContainText('invalid.bin');
		await expect(input).toHaveValue('Keep this draft');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText('');
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [] });
	});

	test(`Failed input restores its original Skill binding and cursor in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1&sendFailure=1`);
		await page.evaluate(() => { window.ashChatInputIntegration.showModels(); window.ashChatInputIntegration.setHistorySkill('original'); });
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('$commit review');
		await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 7, 'backward'));
		await input.press('Enter');
		await expect(input).toHaveValue('$commit review');
		await expect.poll(() => input.evaluate(element => { const input = element as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection]; })).toEqual([2, 7, 'backward']);
		await page.evaluate(() => window.ashChatInputIntegration.setHistorySkill('updated'));
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
			submissions: [
				{ skills: [{ version: { type: 'pinnedDigest', digest: 'original' } }] },
				{ skills: [{ version: { type: 'pinnedDigest', digest: 'original' } }] },
			]
		});
	});
}

for (const locale of ['en', 'zh-CN']) {
	for (const method of ['paste', 'drop'] as const) {
		test(`Mixed ${method} inserts code and images at the message cursor in ${locale}`, async ({ page }, testInfo) => {
			await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}&history=1&sendFailure=1`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
			await input.focus();
			await page.keyboard.type('Review  please');
			await input.press('Home');
			for (let index = 0; index < 7; index++) await input.press('ArrowRight');
			const prevented = await input.evaluate((element, method) => {
				const transfer = new DataTransfer();
				transfer.items.add(new File(['const captured = 42;'], 'sample.ts', { type: 'text/plain' }));
				const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0));
				transfer.items.add(new File([bytes], 'preview.png', { type: 'image/png' }));
				const event = method === 'paste'
					? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
					: new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
				element.dispatchEvent(event);
				return event.defaultPrevented;
			}, method);
			expect(prevented).toBe(true);
			const reference = page.locator('.ash-chat-code-reference');
			await expect(reference).toHaveText('sample.ts');
			const bar = page.locator('.ash-chat-input-attachments');
			await expect(bar).toHaveCount(0);
			const thumbnail = page.locator('.ash-chat-image-reference-control').getByRole('img', { name: 'preview.png' });
			await expect(thumbnail).toBeVisible();
			await expect(input).toBeFocused();
			const accessibility = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			expect(accessibility.help).toContain(locale === 'en' ? 'Activate the thumbnail or file name to preview the image' : '点击缩略图或文件名可预览图片');
			await page.getByRole('button', { name: locale === 'en' ? 'Preview preview.png' : '预览 preview.png', exact: true }).click();
			await expect(page.getByRole('dialog').getByRole('img', { name: 'preview.png' })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await page.getByRole('button', { name: locale === 'en' ? 'Remove preview.png' : '移除 preview.png', exact: true }).click();
			await expect(thumbnail).toHaveCount(0);
			await expect(reference).toHaveText('sample.ts');
			await input.press('ControlOrMeta+z');
			await expect(thumbnail).toBeVisible();
			expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('Review sample.ts preview.png please');
			await expect(reference).toHaveText('sample.ts');
			await page.locator('main').screenshot({ path: testInfo.outputPath('mixed-file-context.png') });
			await input.press('Enter');
			await expect(page.getByLabel('Submission', { exact: true })).toContainText('const captured = 42;');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'Review sample.ts preview.png please' }] });
			const submitted = JSON.parse((await page.getByLabel('Submission', { exact: true }).textContent())!);
			expect(submitted).toEqual([
				{ name: 'sample.ts', content: 'const captured = 42;' },
				expect.objectContaining({ name: 'preview.png', kind: 'image' }),
			]);
			await expect(reference).toHaveText('sample.ts');
			await expect(thumbnail).toBeVisible();
			await expect(bar).toHaveCount(0);
		});
	}
}

for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
	test(`Inline image controls follow wrapped names and support keyboard preview and deletion in ${theme}`, async ({ page }, testInfo) => {
		await page.goto(`/chatInput.html?inlineCode=1&locale=zh-CN&theme=${theme}`);
		await page.setViewportSize({ width: 400, height: 640 });
		await page.locator('main').evaluate(element => { element.style.width = '320px'; });
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
		await input.focus();
		await page.keyboard.insertText('对比图片：\n当前界面：\n参考设计：');
		await input.press('Home');
		await input.press('ArrowUp');
		await input.press('End');
		const name = 'current-layout-reference-with-a-long-file-name.png';
		await input.evaluate((element, name) => {
			const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#e3edff'; context.fillRect(0, 0, 320, 180);
			context.fillStyle = '#2c5b9c'; context.font = '24px sans-serif'; context.fillText('Current layout', 24, 52);
			context.fillStyle = '#ffffff'; context.fillRect(24, 76, 272, 80);
			const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), char => char.charCodeAt(0));
			const transfer = new DataTransfer(); transfer.items.add(new File([bytes], name, { type: 'image/png' }));
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, name);
		const labels = page.locator('.ash-chat-image-reference:not(.ash-chat-image-reference-space)');
		await expect.poll(async () => (await labels.allTextContents()).join('')).toBe(name);
		const preview = page.getByRole('button', { name: `预览 ${name}`, exact: true });
		const remove = page.getByRole('button', { name: `移除 ${name}`, exact: true });
		await expect(preview).toBeVisible();
		await expect(remove).toBeVisible();
		const placement = await page.locator('.ash-chat-input-editor').evaluate(element => {
			const labels = [...element.querySelectorAll('.ash-chat-image-reference:not(.ash-chat-image-reference-space)')];
			const controls = [...element.querySelectorAll('.ash-chat-image-reference-control')];
			const bounds = element.getBoundingClientRect();
			return { overflow: element.scrollWidth > element.clientWidth, clipped: labels.some(label => label.getBoundingClientRect().right > bounds.right + 1), firstLabel: labels[0]!.getBoundingClientRect().toJSON(), lastLabel: labels.at(-1)!.getBoundingClientRect().toJSON(), before: controls[0]!.getBoundingClientRect().toJSON(), after: controls[1]!.getBoundingClientRect().toJSON() };
		});
		expect(placement.overflow).toBe(false);
		expect(placement.clipped).toBe(false);
		expect(placement.before.right).toBeLessThanOrEqual(placement.firstLabel.left + 1);
		expect(placement.after.left).toBeGreaterThanOrEqual(placement.lastLabel.right - 1);
		await page.locator('main').screenshot({ path: testInfo.outputPath('inline-image-wrapped.png') });
		await input.press('Tab');
		await expect(preview).toBeFocused();
		await preview.press('Enter');
		const dialog = page.getByRole('dialog', { name: `预览 ${name}` });
		await expect(dialog.getByRole('img', { name })).toBeVisible();
		const accessiblePreview = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
		expect(accessiblePreview.content).toContain(`图片预览：${name}`);
		expect(accessiblePreview.content).toContain('尺寸：320 × 180');
		await page.screenshot({ path: testInfo.outputPath('inline-image-preview.png') });
		await page.keyboard.press('Escape');
		await expect(preview).toBeFocused();
		await preview.press('Tab');
		await expect(remove).toBeFocused();
		await remove.press('Enter');
		await expect(preview).toHaveCount(0);
		await expect(input).toBeFocused();
		await input.press('ControlOrMeta+z');
		await expect(preview).toBeVisible();
		expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toContain(`当前界面： ${name}`);
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await labels.first().click();
		await expect(dialog).toBeVisible();
		await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
		await expect(dialog).toHaveCount(0);
	});
}

for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
	test(`File drop feedback stays inside the shared composer in ${theme}`, async ({ page }) => {
		await page.goto(`/chatInput.html?theme=${theme}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const composer = page.locator('.ash-chat-input-container');
		const before = await composer.boundingBox();
		await composer.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Dropped contents'], 'dropped.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		});
		const overlay = composer.locator('.ash-chat-drop-overlay');
		await expect(overlay).toBeVisible();
		await expect(overlay).toHaveCSS('pointer-events', 'none');
		await expect(overlay).toHaveCSS('position', 'absolute');
		expect(await composer.boundingBox()).toEqual(before);
		const bounds = await overlay.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(before!.x);
		expect(bounds!.y).toBeGreaterThanOrEqual(before!.y);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(before!.x + before!.width);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(before!.y + before!.height);
		await composer.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Dropped contents'], 'dropped.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		});
		await expect(overlay).toBeHidden();
		await expect(page.locator('.ash-chat-textarea-input')).toHaveValue('dropped.txt ');
		await expect(composer.getByRole('listitem')).toHaveCount(0);
		await page.locator('.ash-chat-textarea-input').press('Enter');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'dropped.txt', content: 'Dropped contents' }]));
	});
}


for (const locale of ['en', 'zh-CN']) {
	test(`Input accessibility help describes pending file preparation in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.locator('.ash-chat-textarea-input').focus();
		const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
		expect(help).toContain(locale === 'en' ? 'Sending waits until file preparation finishes; a failed preparation keeps the draft.' : '发送会等待文件准备完成；准备失败时会保留草稿。');
	});
}


for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`permission subsets use keyboard controls in ${locale} ${theme}`, async ({ page }) => {
			await page.goto(`/chatInput.html?permissions=1&locale=${locale}&theme=${theme}`);
			const chinese = locale === 'zh-CN';
			const read = page.getByRole('checkbox', { name: chinese ? '读取文件' : 'Read files', exact: true });
			const write = page.getByRole('checkbox', { name: chinese ? '写入文件' : 'Write files', exact: true });
			await expect(read).not.toBeChecked();
			await expect(write).not.toBeChecked();
			await read.focus();
			await page.keyboard.press('Space');
			await expect(read).toBeChecked();
			await page.evaluate(() => window.ashChatInputIntegration.refresh());
			await expect(read).toBeFocused();
			const duration = page.getByRole('combobox', { name: chinese ? '权限有效期' : 'Permission duration', exact: true });
			await expect(duration).toHaveValue('turn');
			await page.getByRole('button', { name: chinese ? '批准所选权限' : 'Approve selected', exact: true }).press('Enter');
			await expect(page.getByRole('status', { name: 'Decision' })).toHaveText(JSON.stringify({ duration: 'turn', directories: [{ path: '/workspace/<img src=x>', permissions: ['readFiles'] }], networkHosts: [] }));
			await expect(page.locator('.ash-chat-interaction img')).toHaveCount(0);
			await page.getByRole('button', { name: chinese ? '拒绝' : 'Decline', exact: true }).press('Space');
			await expect(page.getByRole('status', { name: 'Decision' })).toHaveText(JSON.stringify({ duration: 'turn', directories: [], networkHosts: [] }));
		});
	}
}

for (const surface of ['code', 'cowork']) {
	test(`Chat changes scope fences workspace responses and hidden polling in ${surface}`, async ({ page }) => {
		await page.clock.install();
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => { window.ashChatInputIntegration.showModels(); window.ashChatInputIntegration.setChangesScope('workspace'); });
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.workspaceChangesReads())).toBe(1);
		await page.evaluate(() => { window.ashChatInputIntegration.setChangesScope('conversation'); window.ashChatInputIntegration.releaseWorkspaceChanges({ files: 99, additions: 99, deletions: 99 }); });
		const changes = page.locator('.ash-chat-changes-pill');
		await expect(changes).toBeHidden();
		await page.evaluate(() => window.ashChatInputIntegration.setChangesScope('workspace'));
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.workspaceChangesReads())).toBe(2);
		await page.evaluate(() => window.ashChatInputIntegration.releaseWorkspaceChanges({ files: 2, additions: 3, deletions: 1 }));
		await expect(changes).toHaveAccessibleName('Open Workspace Changes: 2 files, 3 lines added, 1 lines removed');
		await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
		await page.clock.runFor(15000);
		expect(await page.evaluate(() => window.ashChatInputIntegration.workspaceChangesReads())).toBe(2);
		await page.evaluate(() => { window.ashChatInputIntegration.setVisible(true); window.ashChatInputIntegration.setChangesScope('conversation'); window.ashChatInputIntegration.setChanges({ files: 0, additions: 0, deletions: 0 }); });
		await expect(changes).toBeHidden();
		await page.evaluate(() => window.ashChatInputIntegration.setChangesError('Changes are unavailable. Open Changes to retry.'));
		await expect(changes).toHaveText('Changes unavailable');
		await changes.click();
		await expect(page.getByLabel('Opened sources')).toHaveText('[{"changes":true}]');
	});
}
