import { generateUuid } from '../../../../base/common/uuid.js';
import { designGradientPosition, sampleDesignPaint, type DesignPaint } from '../common/model/designPaint.js';
import type { DesignShape } from '../common/model/document.js';
const ns = 'http://www.w3.org/2000/svg';
interface PaintBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
const textures = new WeakMap<DesignPaint, Map<string, string>>();
function element<K extends keyof SVGElementTagNameMap>(document: Document, tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const value = document.createElementNS(ns, tag);
	for (const [key, item] of Object.entries(attributes)) {
		value.setAttribute(key, String(item));
	}
	return value;
}
/** Angular and diamond gradients have no SVG paint server; embed a bounded texture so exported SVG is self-contained. */
function texture(document: Document, paint: DesignPaint, width: number, height: number): string {
	const scale = Math.min(2, 2048 / Math.max(width, height));
	const w = Math.max(1, Math.ceil(width * scale));
	const h = Math.max(1, Math.ceil(height * scale));
	const key = `${w}:${h}`;
	let cache = textures.get(paint);
	if (!cache) {
		cache = new Map();
		textures.set(paint, cache);
	}
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const context = canvas.getContext('2d')!;
	const image = context.createImageData(w, h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const color = sampleDesignPaint(paint, paint.type === 'solid' ? 0 : designGradientPosition(paint, { x: (x + .5) / w, y: (y + .5) / h }));
			const index = (y * w + x) * 4;
			for (let channel = 0; channel < 4; channel++) {
				image.data[index + channel] = color[channel];
			}
		}
	}
	context.putImageData(image, 0, 0);
	const result = canvas.toDataURL('image/png');
	if (cache.size > 4) {
		cache.clear();
	}
	cache.set(key, result);
	return result;
}
function paintServer(document: Document, paint: DesignPaint, bounds: PaintBounds): {
	fill: string;
	definition?: SVGElement;
} {
	if (paint.type === 'solid') {
		return { fill: paint.color };
	}
	const id = `paint-${generateUuid()}`;
	if (paint.type === 'angular' || paint.type === 'diamond') {
		const pattern = element(document, 'pattern', { id, patternUnits: 'userSpaceOnUse', ...bounds });
		// Pattern content starts at its own origin; layer placement belongs to the tile, not the image.
		pattern.append(element(document, 'image', { x: 0, y: 0, width: bounds.width, height: bounds.height, href: texture(document, paint, bounds.width, bounds.height), preserveAspectRatio: 'none' }));
		return { fill: `url(#${id})`, definition: pattern };
	}
	const [a, b, c] = paint.handles;
	const gradient = paint.type === 'linear' ? element(document, 'linearGradient', { x1: 0, y1: 0, x2: 1, y2: 0 }) : element(document, 'radialGradient', { cx: 0, cy: 0, r: 1 });
	gradient.id = id;
	gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
	gradient.setAttribute('color-interpolation', 'sRGB');
	gradient.setAttribute('gradientTransform', `matrix(${(b.x - a.x) * bounds.width} ${(b.y - a.y) * bounds.height} ${(c.x - a.x) * bounds.width} ${(c.y - a.y) * bounds.height} ${bounds.x + a.x * bounds.width} ${bounds.y + a.y * bounds.height})`);
	for (const stop of paint.stops) {
		gradient.append(element(document, 'stop', { offset: stop.position, 'stop-color': stop.color.slice(0, 7), 'stop-opacity': stop.color.length === 9 ? parseInt(stop.color.slice(7, 9), 16) / 255 : 1 }));
	}
	return { fill: `url(#${id})`, definition: gradient };
}

export function designPaintBackground(document: Document, paint: DesignPaint, width: number, height: number): string {
	if (paint.type === 'angular' || paint.type === 'diamond') {
		return `url("${texture(document, paint, width, height)}")`;
	}
	const svg = element(document, 'svg', { width, height, viewBox: `0 0 ${width} ${height}` });
	const server = paintServer(document, paint, { x: 0, y: 0, width, height });
	if (server.definition) {
		svg.append(server.definition);
	}
	svg.append(element(document, 'rect', { width, height, fill: server.fill }));
	return `url("data:image/svg+xml,${encodeURIComponent(new document.defaultView!.XMLSerializer().serializeToString(svg))}")`;
}
/** Chromium lacks plus-darker. A backdrop filter computes max(source + backdrop - 1, 0)
 * in sRGB, then restores source coverage, including transparent gradients and an empty backdrop. */
