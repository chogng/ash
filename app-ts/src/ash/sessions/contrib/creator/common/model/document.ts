import { CreatorMode } from '../creator.js';
import { localize } from '../../../../../nls.js';
import { isRecord } from '../../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../../base/common/uuid.js';
import type { DesignFrame, DesignPoint } from '../core/geometry.js';

/** Geometry is in design pixels, independent of zoom and the display's pixel ratio. */
export interface DesignShapeGeometry extends DesignFrame {
	readonly id: string;
	readonly fill: string;
	readonly motion?: DesignMotion;
}

/** Positions are in the object's parent coordinates, matching static geometry. */
export interface DesignKeyframe {
	readonly offset: number;
	readonly x: number;
	readonly y: number;
	readonly rotation: number;
	readonly opacity: number;
}

export interface DesignMotion {
	readonly duration: number;
	readonly loop: boolean;
	readonly keyframes: readonly DesignKeyframe[];
}

/** Path points use fractions of the shape bounds, so resizing preserves the curve. */
export interface DesignPathNode extends DesignPoint {
	readonly incoming: DesignPoint;
	readonly outgoing: DesignPoint;
}

export type DesignShape = DesignShapeGeometry & (
	{ readonly kind: 'rectangle' | 'ellipse'; }
	| { readonly kind: 'text'; readonly text: string; readonly fontSize: number; }
	| { readonly kind: 'path'; readonly nodes: readonly DesignPathNode[]; readonly closed: boolean; readonly strokeWidth: number; }
	| { readonly kind: 'group'; readonly children: readonly DesignShape[]; readonly contentWidth: number; readonly contentHeight: number; }
	| { readonly kind: 'frame'; readonly children: readonly DesignShape[]; readonly clip: boolean; }
	| { readonly kind: 'image'; readonly assetId: string; readonly assetVersionId: string; readonly crop: DesignImageCrop; }
);

