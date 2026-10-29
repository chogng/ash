import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

/** Chromium's native drag protocol keeps Electron icon drags observable across window reloads. */
async function dragElectronView(page: Page, source: Locator, target: Locator, position: { x: number; y: number }): Promise<void> {
	await expect(source).toBeVisible();
	await expect(target).toBeVisible();
	const from = (await source.boundingBox())!;
	const to = (await target.boundingBox())!;
	const x = from.x + from.width / 2;
	const y = from.y + from.height / 2;
	const destination = { x: to.x + position.x, y: to.y + position.y };
	const session = await page.context().newCDPSession(page);
	type DragData = {
		items: { mimeType: string; data: string; title?: string; baseURL?: string }[];
		dragOperationsMask: number;
		files?: string[];
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const intercepted = new Promise<DragData>((resolve, reject) => {
		timer = setTimeout(() => reject(new Error('Native view drag did not start')), 10000);
		session.once('Input.dragIntercepted', event => resolve(event.data));
	});
	try {
		await session.send('Input.setInterceptDrags', { enabled: true });
		await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
		await session.send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x,
			y,
			button: 'left',
			buttons: 1,
			clickCount: 1,
		});
		await session.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: x - 20,
			y: y + 20,
			button: 'left',
			buttons: 1,
		});
		const data = await intercepted;
		for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
			await session.send('Input.dispatchDragEvent', { type, ...destination, data });
		}
		await session.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			...destination,
			button: 'left',
			buttons: 0,
			clickCount: 1,
		});
	} finally {
		clearTimeout(timer);
		await session.send('Input.setInterceptDrags', { enabled: false });
		await session.detach();
	}
}

test('individual views detach, merge, persist across reload and restore their defaults', async ({ workbench, application, reloadWorkbench, target }) => {
	let page = workbench.page;
	const dragView = (source: Locator, destination: Locator, position: { x: number; y: number }) =>
		target.kind === 'electron' ? dragElectronView(page, source, destination, position) : source.dragTo(destination, { targetPosition: position });
	const timeline = () => page.locator('[data-part="sidebar"] [data-view-id="timeline"]');
	const right = () => page.locator('[data-part="auxiliarybar"]');
	await page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Explorer', exact: true }).click();
	if (await right().isHidden()) await workbench.quickaccess.runCommand('workbench.action.toggleAuxiliaryBar');
	const header = timeline().locator('.ash-pane-view-header');
	await expect(header.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute('aria-description', /Move View/u);
	const rail = () => page.locator('[data-part="activitybar"]');
	await dragView(header, rail(), { x: 20, y: 420 });
	const primary = page.locator('[data-part="sidebar"] [data-view-container-id^="workbench.views.service."]');
	await expect(primary.locator('[data-view-id="timeline"]')).toBeVisible();
	const primaryId = (await primary.getAttribute('data-view-container-id'))!;
	await dragView(rail().locator(`[data-action-id="${primaryId}"]`), right().locator('.ash-pane-composite-title').first(), { x: 180, y: 12 });
	const standalone = right().locator('[data-view-container-id^="workbench.views.service."]');
	await expect(standalone.locator('[data-view-id="timeline"]')).toBeVisible();
	const id = (await standalone.getAttribute('data-view-container-id'))!;
	expect(id).toBe(primaryId);
	await expect(timeline()).toHaveCount(0);
	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	const entry = right().locator(`[data-action-id="${id}"]`);
	await expect(entry).toBeVisible();
	await entry.click();
	await expect(right().locator('[data-view-id="timeline"]')).toBeVisible();
	const explorer = page.locator('[data-view-container-id="ash.sidebar"]');
	if (await explorer.isHidden()) await rail().getByRole('tab', { name: 'Explorer', exact: true }).click();
	await dragView(entry, explorer, { x: 100, y: 80 });
	await expect(timeline()).toBeVisible();
	await expect(entry).toHaveCount(0);

	await workbench.quickaccess.runCommand('workbench.action.moveView');
	await workbench.quickaccess.select('Timeline');
	await workbench.quickaccess.select('New Panel Entry');
	const panel = page.locator('[data-part="panel"] [data-view-container-id^="workbench.views.service."]');
	await expect(panel.locator('[data-view-id="timeline"]')).toBeVisible();
	await dragView(page.locator('[data-part="sidebar"] [data-view-id="outline"] .ash-pane-view-header'), panel, {
		x: 150,
		y: 90,
	});
	await expect(panel.locator('[data-view-id="timeline"] .ash-pane-view-header')).toBeVisible();
	await expect(panel.locator('[data-view-id="outline"] .ash-pane-view-header')).toBeVisible();
	await workbench.menus.select(application, () => panel.locator('[data-view-id="outline"] .ash-pane-view-header').getByRole('button', { name: 'Outline', exact: true }).press('Shift+F10'), [
		'Reset Location',
	]);
	await expect(page.locator('[data-part="sidebar"] [data-view-id="outline"]')).toBeVisible();
	await expect(panel.locator('[data-view-id="outline"]')).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.resetViewLocations');
	await expect(timeline()).toBeVisible();
	await expect(page.locator('[data-part="sidebar"] [data-view-id="outline"]')).toBeVisible();
	await expect(page.locator('[data-action-id^="workbench.views.service."]')).toHaveCount(0);
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	await expect(timeline()).toBeVisible();
	await expect(page.locator('[data-action-id^="workbench.views.service."]')).toHaveCount(0);
});
