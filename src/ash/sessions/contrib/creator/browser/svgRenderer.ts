import { applyDesignEffects, designEffectGeometry, designChildBackdrop } from './designEffectRendering.js';
import { designEffects, designEffectPadding } from '../common/model/designEffects.js';
import { applyDesignPaints, applyDesignLayerBlend } from './designPaintRendering.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { designEndpointContours, designStrokeLayers } from '../common/model/designVectorStroke.js';
import { designVariableStrokeContours } from '../common/model/designVariableWidth.js';
import { designPathStrokeContours, designPathFillContours, designPathData } from '../common/model/designVector.js';
import { getDesignVectorContours } from './designVectorGeometry.js';
import { measureDesignText } from './designTextMeasurement.js';
import { renderDesignTextFrame } from './designTextRendering.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { flattenDesignShapes, type DesignDocument, type DesignShape } from '../common/model/document.js';
import { designBounds } from '../common/core/geometry.js';

import type { DesignImageSource } from './designMedia.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function renderStrokePadding(shape: DesignShape): number {
	// Outside miters can extend up to four stroke widths beyond the editable bounds.
	if (shape.kind === 'path') {
		return shape.strokeWidth * ((shape.strokeJoin ?? 'miter') === 'miter' ? 4 : 1);
	}
	if (shape.kind === 'frame') {
		return shape.clip ? 0 : Math.max(0, ...shape.children.map(renderStrokePadding));
	}
	if (shape.kind === 'group') {
		return (Math.max(0, ...shape.children.map(renderStrokePadding)) * shape.width) / shape.contentWidth;
	}
	return 0;
}

function paintShape(element: SVGGraphicsElement, shape: DesignShape, images: ReadonlyMap<string, DesignImageSource>, backdrop: readonly SVGGraphicsElement[]): SVGGraphicsElement {
	const effects = designEffects(shape).some(effect => effect.visible !== false);
	// Backdrop snapshots and blend filter inputs cannot reference session-local blob URLs.
	for (const image of element.querySelectorAll('image')) {
		const source = [...images.values()].find(source => source.url === image.getAttribute('href'));
		if (source?.embeddedUrl) {
			image.setAttribute('href', source.embeddedUrl);
		}
	}
	if (shape.effects && 'x' in shape.effects) {
		element.style.filter = `drop-shadow(${shape.effects.x}px ${shape.effects.y}px ${shape.effects.blur / 2}px ${shape.effects.color})`;
	}
	const geometry = effects && Array.isArray(shape.effects) ? designEffectGeometry(element, shape) : undefined;
	const painted = applyDesignPaints(element, shape);
	if (!effects && shape.blendMode !== 'plus-darker') {
		return applyDesignLayerBlend(painted, shape);
	}
	const bounds = getDesignRenderBounds([{ ...shape, rotation: 0 }]);
	const stroke = renderStrokePadding(shape);
	const content = {
		x: bounds.x - stroke,
		y: bounds.y - stroke,
		width: bounds.width + stroke * 2,
		height: bounds.height + stroke * 2,
	};
	const result = applyDesignEffects(painted, geometry, shape, content, backdrop);
	const rotated = getDesignRenderBounds([shape]),
		padding = designEffectPadding(shape) + stroke;
	return applyDesignLayerBlend(result, shape, {
		x: rotated.x - padding,
		y: rotated.y - padding,
		width: rotated.width + padding * 2,
		height: rotated.height + padding * 2,
	});
}

