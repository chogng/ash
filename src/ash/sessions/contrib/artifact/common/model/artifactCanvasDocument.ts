import type { ArtifactCanvasEffects } from './artifactCanvasEffects.js';
import { artifactCanvasBlendModes, parseArtifactCanvasPaints, type ArtifactCanvasBlendMode, type ArtifactCanvasPaint } from './artifactCanvasPaint.js';
import { parseArtifactCanvasVectorNetwork, freezeArtifactCanvasVectorNetwork, artifactCanvasNetworkStrokeContours, type ArtifactCanvasVectorNetwork } from './artifactCanvasVectorNetwork.js';
import { isArtifactCanvasVector, type ArtifactCanvasBooleanOperation, type ArtifactCanvasPathContour } from './artifactCanvasVector.js';
import { artifactCanvasTextKeys, parseArtifactCanvasTextProperties, type ArtifactCanvasTextProperties } from './artifactCanvasText.js';
import { ArtifactWorkspaceId, isArtifactName } from '../artifactWorkspace.js';
import { localize } from '../../../../../nls.js';
import { isRecord } from '../../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../../base/common/uuid.js';
import { artifactCanvasPropertyTypes, artifactCanvasStyleFields, freezeArtifactCanvasResources, parseArtifactCanvasResources, parseArtifactCanvasResourceProperties, resourceShapeKeys, validateArtifactCanvasShapeResources, getArtifactCanvasLibraryShapes, type ArtifactCanvasBindableProperty, type ArtifactCanvasBindings, type ArtifactCanvasResources, type ArtifactCanvasStyleKind, type ArtifactCanvasLayoutGuide } from './artifactCanvasResources.js';
import { parsePrototypeProperties, prototypeFrames, prototypeScrollScope, flattenPrototypeActions, validatePrototypeExpressions, type PrototypeInteraction } from './prototype.js';
import type { CanvasFrame, CanvasPoint } from '../../../canvas/common/canvasGeometry.js';

/** Geometry is in design pixels, independent of zoom and the display's pixel ratio. */
export interface ArtifactCanvasShapeGeometry extends CanvasFrame {
	readonly id: string;
	readonly fill: string;
	readonly fills?: readonly ArtifactCanvasPaint[];
	readonly blendMode?: ArtifactCanvasBlendMode | 'pass-through';
	readonly visible?: boolean;
	readonly opacity?: number;
	readonly effects?: ArtifactCanvasEffects;
	readonly layoutGuide?: ArtifactCanvasLayoutGuide;
	readonly bindings?: ArtifactCanvasBindings;
	readonly styleBindings?: Partial<Readonly<Record<ArtifactCanvasStyleKind, string>>>;
	readonly variableModes?: Readonly<Record<string, string>>;
	readonly motion?: ArtifactCanvasMotion;
	readonly interactions?: readonly PrototypeInteraction[];
	readonly flowStart?: string;
	/** Only frames scroll. Offsets belong to a preview session, never to saved geometry. */
	readonly overflowDirection?: 'none' | 'horizontal' | 'vertical' | 'both';
	readonly scrollPosition?: 'scroll' | 'fixed' | 'sticky';
	/** Absolute children keep constraints but do not contribute to auto layout or hug sizing. */
	readonly layoutPositioning?: 'auto' | 'absolute';
	readonly name?: string;
	readonly sizing?: { readonly width: 'fixed' | 'fill'; readonly height: 'fixed' | 'fill'; };
	readonly constraints?: { readonly horizontal: ArtifactCanvasConstraint; readonly vertical: ArtifactCanvasConstraint; };
	readonly sizeLimits?: { readonly minWidth?: number; readonly maxWidth?: number; readonly minHeight?: number; readonly maxHeight?: number; };
	/** One-based cell positions are used only when the parent grid uses manual positioning. */
	readonly gridCell?: { readonly column?: number; readonly row?: number; readonly columnSpan?: number; readonly rowSpan?: number; readonly horizontal?: 'start' | 'center' | 'end'; readonly vertical?: 'start' | 'center' | 'end'; };
	/** Instance children identify their corresponding source layer; inherited values are resolved by the model. */
	readonly sourceId?: string;
	/** Only these fields are instance-owned. Their values live on this object, never in a second property store. */
	readonly overrides?: readonly ArtifactCanvasOverride[];
}

const artifactCanvasOverrideFields = ['name', 'width', 'height', 'fill', 'fills', 'blendMode', 'text', 'fontSize', 'strokeWidth', 'nodes', 'closed', 'subpaths', 'network', 'fillRule', 'strokeCap', 'strokeAlignment', 'cornerSmoothing', 'strokeJoin', 'stroke', 'dashArray', 'widthPoints', 'booleanOperation', 'crop', 'assetId', 'assetVersionId', 'autoLayout', 'sizeLimits', 'motion', 'interactions', 'overflowDirection', 'scrollPosition', 'layoutPositioning', 'instance', 'visible', 'opacity', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', ...artifactCanvasTextKeys.filter(key => !['fill', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing'].includes(key)), 'effects', 'layoutGuide', 'bindings', 'styleBindings', 'variableModes'] as const;
export type ArtifactCanvasOverride = typeof artifactCanvasOverrideFields[number] | `bindings:${ArtifactCanvasBindableProperty}` | `styleBindings:${ArtifactCanvasStyleKind}` | `variableModes:${string}`;

