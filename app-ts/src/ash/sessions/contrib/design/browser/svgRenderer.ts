import { mainWindow } from '../../../../base/browser/window.js';
import type { DesignDocument, DesignShape } from '../common/model/document.js';
import { designBounds } from '../common/core/geometry.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Canvas and export share SVG construction; user text never becomes markup. */
export function renderDesignShape(shape: DesignShape, previous?: SVGGraphicsElement): SVGGraphicsElement {
	const tag = ({ rectangle: 'rect', ellipse: 'ellipse', path: 'path', text: 'svg', group: 'svg' } as const)[shape.kind];
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
		if (shape.kind === 'group') {
			element.setAttribute('viewBox', `0 0 ${shape.contentWidth} ${shape.contentHeight}`);
			element.setAttribute('overflow', 'visible');
			const children = shape.children.map((child, index) => renderDesignShape(child, element.children[index] as SVGGraphicsElement | undefined));
			for (const [index, child] of children.entries()) {
				const previous = element.children[index];
				if (!previous) { element.append(child); }
				else if (previous !== child) { previous.replaceWith(child); }
			}
			while (element.children.length > children.length) { element.lastElementChild!.remove(); }
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

export function exportDesignSvg(document: DesignDocument): string {
	const svg = mainWindow.document.createElementNS(SVG_NAMESPACE, 'svg');
	const bounds = designBounds(document.shapes);
	function strokePadding(shape: DesignShape): number {
		if (shape.kind === 'path') { return shape.strokeWidth; }
		if (shape.kind === 'group') { return Math.max(...shape.children.map(strokePadding)) * shape.width / shape.contentWidth; }
		return 0;
	}
	const padding = Math.max(0, ...document.shapes.map(strokePadding));
	svg.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`);
	svg.setAttribute('width', `${bounds.width + padding * 2}`);
	svg.setAttribute('height', `${bounds.height + padding * 2}`);
	for (const shape of document.shapes) { svg.append(renderDesignShape(shape)); }
	for (const element of svg.querySelectorAll('[data-shape-id]')) { element.removeAttribute('data-shape-id'); }
	return new mainWindow.XMLSerializer().serializeToString(svg) + '\n';
}
