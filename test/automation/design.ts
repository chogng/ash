import type { Page } from '@playwright/test';

export async function paintColor(page: Page, value: string): Promise<void> {
	await page.locator('[data-part="auxiliarybar"]').getByRole('button', { name: 'Fill', exact: true }).click();
	const input = page.getByRole('textbox', { name: 'Color value', exact: true });
	await input.fill(value);
	await input.press('Enter');
	await input.press('Escape');
}

export async function paintPixel(page: Page, x: number, y: number): Promise<number[]> {
	const png = await page.screenshot();
	return page.evaluate(async ({ png, x, y }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${png}`;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0);
		return [...context.getImageData(Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio), 1, 1).data];
	}, { png: png.toString('base64'), x, y });
}