export interface DesignImageCrop {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface DesignAssetVersion {
	readonly id: string;
	readonly sha256: string;
	readonly path: string;
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
	readonly width: number;
	readonly height: number;
}

export interface DesignAsset {
	readonly id: string;
	readonly name: string;
	readonly versions: readonly DesignAssetVersion[];
}

/** The immutable tree owns live content; the file codec writes an indexed object table. */
export interface DesignDocument {
	readonly schemaVersion: 2;
	readonly mode: CreatorMode;
	readonly documentId: string;
	readonly artifactId: string;
	/** Array order is paint order, from back to front. */
	readonly shapes: readonly DesignShape[];
	readonly assets: readonly DesignAsset[];
}

function freezeShape(shape: DesignShape): DesignShape {
	if (shape.motion) {
		shape = { ...shape, motion: Object.freeze({ ...shape.motion, keyframes: Object.freeze(shape.motion.keyframes.map(frame => Object.freeze({ ...frame }))) }) };
	}
	if (shape.kind === 'image') {
		return Object.freeze({ ...shape, crop: Object.freeze({ ...shape.crop }) });
	}
	if (shape.kind === 'group' || shape.kind === 'frame') {
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

export function documentFromShapes(shapes: readonly DesignShape[], identity: Pick<DesignDocument, 'documentId' | 'artifactId'> & Partial<Pick<DesignDocument, 'mode'>> = { documentId: generateUuid(), artifactId: generateUuid() }, assets: readonly DesignAsset[] = []): DesignDocument {
	return Object.freeze({ schemaVersion: 2, ...identity, mode: identity.mode ?? CreatorMode.Design, shapes: Object.freeze(shapes.map(freezeShape)), assets: Object.freeze(assets.map(asset => Object.freeze({ ...asset, versions: Object.freeze(asset.versions.map(version => Object.freeze({ ...version }))) }))) });
}

/** Rejects the complete file before any active document state changes. */
export function parseDesignDocument(content: string): DesignDocument {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value)) { throw new TypeError(localize('sessions.design.invalidDocument', 'Invalid design document')); }
	const ids = new Set<string>();
	if (value.version === 1) {
		if (!Array.isArray(value.shapes) || Object.keys(value).some(key => key !== 'version' && key !== 'shapes')) { throw new TypeError(localize('sessions.design.invalidDocument', 'Invalid design document')); }
		const shapes = value.shapes.map(shape => parseShape(shape, ids));
		if (flattenDesignShapes(shapes).some(shape => shape.kind === 'frame' || shape.kind === 'image')) { throw new TypeError(localize('sessions.design.invalidUnsupportedVersion1Object', 'Unsupported version 1 object')); }
		return documentFromShapes(shapes);
	}
	if (value.schemaVersion !== 2 || !isUuid(value.documentId) || !Array.isArray(value.artifactOrder) || value.artifactOrder.length !== 1 || !isUuid(value.artifactOrder[0]) || !isRecord(value.artifacts) || !isRecord(value.assets)
		|| Object.keys(value).some(key => !['schemaVersion', 'documentId', 'artifactOrder', 'artifacts', 'assets'].includes(key))) { throw new TypeError(localize('sessions.design.invalidDocument', 'Invalid design document')); }
	const artifactId = value.artifactOrder[0];
	const artifact = value.artifacts[artifactId];
	if (Object.keys(value.artifacts).length !== 1 || !isRecord(artifact) || artifact.kind !== 'composition' || !Array.isArray(artifact.roots) || !isRecord(artifact.objects)
		|| Object.keys(artifact).some(key => !['kind', 'mode', 'roots', 'objects'].includes(key))) { throw new TypeError(localize('sessions.design.invalidComposition', 'Invalid design composition')); }
	const mode = artifact.mode === undefined ? CreatorMode.Design : artifact.mode;
	if (!Object.values(CreatorMode).includes(mode as CreatorMode)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Creator document mode.')); }
	const objects = artifact.objects;
	const visited = new Set<string>();
	function readObject(id: unknown): unknown {
		if (!isUuid(id) || visited.has(id)) { throw new TypeError(localize('sessions.design.invalidObjectOwnership', 'Invalid design object ownership')); }
		visited.add(id);
		const object = objects[id];
		if (!isRecord(object) || object.id !== id) { throw new TypeError(localize('sessions.design.invalidObjectReference', 'Invalid design object reference')); }
		if (object.kind === 'group' || object.kind === 'frame') {
			if (!Array.isArray(object.children)) { throw new TypeError(localize('sessions.design.invalidContainer', 'Invalid design container')); }
			return { ...object, children: object.children.map(readObject) };
		}
		return object;
	}
	const shapes = artifact.roots.map(id => parseShape(readObject(id), ids));
	if (visited.size !== Object.keys(objects).length) { throw new TypeError(localize('sessions.design.invalidUnownedDesignObject', 'Unowned design object')); }
	const versionIds = new Set<string>();
	const assets = Object.entries(value.assets).map(([id, asset]): DesignAsset => {
		if (!isUuid(id) || !isRecord(asset) || asset.id !== id || typeof asset.name !== 'string' || !Array.isArray(asset.versions) || asset.versions.length === 0 || Object.keys(asset).some(key => !['id', 'name', 'versions'].includes(key))) { throw new TypeError(localize('sessions.design.invalidAsset', 'Invalid design asset')); }
		const versions = asset.versions.map((version: unknown): DesignAssetVersion => {
			if (!isRecord(version) || !isUuid(version.id) || versionIds.has(version.id) || typeof version.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(version.sha256) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(version.mediaType)) || !Number.isSafeInteger(version.width) || !isPositiveNumber(version.width) || !Number.isSafeInteger(version.height) || !isPositiveNumber(version.height)
				|| version.path !== `assets/${version.sha256}` || Object.keys(version).some(key => !['id', 'sha256', 'path', 'mediaType', 'width', 'height'].includes(key))) { throw new TypeError(localize('sessions.design.invalidAssetVersion', 'Invalid design asset version')); }
			versionIds.add(version.id);
			return { id: version.id, sha256: version.sha256, path: version.path, mediaType: version.mediaType as DesignAssetVersion['mediaType'], width: version.width, height: version.height };
		});
		return { id, name: asset.name, versions };
	});
	for (const shape of flattenDesignShapes(shapes)) {
		if (shape.kind === 'image' && !assets.some(asset => asset.id === shape.assetId && asset.versions.some(version => version.id === shape.assetVersionId))) { throw new TypeError(localize('sessions.design.invalidMissingDesignAssetVersion', 'Missing design asset version')); }
	}
	return documentFromShapes(shapes, { documentId: value.documentId, artifactId, mode: mode as CreatorMode }, assets);
}

/** Containers retain the only copy of their children; consumers derive identity lookup from this tree. */
export function flattenDesignShapes(shapes: readonly DesignShape[]): readonly DesignShape[] {
	return shapes.flatMap(shape => [shape, ...(shape.kind === 'group' || shape.kind === 'frame' ? flattenDesignShapes(shape.children) : [])]);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0;
}

function parsePoint(value: unknown): DesignPoint {
	if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1 || Object.keys(value).some(key => key !== 'x' && key !== 'y')) {
		throw new TypeError(localize('sessions.design.invalidPathPoint', 'Invalid design path point'));
	}
	return { x: value.x, y: value.y };
}

