import type { Page } from '@playwright/test';

export async function compareImages(page: Page, baseline: readonly Buffer[], probe: readonly Buffer[]) {
	if (probe.length !== baseline.length) throw new Error('Every sampled component must retain its screenshot');
	return page.evaluate(async ({ baseline, probe }) => {
		const decode = async (base64: string): Promise<ImageData> => {
			const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
			const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
			try {
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext('2d')!;
				context.drawImage(bitmap, 0, 0);
				return context.getImageData(0, 0, bitmap.width, bitmap.height);
			} finally { bitmap.close(); }
		};
		const differences = [];
		for (let index = 0; index < baseline.length; index++) {
			const before = await decode(baseline[index]);
			const after = await decode(probe[index]);
			const sizeChanged = before.width !== after.width || before.height !== after.height;
			let changedPixels = 0;
			let significantPixels = 0;
			let alphaChangedPixels = 0;
			let maxChannelDelta = 0;
			if (!sizeChanged) {
				for (let offset = 0; offset < before.data.length; offset += 4) {
					let delta = 0;
					for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(before.data[offset + channel] - after.data[offset + channel]));
					if (delta > 0) changedPixels++;
					if (before.data[offset + 3] !== after.data[offset + 3]) alphaChangedPixels++;
					// Repainting unchanged HC edges can differ by 1/255. Keep the raw count
					// in the report; only larger changes contribute to the visual verdict.
					if (delta > 1) significantPixels++;
					maxChannelDelta = Math.max(maxChannelDelta, delta);
				}
			}
			differences.push({ index, sizeChanged, changedPixels, significantPixels, alphaChangedPixels, maxChannelDelta });
		}
		return differences;
	}, { baseline: baseline.map(image => image.toString('base64')), probe: probe.map(image => image.toString('base64')) });
}

/** Keep rasterization noise bounded so a uniform color change cannot pass. */
export function isScreenshotDifferenceStable(difference: Awaited<ReturnType<typeof compareImages>>[number]): boolean {
	return !difference.sizeChanged && difference.significantPixels === 0 && difference.alphaChangedPixels === 0 && difference.changedPixels <= 32;
}
