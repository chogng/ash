import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IPartsSplashPartBounds, IPartsSplashSkeleton } from '../../../../platform/theme/common/themeService.js';

const partSelector = '.ash-workbench-part:is([data-part="sessions"], [data-part="editor"], [data-part="customview"], [data-part="auxiliarybar"])';
const gridSelector = '[data-splash-grid]';
const surfaces = '.ash-chat-input-container, .ash-chat-user-message, .ash-canvas-viewport, canvas, iframe, textarea, [contenteditable="true"]';
const headings = 'h1, h2, h3';
const anchors = `${headings}, ${surfaces}, button, input, summary, [role="tab"], [role="row"], [role="treeitem"], [role="option"], li, p, .view-line`;

export function captureSessionsSkeleton(part: HTMLElement, bounds: IPartsSplashPartBounds): IPartsSplashSkeleton | undefined {
	if (!part.matches(partSelector)) return undefined;
	const ownerWindow = part.ownerDocument.defaultView!;
	const grid = Array.from(part.querySelectorAll(gridSelector)).some(element => element.getBoundingClientRect().width > 0);
	const shapes: IPartsSplashSkeleton['shapes'][number][] = [];
	const candidates = grid ? part.querySelectorAll(`${gridSelector} :is(h1, header button)`) : part.querySelectorAll(anchors);
	for (const node of candidates) {
		if (shapes.length === 32) break;
		if (node.parentElement?.closest(surfaces) || ownerWindow.getComputedStyle(node).visibility !== 'visible') continue;
		const rect = node.getBoundingClientRect();
		const surface = node.matches(surfaces);
		const heading = node.matches(headings);
		const left = Math.max(bounds.left, rect.left);
		const top = Math.max(bounds.top, surface ? rect.top : rect.top + rect.height * 0.2);
		const right = Math.min(bounds.left + bounds.width, rect.right, left + (surface ? rect.width : Math.min(heading ? 240 : 360, rect.width * 0.8)));
		const bottom = Math.min(bounds.top + bounds.height, rect.bottom, top + (surface ? rect.height : Math.min(heading ? 22 : 12, rect.height * 0.6)));
		if (right - left < 8 || bottom - top < 4) continue;
		const shape = {
			left: (left - bounds.left) / bounds.width,
			top: (top - bounds.top) / bounds.height,
			width: (right - left) / bounds.width,
			height: (bottom - top) / bounds.height,
			...(surface ? { surface: true as const } : {}),
		};
		// For overlapping candidates (for example, a row and its label), keep the outer outline.
		if (shapes.some(other => shape.left < other.left + other.width && other.left < shape.left + shape.width
			&& shape.top < other.top + other.height && other.top < shape.top + shape.height)) continue;
		shapes.push(shape);
	}
	return { shapes, ...(grid ? { grid: true } : {}) };
}

export function watchSessionsSplashContent(root: HTMLElement, onChange: () => void): IDisposable {
	const Observer = root.ownerDocument.defaultView?.MutationObserver;
	if (!Observer) return Disposable.None;
	const observer = new Observer(records => {
		if (records.some(record => {
			const target = record.target;
			if (target.nodeType !== 1 || !(target as Element).closest(partSelector)) return false;
			if (record.type === 'attributes') return true;
			// Text changes and streaming tokens do not change which page is open.
			return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
				&& ((node as Element).matches(anchors) || (node as Element).querySelector(anchors)));
		})) onChange();
	});
	// Page switches within the same Part (such as opening a project) need no window layout.
	observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'data-splash-grid'] });
	return toDisposable(() => observer.disconnect());
}