function parseShape(value: unknown, ids: Set<string>): DesignShape {
	if (!isRecord(value) || !isUuid(value.id) || ids.has(value.id)
		|| !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.rotation)
		|| !isPositiveNumber(value.width) || !isPositiveNumber(value.height)
		|| typeof value.fill !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value.fill)) {
		throw new TypeError(localize('sessions.design.invalidShape', 'Invalid design shape'));
	}
	ids.add(value.id);
	const geometry: DesignShapeGeometry = { id: value.id, x: value.x, y: value.y, width: value.width, height: value.height, rotation: value.rotation, fill: value.fill, ...(value.motion === undefined ? {} : { motion: parseMotion(value.motion) }) };
	const keys = ['id', 'kind', 'x', 'y', 'width', 'height', 'rotation', 'fill'];
	if (value.motion !== undefined) { keys.push('motion'); }
	let shape: DesignShape;
	switch (value.kind) {
		case 'rectangle': case 'ellipse': shape = { ...geometry, kind: value.kind }; break;
		case 'text':
			if (typeof value.text !== 'string' || !isPositiveNumber(value.fontSize)) { throw new TypeError(localize('sessions.design.invalidText', 'Invalid design text')); }
			keys.push('text', 'fontSize');
			shape = { ...geometry, kind: 'text', text: value.text, fontSize: value.fontSize };
			break;
		case 'path': {
			if (!Array.isArray(value.nodes) || value.nodes.length < 2 || typeof value.closed !== 'boolean' || !isPositiveNumber(value.strokeWidth)) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
			keys.push('nodes', 'closed', 'strokeWidth');
			const nodes = value.nodes.map((node: unknown): DesignPathNode => {
				if (!isRecord(node) || Object.keys(node).some(key => !['x', 'y', 'incoming', 'outgoing'].includes(key))) { throw new TypeError(localize('sessions.design.invalidPathNode', 'Invalid design path node')); }
				return { ...parsePoint({ x: node.x, y: node.y }), incoming: parsePoint(node.incoming), outgoing: parsePoint(node.outgoing) };
			});
			shape = { ...geometry, kind: 'path', nodes, closed: value.closed, strokeWidth: value.strokeWidth };
			break;
		}
		case 'image': {
			if (!isUuid(value.assetId) || !isUuid(value.assetVersionId) || !isRecord(value.crop)) { throw new TypeError(localize('sessions.design.invalidImage', 'Invalid design image')); }
			const crop = value.crop;
			if (!isFiniteNumber(crop.x) || !isFiniteNumber(crop.y) || !isPositiveNumber(crop.width) || !isPositiveNumber(crop.height) || crop.x < 0 || crop.y < 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1 || Object.keys(crop).some(key => !['x', 'y', 'width', 'height'].includes(key))) { throw new TypeError(localize('sessions.design.invalidImageCrop', 'Invalid design image crop')); }
			keys.push('assetId', 'assetVersionId', 'crop');
			shape = { ...geometry, kind: 'image', assetId: value.assetId, assetVersionId: value.assetVersionId, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } };
			break;
		}
		case 'frame':
			if (!Array.isArray(value.children) || typeof value.clip !== 'boolean') { throw new TypeError(localize('sessions.design.invalidFrame', 'Invalid design frame')); }
			keys.push('children', 'clip');
			shape = { ...geometry, kind: 'frame', clip: value.clip, children: value.children.map(child => parseShape(child, ids)) };
			break;
		case 'group':
			if (!Array.isArray(value.children) || value.children.length < 2 || !isPositiveNumber(value.contentWidth) || !isPositiveNumber(value.contentHeight)
				|| Math.abs(value.width / value.contentWidth - value.height / value.contentHeight) > 1e-8) { throw new TypeError(localize('sessions.design.invalidGroup', 'Invalid design group')); }
			keys.push('children', 'contentWidth', 'contentHeight');
			shape = { ...geometry, kind: 'group', children: value.children.map(child => parseShape(child, ids)), contentWidth: value.contentWidth, contentHeight: value.contentHeight };
			break;
		default: throw new TypeError(localize('sessions.design.invalidShapeKind', 'Invalid design shape kind'));
	}
	if (Object.keys(value).some(key => !keys.includes(key))) { throw new TypeError(localize('sessions.design.invalidShapeProperty', 'Invalid design shape property')); }
	return shape;
}

