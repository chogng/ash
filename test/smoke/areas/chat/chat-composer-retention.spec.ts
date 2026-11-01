import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('creating another Chat keeps the existing composer and draft mounted', { tag: ['@browser-ui', '@electron-ui'] }, async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const view = page.locator('.ash-chat-view-pane');
	const composer = view.locator('.ash-chat:visible .ash-chat-input-part');
	const input = composer.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('retained Chat draft');
	await expect(composer.locator('.stanza-editor-line-text')).toHaveText('retained Chat draft');
	const monitor = await composer.evaluateHandle(node => {
		const pane = node.closest<HTMLElement>('.ash-chat')!;
		const removed: Node[] = [];
		const observer = new MutationObserver(records => {
			for (const record of records) removed.push(...record.removedNodes);
		});
		observer.observe(pane.parentElement!, { childList: true });
		return { node, pane, removed, observer };
	});
	try {
		const newChat = page.getByRole('toolbar', { name: 'Chat actions', exact: true })
			.getByRole('button', { name: 'New Chat', exact: true })
			.and(page.locator('button:not([aria-haspopup="menu"])'));
		await newChat.click();
		await expect(view.locator('.ash-chat-pane-host > .ash-chat')).toHaveCount(2);
		const activeComposer = view.locator('.ash-chat:visible .ash-chat-input-part');
		await expect(activeComposer.locator('.stanza-editor-input')).toBeFocused();
		await expect(activeComposer.locator('.stanza-editor-line-text')).toHaveText('');
		expect(await monitor.evaluate(({ node, pane, removed, observer }) => {
			for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
			return {
				connected: pane.isConnected && node.isConnected,
				hidden: pane.hidden,
				removed: removed.some(removedNode => removedNode === pane || removedNode.contains(pane)),
				draft: node.querySelector('.stanza-editor-line-text')?.textContent,
			};
		})).toEqual({ connected: true, hidden: true, removed: false, draft: 'retained Chat draft' });
	} finally {
		if (!page.isClosed()) await monitor.evaluate(({ observer }) => observer.disconnect());
		await monitor.dispose();
	}
});

test('Chat host retains its composer through session-list resizing and editor mounting', { tag: ['@browser-ui', '@electron-ui', '@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench }, testInfo) => {
	const page = workbench.page;
	await driver.setWindowSize({ width: 1800, height: 900 });
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const input = chat.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('Keep this host migration draft');
	const originalInput = await input.elementHandle();
	const originalChatId = await chat.getAttribute('id');
	const body = page.locator('.ash-chat-body');
	const sidebar = body.locator('.ash-chat-sessions-sidebar');
	const toggle = page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button');
	await workbench.quickaccess.runCommand('workbench.action.chat.focusAgentSessionsViewer');
	await expect(sidebar.getByRole('tree', { name: 'Agent sessions', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(sidebar).toBeHidden();
	await expect(input).toBeFocused();
	await toggle.click();
	await expect(sidebar).toBeVisible();
	await expect(body).toHaveClass(/sessions-side-by-side/u);
	await expect.poll(async () => {
		const left = await body.locator('.ash-chat-pane-host').boundingBox();
		const right = await sidebar.boundingBox();
		return !!left && !!right && left.width >= 300 && right.width >= 200 && left.x + left.width <= right.x + 1;
	}).toBe(true);
	const separator = body.getByRole('separator', { name: 'Resize sessions sidebar', exact: true });
	const previousWidth = Number(await separator.getAttribute('aria-valuenow'));
	await separator.focus();
	await separator.press('ArrowRight');
	await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeLessThan(previousWidth);
	await separator.press('Escape');
	await expect(sidebar).toBeHidden();
	await expect(toggle).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.chat.moveToEditor');
	const editorChat = page.locator('.ash-chat-editor .ash-chat:visible');
	await expect(editorChat).toHaveAttribute('id', originalChatId!);
	await expect(editorChat.locator('.stanza-editor-line-text')).toHaveText('Keep this host migration draft');
	expect(await editorChat.locator('.stanza-editor-input').evaluate((element, original) => element === original, originalInput)).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.chat.moveToSideBar');
	await expect(chat).toHaveAttribute('id', originalChatId!);
	await expect(input).toBeFocused();
	await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this host migration draft');
	expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true);
	await testInfo.attach('chat-host-returned-to-sidebar', { body: await page.screenshot(), contentType: 'image/png' });
	await originalInput?.dispose();
});
