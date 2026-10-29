import { expect, test } from '../../../automation/test.js';

test('creating another Chat keeps the existing composer and draft mounted', { tag: ['@browser-ui', '@electron-ui'] }, async ({ workbench }) => {
	const page = workbench.page;
	if (!(await page.locator('.ash-chat-view-pane').isVisible())) {
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
		await page.getByRole('toolbar', { name: 'Chat actions', exact: true }).getByRole('button', { name: 'New Chat', exact: true }).click();
		await expect(view.locator('.ash-chat-pane-host > .ash-chat')).toHaveCount(2);
		const activeComposer = view.locator('.ash-chat:visible .ash-chat-input-part');
		await expect(activeComposer.locator('.stanza-editor-input')).toBeFocused();
		await expect(activeComposer.locator('.stanza-editor-line-text')).toHaveText('');
		expect(
			await monitor.evaluate(({ node, pane, removed, observer }) => {
				for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
				return {
					connected: pane.isConnected && node.isConnected,
					hidden: pane.hidden,
					removed: removed.some(removedNode => removedNode === pane || removedNode.contains(pane)),
					draft: node.querySelector('.stanza-editor-line-text')?.textContent,
				};
			}),
		).toEqual({ connected: true, hidden: true, removed: false, draft: 'retained Chat draft' });
	} finally {
		if (!page.isClosed()) await monitor.evaluate(({ observer }) => observer.disconnect());
		await monitor.dispose();
	}
});
