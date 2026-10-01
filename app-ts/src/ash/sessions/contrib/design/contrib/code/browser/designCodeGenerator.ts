import { mainWindow } from '../../../../../../base/browser/window.js';
import { localize } from '../../../../../../nls.js';
import { designBounds } from '../../../common/core/geometry.js';
import { serializeDesignDocument, type DesignDocument, type DesignShape } from '../../../common/model/document.js';
import { renderDesignShape } from '../../../browser/svgRenderer.js';

/** Generates runnable source from committed data, retaining IDs and JSON for agent edits. */
export function generateDesignCode(document: DesignDocument): string {
	const ownerDocument = mainWindow.document;
	const scene = ownerDocument.createElement('div');
	scene.className = 'ash-design-scene';
	const rules = ['body { margin: 0; }', '.ash-design-scene { position: relative; overflow: visible; }', '.ash-design-object { position: absolute; transform-origin: center; }'];
	const frames = document.shapes.flatMap(shape => [shape, ...(shape.motion?.keyframes.map(frame => ({ ...shape, ...frame })) ?? [])]);
	const bounds = designBounds(frames);
	const padding = strokePadding(document.shapes);
	rules.push(`.ash-design-scene { width: ${bounds.width + padding * 2}px; height: ${bounds.height + padding * 2}px; }`);
	function render(shape: DesignShape, originX: number, originY: number): HTMLElement {
		const node = ownerDocument.createElement('div');
		const className = `ash-design-object-${shape.id}`;
		node.className = `ash-design-object ${className}`;
		node.dataset.designId = shape.id;
		node.dataset.designKind = shape.kind;
		const geometry = `left: ${shape.x - originX}px; top: ${shape.y - originY}px; width: ${shape.width}px; height: ${shape.height}px; transform: rotate(${shape.rotation}deg);`;
		let appearance = '';
		if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
			appearance = ` background: ${shape.fill};${shape.kind === 'ellipse' ? ' border-radius: 50%;' : ''}`;
		} else if (shape.kind === 'group') {
			const content = ownerDocument.createElement('div');
			content.className = `${className}-content`;
			rules.push(`.${className}-content { width: ${shape.contentWidth}px; height: ${shape.contentHeight}px; transform-origin: top left; transform: scale(${shape.width / shape.contentWidth}); }`);
			content.append(...shape.children.map(child => render(child, 0, 0)));
			node.append(content);
		} else {
			const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', `${shape.width}`);
			svg.setAttribute('height', `${shape.height}`);
			svg.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
			svg.setAttribute('overflow', 'visible');
			svg.append(renderDesignShape({ ...shape, x: 0, y: 0, rotation: 0 }));
			svg.querySelector('[data-shape-id]')!.removeAttribute('data-shape-id');
			if (shape.kind === 'text') { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', shape.text); }
			node.append(svg);
		}
		if (shape.motion) {
			const motion = shape.motion;
			appearance += ` animation: ${className}-motion ${motion.duration}ms linear ${motion.loop ? 'infinite' : '1'} both;`;
			const keyframes = motion.keyframes.map(frame => `  ${frame.offset * 100}% { transform: translate(${frame.x - shape.x}px, ${frame.y - shape.y}px) rotate(${frame.rotation}deg); opacity: ${frame.opacity}; }`);
			rules.push(`@keyframes ${className}-motion {\n${keyframes.join('\n')}\n}`);
		}
		rules.push(`.${className} { ${geometry}${appearance} }`);
		return node;
	}
	scene.append(...document.shapes.map(shape => render(shape, bounds.x - padding, bounds.y - padding)));
	const title = ownerDocument.createElement('title');
	title.textContent = localize('sessions.design.codeTitle', 'Ash design');
	// A raw-text script cannot contain a literal closing tag, even for inert JSON.
	const data = serializeDesignDocument(document).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
	return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${title.outerHTML}\n<style>\n${rules.join('\n')}\n@media (prefers-reduced-motion: reduce) { .ash-design-object { animation: none; } }\n</style>\n</head>\n<body>\n${scene.outerHTML}\n<script type="application/json" id="ash-design-document">\n${data}</script>\n</body>\n</html>\n`;
}

function strokePadding(shapes: readonly DesignShape[]): number {
	return Math.max(0, ...shapes.map(shape => {
		if (shape.kind === 'path') { return shape.strokeWidth; }
		if (shape.kind === 'group') { return strokePadding(shape.children) * shape.width / shape.contentWidth; }
		return 0;
	}));
}
