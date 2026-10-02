import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import type { DesignDocument, DesignShape } from '../common/model/document.js';
import { designBounds } from '../common/core/geometry.js';

import type { DesignImageSource } from './designMedia.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Canvas and export share SVG construction; user text never becomes markup. */
export function renderDesignShape(shape: DesignShape, previous?: SVGGraphicsElement, images: ReadonlyMap<string, DesignImageSource> = new Map()): SVGGraphicsElement {
	const tag = ({ rectangle: 'rect', ellipse: 'ellipse', path: 'path', text: 'svg', group: 'svg', frame: 'svg', image: 'svg' } as const)[shape.kind];
	const element = previous?.tagName === tag ? previous : mainWindow.document.createElementNS(SVG_NAMESPACE, tag);
	element.dataset.shapeId = shape.id;
	element.setAttribute('transform', `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`);
	element.setAttribute('fill', shape.fill);
	if (shape.kind === 'ellipse') {
		for (const [key, value] of Object.entries({ cx: shape.x + shape.width / 2, cy: shape.y + shape.height / 2, rx: shape.width / 2, ry: shape.height / 2 })) { element.setAttribute(key, `${value}`); }
	} else if (shape.kind === 'path') {
		const point = (p: { x: number; y: number }): string => `${shape.x + p.x * shape.width} ${shape.y + p.y * shape.height}`;
		let path = `M ${point(shape.nodes[0])}`;
		const count = shape.closed ? shape.nodes.length : shape.nodes.length - 1;
		for (let index = 0; index < count; index++) {
			const start = shape.nodes[index];
			const end = shape.nodes[(index + 1) % shape.nodes.length];
			path += ` C ${point(start.outgoing)} ${point(end.incoming)} ${point(end)}`;
		}
		element.setAttribute('d', path + (shape.closed ? ' Z' : ''));
		element.setAttribute('fill', shape.closed ? shape.fill : 'none');
		element.setAttribute('stroke', shape.fill);
		element.setAttribute('stroke-width', `${shape.strokeWidth}`);
	} else {
		for (const key of ['x', 'y', 'width', 'height'] as const) { element.setAttribute(key, `${shape[key]}`); }
		if (shape.kind === 'group' || shape.kind === 'frame') {
			element.setAttribute('viewBox', shape.kind === 'group' ? `0 0 ${shape.contentWidth} ${shape.contentHeight}` : `0 0 ${shape.width} ${shape.height}`);
			element.setAttribute('overflow', shape.kind === 'frame' && shape.clip ? 'hidden' : 'visible');
			element.setAttribute('preserveAspectRatio', 'none');
			const children: SVGElement[] = [];
			if (shape.kind === 'frame') {
				const background = element.firstElementChild?.tagName === 'rect' && !element.firstElementChild.hasAttribute('data-shape-id') ? element.firstElementChild : mainWindow.document.createElementNS(SVG_NAMESPACE, 'rect');
				background.setAttribute('width', `${shape.width}`);
				background.setAttribute('height', `${shape.height}`);
				background.setAttribute('fill', shape.fill);
				children.push(background as SVGRectElement);
			}
			children.push(...shape.children.map((child, index) => renderDesignShape(child, element.children[index + (shape.kind === 'frame' ? 1 : 0)] as SVGGraphicsElement | undefined, images)));
			for (const [index, child] of children.entries()) {
				const previous = element.children[index];
				if (!previous) { element.append(child); }
				else if (previous !== child) { previous.replaceWith(child); }
			}
			while (element.children.length > children.length) { element.lastElementChild!.remove(); }
		} else if (shape.kind === 'image') {
			const source = images.get(shape.assetVersionId);
			if (!source) { throw new Error(localize('sessions.design.imageSourceMissing', 'Image preview is missing: {0}', shape.assetVersionId)); }
			const crop = shape.crop;
			element.setAttribute('viewBox', `${crop.x * source.width} ${crop.y * source.height} ${crop.width * source.width} ${crop.height * source.height}`);
			element.setAttribute('overflow', 'hidden');
			element.setAttribute('preserveAspectRatio', 'xMidYMid slice');
			const image = element.firstElementChild?.tagName === 'image' ? element.firstElementChild : mainWindow.document.createElementNS(SVG_NAMESPACE, 'image');
			image.setAttribute('href', source.url);
			image.setAttribute('width', `${source.width}`);
			image.setAttribute('height', `${source.height}`);
			if (image.parentNode !== element) { element.replaceChildren(image); }
		} else if (shape.kind === 'text') {
			element.setAttribute('overflow', 'hidden');
			element.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
			const text = element.firstElementChild?.tagName === 'text' ? element.firstElementChild : mainWindow.document.createElementNS(SVG_NAMESPACE, 'text');
			text.setAttribute('font-family', 'sans-serif');
			text.setAttribute('font-size', `${shape.fontSize}`);
			text.setAttribute('xml:space', 'preserve');
			const lines = shape.text.split('\n');
			for (const [index, line] of lines.entries()) {
				const span = text.children[index] ?? mainWindow.document.createElementNS(SVG_NAMESPACE, 'tspan');
				span.setAttribute('x', '0');
				span.setAttribute('y', `${shape.fontSize * (1 + index * 1.2)}`);
				if (span.textContent !== line) { span.textContent = line; }
				if (span.parentNode !== text) { text.append(span); }
			}
			while (text.children.length > lines.length) { text.lastElementChild!.remove(); }
			if (text.parentNode !== element) { element.replaceChildren(text); }
		}
	}
	return element;
}

