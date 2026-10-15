import { designPaints } from '../common/model/designPaint.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { designEffects, designEffectMaxBlur, designEffectPadding, supportsDesignShadowSpread, type DesignEffect } from '../common/model/designEffects.js';
import type { DesignShape } from '../common/model/document.js';
import { renderDesignPlusDarker } from './designPaintRendering.js';

interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
const ns = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
	document: Document,
	tag: K,
	attributes: Record<string, number | string> = {}): SVGElementTagNameMap[K] {
	const node = document.createElementNS(ns, tag);
	for (const [key, value] of Object.entries(attributes)) {
		node.setAttribute(key, String(value));
	}
	return node;
}

/** Clones used for masks never become a second set of selectable layers or duplicate definition IDs. */

function artwork(
	source: SVGGraphicsElement): SVGGraphicsElement {
	const clone = source.cloneNode(true) as SVGGraphicsElement;
	const nodes = [clone, ...clone.querySelectorAll<SVGElement>('*')];
	const ids = new Map(nodes.filter(node => node.id).map(node => [node.id, `effect-${generateUuid()}`]));
	for (const node of nodes) {
		for (const attribute of [...node.attributes]) {
			if (attribute.name.startsWith('data-') || attribute.name.startsWith('aria-') || ['tabindex', 'role'].includes(attribute.name)) {
				node.removeAttribute(attribute.name);
			}
			else if (attribute.name === 'id') {
				node.id = ids.get(attribute.value)!;
			}
			else {
				let value = attribute.value;
				for (const [old, id] of ids) {
					value = value.replaceAll(`url(#${old})`, `url(#${id})`);
					if (value === `#${old}`) {
						value = `#${id}`;
					}
				}
				if (value !== attribute.value) {
					node.setAttribute(attribute.name, value);
				}
			}
		}
	}
	return clone;
}

export function designEffectGeometry(
	base: SVGGraphicsElement,
	shape: DesignShape): SVGGraphicsElement {
	const source = base.cloneNode(true) as SVGGraphicsElement;
	const hasFill = designPaints(shape).some(paint => paint.visible !== false);
	if (shape.kind === 'frame') {
		for (const fill of source.querySelectorAll(':scope > [data-design-fill]')) {
			if (hasFill) {
				fill.setAttribute('fill', '#ffffff');
			} else {
				fill.remove();
			}
		}
	} else if (shape.kind !== 'group' && shape.kind !== 'image') {
		for (const node of [source, ...source.querySelectorAll<SVGElement>('*')]) {
			if (['defs', 'mask', 'clipPath'].includes(node.tagName) || node.closest('defs, mask, clipPath')) {
				continue;
			}
			const stroke = node.hasAttribute('data-design-stroke');
			if (node.getAttribute('fill') !== 'none' && ['rect', 'ellipse', 'path', 'svg', 'g'].includes(node.tagName)) {
				node.setAttribute(
					'fill',
					hasFill || stroke ? '#ffffff' : 'none'
				);
			}
			if (node.hasAttribute('stroke')) {
				node.setAttribute('stroke', '#ffffff');
			}
			if (shape.kind === 'text' && node.namespaceURI !== ns) {
				node.style.color = node.style.webkitTextFillColor = hasFill ? '#ffffff' : '#ffffff00';
			}
		}
	}
	const geometry = artwork(source);
	geometry.removeAttribute('transform');
	geometry.removeAttribute('opacity');
	geometry.style.filter = '';
	return geometry;
}