export function renderDesignPlusDarker(document: Document, source: SVGGraphicsElement, bounds: PaintBounds): SVGGElement {
	const group = element(document, 'g'), definitions = element(document, 'defs'), filterId = `blend-filter-${generateUuid()}`;
	const symbol = element(document, 'svg', { viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`, width: bounds.width, height: bounds.height, overflow: 'visible' });
	symbol.append(source);
	const sourceUrl = `data:image/svg+xml,${encodeURIComponent(new document.defaultView!.XMLSerializer().serializeToString(symbol))}`;
	// CSS filter primitives must use pixels: the editor's outer SVG viewport is only one pixel.
	const filter = element(document, 'filter', { id: filterId, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', x: 0, y: 0, width: bounds.width, height: bounds.height, 'color-interpolation-filters': 'sRGB' });
	filter.append(element(document, 'feImage', { href: sourceUrl, x: 0, y: 0, width: bounds.width, height: bounds.height, preserveAspectRatio: 'none', result: 'paint' }));
	for (const [input, result] of [['paint', 'opaquePaint'], ['SourceGraphic', 'opaqueBackdrop']]) {
		const transfer = element(document, 'feComponentTransfer', { in: input, result });
		transfer.append(element(document, 'feFuncA', { type: 'linear', slope: 0, intercept: 1 }));
		filter.append(transfer);
	}
	filter.append(element(document, 'feComposite', { in: 'opaquePaint', in2: 'opaqueBackdrop', operator: 'arithmetic', k2: 1, k3: 1, k4: -1, result: 'burn' }));
	filter.append(element(document, 'feComposite', { in: 'burn', in2: 'paint', operator: 'in', result: 'coveredPaint' }));
	filter.append(element(document, 'feComposite', { in: 'coveredPaint', in2: 'SourceGraphic', operator: 'in', result: 'coveredBlend' }));
	filter.append(element(document, 'feComposite', { in: 'paint', in2: 'SourceGraphic', operator: 'out', result: 'uncoveredPaint' }));
	filter.append(element(document, 'feComposite', { in: 'coveredBlend', in2: 'uncoveredPaint', operator: 'arithmetic', k2: 1, k3: 1 }));
	definitions.append(filter);
	const foreign = element(document, 'foreignObject', { ...bounds }), content = document.createElement('div');
	content.style.width = '100%';
	content.style.height = '100%';
	content.style.backdropFilter = `url(#${filterId})`;
	foreign.append(content);
	group.append(definitions, foreign);
	return group;
}

/** A filter image has no descendant DOM. Preserve container coordinates and clipping for
 * prototype hotspots, scrolling and keyboard focus without painting the source twice. */
function interactionTree(document: Document, shape: DesignShape): SVGGraphicsElement {
	const container = shape.kind === 'frame' || shape.kind === 'group';
	const node = element(document, container ? 'svg' : 'rect', {
		x: shape.x, y: shape.y, width: shape.width, height: shape.height,
		transform: `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`,
		'data-shape-id': shape.id, fill: '#00000000',
	});
	if (shape.visible === false) { node.style.display = 'none'; }
	if (shape.kind === 'frame' || shape.kind === 'group') {
		const width = shape.kind === 'group' ? shape.contentWidth : shape.width;
		const height = shape.kind === 'group' ? shape.contentHeight : shape.height;
		node.setAttribute('viewBox', `0 0 ${width} ${height}`);
		node.setAttribute('preserveAspectRatio', 'none');
		node.setAttribute('overflow', shape.kind === 'frame' && shape.clip ? 'hidden' : 'visible');
		node.append(element(document, 'rect', { width, height, fill: '#00000000' }));
		node.append(...shape.children.map(child => interactionTree(document, child)));
	}
	return node;
}
/** Paint layers are rendered back-to-front; opacity and blend belong to the whole paint, not each region. */

export function applyDesignPaints(base: SVGGraphicsElement, shape: DesignShape): SVGGraphicsElement {
	const document = base.ownerDocument, container = shape.kind === 'frame' || shape.kind === 'group' || shape.kind === 'image' || shape.kind === 'text';
	const bounds = {
		x: container ? 0 : shape.x,
		y: container ? 0 : shape.y,
		width: shape.kind === 'group' ? shape.contentWidth : shape.width,
		height: shape.kind === 'group' ? shape.contentHeight : shape.height
	};
	let root = base;
	if (shape.fills !== undefined) {
		const targets: SVGGraphicsElement[] = container || base.tagName === 'g' ? [...base.querySelectorAll<SVGGraphicsElement>(':scope > [data-design-fill]')] : base.getAttribute('fill') === 'none' ? [] : [base];
		if (targets.length) {
			if (targets[0] === base) {
				root = element(document, 'g');
				for (const key of ['transform', 'opacity', 'data-shape-id', 'visibility', 'style']) {
					const value = base.getAttribute(key);
					if (value !== null) {
						root.setAttribute(key, value);
						base.removeAttribute(key);
					}
				}
				root.append(base);
			}
			const fills = element(document, 'g', { 'data-design-fills': '' });
			for (const paint of shape.fills.slice().reverse()) {
				if (paint.visible === false || paint.opacity === 0) {
					continue;
				}
				const layer = element(document, 'g', { opacity: paint.opacity ?? 1, 'data-paint-id': paint.id }), server = paintServer(document, paint, bounds);
				if (server.definition) {
					const defs = element(document, 'defs');
					defs.append(server.definition);
					layer.append(defs);
				}
				for (const target of targets) {
					const clone = target.cloneNode(true) as SVGGraphicsElement;
					clone.removeAttribute('data-design-fill');
					clone.removeAttribute('stroke');
					clone.removeAttribute('stroke-width');
					clone.setAttribute('fill', server.fill);
					if (shape.kind === 'text') {
						const content = clone.firstElementChild as HTMLElement;
						Object.assign(content.style, {
							backgroundImage: designPaintBackground(document, paint, bounds.width, bounds.height),
							backgroundSize: '100% 100%',
							backgroundRepeat: 'no-repeat',
							backgroundClip: 'text',
							webkitBackgroundClip: 'text'
						});
						for (const node of [content, ...content.querySelectorAll<HTMLElement>('*')]) {
							node.style.webkitTextFillColor = 'transparent';
							node.style.color = 'transparent';
						}
					}
					layer.append(clone);
				}
				if (paint.blendMode === 'plus-darker') {
					fills.append(renderDesignPlusDarker(document, layer, bounds));
				}
				else {
					layer.style.mixBlendMode = paint.blendMode ?? 'normal';
					fills.append(layer);
				}
			}
			for (const target of targets) {
				if (target === base) {
					target.setAttribute('fill', 'none');
				}
				else {
					target.remove();
				}
			}
			root.prepend(fills);
		}
	}
	for (const target of root.querySelectorAll('[data-design-fill]')) {
		target.removeAttribute('data-design-fill');
	}
	return root;
}

export function applyDesignLayerBlend(root: SVGGraphicsElement, shape: DesignShape, layerBounds?: PaintBounds): SVGGraphicsElement {
	const document = root.ownerDocument;
	if (shape.blendMode === 'plus-darker') {
		const placed = layerBounds ?? { x: shape.x, y: shape.y, width: shape.width, height: shape.height }, wrapper = renderDesignPlusDarker(document, root, placed);
		wrapper.dataset.shapeId = shape.id;
		root.removeAttribute('data-shape-id');
		const interactions = interactionTree(document, shape);
		interactions.removeAttribute('data-shape-id');
		interactions.setAttribute('data-design-hit-area', '');
		wrapper.append(interactions);
		return wrapper;
	}
	root.style.mixBlendMode = shape.blendMode === 'pass-through' ? 'normal' : shape.blendMode ?? 'normal';
	root.style.isolation = !shape.blendMode || shape.blendMode === 'pass-through' ? 'auto' : 'isolate';
	// Isolation alone does not establish a backdrop root for CSS backdrop filters.
	if (root.style.isolation === 'isolate') {
		root.style.filter = `${root.style.filter} opacity(1)`.trim();
	}
	return root;
}