export function exportDesignSvg(document: DesignDocument, images: ReadonlyMap<string, DesignImageSource> = new Map()): string {
	const svg = mainWindow.document.createElementNS(SVG_NAMESPACE, 'svg');
	const bounds = getDesignRenderBounds(document.shapes);
	function strokePadding(shape: DesignShape): number {
		if (shape.kind === 'path') { return shape.strokeWidth; }
		if (shape.kind === 'frame') { return shape.clip ? 0 : Math.max(0, ...shape.children.map(strokePadding)); }
		if (shape.kind === 'group') { return Math.max(...shape.children.map(strokePadding)) * shape.width / shape.contentWidth; }
		return 0;
	}
	const padding = Math.max(0, ...document.shapes.map(strokePadding));
	svg.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`);
	svg.setAttribute('width', `${bounds.width + padding * 2}`);
	svg.setAttribute('height', `${bounds.height + padding * 2}`);
	for (const shape of document.shapes) { svg.append(renderDesignShape(shape, undefined, images)); }
	for (const element of svg.querySelectorAll('[data-shape-id]')) { element.removeAttribute('data-shape-id'); }
	return new mainWindow.XMLSerializer().serializeToString(svg) + '\n';
}

/** Unclipped containers include overflowing content in exports without changing their editable geometry. */
export function getDesignRenderBounds(shapes: readonly DesignShape[]): { x: number; y: number; width: number; height: number } {
	return designBounds(shapes.flatMap(shape => {
		if ((shape.kind !== 'frame' && shape.kind !== 'group') || (shape.kind === 'frame' && shape.clip) || shape.children.length === 0) { return [shape]; }
		const child = getDesignRenderBounds(shape.children);
		const scale = shape.kind === 'group' ? shape.width / shape.contentWidth : 1;
		const angle = shape.rotation * Math.PI / 180;
		const dx = (child.x + child.width / 2) * scale - shape.width / 2;
		const dy = (child.y + child.height / 2) * scale - shape.height / 2;
		return [shape, { x: shape.x + shape.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - child.width * scale / 2, y: shape.y + shape.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - child.height * scale / 2, width: child.width * scale, height: child.height * scale, rotation: shape.rotation }];
	}));
}