function shadowLayer(
	geometry: SVGGraphicsElement,
	shape: DesignShape,
	effect: Extract<DesignEffect, {
		type: 'drop-shadow' | 'inner-shadow';
	}>,
	bounds: Bounds): SVGGraphicsElement {
	const document = geometry.ownerDocument, group = svg(document, 'g', { 'data-design-effect': effect.type });
	const filter = svg(document, 'filter', {
		id: `shadow-${generateUuid()}`,
		...bounds,
		filterUnits: 'userSpaceOnUse',
		'color-interpolation-filters': 'sRGB'
	});
	const inner = effect.type === 'inner-shadow';
	const spread = supportsDesignShadowSpread(shape) ? effect.spread ?? 0 : 0;
	filter.append(svg(document, 'feGaussianBlur', { in: 'SourceAlpha', stdDeviation: effect.blur / 2, result: 'blur' }));
	filter.append(svg(document, 'feOffset', { in: 'blur', dx: effect.x, dy: effect.y, result: 'offset' }));
	if (inner) {
		filter.append(svg(document, 'feFlood', { 'flood-color': '#ffffff', result: 'opaque' }));
		filter.append(svg(document, 'feComposite', { in: 'opaque', in2: 'offset', operator: 'out', result: 'shadow' }));
	} else {
		filter.append(svg(document, 'feGaussianBlur', { in: 'offset', stdDeviation: 0, result: 'shadow' }));
	}
	filter.append(svg(document, 'feFlood', {
		'flood-color': effect.color.slice(0, 7),
		'flood-opacity': parseInt(effect.color.slice(7) || 'ff', 16) / 255,
		result: 'color'
	}));
	filter.append(svg(document, 'feComposite', { in: 'color', in2: 'shadow', operator: 'in' }));
	let source = artwork(geometry);
	if (spread && designPaints(shape).some(paint => paint.visible !== false)) {
		// Spread changes the geometry, rather than applying a square-kernel dilation
		// which turns an ellipse's shadow into a rounded rectangle.
		const amount = inner ? -spread : spread;
		const width = shape.width + amount * 2, height = shape.height + amount * 2;
		source = width <= 0 || height <= 0 ? svg(document, 'rect', { ...bounds, fill: '#00000000' }) : shape.kind === 'ellipse'
			? svg(document, 'ellipse', {
				cx: shape.x + shape.width / 2,
				cy: shape.y + shape.height / 2,
				rx: width / 2,
				ry: height / 2,
				fill: '#ffffff'
			})
			: svg(document, 'rect', { x: shape.x - amount, y: shape.y - amount, width, height, fill: '#ffffff' });
	}
	// The filter is outside the nested SVG viewport so offsets and blur use layer pixels.
	const filtered = svg(document, 'g', { filter: `url(#${filter.id})` });
	filtered.append(source);
	group.append(filter);
	if (inner || !effect.showBehind) {
		const mask = svg(document, 'mask', {
			id: `shadow-cutout-${generateUuid()}`,
			...bounds,
			maskUnits: 'userSpaceOnUse',
			'mask-type': inner ? 'alpha' : 'luminance'
		});
		const cutout = artwork(geometry);
		if (!inner) {
			mask.append(svg(document, 'rect', { ...bounds, fill: '#ffffff' }));
			cutout.style.filter = 'brightness(0)';
		}
		mask.append(cutout);
		const clipped = svg(document, 'g', { mask: `url(#${mask.id})` });
		clipped.append(filtered);
		group.append(mask, clipped);
	} else {
		group.append(filtered);
	}
	group.style.pointerEvents = 'none';
	if (effect.blendMode === 'plus-darker') {
		return renderDesignPlusDarker(document, group, bounds);
	}
	group.style.mixBlendMode = effect.blendMode ?? 'normal';
	return group;
}

/** SVG has no spatially varying Gaussian primitive. Interpolate Gaussian samples with
 * triangular weights whose sum is one. Arithmetic addition preserves premultiplied
 * alpha; stacking translucent bands with source-over would leave seams and darken them.
 * Keep the original artwork as SourceGraphic so text and prototype targets remain live. */
