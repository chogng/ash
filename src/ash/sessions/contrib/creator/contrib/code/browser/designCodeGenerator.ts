import { designEffectPadding } from '../../../common/model/designEffects.js';
import { designPaintBackground } from '../../../browser/designPaintRendering.js';
import { renderDesignTextFrame } from '../../../browser/designTextRendering.js';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { localize } from '../../../../../../nls.js';
import { flattenDesignShapes, serializeDesignDocument, type DesignDocument, type DesignGridTrack, type DesignShape } from '../../../common/model/document.js';
import { getDesignGridCells } from '../../../common/model/layout.js';
import type { DesignImageSource } from '../../../browser/designMedia.js';
import { getDesignRenderBounds, renderDesignShape } from '../../../browser/svgRenderer.js';

/** Generates runnable source from committed data, retaining IDs and JSON for agent edits. */
export function generateDesignCode(document: DesignDocument, images: ReadonlyMap<string, DesignImageSource> = new Map()): string {
	const ownerDocument = mainWindow.document;
	const scene = ownerDocument.createElement('div');
	scene.className = 'ash-design-scene';
	const rules = ['body { margin: 0; }', '.ash-design-scene { position: relative; overflow: visible; }', '.ash-design-object { position: absolute; transform-origin: center; }'];
	const frames = document.shapes.flatMap(shape => [shape, ...(shape.motion?.keyframes.map(frame => ({ ...shape, ...frame })) ?? [])]);
	const bounds = getDesignRenderBounds(frames);
	const padding = strokePadding(document.shapes) + Math.max(0, ...document.shapes.map(designEffectPadding));
	rules.push(`.ash-design-scene { width: ${bounds.width + padding * 2}px; height: ${bounds.height + padding * 2}px; }`);
	function render(shape: DesignShape, originX: number, originY: number, parent?: Extract<DesignShape, { kind: 'frame' }>, backdrop: readonly SVGGraphicsElement[] = []): HTMLElement {
		const node = ownerDocument.createElement('div');
		const className = `ash-design-object-${shape.id}`;
		node.className = `ash-design-object ${className}`;
		node.dataset.designId = shape.id;
		node.dataset.designKind = shape.kind;
		if (shape.name) {
			node.setAttribute('aria-label', shape.name);
		}
		const geometry = `left: ${shape.x - originX}px; top: ${shape.y - originY}px; width: ${shape.width}px; height: ${shape.height}px; transform: rotate(${shape.rotation}deg);`;
		let appearance = '';
		const stackedEffects = flattenDesignShapes([shape]).some(layer => Array.isArray(layer.effects) && layer.effects.length > 0);
		if (stackedEffects) {
			const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '100%');
			svg.setAttribute('height', '100%');
			svg.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
			svg.setAttribute('overflow', 'visible');
			const behind = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
			behind.setAttribute('transform', `translate(${-shape.x} ${-shape.y})`);
			behind.append(...backdrop.map(element => element.cloneNode(true)));
			svg.append(renderDesignShape({ ...shape, x: 0, y: 0, rotation: 0, opacity: 1 }, undefined, images, [behind]));
			node.append(svg);
		} else if (shape.blendMode === 'plus-darker') {
			const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '100%');
			svg.setAttribute('height', '100%');
			svg.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
			svg.setAttribute('overflow', 'visible');
			svg.append(renderDesignShape({ ...shape, x: 0, y: 0, rotation: 0, opacity: 1, effects: undefined }, undefined, images));
			node.append(svg);
		} else if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
			appearance = ` background: ${shape.fills !== undefined ? 'transparent' : shape.fill};${shape.kind === 'ellipse' ? ' border-radius: 50%;' : ''}`;
		} else if (shape.kind === 'frame') {
			appearance = ` background: ${shape.fills !== undefined ? 'transparent' : shape.fill}; overflow: ${shape.clip ? 'hidden' : 'visible'};`;
			if (shape.autoLayout) {
				const layout = shape.autoLayout;
				const align = {
					start: 'flex-start',
					center: 'center',
					end: 'flex-end',
					'space-between': 'space-between',
				};
				appearance += ` box-sizing: border-box; padding: ${layout.padding.top}px ${layout.padding.right}px ${layout.padding.bottom}px ${layout.padding.left}px;`;
				if (layout.direction === 'grid' && layout.grid) {
					const grid = layout.grid;
					const cells = getDesignGridCells(
						shape.children.filter(child => child.visible !== false && child.layoutPositioning !== 'absolute'),
						grid,
					);
					const rowCount = Math.max(grid.autoRows ? 0 : grid.rows.length, ...cells.map(cell => cell.row + cell.rowSpan));
					const rows = Array.from({ length: rowCount }, (_, index) => grid.rows[index] ?? ({ sizing: 'fill', value: 1 } as const));
					appearance += ` display: grid; grid-template-columns: ${grid.columns.map(trackCss).join(' ')}; grid-template-rows: ${rows.map(trackCss).join(' ') || 'none'}; grid-auto-rows: minmax(0, 1fr); column-gap: ${layout.gap}px; row-gap: ${layout.crossGap ?? layout.gap}px; justify-items: start; align-items: start;`;
				} else {
					const horizontal = layout.direction === 'horizontal';
					appearance += ` display: flex; flex-direction: ${horizontal ? 'row' : 'column'}; flex-wrap: ${layout.wrap ? 'wrap' : 'nowrap'}; column-gap: ${horizontal ? layout.gap : (layout.crossGap ?? layout.gap)}px; row-gap: ${horizontal ? (layout.crossGap ?? layout.gap) : layout.gap}px; align-items: ${align[layout.align]}; align-content: ${align[layout.align]}; justify-content: ${align[layout.justify]};`;
				}
				for (const axis of ['width', 'height'] as const) {
					if (layout[axis] === 'hug' && !(parent?.autoLayout && shape.layoutPositioning !== 'absolute' && shape.sizing?.[axis] === 'fill')) {
						appearance += ` ${axis}: max-content; min-${axis}: 0.001px;`;
					}
				}
			}
			node.append(...shape.children.map(child => render(child, 0, 0, shape)));
		} else if (shape.kind === 'group' && !shape.booleanOperation) {
			const content = ownerDocument.createElement('div');
			content.className = `${className}-content`;
			rules.push(
				`.${className}-content { width: ${shape.contentWidth}px; height: ${shape.contentHeight}px; transform-origin: top left; transform: scale(${shape.width / shape.contentWidth}); }`,
			);
			content.append(...shape.children.map(child => render(child, 0, 0)));
			node.append(content);
		} else if (shape.kind === 'text' && shape.fills === undefined) {
			node.append(renderDesignTextFrame(ownerDocument, shape));
			if (shape.textAutoResize === 'width' && shape.sizing?.width !== 'fill') {
				appearance += ' width: max-content;';
			}
			if (shape.textAutoResize && shape.textAutoResize !== 'none' && shape.sizing?.height !== 'fill') {
				appearance += ' height: auto;';
			}
			appearance += ` overflow: ${shape.textTruncate ? 'hidden' : 'visible'};`;
		} else {
			const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', `${shape.width}`);
			svg.setAttribute('height', `${shape.height}`);
			svg.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
			svg.setAttribute('overflow', 'visible');
			svg.append(renderDesignShape({ ...shape, x: 0, y: 0, rotation: 0, opacity: 1, effects: undefined, blendMode: undefined }, undefined, images));
			svg.querySelector('[data-shape-id]')!.removeAttribute('data-shape-id');
			if (shape.sizing?.width === 'fill') {
				svg.setAttribute('width', '100%');
			}
			if (shape.sizing?.height === 'fill') {
				svg.setAttribute('height', '100%');
			}
			node.append(svg);
		}
		if (!stackedEffects && shape.blendMode !== 'plus-darker' && shape.fills !== undefined && (shape.kind === 'rectangle' || shape.kind === 'ellipse' || shape.kind === 'frame')) {
			const backdrop = ownerDocument.createElement('div');
			backdrop.style.position = 'absolute';
			backdrop.style.inset = '0';
			backdrop.style.pointerEvents = 'none';
			backdrop.style.borderRadius = 'inherit';
			for (const paint of shape.fills.slice().reverse()) {
				if (paint.visible === false) {
					continue;
				}
				if (paint.blendMode === 'plus-darker') {
					const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
					svg.setAttribute('width', '100%');
					svg.setAttribute('height', '100%');
					svg.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
					svg.style.position = 'absolute';
					svg.style.inset = '0';
					svg.append(
						renderDesignShape(
							{
								id: shape.id,
								kind: shape.kind === 'ellipse' ? 'ellipse' : 'rectangle',
								x: 0,
								y: 0,
								width: shape.width,
								height: shape.height,
								rotation: 0,
								fill: shape.fill,
								fills: [paint],
							},
							undefined,
							images,
						),
					);
					backdrop.append(svg);
				} else {
					const layer = ownerDocument.createElement('div');
					Object.assign(layer.style, {
						position: 'absolute',
						inset: '0',
						borderRadius: 'inherit',
						backgroundImage: designPaintBackground(ownerDocument, paint, shape.width, shape.height),
						backgroundSize: '100% 100%',
						opacity: String(paint.opacity ?? 1),
						mixBlendMode: paint.blendMode ?? 'normal',
					});
					backdrop.append(layer);
				}
			}
			node.prepend(backdrop);
		}
		appearance += ` mix-blend-mode: ${!stackedEffects && shape.blendMode && shape.blendMode !== 'pass-through' && shape.blendMode !== 'plus-darker' ? shape.blendMode : 'normal'}; isolation: ${!stackedEffects && shape.blendMode && shape.blendMode !== 'pass-through' && shape.blendMode !== 'plus-darker' ? 'isolate' : 'auto'};`;
		if (parent?.autoLayout && shape.visible !== false && shape.layoutPositioning !== 'absolute') {
			appearance += ' position: relative; left: auto; top: auto; flex-shrink: 0;';
			const layout = parent.autoLayout;
			if (layout.direction === 'grid' && layout.grid) {
				const grid = layout.grid;
				const cell = getDesignGridCells(
					parent.children.filter(child => child.visible !== false && child.layoutPositioning !== 'absolute'),
					grid,
				)[parent.children.filter(child => child.visible !== false && child.layoutPositioning !== 'absolute').findIndex(child => child.id === shape.id)];
				appearance += ` grid-column: ${grid.positioning === 'manual' ? cell.column + 1 + ' / ' : ''}span ${cell.columnSpan}; grid-row: ${grid.positioning === 'manual' ? cell.row + 1 + ' / ' : ''}span ${cell.rowSpan}; justify-self: ${shape.gridCell?.horizontal ?? 'start'}; align-self: ${shape.gridCell?.vertical ?? 'start'};`;
				for (const axis of ['width', 'height'] as const) {
					if (shape.kind !== 'group' && shape.sizing?.[axis] === 'fill') {
						appearance += ` ${axis}: 100%; min-${axis}: 0.001px;`;
					}
				}
			} else {
				const main = layout.direction === 'horizontal' ? 'width' : 'height';
				const cross = main === 'width' ? 'height' : 'width';
				if (shape.kind !== 'group' && shape.sizing?.[main] === 'fill' && (layout[main] === 'fixed' || parent.sizing?.[main] === 'fill')) {
					appearance += ` ${main}: 0; min-${main}: 0.001px; flex-grow: 1; flex-basis: 0;`;
				}
				if (shape.kind !== 'group' && shape.sizing?.[cross] === 'fill' && (layout[cross] === 'fixed' || parent.sizing?.[cross] === 'fill')) {
					appearance += ` ${cross}: auto; align-self: stretch;`;
				}
			}
		} else if (parent && shape.constraints) {
			for (const [axis, size, start, end] of [
				['horizontal', 'width', 'left', 'right'],
				['vertical', 'height', 'top', 'bottom'],
			] as const) {
				const position = axis === 'horizontal' ? shape.x : shape.y;
				const mode = shape.constraints[axis];
				if (mode === 'end') {
					appearance += ` ${start}: auto; ${end}: ${parent[size] - position - shape[size]}px;`;
				}
				if (mode === 'center') {
					appearance += ` ${start}: calc(50% + ${position - parent[size] / 2}px);`;
				}
				if (mode === 'stretch') {
					appearance += ` ${size}: auto; ${end}: ${parent[size] - position - shape[size]}px;`;
				}
				if (mode === 'scale') {
					appearance += ` ${start}: ${(position / parent[size]) * 100}%; ${size}: ${(shape[size] / parent[size]) * 100}%;`;
				}
			}
		}
		for (const [field, property] of [
			['minWidth', 'min-width'],
			['maxWidth', 'max-width'],
			['minHeight', 'min-height'],
			['maxHeight', 'max-height'],
		] as const) {
			const value = shape.sizeLimits?.[field];
			if (value !== undefined) {
				appearance += ` ${property}: ${value}px;`;
			}
		}
		const legacyShadow = shape.effects && 'x' in shape.effects ? shape.effects : undefined;
		appearance += ` opacity: ${shape.opacity ?? 1};${shape.visible === false ? ' display: none;' : ''}${legacyShadow || (!stackedEffects && shape.blendMode && shape.blendMode !== 'pass-through' && shape.blendMode !== 'plus-darker') ? ` filter: ${legacyShadow ? `drop-shadow(${legacyShadow.x}px ${legacyShadow.y}px ${legacyShadow.blur / 2}px ${legacyShadow.color}) ` : ''}opacity(1);` : ''}`;
		if (shape.motion) {
			const motion = shape.motion;
			appearance += ` animation: ${className}-motion ${motion.duration}ms linear ${motion.loop ? 'infinite' : '1'} both;`;
			const keyframes = motion.keyframes.map(
				frame => `  ${frame.offset * 100}% { transform: translate(${frame.x - shape.x}px, ${frame.y - shape.y}px) rotate(${frame.rotation}deg); opacity: ${frame.opacity}; }`,
			);
			rules.push(`@keyframes ${className}-motion {\n${keyframes.join('\n')}\n}`);
		}
		rules.push(`.${className} { ${geometry}${appearance} }`);
		return node;
	}
	const backdrop: SVGGraphicsElement[] = [];
	for (const shape of document.shapes) {
		scene.append(render(shape, bounds.x - padding, bounds.y - padding, undefined, backdrop));
		backdrop.push(renderDesignShape(shape, undefined, images, backdrop));
	}
	const title = ownerDocument.createElement('title');
	title.textContent = localize('sessions.design.codeTitle', 'Ash design');
	// A raw-text script cannot contain a literal closing tag, even for inert JSON.
	const data = serializeDesignDocument(document).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
	return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${title.outerHTML}\n<style>\n${rules.join('\n')}\n@media (prefers-reduced-motion: reduce) { .ash-design-object { animation: none; } }\n</style>\n</head>\n<body>\n${scene.outerHTML}\n<script type="application/json" id="ash-design-document">\n${data}</script>\n</body>\n</html>\n`;
}

function strokePadding(shapes: readonly DesignShape[]): number {
	return Math.max(
		0,
		...shapes.map(shape => {
			if (shape.kind === 'path') {
				return shape.strokeWidth;
			}
			if (shape.kind === 'frame') {
				return shape.clip ? 0 : strokePadding(shape.children);
			}
			if (shape.kind === 'group') {
				return (strokePadding(shape.children) * shape.width) / shape.contentWidth;
			}
			return 0;
		}),
	);
}

function trackCss(track: DesignGridTrack): string {
	return track.sizing === 'hug' ? 'max-content' : track.sizing === 'fixed' ? `${track.value}px` : `minmax(0, ${track.value}fr)`;
}