/** Resource overrides address individual properties so unrelated source bindings keep inheriting. */
export function getArtifactCanvasOverrideFields(shape: ArtifactCanvasShape, previous: ArtifactCanvasShape): readonly ArtifactCanvasOverride[] {
	const fields: ArtifactCanvasOverride[] = artifactCanvasOverrideFields.filter(field => !['bindings', 'styleBindings', 'variableModes'].includes(field));
	for (const group of ['bindings', 'styleBindings', 'variableModes'] as const) { for (const key of new Set([...Object.keys(shape[group] ?? {}), ...Object.keys(previous[group] ?? {})])) { fields.push(`${group}:${key}` as ArtifactCanvasOverride); } }
	return fields;
}
export function getArtifactCanvasOverrideValue(shape: ArtifactCanvasShape, field: ArtifactCanvasOverride): unknown {
	const [group, key] = field.split(':');
	return key ? Reflect.get(Reflect.get(shape, group) ?? {}, key) : Reflect.get(shape, field);
}
/** Target is a newly constructed layer. The source and its nested maps remain immutable. */
export function copyArtifactCanvasOverride(target: ArtifactCanvasShape, source: ArtifactCanvasShape, field: ArtifactCanvasOverride): void {
	const [group, key] = field.split(':'); const value = getArtifactCanvasOverrideValue(source, field);
	if (key) { const values = { ...Reflect.get(target, group) }; if (value === undefined) { Reflect.deleteProperty(values, key); } else { Reflect.set(values, key, value); } Reflect.set(target, group, values); }
	else if (value === undefined) { Reflect.deleteProperty(target, field); } else { Reflect.set(target, field, value); }
}
function isArtifactCanvasOverride(value: unknown): value is ArtifactCanvasOverride {
	if (typeof value !== 'string') { return false; }
	if ((artifactCanvasOverrideFields as readonly string[]).includes(value)) { return true; }
	const [group, key, extra] = value.split(':');
	return extra === undefined && !!key && (group === 'bindings' ? Object.hasOwn(artifactCanvasPropertyTypes, key) : group === 'styleBindings' ? Object.hasOwn(artifactCanvasStyleFields, key) : group === 'variableModes' && isUuid(key));
}
export type ArtifactCanvasComponent = { readonly kind: 'main'; readonly variant?: Readonly<Record<string, string>>; } | { readonly kind: 'set'; readonly properties: readonly string[]; };

export type ArtifactCanvasConstraint = 'start' | 'center' | 'end' | 'stretch' | 'scale';

export type ArtifactCanvasGridTrack = { readonly sizing: 'fixed' | 'fill'; readonly value: number; } | { readonly sizing: 'hug'; };
export interface ArtifactCanvasGrid {
	readonly columns: readonly ArtifactCanvasGridTrack[];
	readonly rows: readonly ArtifactCanvasGridTrack[];
	readonly autoRows: boolean;
	readonly positioning: 'auto' | 'manual';
}

/** Layout settings belong to the frame; children retain their resolved, editable geometry. */
export interface ArtifactCanvasAutoLayout {
	readonly direction: 'horizontal' | 'vertical' | 'grid';
	readonly gap: number;
	/** Between wrapped lines, or between grid rows. Defaults to gap in older files. */
	readonly crossGap?: number;
	readonly wrap?: boolean;
	readonly grid?: ArtifactCanvasGrid;
	readonly padding: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number; };
	readonly align: 'start' | 'center' | 'end';
	readonly justify: 'start' | 'center' | 'end' | 'space-between';
	readonly width: 'fixed' | 'hug';
	readonly height: 'fixed' | 'hug';
}

/** Positions are in the object's parent coordinates, matching static geometry. */
export interface ArtifactCanvasKeyframe {
	readonly offset: number;
	readonly x: number;
	readonly y: number;
	readonly rotation: number;
	readonly opacity: number;
}

export interface ArtifactCanvasMotion {
	readonly duration: number;
	readonly loop: boolean;
	readonly keyframes: readonly ArtifactCanvasKeyframe[];
}

export const artifactCanvasEndpointStyles = ['butt', 'round', 'square', 'line-arrow', 'triangle-arrow', 'reverse-triangle', 'diamond-arrow', 'circle-arrow'] as const;
export type ArtifactCanvasEndpoint = typeof artifactCanvasEndpointStyles[number];

/** Path points use fractions of the shape bounds, so resizing preserves the curve. */
export interface ArtifactCanvasPathNode extends CanvasPoint {
	readonly incoming: CanvasPoint;
	readonly outgoing: CanvasPoint;
	readonly mirroring?: 'none' | 'angle' | 'angle-length';
	readonly cornerRadius?: number;
	/** Applies only while this anchor is an open endpoint. */
	readonly endpoint?: ArtifactCanvasEndpoint;
}

/** Width is a multiplier of strokeWidth; position is a fraction of the contour's arc length. */
export interface ArtifactCanvasWidthPoint {
	readonly id: string;
	readonly contour: number;
	readonly position: number;
	readonly width: number;
	/** Width derivative along normalized arc length, retained when inserting a point without reshaping the profile. */
	readonly slope?: number;
}

export type ArtifactCanvasShape = ArtifactCanvasShapeGeometry & (
	{ readonly kind: 'rectangle' | 'ellipse'; }
	| ({ readonly kind: 'text'; readonly text: string; readonly fontSize: number; } & ArtifactCanvasTextProperties)
	| { readonly kind: 'path'; readonly network?: ArtifactCanvasVectorNetwork; readonly nodes: readonly ArtifactCanvasPathNode[]; readonly closed: boolean; readonly strokeWidth: number; readonly subpaths?: readonly ArtifactCanvasPathContour[]; readonly fillRule?: 'nonzero' | 'evenodd'; readonly strokeCap?: 'butt' | 'round' | 'square'; readonly strokeAlignment?: 'center' | 'inside' | 'outside'; readonly cornerSmoothing?: number; readonly strokeJoin?: 'miter' | 'round' | 'bevel'; readonly stroke?: string; readonly dashArray?: readonly number[]; readonly widthPoints?: readonly ArtifactCanvasWidthPoint[]; }
	| { readonly kind: 'group'; readonly children: readonly ArtifactCanvasShape[]; readonly contentWidth: number; readonly contentHeight: number; readonly booleanOperation?: ArtifactCanvasBooleanOperation; }
	| { readonly kind: 'frame'; readonly children: readonly ArtifactCanvasShape[]; readonly clip: boolean; readonly autoLayout?: ArtifactCanvasAutoLayout; readonly component?: ArtifactCanvasComponent; readonly instance?: { readonly componentId: string; }; }
	| { readonly kind: 'image'; readonly assetId: string; readonly assetVersionId: string; readonly crop: ArtifactCanvasImageCrop; }
);