function blurFilter(document: Document, shape: DesignShape, effect: DesignEffect, bounds: Bounds): SVGFilterElement {
	const filter = svg(document, 'filter', {
		id: `${effect.type}-${generateUuid()}`,
		...bounds,
		filterUnits: 'userSpaceOnUse',
		primitiveUnits: 'userSpaceOnUse',
		'color-interpolation-filters': 'sRGB'
	});
	const progressive = 'progressive' in effect ? effect.progressive : undefined;
	const start = progressive && { x: shape.x + progressive.start.x * shape.width, y: shape.y + progressive.start.y * shape.height };
	const end = progressive && { x: shape.x + progressive.end.x * shape.width, y: shape.y + progressive.end.y * shape.height };
	if (!progressive || !start || !end || progressive.startBlur === effect.blur || Math.hypot(end.x - start.x, end.y - start.y) < 1e-6) {
		filter.append(svg(document, 'feGaussianBlur', { stdDeviation: effect.blur / 2 }));
		return filter;
	}
	// Two-pixel radius intervals, bounded to 33 samples for large blur ranges.
	const steps = Math.max(8, Math.min(32, Math.ceil(Math.abs(effect.blur - progressive.startBlur) / 2)));
	for (let index = 0; index <= steps; index++) {
		const radius = progressive.startBlur + (effect.blur - progressive.startBlur) * index / steps;
		const mask = svg(document, 'svg', {
			width: bounds.width, height: bounds.height,
			viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`
		});
		const gradient = svg(document, 'linearGradient', {
			id: 'weight', gradientUnits: 'userSpaceOnUse',
			x1: start.x, y1: start.y, x2: end.x, y2: end.y
		});
		for (const [position, opacity] of [
			...(index > 0 ? [[(index - 1) / steps, 0]] : []),
			[index / steps, 1],
			...(index < steps ? [[(index + 1) / steps, 0]] : [])
		]) {
			gradient.append(svg(document, 'stop', { offset: position, 'stop-color': '#ffffff', 'stop-opacity': opacity }));
		}
		mask.append(gradient, svg(document, 'rect', { ...bounds, fill: 'url(#weight)' }));
		const url = `data:image/svg+xml,${encodeURIComponent(new document.defaultView!.XMLSerializer().serializeToString(mask))}`;
		filter.append(
			svg(document, 'feGaussianBlur', { in: 'SourceGraphic', stdDeviation: radius / 2, result: `sample-${index}` }),
			svg(document, 'feImage', { ...bounds, href: url, preserveAspectRatio: 'none', result: 'weight' }),
			svg(document, 'feComposite', { in: `sample-${index}`, in2: 'weight', operator: 'in', result: `weighted-${index}` })
		);
		if (index > 0) {
			filter.append(svg(document, 'feComposite', {
				in: index === 1 ? 'weighted-0' : `sum-${index - 1}`,
				in2: `weighted-${index}`, operator: 'arithmetic', k2: 1, k3: 1, result: `sum-${index}`
			}));
		}
	}
	return filter;
}

/** Background blur samples the scene without previous background blurs. Serializing the
 * backdrop also makes SVG export independent of CSS backdrop-filter support. */

function backgroundLayer(
	geometry: SVGGraphicsElement,
	backdrop: readonly SVGGraphicsElement[],
	shape: DesignShape,
	effect: DesignEffect,
	bounds: Bounds): SVGGraphicsElement {
	const document = geometry.ownerDocument, layer = svg(document, 'g', { 'data-design-background-blur': '' });
	const source = svg(document, 'svg', {
		...bounds,
		x: 0,
		y: 0,
		viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`
	});
	const unrotated = svg(document, 'g', { transform: `rotate(${-shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})` });
	for (const node of backdrop) {
		const copy = node.cloneNode(true) as SVGGraphicsElement;
		for (const background of copy.querySelectorAll('[data-design-background-blur]')) {
			background.remove();
		}
		for (const guide of copy.querySelectorAll('[data-layout-guide]')) {
			guide.remove();
		}
		unrotated.append(artwork(copy));
	}
	source.append(unrotated);
	const url = `data:image/svg+xml,${encodeURIComponent(new document.defaultView!.XMLSerializer().serializeToString(source))}`;
	const mask = svg(document, 'mask', {
		id: `background-mask-${generateUuid()}`,
		...bounds,
		maskUnits: 'userSpaceOnUse',
		'mask-type': 'alpha'
	});
	mask.append(artwork(geometry));
	const filter = blurFilter(document, shape, effect, bounds);
	const image = svg(document, 'image', { ...bounds, href: url, preserveAspectRatio: 'none', filter: `url(#${filter.id})` });
	const clipped = svg(document, 'g', { mask: `url(#${mask.id})` });
	clipped.append(image);
	layer.append(mask, filter, clipped);
	layer.style.pointerEvents = 'none';
	return layer;
}

export function applyDesignEffects(
	painted: SVGGraphicsElement,
	geometry: SVGGraphicsElement | undefined,
	shape: DesignShape,
	bounds: Bounds,
	backdrop: readonly SVGGraphicsElement[]): SVGGraphicsElement {
	const effects = designEffects(shape).filter(effect => effect.visible !== false);
	if (!effects.length || !geometry) {
		return painted;
	}
	const document = painted.ownerDocument, root = svg(document, 'g');
	for (const key of ['transform', 'opacity', 'data-shape-id', 'visibility', 'style']) {
		const value = painted.getAttribute(key);
		if (value !== null) {
			root.setAttribute(key, value);
			painted.removeAttribute(key);
		}
	}
	const extra = Math.max(designEffectPadding({ ...shape, rotation: 0 }), ...effects.map(effect => designEffectMaxBlur(effect) * 2), 1);
	const area = { x: bounds.x - extra, y: bounds.y - extra, width: bounds.width + extra * 2, height: bounds.height + extra * 2 };
	const background = effects.find(effect => effect.type === 'background-blur');
	if (background) {
		root.append(backgroundLayer(geometry, backdrop, shape, background, area));
	}
	for (const effect of effects.slice().reverse()) {
		if (effect.type === 'drop-shadow') {
			root.append(shadowLayer(geometry, shape, effect, area));
		}
	}
	const strokes = svg(document, 'g');
	if (shape.kind === 'path' && effects.some(effect => effect.type === 'inner-shadow')) {
		for (const stroke of [...painted.querySelectorAll('[data-design-stroke]')]) {
			strokes.append(stroke);
		}
		if (painted.tagName === 'path' || painted.querySelector('path[stroke]')) {
			const path = painted.tagName === 'path' ? painted : painted.querySelector<SVGGraphicsElement>('path[stroke]')!;
			const stroke = artwork(path);
			stroke.setAttribute('fill', 'none');
			path.removeAttribute('stroke');
			strokes.append(stroke);
		}
	}
	root.append(painted);
	for (const effect of effects.slice().reverse()) {
		if (effect.type === 'inner-shadow') {
			root.append(shadowLayer(geometry, shape, effect, area));
		}
	}
	root.append(strokes);
	const blur = effects.find(effect => effect.type === 'layer-blur');
	if (blur) {
		const filter = blurFilter(document, shape, blur, area);
		const content = svg(document, 'g', { filter: `url(#${filter.id})`, 'data-design-effect': 'layer-blur' });
		content.append(...root.childNodes);
		root.append(filter, content);
	}
	return root;
}

/** Express the ancestor backdrop in a container's child coordinate system. */

export function designChildBackdrop(
	shape: Extract<DesignShape, {
		kind: 'frame' | 'group';
	}>,
	backdrop: readonly SVGGraphicsElement[],
	document: Document): SVGGraphicsElement[] {
	if ((shape.opacity ?? 1) < 1 || shape.blendMode && shape.blendMode !== 'pass-through' || designEffects(shape).some(effect => effect.visible !== false && effect.type === 'layer-blur')) {
		return [];
	}
	const width = shape.kind === 'group' ? shape.contentWidth : shape.width;
	const height = shape.kind === 'group' ? shape.contentHeight : shape.height;
	const group = svg(
		document,
		'g',
		{ transform: `scale(${width / shape.width} ${height / shape.height}) translate(${-shape.x} ${-shape.y}) rotate(${-shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})` }
	);
	group.append(...backdrop.map(node => node.cloneNode(true)));
	return [group];
}