/** Canvas and export share SVG construction; user text never becomes markup. */
export function renderDesignShape(
	shape: DesignShape,
	previous?: SVGGraphicsElement,
	images: ReadonlyMap<string, DesignImageSource> = new Map(),
	backdrop: readonly SVGGraphicsElement[] = [],
): SVGGraphicsElement {
	const tag =
		shape.kind === 'path' &&
		(shape.network ||
			(shape.strokeAlignment && shape.strokeAlignment !== 'center') ||
			shape.nodes.some(node => node.endpoint) ||
			shape.widthPoints?.length ||
			shape.subpaths?.some(contour => contour.fill || contour.nodes.some(node => node.endpoint)))
			? 'g'
			: (
					{
						rectangle: 'rect',
						ellipse: 'ellipse',
						path: 'path',
						text: 'svg',
						group: 'svg',
						frame: 'svg',
						image: 'svg',
					} as const
				)[shape.kind];
	const element = shape.fills === undefined && !shape.effects && previous?.tagName === tag ? previous : mainWindow.document.createElementNS(SVG_NAMESPACE, tag);
	element.dataset.shapeId = shape.id;
	element.removeAttribute('visibility');
	element.setAttribute('transform', `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`);
	element.setAttribute('fill', shape.fill);
	element.style.display = shape.visible === false ? 'none' : '';
	element.setAttribute('opacity', `${shape.opacity ?? 1}`);
	element.style.filter = '';
	if (shape.kind === 'ellipse') {
		for (const [key, value] of Object.entries({
			cx: shape.x + shape.width / 2,
			cy: shape.y + shape.height / 2,
			rx: shape.width / 2,
			ry: shape.height / 2,
		})) {
			element.setAttribute(key, `${value}`);
		}
	} else if (shape.kind === 'path') {
		if (tag === 'g') {
			const contours = designPathFillContours(shape),
				colors = [...new Set([...(shape.network ? [shape.fill] : []), ...contours.map(contour => contour.fill ?? shape.fill)])];
			const children: SVGElement[] = colors.map(color => {
				const fill = mainWindow.document.createElementNS(SVG_NAMESPACE, 'path');
				fill.setAttribute('data-design-fill', '');
				fill.setAttribute(
					'd',
					designPathData(
						contours.filter(contour => (contour.fill ?? shape.fill) === color),
						shape,
					),
				);
				fill.setAttribute('fill', color);
				fill.setAttribute('fill-rule', shape.network ? 'nonzero' : (shape.fillRule ?? 'nonzero'));
				return fill;
			});
			if (shape.strokeWidth) {
				const variable = designVariableStrokeContours(shape);
				const filledStroke = (contours: ReturnType<typeof designEndpointContours>) => {
					const path = mainWindow.document.createElementNS(SVG_NAMESPACE, 'path');
					path.setAttribute('data-design-stroke', '');
					path.setAttribute('d', designPathData(contours, shape));
					path.setAttribute('fill', shape.stroke ?? shape.fill);
					path.setAttribute('fill-rule', 'nonzero');
					children.push(path);
				};
				if (variable.length) {
					filledStroke(variable);
				} else {
					for (const layer of designStrokeLayers(shape)) {
						const stroke = mainWindow.document.createElementNS(SVG_NAMESPACE, 'path');
						stroke.setAttribute('data-design-stroke', '');
						stroke.setAttribute('d', designPathData(layer.contours, shape));
						stroke.setAttribute('fill', 'none');
						for (const [key, value] of Object.entries({
							stroke: shape.stroke ?? shape.fill,
							'stroke-width': layer.width,
							'stroke-linecap': shape.dashArray?.length ? (shape.strokeCap ?? 'butt') : 'butt',
							'stroke-linejoin': shape.strokeJoin ?? 'miter',
							'stroke-dasharray': shape.dashArray?.join(' ') || 'none',
						})) {
							stroke.setAttribute(key, String(value));
						}
						if (layer.alignment !== 'center') {
							const id = `stroke-${generateUuid()}`,
								outside = layer.alignment === 'outside',
								clip = mainWindow.document.createElementNS(SVG_NAMESPACE, outside ? 'mask' : 'clipPath');
							clip.id = id;
							const boundary = mainWindow.document.createElementNS(SVG_NAMESPACE, 'path');
							boundary.setAttribute('d', designPathData(layer.contours, shape));
							boundary.setAttribute('fill', outside ? '#000000' : '#ffffff');
							boundary.setAttribute('fill-rule', shape.fillRule ?? 'nonzero');
							boundary.setAttribute('clip-rule', shape.fillRule ?? 'nonzero');
							if (outside) {
								clip.setAttribute('maskUnits', 'userSpaceOnUse');
								clip.setAttribute('maskContentUnits', 'userSpaceOnUse');
								const points = layer.contours.flatMap(contour => contour.nodes.flatMap(node => [node, node.incoming, node.outgoing])),
									pad = layer.width * 4 + 1;
								const left = Math.min(...points.map(p => p.x)) * shape.width + shape.x - pad,
									top = Math.min(...points.map(p => p.y)) * shape.height + shape.y - pad;
								const width = Math.max(...points.map(p => p.x)) * shape.width + shape.x + pad - left,
									height = Math.max(...points.map(p => p.y)) * shape.height + shape.y + pad - top;
								const background = mainWindow.document.createElementNS(SVG_NAMESPACE, 'rect');
								for (const [key, value] of Object.entries({ x: left, y: top, width, height })) {
									background.setAttribute(key, String(value));
									clip.setAttribute(key, String(value));
								}
								background.setAttribute('fill', '#ffffff');
								clip.append(background);
							}
							clip.append(boundary);
							children.push(clip);
							stroke.setAttribute(outside ? 'mask' : 'clip-path', `url(#${id})`);
						}
						children.push(stroke);
					}
					const ends = designEndpointContours(shape);
					if (ends.length) {
						filledStroke(ends);
					}
				}
			}
			element.replaceChildren(...children);
			return paintShape(element, shape, images, backdrop);
		}
		element.setAttribute('d', designPathData(designPathStrokeContours(shape), shape));
		element.setAttribute('fill', designPathStrokeContours(shape).some(contour => contour.closed) ? shape.fill : 'none');
		element.setAttribute('fill-rule', shape.fillRule ?? 'nonzero');
		element.setAttribute('stroke', shape.stroke ?? shape.fill);
		element.setAttribute('stroke-width', `${shape.strokeWidth}`);
		element.setAttribute('stroke-linecap', shape.strokeCap ?? 'butt');
		element.setAttribute('stroke-linejoin', shape.strokeJoin ?? 'miter');
		element.setAttribute('stroke-dasharray', shape.dashArray?.join(' ') || 'none');
	} else {
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			element.setAttribute(key, `${shape[key]}`);
		}
		if (shape.kind === 'group' || shape.kind === 'frame') {
			element.setAttribute('viewBox', shape.kind === 'group' ? `0 0 ${shape.contentWidth} ${shape.contentHeight}` : `0 0 ${shape.width} ${shape.height}`);
			element.setAttribute('overflow', shape.kind === 'frame' && shape.clip ? 'hidden' : 'visible');
			element.setAttribute('preserveAspectRatio', 'none');
			const children: SVGElement[] = [];
			if (shape.kind === 'frame') {
				const background =
					element.firstElementChild?.tagName === 'rect' && !element.firstElementChild.hasAttribute('data-shape-id')
						? element.firstElementChild
						: mainWindow.document.createElementNS(SVG_NAMESPACE, 'rect');
				background.setAttribute('data-design-fill', '');
				background.setAttribute('width', `${shape.width}`);
				background.setAttribute('height', `${shape.height}`);
				background.setAttribute('fill', shape.fill);
				children.push(background as SVGRectElement);
			}
			if (shape.kind === 'group' && shape.booleanOperation) {
				const path = mainWindow.document.createElementNS(SVG_NAMESPACE, 'path');
				path.setAttribute('data-design-fill', '');
				path.setAttribute(
					'd',
					designPathData(getDesignVectorContours(shape), {
						x: 0,
						y: 0,
						width: shape.contentWidth,
						height: shape.contentHeight,
					}),
				);
				path.setAttribute('fill', shape.fill);
				path.setAttribute('fill-rule', 'nonzero');
				children.push(path);
			} else {
				const needsBackdrop = flattenDesignShapes(shape.children).some(child => designEffects(child).some(effect => effect.visible !== false && effect.type === 'background-blur'));
				const behind = needsBackdrop ? designChildBackdrop(shape, backdrop, element.ownerDocument) : [];
				if (needsBackdrop && shape.kind === 'frame') {
					const background = mainWindow.document.createElementNS(SVG_NAMESPACE, 'rect');
					background.setAttribute('width', String(shape.width));
					background.setAttribute('height', String(shape.height));
					background.setAttribute('fill', shape.fill);
					behind.push(
						applyDesignPaints(background, {
							...shape,
							kind: 'rectangle',
							x: 0,
							y: 0,
							rotation: 0,
							effects: undefined,
						}),
					);
				}
				for (const [index, child] of shape.children.entries()) {
					const rendered = renderDesignShape(child, element.children[index + (shape.kind === 'frame' ? 1 : 0)] as SVGGraphicsElement | undefined, images, behind);
					children.push(rendered);
					behind.push(rendered);
				}
			}
			if (shape.kind === 'frame' && shape.layoutGuide) {
				const guide = mainWindow.document.createElementNS(SVG_NAMESPACE, 'svg');
				guide.setAttribute('data-layout-guide', '');
				guide.setAttribute('width', `${shape.width}`);
				guide.setAttribute('height', `${shape.height}`);
				guide.style.pointerEvents = 'none';
				const pattern = mainWindow.document.createElementNS(SVG_NAMESPACE, 'pattern');
				pattern.id = `guide-${shape.id}`;
				pattern.setAttribute('width', `${shape.layoutGuide.size}`);
				pattern.setAttribute('height', `${shape.layoutGuide.size}`);
				pattern.setAttribute('patternUnits', 'userSpaceOnUse');
				const path = mainWindow.document.createElementNS(SVG_NAMESPACE, 'path');
				path.setAttribute('d', `M ${shape.layoutGuide.size} 0 L 0 0 0 ${shape.layoutGuide.size}`);
				path.setAttribute('fill', 'none');
				path.setAttribute('stroke', shape.layoutGuide.color);
				path.setAttribute('stroke-width', '1');
				pattern.append(path);
				const rect = mainWindow.document.createElementNS(SVG_NAMESPACE, 'rect');
				rect.setAttribute('width', '100%');
				rect.setAttribute('height', '100%');
				rect.setAttribute('fill', `url(#${pattern.id})`);
				guide.append(pattern, rect);
				children.push(guide);
			}
			for (const [index, child] of children.entries()) {
				const previous = element.children[index];
				if (!previous) {
					element.append(child);
				} else if (previous !== child) {
					previous.replaceWith(child);
				}
			}
			while (element.children.length > children.length) {
				element.lastElementChild!.remove();
			}
		} else if (shape.kind === 'image') {
			const source = images.get(shape.assetVersionId);
			if (!source) {
				throw new Error(localize('sessions.design.imageSourceMissing', 'Image preview is missing: {0}', shape.assetVersionId));
			}
			const crop = shape.crop;
			element.setAttribute('viewBox', `${crop.x * source.width} ${crop.y * source.height} ${crop.width * source.width} ${crop.height * source.height}`);
			element.setAttribute('overflow', 'hidden');
			element.setAttribute('preserveAspectRatio', 'xMidYMid slice');
			const image = element.firstElementChild?.tagName === 'image' ? element.firstElementChild : mainWindow.document.createElementNS(SVG_NAMESPACE, 'image');
			image.setAttribute('href', source.url);
			image.setAttribute('width', `${source.width}`);
			image.setAttribute('height', `${source.height}`);
			if (image.parentNode !== element) {
				element.replaceChildren(image);
			}
		} else if (shape.kind === 'text') {
			element.setAttribute('overflow', shape.textTruncate ? 'hidden' : 'visible');
			element.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
			const foreignObject = mainWindow.document.createElementNS(SVG_NAMESPACE, 'foreignObject');
			foreignObject.setAttribute('data-design-fill', '');
			foreignObject.setAttribute('width', String(shape.width));
			foreignObject.setAttribute('height', String(shape.height));
			foreignObject.style.overflow = 'visible';
			const content = renderDesignTextFrame(mainWindow.document, shape);
			foreignObject.append(content);
			element.replaceChildren(foreignObject);
		}
	}
	return paintShape(element, shape, images, backdrop);
}

