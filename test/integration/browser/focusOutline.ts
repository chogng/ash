import { expect, type Locator } from '@playwright/test';

/** Check painted pixels: computed outlines can exist underneath an opaque action bar. */
export async function expectVisibleFocusOutline(row: Locator): Promise<void> {
	const color = await row.evaluate(element => getComputedStyle(element).outlineColor);
	const bounds = (await row.boundingBox())!;
	// Chromium snaps the stroke to device pixels, while screenshots round the clip outward.
	const edges = [Math.round(bounds.y) - Math.floor(bounds.y), Math.round(bounds.y + bounds.height) - 1 - Math.floor(bounds.y)];
	const screenshot = await row.screenshot({ scale: 'css' });
	const missing = await row.page().evaluate(async ({ base64, color, edges }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${base64}`;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext('2d')!;
		context.fillStyle = color;
		context.fillRect(0, 0, 1, 1);
		const expected = context.getImageData(0, 0, 1, 1).data;
		context.drawImage(image, 0, 0);
		let missing = 0;
		// Skip rounded corners; both horizontal edges must remain continuous under actions/fades.
		for (const y of edges) {
			for (let x = 8; x < image.width - 8; x++) {
				const pixel = context.getImageData(x, y, 1, 1).data;
				if (pixel.some((channel, index) => channel !== expected[index])) missing++;
			}
		}
		return missing;
	}, { base64: screenshot.toString('base64'), color, edges });
	expect(missing, 'Focus outline pixels covered by row content').toBe(0);
}