export interface ArtifactCanvasImageCrop {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ArtifactCanvasAssetVersion {
	readonly id: string;
	readonly sha256: string;
	readonly path: string;
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
	readonly width: number;
	readonly height: number;
}

export interface ArtifactCanvasAsset {
	readonly id: string;
	readonly name: string;
	readonly versions: readonly ArtifactCanvasAssetVersion[];
}

/** The immutable tree owns live content; the file codec writes an indexed object table. */
export interface ArtifactCanvasDocument {
	readonly schemaVersion: 2;
	readonly mode: ArtifactWorkspaceId;
	readonly documentId: string;
	readonly artifactId: string;
	readonly title?: string;
	/** Document creation time in milliseconds; legacy packages may not record it. */
	readonly createdAt?: number;
	/** Page background is canvas presentation, independent of exported object fills. */
	readonly background?: string;
	/** Array order is paint order, from back to front. */
	readonly shapes: readonly ArtifactCanvasShape[];
	readonly assets: readonly ArtifactCanvasAsset[];
	readonly resources?: ArtifactCanvasResources;
}

function freezeShape(shape: ArtifactCanvasShape): ArtifactCanvasShape {
	if (shape.fills) { shape = { ...shape, fills: freezeArtifactCanvasResources(shape.fills) }; }
	if (shape.kind === 'text') { shape = { ...shape }; for (const key of artifactCanvasTextKeys) { if (shape[key] === undefined) { Reflect.deleteProperty(shape, key); } } for (const key of ['textRuns', 'fontFeatures', 'fontVariations'] as const) { if (shape[key]) { shape = { ...shape, [key]: freezeArtifactCanvasResources(shape[key]) }; } } }
	if (shape.interactions) { shape = { ...shape, interactions: freezeArtifactCanvasResources(shape.interactions) }; }
	for (const key of resourceShapeKeys) { const value = Reflect.get(shape, key); if (value && typeof value === 'object') { shape = { ...shape, [key]: freezeArtifactCanvasResources(Array.isArray(value) ? [...value] : { ...value }) }; } }
	if (shape.overrides) { shape = { ...shape, overrides: Object.freeze([...shape.overrides]) }; }
	if (shape.kind === 'frame') {
		if (shape.instance) { shape = { ...shape, instance: Object.freeze({ ...shape.instance }) }; }
		const component = shape.component;
		if (component) { shape = { ...shape, component: Object.freeze(component.kind === 'set' ? { ...component, properties: Object.freeze([...component.properties]) } : { ...component, ...(component.variant ? { variant: Object.freeze({ ...component.variant }) } : {}) }) }; }
	}
	if (shape.sizing) { shape = { ...shape, sizing: Object.freeze({ ...shape.sizing }) }; }
	if (shape.constraints) { shape = { ...shape, constraints: Object.freeze({ ...shape.constraints }) }; }
	if (shape.sizeLimits) { shape = { ...shape, sizeLimits: Object.freeze({ ...shape.sizeLimits }) }; }
	if (shape.gridCell) { shape = { ...shape, gridCell: Object.freeze({ ...shape.gridCell }) }; }
	if (shape.kind === 'frame' && shape.autoLayout) {
		const grid = shape.autoLayout.grid;
		shape = { ...shape, autoLayout: Object.freeze({ ...shape.autoLayout, padding: Object.freeze({ ...shape.autoLayout.padding }), ...(grid ? { grid: Object.freeze({ ...grid, columns: Object.freeze(grid.columns.map(track => Object.freeze({ ...track }))), rows: Object.freeze(grid.rows.map(track => Object.freeze({ ...track }))) }) } : {}) }) };
	}
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
		const freezeNodes = (nodes: readonly ArtifactCanvasPathNode[]) => Object.freeze(nodes.map(node => Object.freeze({ ...node, incoming: Object.freeze({ ...node.incoming }), outgoing: Object.freeze({ ...node.outgoing }) })));
		return Object.freeze({ ...shape, ...(shape.network ? { network: freezeArtifactCanvasVectorNetwork(shape.network) } : {}), nodes: freezeNodes(shape.nodes), ...(shape.widthPoints ? { widthPoints: Object.freeze(shape.widthPoints.map(point => Object.freeze({ ...point }))) } : {}), ...(shape.subpaths ? { subpaths: Object.freeze(shape.subpaths.map(contour => Object.freeze({ ...contour, nodes: freezeNodes(contour.nodes) }))) } : {}), ...(shape.dashArray ? { dashArray: Object.freeze([...shape.dashArray]) } : {}) });
	}
	return Object.freeze({ ...shape });
}

export function documentFromShapes(shapes: readonly ArtifactCanvasShape[], identity: Pick<ArtifactCanvasDocument, 'documentId' | 'artifactId'> & Partial<Pick<ArtifactCanvasDocument, 'mode' | 'resources' | 'background' | 'title' | 'createdAt'>> = { documentId: generateUuid(), artifactId: generateUuid() }, assets: readonly ArtifactCanvasAsset[] = []): ArtifactCanvasDocument {
	return Object.freeze({ schemaVersion: 2, ...identity, mode: identity.mode ?? ArtifactWorkspaceId.Design, ...(identity.resources ? { resources: freezeArtifactCanvasResources(identity.resources) } : {}), shapes: Object.freeze(shapes.map(freezeShape)), assets: Object.freeze(assets.map(asset => Object.freeze({ ...asset, versions: Object.freeze(asset.versions.map(version => Object.freeze({ ...version }))) }))) });
}

/** Rejects the complete file before any active document state changes. */
export function parseArtifactCanvasDocument(content: string): ArtifactCanvasDocument { return readDocument(content, true); }

