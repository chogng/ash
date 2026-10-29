import { mainWindow } from '../../../../base/browser/window.js';
import { designTextKeys, type DesignTextMeasurer, type DesignTextShape } from '../common/model/designText.js';
import { renderDesignText } from './designTextRendering.js';

const measurements = new Map<string, { width: number; height: number; }>();
export function clearDesignTextMeasurements(): void { measurements.clear(); }
/** Browser font shaping and line breaking, including fallback fonts, determine document geometry. */
export const measureDesignText: DesignTextMeasurer = (shape, width) => {
	const key = JSON.stringify([shape.text, width, ...designTextKeys.map(key => shape[key])]);
	const cached = measurements.get(key); if (cached) { return cached; }
	const element = renderDesignText(mainWindow.document, { ...shape, textTruncate: !!shape.textTruncate && !!shape.maxLines });
	Object.assign(element.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none', width: width === undefined ? 'max-content' : `${width}px` });
	element.setAttribute('aria-hidden', 'true');
	mainWindow.document.body.append(element);
	try {
		const bounds = element.getBoundingClientRect();
		// DOM-less tests supply no layout engine. Production always takes measured font metrics.
		if (!bounds.height) { return fallbackMeasurement(shape, width); }
		const result = { width: Math.max(0.001, bounds.width), height: Math.max(0.001, bounds.height) };
		if (measurements.size > 256) { measurements.clear(); }
		if (mainWindow.document.fonts?.status !== 'loading') { measurements.set(key, result); }
		return result;
	} finally { element.remove(); }
};
function fallbackMeasurement(shape: DesignTextShape, width: number | undefined): { width: number; height: number; } {
	const lines = shape.text.split('\n');
	const lineHeight = shape.lineHeight === undefined ? shape.fontSize * 1.2 : shape.lineHeightUnit === 'percent' ? shape.fontSize * shape.lineHeight / 100 : shape.lineHeight;
	const widths = lines.map(line => [...line].length * (shape.fontSize * 0.6 + (shape.letterSpacing ?? 0)));
	return { width: width ?? Math.max(shape.fontSize * 0.1, ...widths), height: widths.reduce((sum, value) => sum + Math.max(1, width ? Math.ceil(value / width) : 1) * lineHeight, 0) + (lines.length - 1) * (shape.paragraphSpacing ?? 0) };
}
