import { expect, type Page, type Locator } from '@playwright/test';
import type { PlaywrightApplication } from './playwrightDriver.js';
import { captureElectronMenu } from './menus.js';

export async function paintColor(page: Page, value: string): Promise<void> {
	await page.locator('[data-part="auxiliarybar"]').getByRole('button', { name: 'Fill', exact: true }).click();
	const input = page.getByRole('textbox', { name: 'Color value', exact: true });
	await input.fill(value);
	await input.press('Enter');
	await input.press('Escape');
}

export async function paintPixel(page: Page, x: number, y: number): Promise<number[]> {
	const png = await page.screenshot();
	return page.evaluate(
		async ({ png, x, y }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${png}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext('2d')!;
			context.drawImage(image, 0, 0);
			return [...context.getImageData(Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio), 1, 1).data];
		},
		{ png: png.toString('base64'), x, y },
	);
}

export async function clickCanvasMenu(canvas: Locator, name: string, application?: PlaywrightApplication): Promise<void> {
	const trigger = async (): Promise<void> => {
		await canvas.focus();
		await canvas.press('Shift+F10');
	};
	if (application && 'windows' in application && process.platform === 'darwin') {
		await captureElectronMenu(application, trigger, { label: name });
	} else {
		await trigger();
		await canvas.page().getByRole('menuitem', { name, exact: true }).click();
	}
}

export async function inspectCanvasMenu(canvas: Locator, application?: PlaywrightApplication, pointer = false): Promise<readonly { label: string; enabled: boolean }[]> {
	const trigger = async (): Promise<void> => {
		await canvas.focus();
		if (pointer) await canvas.locator('.ash-canvas-viewport').click({ button: 'right', position: { x: 20, y: 20 } });
		else await canvas.press('Shift+F10');
	};
	if (application && 'windows' in application && process.platform === 'darwin') {
		return (await captureElectronMenu(application, trigger)).map(({ label, enabled }) => ({ label, enabled }));
	}
	await trigger();
	const menu = canvas.page().getByRole('menu');
	await expect(menu).toBeVisible();
	const items = await menu.getByRole('menuitem').evaluateAll(items =>
		items.map(item => ({
			label: item.querySelector('.ash-button-label')!.textContent!,
			enabled: !(item as HTMLButtonElement).disabled,
		})),
	);
	await canvas.page().keyboard.press('Escape');
	return items;
}

export async function drawBezierPath(canvas: Locator): Promise<void> {
	await canvas.press('Escape');
	await canvas.press('p');
	const viewport = canvas.locator('.ash-canvas-viewport'),
		bounds = await viewport.boundingBox();
	await viewport.click({ position: { x: bounds!.width * 0.3, y: bounds!.height * 0.3 } });
	await viewport.click({ position: { x: bounds!.width * 0.5, y: bounds!.height * 0.5 } });
	await canvas.press('Enter');
	await canvas.press('v');
	await canvas.press('Enter');
}

export async function rightClickCanvasShape(shape: Locator): Promise<void> {
	const bounds = await shape.boundingBox();
	expect(bounds).not.toBeNull();
	// The viewport owns pointer input; SVG objects deliberately do not receive it.
	await shape.page().mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2, { button: 'right' });
}