function readDocument(content: string, allowLibraries: boolean): ArtifactCanvasDocument {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value)) { throw new TypeError(localize('sessions.design.invalidDocument', 'Invalid design document')); }
	const ids = new Set<string>();
	if (value.version === 1) {
		if (!Array.isArray(value.shapes) || Object.keys(value).some(key => key !== 'version' && key !== 'shapes')) { throw new TypeError(localize('sessions.design.invalidDocument', 'Invalid design document')); }
		const shapes = value.shapes.map(shape => parseShape(shape, ids));
		if (flattenArtifactCanvasShapes(shapes).some(shape => shape.kind === 'frame' || shape.kind === 'image')) { throw new TypeError(localize('sessions.design.invalidUnsupportedVersion1Object', 'Unsupported version 1 object')); }
		return documentFromShapes(shapes);
	}
	if (value.schemaVersion !== 2 || !isUuid(value.documentId) || !Array.isArray(value.artifactOrder) || value.artifactOrder.length !== 1 || !isUuid(value.artifactOrder[0]) || !isRecord(value.artifacts) || !isRecord(value.assets)
		|| value.title !== undefined && !isArtifactName(value.title)
		|| value.createdAt !== undefined && (!isFiniteNumber(value.createdAt) || value.createdAt < 0)
		|| Object.keys(value).some(key => !['schemaVersion', 'documentId', 'title', 'createdAt', 'artifactOrder', 'artifacts', 'assets', 'resources'].includes(key))) { throw new TypeError(localize('sessions.design.invalidDocument', 'Invalid design document')); }
	const artifactId = value.artifactOrder[0];
	const artifact = value.artifacts[artifactId];
	if (Object.keys(value.artifacts).length !== 1 || !isRecord(artifact) || artifact.kind !== 'composition' || !Array.isArray(artifact.roots) || !isRecord(artifact.objects)
		|| Object.keys(artifact).some(key => !['kind', 'mode', 'roots', 'objects', 'background'].includes(key))) { throw new TypeError(localize('sessions.design.invalidComposition', 'Invalid design composition')); }
	if (artifact.background !== undefined && (typeof artifact.background !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(artifact.background))) { throw new TypeError(localize('sessions.design.invalidComposition', 'Invalid design composition')); }
	const mode = artifact.mode === undefined ? ArtifactWorkspaceId.Design : artifact.mode;
	if (!Object.values(ArtifactWorkspaceId).includes(mode as ArtifactWorkspaceId)) { throw new TypeError(localize('sessions.artifacts.invalidMode', 'Invalid Artifacts document mode.')); }
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
	const assets = Object.entries(value.assets).map(([id, asset]): ArtifactCanvasAsset => {
		if (!isUuid(id) || !isRecord(asset) || asset.id !== id || typeof asset.name !== 'string' || !Array.isArray(asset.versions) || asset.versions.length === 0 || Object.keys(asset).some(key => !['id', 'name', 'versions'].includes(key))) { throw new TypeError(localize('sessions.design.invalidAsset', 'Invalid design asset')); }
		const versions = asset.versions.map((version: unknown): ArtifactCanvasAssetVersion => {
			if (!isRecord(version) || !isUuid(version.id) || versionIds.has(version.id) || typeof version.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(version.sha256) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(version.mediaType)) || !Number.isSafeInteger(version.width) || !isPositiveNumber(version.width) || !Number.isSafeInteger(version.height) || !isPositiveNumber(version.height)
				|| version.path !== `assets/${version.sha256}` || Object.keys(version).some(key => !['id', 'sha256', 'path', 'mediaType', 'width', 'height'].includes(key))) { throw new TypeError(localize('sessions.design.invalidAssetVersion', 'Invalid design asset version')); }
			versionIds.add(version.id);
			return { id: version.id, sha256: version.sha256, path: version.path, mediaType: version.mediaType as ArtifactCanvasAssetVersion['mediaType'], width: version.width, height: version.height };
		});
		return { id, name: asset.name, versions };
	});
	for (const shape of flattenArtifactCanvasShapes(shapes)) {
		if (shape.kind === 'image' && !assets.some(asset => asset.id === shape.assetId && asset.versions.some(version => version.id === shape.assetVersionId))) { throw new TypeError(localize('sessions.design.invalidMissingDesignAssetVersion', 'Missing design asset version')); }
	}
	const resources = value.resources === undefined ? undefined : parseArtifactCanvasResources(value.resources, value => {
		if (!allowLibraries) { throw new TypeError(localize('sessions.design.invalidResources', 'Invalid design resource, binding, or circular variable alias.')); }
		return readDocument(JSON.stringify(value), false);
	});
	const libraryShapes = getArtifactCanvasLibraryShapes(resources);
	const allShapes = [...shapes, ...libraryShapes];
	if (new Set(flattenArtifactCanvasShapes(allShapes).map(shape => shape.id)).size !== flattenArtifactCanvasShapes(allShapes).length) { throw new TypeError(localize('sessions.design.invalidObjectOwnership', 'Invalid design object ownership')); }
	if (flattenArtifactCanvasShapes(shapes).some(shape => shape.flowStart && (!shapes.includes(shape) || shape.kind !== 'frame' || shape.component))) { throw new TypeError(localize('sessions.design.prototype.invalid', 'Invalid prototype interaction or flow starting point.')); }
	const targets = new Set(prototypeFrames(shapes).map(frame => frame.id));
	const variants = new Set(flattenArtifactCanvasShapes(shapes).filter(shape => shape.kind === 'frame' && shape.component?.kind === 'main').map(shape => shape.id));
	if (flattenArtifactCanvasShapes(shapes).some(shape => shape.interactions?.some(interaction => flattenPrototypeActions(interaction.actions).some(item => item.destination && ['navigate', 'overlay', 'swap', 'changeTo'].includes(item.action) && ids.has(item.destination) && !(item.action === 'changeTo' ? variants : targets).has(item.destination))))) { throw new TypeError(localize('sessions.design.prototype.invalid', 'Invalid prototype interaction or flow starting point.')); }
	for (const shape of flattenArtifactCanvasShapes(shapes)) {
		const owner = prototypeScrollScope(shapes, shape.id);
		for (const action of (shape.interactions ?? []).flatMap(item => flattenPrototypeActions(item.actions))) { if (action.action === 'scrollTo' && ids.has(action.destination!) && (!owner || !flattenArtifactCanvasShapes([owner]).some(target => target.id === action.destination || target.sourceId === action.destination))) { throw new TypeError(localize('sessions.design.prototype.invalid', 'Invalid prototype interaction or flow starting point.')); } }
	}
	validatePrototypeExpressions(shapes, resources);
	validateArtifactCanvasComponents(allShapes);
	validateArtifactCanvasShapeResources(allShapes, resources);
	return documentFromShapes(shapes, { documentId: value.documentId, artifactId, mode: mode as ArtifactWorkspaceId, ...(value.title === undefined ? {} : { title: value.title }), ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt as number }), ...(artifact.background === undefined ? {} : { background: artifact.background as string }), ...(resources ? { resources } : {}) }, assets);
}

