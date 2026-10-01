import { isRecord } from '../../../../../base/common/types.js';
import { isUuid } from '../../../../../base/common/uuid.js';
import type { DesignFrame, DesignPoint } from '../core/geometry.js';

/** Geometry is in design pixels, independent of zoom and the display's pixel ratio. */
export interface DesignShapeGeometry extends DesignFrame {
	readonly id: string;
	readonly fill: string;
}

/** Path points use fractions of the shape bounds, so resizing preserves the curve. */
export interface DesignPathNode extends DesignPoint {
	readonly incoming: DesignPoint;
	readonly outgoing: DesignPoint;
}

export type DesignShape = DesignShapeGeometry & (
	{ readonly kind: 'rectangle' | 'ellipse' }
	| { readonly kind: 'text'; readonly text: string; readonly fontSize: number }
	| { readonly kind: 'path'; readonly nodes: readonly DesignPathNode[]; readonly closed: boolean; readonly strokeWidth: number }
	| { readonly kind: 'group'; readonly children: readonly DesignShape[]; readonly contentWidth: number; readonly contentHeight: number }
);

export interface DesignDocument {
	readonly version: 1;
	/** Array order is paint order, from back to front. */
	readonly shapes: readonly DesignShape[];
}

function freezeShape(shape: DesignShape): DesignShape {
	if (shape.kind === 'group') {
		return Object.freeze({ ...shape, children: Object.freeze(shape.children.map(freezeShape)) });
	}
	if (shape.kind === 'path') {
		const nodes = shape.nodes.map(node => Object.freeze({
			...node,
			incoming: Object.freeze({ ...node.incoming }),
			outgoing: Object.freeze({ ...node.outgoing }),
		}));
		return Object.freeze({ ...shape, nodes: Object.freeze(nodes) });
	}
	return Object.freeze({ ...shape });
}

export function documentFromShapes(shapes: readonly DesignShape[]): DesignDocument {
	return Object.freeze({ version: 1, shapes: Object.freeze(shapes.map(freezeShape)) });
}

/** Rejects the complete file before any active document state changes. */
export function parseDesignDocument(content: string): DesignDocument {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.shapes) || Object.keys(value).some(key => key !== 'version' && key !== 'shapes')) {
		throw new TypeError('Invalid design document');
	}
	const ids = new Set<string>();
	return documentFromShapes(value.shapes.map(shape => parseShape(shape, ids)));
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0;
}

function parsePoint(value: unknown): DesignPoint {
	if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1 || Object.keys(value).some(key => key !== 'x' && key !== 'y')) {
		throw new TypeError('Invalid design path point');
	}
	return { x: value.x, y: value.y };
}

function parseShape(value: unknown, ids: Set<string>): DesignShape {
	if (!isRecord(value) || !isUuid(value.id) || ids.has(value.id)
		|| !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.rotation)
		|| !isPositiveNumber(value.width) || !isPositiveNumber(value.height)
		|| typeof value.fill !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value.fill)) {
		throw new TypeError('Invalid design shape');
	}
	ids.add(value.id);
	const geometry: DesignShapeGeometry = { id: value.id, x: value.x, y: value.y, width: value.width, height: value.height, rotation: value.rotation, fill: value.fill };
	const keys = ['id', 'kind', 'x', 'y', 'width', 'height', 'rotation', 'fill'];
	let shape: DesignShape;
	switch (value.kind) {
		case 'rectangle': case 'ellipse': shape = { ...geometry, kind: value.kind }; break;
		case 'text':
			if (typeof value.text !== 'string' || !isPositiveNumber(value.fontSize)) { throw new TypeError('Invalid design text'); }
			keys.push('text', 'fontSize');
			shape = { ...geometry, kind: 'text', text: value.text, fontSize: value.fontSize };
			break;
		case 'path': {
			if (!Array.isArray(value.nodes) || value.nodes.length < 2 || typeof value.closed !== 'boolean' || !isPositiveNumber(value.strokeWidth)) { throw new TypeError('Invalid design path'); }
			keys.push('nodes', 'closed', 'strokeWidth');
			const nodes = value.nodes.map((node: unknown): DesignPathNode => {
				if (!isRecord(node) || Object.keys(node).some(key => !['x', 'y', 'incoming', 'outgoing'].includes(key))) { throw new TypeError('Invalid design path node'); }
				return { ...parsePoint({ x: node.x, y: node.y }), incoming: parsePoint(node.incoming), outgoing: parsePoint(node.outgoing) };
			});
			shape = { ...geometry, kind: 'path', nodes, closed: value.closed, strokeWidth: value.strokeWidth };
			break;
		}
		case 'group':
			if (!Array.isArray(value.children) || value.children.length < 2 || !isPositiveNumber(value.contentWidth) || !isPositiveNumber(value.contentHeight)
				|| Math.abs(value.width / value.contentWidth - value.height / value.contentHeight) > 1e-8) { throw new TypeError('Invalid design group'); }
			keys.push('children', 'contentWidth', 'contentHeight');
			shape = { ...geometry, kind: 'group', children: value.children.map(child => parseShape(child, ids)), contentWidth: value.contentWidth, contentHeight: value.contentHeight };
			break;
		default: throw new TypeError('Invalid design shape kind');
	}
	if (Object.keys(value).some(key => !keys.includes(key))) { throw new TypeError('Invalid design shape property'); }
	return shape;
}

export function serializeDesignDocument(document: DesignDocument): string {
	return JSON.stringify(document, null, '\t') + '\n';
}