function parseMotion(value: unknown): DesignMotion {
	if (!isRecord(value) || !isPositiveNumber(value.duration) || typeof value.loop !== 'boolean' || !Array.isArray(value.keyframes) || value.keyframes.length < 2
		|| Object.keys(value).some(key => !['duration', 'loop', 'keyframes'].includes(key))) {
		throw new TypeError(localize('sessions.design.invalidMotion', 'Invalid design motion'));
	}
	const keyframes = value.keyframes.map((frame: unknown): DesignKeyframe => {
		if (!isRecord(frame) || !isFiniteNumber(frame.offset) || frame.offset < 0 || frame.offset > 1
			|| !isFiniteNumber(frame.x) || !isFiniteNumber(frame.y) || !isFiniteNumber(frame.rotation)
			|| !isFiniteNumber(frame.opacity) || frame.opacity < 0 || frame.opacity > 1
			|| Object.keys(frame).some(key => !['offset', 'x', 'y', 'rotation', 'opacity'].includes(key))) {
			throw new TypeError(localize('sessions.design.invalidKeyframe', 'Invalid design keyframe'));
		}
		return { offset: frame.offset, x: frame.x, y: frame.y, rotation: frame.rotation, opacity: frame.opacity };
	});
	if (keyframes[0].offset !== 0 || keyframes.at(-1)!.offset !== 1 || keyframes.some((frame, index) => index > 0 && frame.offset <= keyframes[index - 1].offset)) {
		throw new TypeError(localize('sessions.design.invalidDesignKeyframesMustBeOrderedFromZeroToOne', 'Design keyframes must be ordered from zero to one'));
	}
	return { duration: value.duration, loop: value.loop, keyframes };
}

export function serializeDesignDocument(document: DesignDocument): string {
	const objects: Record<string, unknown> = {};
	function writeObject(shape: DesignShape): void {
		if (shape.kind === 'group' || shape.kind === 'frame') {
			objects[shape.id] = { ...shape, children: shape.children.map(child => child.id) };
			shape.children.forEach(writeObject);
		} else { objects[shape.id] = shape; }
	}
	document.shapes.forEach(writeObject);
	return JSON.stringify({ schemaVersion: 2, documentId: document.documentId, artifactOrder: [document.artifactId], artifacts: { [document.artifactId]: { kind: 'composition', ...(document.mode === CreatorMode.Design ? {} : { mode: document.mode }), roots: document.shapes.map(shape => shape.id), objects } }, assets: Object.fromEntries(document.assets.map(asset => [asset.id, asset])) }, null, '\t') + '\n';
}