/** Containers retain the only copy of their children; consumers derive identity lookup from this tree. */
export function flattenArtifactCanvasShapes(shapes: readonly ArtifactCanvasShape[]): readonly ArtifactCanvasShape[] {
	return shapes.flatMap(shape => [shape, ...(shape.kind === 'group' || shape.kind === 'frame' ? flattenArtifactCanvasShapes(shape.children) : [])]);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0;
}

function parsePoint(value: unknown): CanvasPoint {
	if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || Object.keys(value).some(key => key !== 'x' && key !== 'y')) {
		throw new TypeError(localize('sessions.design.invalidPathPoint', 'Invalid design path point'));
	}
	return { x: value.x, y: value.y };
}

function parseShape(value: unknown, ids: Set<string>): ArtifactCanvasShape {
	if (!isRecord(value) || !isUuid(value.id) || ids.has(value.id)
		|| !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.rotation)
		|| !isPositiveNumber(value.width) || !isPositiveNumber(value.height)
		|| typeof value.fill !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value.fill)) {
		throw new TypeError(localize('sessions.design.invalidShape', 'Invalid design shape'));
	}
	ids.add(value.id);
	if ((value.sourceId !== undefined && !isUuid(value.sourceId)) || (value.overrides !== undefined && (!Array.isArray(value.overrides) || new Set(value.overrides).size !== value.overrides.length || value.overrides.some(field => !isArtifactCanvasOverride(field))))) { throw new TypeError(localize('sessions.design.invalidComponent', 'Invalid component or instance')); }
	if (value.blendMode !== undefined && value.blendMode !== 'pass-through' && !artifactCanvasBlendModes.includes(value.blendMode as ArtifactCanvasBlendMode)) { throw new TypeError(localize('sessions.design.invalidPaint', 'Invalid design fill, gradient, or blend mode')); }
	const geometry: ArtifactCanvasShapeGeometry = { ...(value.fills !== undefined ? { fills: parseArtifactCanvasPaints(value.fills) } : {}), ...(value.blendMode !== undefined ? { blendMode: value.blendMode as ArtifactCanvasShapeGeometry['blendMode'] } : {}), id: value.id, x: value.x, y: value.y, width: value.width, height: value.height, rotation: value.rotation, fill: value.fill, ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId as string }), ...(value.overrides === undefined ? {} : { overrides: value.overrides as ArtifactCanvasOverride[] }), ...(value.motion === undefined ? {} : { motion: parseMotion(value.motion) }), ...parseLayoutProperties(value), ...parseArtifactCanvasResourceProperties(value), ...parsePrototypeProperties(value) };
	const keys = ['id', 'kind', 'x', 'y', 'width', 'height', 'rotation', 'fill', 'fills', 'blendMode', ...resourceShapeKeys];
	for (const key of ['name', 'sizing', 'constraints', 'sizeLimits', 'gridCell', 'sourceId', 'overrides', 'interactions', 'flowStart', 'overflowDirection', 'scrollPosition', 'layoutPositioning']) { if (value[key] !== undefined) { keys.push(key); } }
	if (value.motion !== undefined) { keys.push('motion'); }
	let shape: ArtifactCanvasShape;
	switch (value.kind) {
		case 'rectangle': case 'ellipse': shape = { ...geometry, kind: value.kind }; break;
		case 'text':
			if (typeof value.text !== 'string' || !isPositiveNumber(value.fontSize)) { throw new TypeError(localize('sessions.design.invalidText', 'Invalid design text')); }
			keys.push('text', ...artifactCanvasTextKeys);
			shape = { ...geometry, ...parseArtifactCanvasTextProperties(value), kind: 'text', text: value.text, fontSize: value.fontSize };
			break;
		case 'path': {
			if ((!value.network && typeof value.closed !== 'boolean') || !isFiniteNumber(value.strokeWidth) || value.strokeWidth < 0) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
			const parseNodes = (value: unknown): readonly ArtifactCanvasPathNode[] => {
				if (!Array.isArray(value) || value.length < 2 || value.length > 10000) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
				return value.map((node: unknown): ArtifactCanvasPathNode => {
					if (!isRecord(node) || node.endpoint !== undefined && !artifactCanvasEndpointStyles.includes(node.endpoint as ArtifactCanvasEndpoint) || (node.cornerRadius !== undefined && (!isFiniteNumber(node.cornerRadius) || node.cornerRadius < 0)) || Object.keys(node).some(key => !['x', 'y', 'incoming', 'outgoing', 'mirroring', 'cornerRadius', 'endpoint'].includes(key)) || (node.mirroring !== undefined && !['none', 'angle', 'angle-length'].includes(String(node.mirroring)))) { throw new TypeError(localize('sessions.design.invalidPathNode', 'Invalid design path node')); }
					return { ...parsePoint({ x: node.x, y: node.y }), incoming: parsePoint(node.incoming), outgoing: parsePoint(node.outgoing), ...(node.mirroring ? { mirroring: node.mirroring as ArtifactCanvasPathNode['mirroring'] } : {}), ...(node.cornerRadius !== undefined ? { cornerRadius: node.cornerRadius as number } : {}), ...(node.endpoint !== undefined ? { endpoint: node.endpoint as ArtifactCanvasEndpoint } : {}) };
				});
			};
			keys.push('nodes', 'closed', 'strokeWidth', 'subpaths', 'network', 'fillRule', 'strokeCap', 'strokeAlignment', 'cornerSmoothing', 'strokeJoin', 'stroke', 'dashArray', 'widthPoints');
			const properties: Record<string, unknown> = {};
			if (value.cornerSmoothing !== undefined) { if (!isFiniteNumber(value.cornerSmoothing) || value.cornerSmoothing < 0 || value.cornerSmoothing > 1) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); } properties.cornerSmoothing = value.cornerSmoothing; }
			for (const [key, options] of Object.entries({ fillRule: ['nonzero', 'evenodd'], strokeCap: ['butt', 'round', 'square'], strokeAlignment: ['center', 'inside', 'outside'], strokeJoin: ['miter', 'round', 'bevel'] })) {
				if (value[key] !== undefined) { if (!options.includes(String(value[key]))) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); } properties[key] = value[key]; }
			}
			if (value.stroke !== undefined) { if (typeof value.stroke !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value.stroke)) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); } properties.stroke = value.stroke; }
			if (value.dashArray !== undefined) { if (!Array.isArray(value.dashArray) || value.dashArray.length > 32 || value.dashArray.some(n => !isFiniteNumber(n) || n < .01)) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); } properties.dashArray = value.dashArray; }
			if (value.widthPoints !== undefined) {
				const ids = new Set<string>();
				if (!Array.isArray(value.widthPoints) || value.widthPoints.length > 1000) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
				properties.widthPoints = value.widthPoints.map(point => {
					if (!isRecord(point) || Object.keys(point).some(key => !['id', 'contour', 'position', 'width', 'slope'].includes(key)) || !isUuid(point.id) || ids.has(point.id) || !Number.isInteger(point.contour) || Number(point.contour) < 0 || !isFiniteNumber(point.position) || point.position < 0 || point.position > 1 || !isFiniteNumber(point.width) || point.width < 0 || point.width > 10000 || point.slope !== undefined && !isFiniteNumber(point.slope)) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
					ids.add(point.id); return { id: point.id, contour: Number(point.contour), position: point.position, width: point.width, ...(point.slope !== undefined ? { slope: point.slope } : {}) };
				});
			}
			if (value.subpaths !== undefined) {
				if (!Array.isArray(value.subpaths) || value.subpaths.length > 1000) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
				properties.subpaths = value.subpaths.map(contour => { if (!isRecord(contour) || typeof contour.closed !== 'boolean' || Object.keys(contour).some(key => !['nodes', 'closed', 'fill'].includes(key))) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); } if (contour.fill !== undefined && (typeof contour.fill !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(contour.fill))) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); } return { nodes: parseNodes(contour.nodes), closed: contour.closed, ...(contour.fill ? { fill: contour.fill as string } : {}) }; });
			}
			if (value.network !== undefined) {
				if (value.subpaths !== undefined || value.nodes !== undefined && (!Array.isArray(value.nodes) || value.nodes.length) || value.closed !== undefined && value.closed !== false) { throw new TypeError(localize('sessions.design.invalidNetwork', 'Invalid vector network')); }
				shape = { ...geometry, ...properties, kind: 'path', network: parseArtifactCanvasVectorNetwork(value.network), nodes: [], closed: false, strokeWidth: value.strokeWidth };
			} else { shape = { ...geometry, ...properties, kind: 'path', nodes: parseNodes(value.nodes), closed: value.closed as boolean, strokeWidth: value.strokeWidth }; }
			const contourCount = shape.network ? artifactCanvasNetworkStrokeContours(shape.network).length : 1 + (shape.subpaths?.length ?? 0);
			if (shape.widthPoints?.some(point => point.contour >= contourCount)) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
			if (shape.nodes.length + (shape.subpaths?.reduce((sum, contour) => sum + contour.nodes.length, 0) ?? 0) > 10000) { throw new TypeError(localize('sessions.design.invalidPath', 'Invalid design path')); }
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
			if (value.autoLayout !== undefined) { keys.push('autoLayout'); }
			if (value.component !== undefined) { keys.push('component'); }
			if (value.instance !== undefined) { keys.push('instance'); }
			if (value.instance !== undefined && (!isRecord(value.instance) || !isUuid(value.instance.componentId) || Object.keys(value.instance).length !== 1 || value.component !== undefined)) { throw new TypeError(localize('sessions.design.invalidComponent', 'Invalid component or instance')); }
			shape = { ...geometry, kind: 'frame', clip: value.clip, children: value.children.map(child => parseShape(child, ids)), ...(value.autoLayout === undefined ? {} : { autoLayout: parseAutoLayout(value.autoLayout) }), ...(value.component === undefined ? {} : { component: parseComponent(value.component) }), ...(value.instance === undefined ? {} : { instance: value.instance as { componentId: string; } }) };
			break;
		case 'group':
			if (!Array.isArray(value.children) || value.children.length < 1 || !isPositiveNumber(value.contentWidth) || !isPositiveNumber(value.contentHeight)
				|| Math.abs(value.width / value.contentWidth - value.height / value.contentHeight) > 1e-8) { throw new TypeError(localize('sessions.design.invalidGroup', 'Invalid design group')); }
			keys.push('children', 'contentWidth', 'contentHeight', 'booleanOperation');
			if (value.booleanOperation !== undefined && !['union', 'subtract', 'intersect', 'exclude'].includes(String(value.booleanOperation))) { throw new TypeError(localize('sessions.design.invalidGroup', 'Invalid design group')); }
			shape = { ...geometry, kind: 'group', children: value.children.map(child => parseShape(child, ids)), contentWidth: value.contentWidth, contentHeight: value.contentHeight, ...(value.booleanOperation ? { booleanOperation: value.booleanOperation as ArtifactCanvasBooleanOperation } : {}) };
			if (shape.booleanOperation && !isArtifactCanvasVector(shape)) { throw new TypeError(localize('sessions.design.invalidGroup', 'Invalid design group')); }
			break;
		default: throw new TypeError(localize('sessions.design.invalidShapeKind', 'Invalid design shape kind'));
	}
	if (Object.keys(value).some(key => !keys.includes(key))) { throw new TypeError(localize('sessions.design.invalidShapeProperty', 'Invalid design shape property')); }
	return shape;
}

