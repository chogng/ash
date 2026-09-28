import { expect, test } from '../../../automation/test.js';

test('selected Chat tab uses the tab surface instead of list selection blue', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selected = page.locator('.ash-multi-chat-tabs-control .ash-tab.checked');
	await expect(selected.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
	const colors = await selected.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-tab-list-active-background)';
		element.append(reference);
		const active = getComputedStyle(reference).backgroundColor;
		reference.style.background = 'var(--ash-list-active-selection-background)';
		const listSelection = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { tab: getComputedStyle(element).backgroundColor, active, listSelection };
	});
	expect(colors.tab).toBe(colors.active);
	expect(colors.tab).not.toBe(colors.listSelection);
});

test('opening another Chat tab keeps the existing composer mounted', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-part');
	const monitor = await composer.evaluateHandle(node => {
		const removed: Node[] = [];
		const observer = new MutationObserver(records => {
			for (const record of records) removed.push(...record.removedNodes);
		});
		observer.observe(node.closest('.ash-chat-pane-host')!, { childList: true });
		return { node, removed, observer };
	});
	await page.locator('.ash-chat-title-actions [data-action-id="workbench.action.chat.new"] button').click();
	await expect(page.locator('.ash-chat-view-pane .ash-chat-pane-host > .ash-chat')).toHaveCount(2);
	const wasRemoved = await monitor.evaluate(({ node, removed, observer }) => {
		for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
		observer.disconnect();
		return removed.some(removedNode => removedNode === node.parentElement);
	});
	expect(wasRemoved).toBe(false);
});