export function exportDesignSvg(document: DesignDocument, images: ReadonlyMap<string, DesignImageSource> = new Map()): string {
	const svg = mainWindow.document.createElementNS(SVG_NAMESPACE, 'svg');
	const bounds = getDesignRenderBounds(document.shapes);

	const padding = Math.max(0, ...document.shapes.map(shape => renderStrokePadding(shape) + designEffectPadding(shape)));
	svg.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`);
	svg.setAttribute('width', `${bounds.width + padding * 2}`);
	svg.setAttribute('height', `${bounds.height + padding * 2}`);
	const backdrop: SVGGraphicsElement[] = [];
	for (const shape of document.shapes) {
		const rendered = renderDesignShape(shape, undefined, images, backdrop);
		svg.append(rendered);
		backdrop.push(rendered);
	}
	for (const guide of svg.querySelectorAll('[data-layout-guide], [data-design-hit-area]')) {
		guide.remove();
	}
	for (const element of svg.querySelectorAll('[data-shape-id], [data-paint-id], [data-design-fills]')) {
		for (const attribute of ['data-shape-id', 'data-paint-id', 'data-design-fills']) {
			element.removeAttribute(attribute);
		}
	}
	return new mainWindow.XMLSerializer().serializeToString(svg) + '\n';
}

/** Unclipped containers include overflowing content in exports without changing their editable geometry. */
export function getDesignRenderBounds(shapes: readonly DesignShape[]): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	return designBounds(
		shapes
			.filter(shape => shape.visible !== false)
			.flatMap(shape => {
				if (shape.kind === 'path') {
					const angle = (shape.rotation * Math.PI) / 180;
					const points = [...designPathStrokeContours(shape), ...designEndpointContours(shape), ...designVariableStrokeContours(shape)]
						.flatMap(contour => contour.nodes.flatMap(node => [node, node.incoming, node.outgoing]))
						.map(point => {
							const dx = (point.x - 0.5) * shape.width,
								dy = (point.y - 0.5) * shape.height;
							return {
								x: shape.x + shape.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
								y: shape.y + shape.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
							};
						});
					const left = Math.min(...points.map(point => point.x)),
						top = Math.min(...points.map(point => point.y));
					return [
						shape,
						{
							x: left,
							y: top,
							width: Math.max(1, Math.max(...points.map(point => point.x)) - left),
							height: Math.max(1, Math.max(...points.map(point => point.y)) - top),
							rotation: 0,
						},
					];
				}
				if (shape.kind === 'text' && !shape.textTruncate) {
					const size = measureDesignText(shape, shape.textAutoResize === 'width' && shape.sizing?.width !== 'fill' && !shape.sizeLimits?.maxWidth ? undefined : shape.width);
					const offset = shape.textVerticalAlign === 'center' ? (shape.height - size.height) / 2 : shape.textVerticalAlign === 'bottom' ? shape.height - size.height : 0;
					const dy = offset + size.height / 2 - shape.height / 2;
					const radians = (shape.rotation * Math.PI) / 180;
					return [
						shape,
						{
							...shape,
							x: shape.x - dy * Math.sin(radians),
							y: shape.y + shape.height / 2 + dy * Math.cos(radians) - size.height / 2,
							width: Math.max(shape.width, size.width),
							height: size.height,
						},
					];
				}
				if ((shape.kind !== 'frame' && shape.kind !== 'group') || (shape.kind === 'frame' && shape.clip) || shape.children.length === 0) {
					return [shape];
				}
				const child = getDesignRenderBounds(shape.children);
				const scale = shape.kind === 'group' ? shape.width / shape.contentWidth : 1;
				const angle = (shape.rotation * Math.PI) / 180;
				const dx = (child.x + child.width / 2) * scale - shape.width / 2;
				const dy = (child.y + child.height / 2) * scale - shape.height / 2;
				return [
					shape,
					{
						x: shape.x + shape.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - (child.width * scale) / 2,
						y: shape.y + shape.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - (child.height * scale) / 2,
						width: child.width * scale,
						height: child.height * scale,
						rotation: shape.rotation,
					},
				];
			}),
	);
}