function parseLayoutProperties(value: Record<string, unknown>): Pick<ArtifactCanvasShapeGeometry, 'name' | 'sizing' | 'constraints' | 'sizeLimits' | 'gridCell'> {
	if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 1024)) { throw new TypeError(localize('sessions.design.invalidLayerName', 'Invalid layer name')); }
	const sizing = value.sizing;
	if (sizing !== undefined && (!isRecord(sizing) || !['fixed', 'fill'].includes(sizing.width as string) || !['fixed', 'fill'].includes(sizing.height as string) || Object.keys(sizing).some(key => !['width', 'height'].includes(key)))) {
		throw new TypeError(localize('sessions.design.invalidSizing', 'Invalid layer sizing'));
	}
	const constraints = value.constraints;
	const modes = value.kind === 'group' ? ['start', 'center', 'end'] : ['start', 'center', 'end', 'stretch', 'scale'];
	if (constraints !== undefined && (!isRecord(constraints) || !modes.includes(constraints.horizontal as string) || !modes.includes(constraints.vertical as string) || Object.keys(constraints).some(key => !['horizontal', 'vertical'].includes(key)))) {
		throw new TypeError(localize('sessions.design.invalidConstraints', 'Invalid layer constraints'));
	}
	if (value.kind === 'group' && isRecord(sizing) && (sizing.width === 'fill' || sizing.height === 'fill')) {
		throw new TypeError(localize('sessions.design.invalidSizing', 'Invalid layer sizing'));
	}
	const limits = value.sizeLimits;
	if (limits !== undefined && (value.kind === 'group' || !isRecord(limits)
		|| Object.entries(limits).some(([key, limit]) => !['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].includes(key) || !isFiniteNumber(limit) || limit < (key.startsWith('min') ? 0 : 0.001))
		|| (isFiniteNumber(limits.minWidth) && isFiniteNumber(limits.maxWidth) && limits.minWidth > limits.maxWidth)
		|| (isFiniteNumber(limits.minHeight) && isFiniteNumber(limits.maxHeight) && limits.minHeight > limits.maxHeight))) {
		throw new TypeError(localize('sessions.design.invalidSizeLimits', 'Invalid minimum or maximum dimensions'));
	}
	const cell = value.gridCell;
	if (cell !== undefined && (!isRecord(cell) || Object.entries(cell).some(([key, entry]) => ['horizontal', 'vertical'].includes(key)
		? !['start', 'center', 'end'].includes(entry as string)
		: !['column', 'row', 'columnSpan', 'rowSpan'].includes(key) || !Number.isInteger(entry) || (entry as number) < 1 || (entry as number) > 1000))) {
		throw new TypeError(localize('sessions.design.invalidGridCell', 'Invalid grid cell'));
	}
	return { ...(value.name === undefined ? {} : { name: value.name as string }), ...(sizing === undefined ? {} : { sizing: sizing as ArtifactCanvasShapeGeometry['sizing'] }), ...(constraints === undefined ? {} : { constraints: constraints as ArtifactCanvasShapeGeometry['constraints'] }), ...(limits === undefined ? {} : { sizeLimits: limits as ArtifactCanvasShapeGeometry['sizeLimits'] }), ...(cell === undefined ? {} : { gridCell: cell as ArtifactCanvasShapeGeometry['gridCell'] }) };
}

function parseAutoLayout(value: unknown): ArtifactCanvasAutoLayout {
	const padding = isRecord(value) && isRecord(value.padding) ? value.padding : undefined;
	if (!isRecord(value) || !['horizontal', 'vertical', 'grid'].includes(value.direction as string) || !isFiniteNumber(value.gap) || value.gap < 0
		|| (value.crossGap !== undefined && (!isFiniteNumber(value.crossGap) || value.crossGap < 0))
		|| (value.wrap !== undefined && typeof value.wrap !== 'boolean')
		|| (value.direction === 'grid' && (!isRecord(value.grid) || value.wrap === true))
		|| !['start', 'center', 'end'].includes(value.align as string) || !['start', 'center', 'end', 'space-between'].includes(value.justify as string)
		|| !['fixed', 'hug'].includes(value.width as string) || !['fixed', 'hug'].includes(value.height as string)
		|| !padding || ['top', 'right', 'bottom', 'left'].some(key => !isFiniteNumber(padding[key]) || padding[key] < 0)
		|| Object.keys(padding).some(key => !['top', 'right', 'bottom', 'left'].includes(key))
		|| Object.keys(value).some(key => !['direction', 'gap', 'crossGap', 'wrap', 'grid', 'padding', 'align', 'justify', 'width', 'height'].includes(key))) {
		throw new TypeError(localize('sessions.design.invalidAutoLayout', 'Invalid auto layout'));
	}
	if (value.grid !== undefined) {
		const grid = value.grid;
		const tracksValid = (tracks: unknown): boolean => Array.isArray(tracks) && tracks.length > 0 && tracks.length <= 1000 && tracks.every(track => isRecord(track)
			&& (track.sizing === 'hug' ? Object.keys(track).length === 1 : ['fixed', 'fill'].includes(track.sizing as string) && isPositiveNumber(track.value) && Object.keys(track).every(key => ['sizing', 'value'].includes(key))));
		if (!isRecord(grid) || !tracksValid(grid.columns) || !tracksValid(grid.rows) || typeof grid.autoRows !== 'boolean' || !['auto', 'manual'].includes(grid.positioning as string)
			|| Object.keys(grid).some(key => !['columns', 'rows', 'autoRows', 'positioning'].includes(key))) {
			throw new TypeError(localize('sessions.design.invalidGrid', 'Invalid grid layout'));
		}
	}
	return value as unknown as ArtifactCanvasAutoLayout;
}

function parseMotion(value: unknown): ArtifactCanvasMotion {
	if (!isRecord(value) || !isPositiveNumber(value.duration) || typeof value.loop !== 'boolean' || !Array.isArray(value.keyframes) || value.keyframes.length < 2
		|| Object.keys(value).some(key => !['duration', 'loop', 'keyframes'].includes(key))) {
		throw new TypeError(localize('sessions.design.invalidMotion', 'Invalid design motion'));
	}
	const keyframes = value.keyframes.map((frame: unknown): ArtifactCanvasKeyframe => {
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

export function serializeArtifactCanvasDocument(document: ArtifactCanvasDocument): string {
	const objects: Record<string, unknown> = {};
	function writeObject(shape: ArtifactCanvasShape): void {
		if (shape.kind === 'group' || shape.kind === 'frame') {
			objects[shape.id] = { ...shape, children: shape.children.map(child => child.id) };
			shape.children.forEach(writeObject);
		} else if (shape.kind === 'path' && shape.network) { const { nodes: _nodes, closed: _closed, ...networkPath } = shape; objects[shape.id] = networkPath; } else { objects[shape.id] = shape; }
	}
	document.shapes.forEach(writeObject);
	return JSON.stringify({ schemaVersion: 2, documentId: document.documentId, title: document.title, createdAt: document.createdAt, ...(document.resources ? { resources: { ...document.resources, libraries: document.resources.libraries.map(library => ({ ...library, document: JSON.parse(serializeArtifactCanvasDocument(library.document)) })) } } : {}), artifactOrder: [document.artifactId], artifacts: { [document.artifactId]: { kind: 'composition', ...(document.background === undefined ? {} : { background: document.background }), ...(document.mode === ArtifactWorkspaceId.Design ? {} : { mode: document.mode }), roots: document.shapes.map(shape => shape.id), objects } }, assets: Object.fromEntries(document.assets.map(asset => [asset.id, asset])) }, null, '\t') + '\n';
}

function parseComponent(value: unknown): ArtifactCanvasComponent {
	const name = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0 && text.length <= 256;
	if (isRecord(value)) {
		if (value.kind === 'set' && Array.isArray(value.properties) && value.properties.length > 0 && value.properties.length <= 32 && value.properties.every(name) && new Set(value.properties).size === value.properties.length && Object.keys(value).every(key => ['kind', 'properties'].includes(key))) { return { kind: 'set', properties: value.properties as string[] }; }
		if (value.kind === 'main' && Object.keys(value).every(key => ['kind', 'variant'].includes(key)) && (value.variant === undefined || (isRecord(value.variant) && Object.entries(value.variant).every(([key, value]) => name(key) && name(value))))) { return value as unknown as ArtifactCanvasComponent; }
	}
	throw new TypeError(localize('sessions.design.invalidComponent', 'Invalid component or instance'));
}

/** References may be missing after a main is deleted, but must never point to ordinary layers or form cycles. */
function validateArtifactCanvasComponents(shapes: readonly ArtifactCanvasShape[]): void {
	const objects = new Map(flattenArtifactCanvasShapes(shapes).map(shape => [shape.id, shape]));
	const fail = (): never => { throw new TypeError(localize('sessions.design.invalidComponent', 'Invalid component or instance')); };
	const visit = (shape: ArtifactCanvasShape, insideInstance: boolean, parentSet?: Extract<ArtifactCanvasShape, { kind: 'frame'; }>): void => {
		if (shape.sourceId && !insideInstance) { fail(); }
		if (shape.overrides && !insideInstance && !(shape.kind === 'frame' && shape.instance)) { fail(); }
		if (shape.kind !== 'frame' && shape.kind !== 'group') { return; }
		if (shape.kind === 'frame' && shape.component && insideInstance) { fail(); }
		if (shape.kind === 'frame' && shape.component?.kind === 'main' && shape.component.variant && !parentSet) { fail(); }
		if (shape.kind === 'frame' && shape.component?.kind === 'set') {
			const properties = shape.component.properties;
			const combinations = new Set<string>();
			for (const child of shape.children) {
				if (child.kind !== 'frame' || child.component?.kind !== 'main') { fail(); }
				const variant = (child as Extract<ArtifactCanvasShape, { kind: 'frame'; }>).component;
				const values = variant?.kind === 'main' ? variant.variant : undefined;
				if (!values || Object.keys(values).length !== properties.length || properties.some(property => !Object.hasOwn(values, property))) { fail(); }
				const key = JSON.stringify(properties.map(property => values![property]));
				if (combinations.has(key)) { fail(); }
				combinations.add(key);
			}
		}
		if (shape.kind === 'frame' && shape.instance) {
			const source = objects.get(shape.instance.componentId);
			if (source && (source.kind !== 'frame' || source.component?.kind !== 'main')) { fail(); }
		}
		for (const child of shape.children) { visit(child, insideInstance || (shape.kind === 'frame' && !!shape.instance), shape.kind === 'frame' && shape.component?.kind === 'set' ? shape : undefined); }
	};
	shapes.forEach(shape => visit(shape, false));
	const visiting = new Set<string>(); const visited = new Set<string>();
	const check = (shape: ArtifactCanvasShape): void => {
		if (visited.has(shape.id)) { return; }
		if (visiting.has(shape.id)) { fail(); }
		visiting.add(shape.id);
		if (shape.kind === 'frame' && shape.instance) { const source = objects.get(shape.instance.componentId); if (source) { check(source); } }
		if (shape.kind === 'frame' || shape.kind === 'group') { shape.children.forEach(check); }
		visiting.delete(shape.id); visited.add(shape.id);
	};
	shapes.forEach(check);
}
