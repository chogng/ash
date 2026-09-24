export type LineId = string;
export type MarkId = string;
export type AtomId = string;
export type FacetId = string;
export type RegionId = string;
export type RelationId = string;

export type LineSemanticValue =
	| string
	| number
	| boolean
	| null
	| readonly LineSemanticValue[]
	| { readonly [key: string]: LineSemanticValue };
export type LineSemanticAttributes = Readonly<Record<string, LineSemanticValue>>;

export interface ModelLine {
	readonly id: LineId;
	readonly text: string;
}

export interface LinePoint {
	readonly lineId: LineId;
	readonly offset: number;
}

export interface PersistentMark {
	readonly id: MarkId;
	readonly kind: string;
	readonly from: LinePoint;
	readonly to: LinePoint;
	readonly attrs: LineSemanticAttributes;
}

export interface InlineAtom {
	readonly id: AtomId;
	readonly kind: string;
	readonly position: LinePoint;
	readonly display: 'inline' | 'block';
	readonly attrs: LineSemanticAttributes;
}

export interface LineFacet {
	readonly id: FacetId;
	readonly kind: string;
	readonly lineId: LineId;
	readonly attrs: LineSemanticAttributes;
}

export interface LineRegion {
	readonly id: RegionId;
	readonly kind: string;
	readonly startLineId: LineId;
	readonly endLineId: LineId;
	readonly parentRegionId?: RegionId;
	readonly attrs: LineSemanticAttributes;
}

export type LineRelationTarget =
	| { readonly kind: 'line'; readonly lineId: LineId }
	| { readonly kind: 'atom'; readonly atomId: AtomId }
	| { readonly kind: 'region'; readonly regionId: RegionId }
	| { readonly kind: 'external'; readonly targetId: string };

export interface LineRelation {
	readonly id: RelationId;
	readonly kind: string;
	readonly source: LineRelationTarget;
	readonly target: LineRelationTarget;
	readonly unresolved?: boolean;
	readonly attrs: LineSemanticAttributes;
}

export interface LineDocumentSnapshot {
	readonly lines: LineSequence;
	readonly marks: RangeStore;
	readonly atoms: PointStore;
	readonly facets: LineFacetStore;
	readonly regions: RegionStore;
	readonly relations: RelationStore;
	readonly metadata: LineSemanticAttributes;
	getText(): string;
}

export interface LineDocumentSnapshotInput {
	readonly lines: readonly ModelLine[];
	readonly marks?: readonly PersistentMark[];
	readonly atoms?: readonly InlineAtom[];
	readonly facets?: readonly LineFacet[];
	readonly regions?: readonly LineRegion[];
	readonly relations?: readonly LineRelation[];
	readonly metadata?: LineSemanticAttributes;
}

export class LineSequence {
	public readonly values: readonly ModelLine[];
	private readonly indicesById: ReadonlyMap<LineId, number>;

	constructor(lines: readonly ModelLine[]) {
		if (!Array.isArray(lines) || lines.length === 0) throw new TypeError('A line document must contain at least one logical line');
		const values: ModelLine[] = [];
		const indicesById = new Map<LineId, number>();
		for (const line of lines) {
			assertIdentity(line.id, 'Line');
			if (indicesById.has(line.id)) throw new TypeError(`Duplicate line id '${line.id}'`);
			if (typeof line.text !== 'string' || /[\r\n]/u.test(line.text)) {
				throw new TypeError(`Logical line '${line.id}' must not contain a line terminator`);
			}
			indicesById.set(line.id, values.length);
			values.push(Object.freeze({ id: line.id, text: line.text }));
		}
		this.values = Object.freeze(values);
		this.indicesById = indicesById;
	}

	public get length(): number {
		return this.values.length;
	}

	public at(index: number): ModelLine | undefined {
		return this.values[index];
	}

	public get(lineId: LineId): ModelLine | undefined {
		const index = this.indicesById.get(lineId);
		return index === undefined ? undefined : this.values[index];
	}

	public indexOf(lineId: LineId): number {
		return this.indicesById.get(lineId) ?? -1;
	}
}

export class RangeStore {
	public readonly values: readonly PersistentMark[];
	private readonly valuesById: ReadonlyMap<MarkId, PersistentMark>;

	constructor(private readonly lines: LineSequence, marks: readonly PersistentMark[] = []) {
		const values = marks.map(mark => freezeMark(mark));
		this.values = Object.freeze(values);
		this.valuesById = indexIdentities(values, 'mark');
	}

	public get(id: MarkId): PersistentMark | undefined {
		return this.valuesById.get(id);
	}

	public forLine(lineId: LineId): readonly PersistentMark[] {
		const lineIndex = this.lines.indexOf(lineId);
		if (lineIndex < 0) throw new RangeError(`Line '${lineId}' does not exist in the mark store's document`);
		return this.values.filter(mark => {
			const fromLineIndex = this.lines.indexOf(mark.from.lineId);
			const toLineIndex = this.lines.indexOf(mark.to.lineId);
			if (lineIndex < fromLineIndex || lineIndex > toLineIndex) return false;
			return lineIndex !== toLineIndex || lineIndex === fromLineIndex || mark.to.offset > 0;
		});
	}
}

export class PointStore {
	public readonly values: readonly InlineAtom[];
	private readonly valuesById: ReadonlyMap<AtomId, InlineAtom>;

	constructor(atoms: readonly InlineAtom[] = []) {
		const values = atoms.map(atom => freezeAtom(atom));
		this.values = Object.freeze(values);
		this.valuesById = indexIdentities(values, 'atom');
	}

	public get(id: AtomId): InlineAtom | undefined {
		return this.valuesById.get(id);
	}

	public at(point: LinePoint): InlineAtom | undefined {
		return this.values.find(atom => pointsEqual(atom.position, point));
	}

	public forLine(lineId: LineId): readonly InlineAtom[] {
		return this.values.filter(atom => atom.position.lineId === lineId);
	}
}

export class LineFacetStore {
	public readonly values: readonly LineFacet[];
	private readonly valuesById: ReadonlyMap<FacetId, LineFacet>;

	constructor(facets: readonly LineFacet[] = []) {
		const values = facets.map(facet => freezeFacet(facet));
		this.values = Object.freeze(values);
		this.valuesById = indexIdentities(values, 'facet');
	}

	public get(id: FacetId): LineFacet | undefined {
		return this.valuesById.get(id);
	}

	public forLine(lineId: LineId): readonly LineFacet[] {
		return this.values.filter(facet => facet.lineId === lineId);
	}
}

export class RegionStore {
	public readonly values: readonly LineRegion[];
	private readonly valuesById: ReadonlyMap<RegionId, LineRegion>;

	constructor(regions: readonly LineRegion[] = []) {
		const values = regions.map(region => freezeRegion(region));
		this.values = Object.freeze(values);
		this.valuesById = indexIdentities(values, 'region');
	}

	public get(id: RegionId): LineRegion | undefined {
		return this.valuesById.get(id);
	}
}

export class RelationStore {
	public readonly values: readonly LineRelation[];
	private readonly valuesById: ReadonlyMap<RelationId, LineRelation>;

	constructor(relations: readonly LineRelation[] = []) {
		const values = relations.map(relation => freezeRelation(relation));
		this.values = Object.freeze(values);
		this.valuesById = indexIdentities(values, 'relation');
	}

	public get(id: RelationId): LineRelation | undefined {
		return this.valuesById.get(id);
	}
}

export function createLineDocumentSnapshot(input: LineDocumentSnapshotInput): LineDocumentSnapshot {
	if (!input || typeof input !== 'object') throw new TypeError('Line document input must be an object');
	const lines = new LineSequence(input.lines);
	const marks = new RangeStore(lines, input.marks);
	const atoms = new PointStore(input.atoms);
	const facets = new LineFacetStore(input.facets);
	const regions = new RegionStore(input.regions);
	const relations = new RelationStore(input.relations);
	validateSemanticIdentities(marks, atoms, facets, regions, relations);
	validateMarks(lines, marks, atoms);
	validateAtoms(lines, atoms);
	validateFacets(lines, facets);
	validateRegions(lines, regions);
	validateRelations(lines, atoms, regions, relations);
	const text = lines.values.map(line => line.text).join('\n');
	return Object.freeze({
		lines,
		marks,
		atoms,
		facets,
		regions,
		relations,
		metadata: freezeAttributes(input.metadata),
		getText: () => text,
	});
}

export function linePoint(lineId: LineId, offset: number): LinePoint {
	assertIdentity(lineId, 'Line');
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Line point offset must be a non-negative safe integer');
	return Object.freeze({ lineId, offset });
}

function freezeMark(mark: PersistentMark): PersistentMark {
	assertIdentity(mark.id, 'Mark');
	assertKind(mark.kind, 'Mark');
	return Object.freeze({
		id: mark.id,
		kind: mark.kind,
		from: freezePoint(mark.from),
		to: freezePoint(mark.to),
		attrs: freezeAttributes(mark.attrs),
	});
}

function freezeAtom(atom: InlineAtom): InlineAtom {
	assertIdentity(atom.id, 'Atom');
	assertKind(atom.kind, 'Atom');
	if (atom.display !== 'inline' && atom.display !== 'block') throw new TypeError(`Atom '${atom.id}' has an invalid display mode`);
	return Object.freeze({
		id: atom.id,
		kind: atom.kind,
		position: freezePoint(atom.position),
		display: atom.display,
		attrs: freezeAttributes(atom.attrs),
	});
}

function freezeFacet(facet: LineFacet): LineFacet {
	assertIdentity(facet.id, 'Facet');
	assertKind(facet.kind, 'Facet');
	assertIdentity(facet.lineId, 'Line');
	return Object.freeze({ id: facet.id, kind: facet.kind, lineId: facet.lineId, attrs: freezeAttributes(facet.attrs) });
}

function freezeRegion(region: LineRegion): LineRegion {
	assertIdentity(region.id, 'Region');
	assertKind(region.kind, 'Region');
	assertIdentity(region.startLineId, 'Line');
	assertIdentity(region.endLineId, 'Line');
	if (region.parentRegionId !== undefined) assertIdentity(region.parentRegionId, 'Parent region');
	return Object.freeze({
		id: region.id,
		kind: region.kind,
		startLineId: region.startLineId,
		endLineId: region.endLineId,
		...(region.parentRegionId === undefined ? {} : { parentRegionId: region.parentRegionId }),
		attrs: freezeAttributes(region.attrs),
	});
}

function freezeRelation(relation: LineRelation): LineRelation {
	assertIdentity(relation.id, 'Relation');
	assertKind(relation.kind, 'Relation');
	if (relation.unresolved !== undefined && typeof relation.unresolved !== 'boolean') {
		throw new TypeError(`Relation '${relation.id}' unresolved state must be a boolean`);
	}
	return Object.freeze({
		id: relation.id,
		kind: relation.kind,
		source: freezeRelationTarget(relation.source),
		target: freezeRelationTarget(relation.target),
		...(relation.unresolved === undefined ? {} : { unresolved: relation.unresolved }),
		attrs: freezeAttributes(relation.attrs),
	});
}

function freezePoint(point: LinePoint): LinePoint {
	if (!point || typeof point !== 'object') throw new TypeError('Line point must be an object');
	return linePoint(point.lineId, point.offset);
}

function freezeRelationTarget(target: LineRelationTarget): LineRelationTarget {
	if (!target || typeof target !== 'object') throw new TypeError('Line relation target must be an object');
	switch (target.kind) {
		case 'line':
			assertIdentity(target.lineId, 'Relation line');
			return Object.freeze({ kind: target.kind, lineId: target.lineId });
		case 'atom':
			assertIdentity(target.atomId, 'Relation atom');
			return Object.freeze({ kind: target.kind, atomId: target.atomId });
		case 'region':
			assertIdentity(target.regionId, 'Relation region');
			return Object.freeze({ kind: target.kind, regionId: target.regionId });
		case 'external':
			assertIdentity(target.targetId, 'External relation target');
			return Object.freeze({ kind: target.kind, targetId: target.targetId });
		default:
			throw new TypeError('Unknown line relation target kind');
	}
}

function freezeAttributes(attrs: LineSemanticAttributes | undefined): LineSemanticAttributes {
	if (attrs === undefined) return EMPTY_ATTRIBUTES;
	if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw new TypeError('Line semantic attributes must be an object');
	const prototype = Object.getPrototypeOf(attrs);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Line semantic attributes must be a plain object');
	const result: Record<string, LineSemanticValue> = {};
	const seen = new WeakSet<object>();
	seen.add(attrs);
	for (const [key, value] of Object.entries(attrs)) result[key] = freezeSemanticValue(value, key, seen);
	return Object.freeze(result);
}

function freezeSemanticValue(value: LineSemanticValue, owner: string, seen: WeakSet<object>): LineSemanticValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError(`Line semantic attribute '${owner}' must be finite`);
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError(`Line semantic attribute '${owner}' must not contain cycles`);
		seen.add(value);
		const result = Object.freeze(value.map(item => freezeSemanticValue(item, owner, seen)));
		seen.delete(value);
		return result;
	}
	if (typeof value === 'object') {
		if (seen.has(value)) throw new TypeError(`Line semantic attribute '${owner}' must not contain cycles`);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`Line semantic attribute '${owner}' must be a plain object`);
		}
		seen.add(value);
		const result: Record<string, LineSemanticValue> = {};
		for (const [key, child] of Object.entries(value)) result[key] = freezeSemanticValue(child, `${owner}.${key}`, seen);
		seen.delete(value);
		return Object.freeze(result);
	}
	throw new TypeError(`Line semantic attribute '${owner}' is not JSON-safe`);
}

function validateMarks(lines: LineSequence, marks: RangeStore, atoms: PointStore): void {
	for (const mark of marks.values) {
		validatePoint(lines, mark.from, `Mark '${mark.id}' start`);
		validatePoint(lines, mark.to, `Mark '${mark.id}' end`);
		if (comparePoints(lines, mark.from, mark.to) >= 0) throw new RangeError(`Mark '${mark.id}' must have a non-empty ordered range`);
		for (const atom of atoms.values) {
			const atomEnd = linePoint(atom.position.lineId, atom.position.offset + 1);
			if (comparePoints(lines, mark.from, atomEnd) < 0 && comparePoints(lines, mark.to, atom.position) > 0) {
				throw new RangeError(`Mark '${mark.id}' must not include atom '${atom.id}'`);
			}
		}
	}
}

function validateAtoms(lines: LineSequence, atoms: PointStore): void {
	const atomsByPoint = new Set<string>();
	for (const atom of atoms.values) {
		validatePoint(lines, atom.position, `Atom '${atom.id}' position`, false);
		const line = lines.get(atom.position.lineId)!;
		if (line.text.charAt(atom.position.offset) !== OBJECT_REPLACEMENT_CHARACTER) {
			throw new RangeError(`Atom '${atom.id}' must point at one object replacement character`);
		}
		const pointKey = `${atom.position.lineId}\u0000${atom.position.offset}`;
		if (atomsByPoint.has(pointKey)) throw new RangeError(`More than one atom occupies ${atom.position.lineId}:${atom.position.offset}`);
		atomsByPoint.add(pointKey);
		if (atom.display === 'block' && line.text !== OBJECT_REPLACEMENT_CHARACTER) {
			throw new RangeError(`Block atom '${atom.id}' must be the only content in its logical line`);
		}
	}
	for (const line of lines.values) {
		for (
			let offset = line.text.indexOf(OBJECT_REPLACEMENT_CHARACTER);
			offset >= 0;
			offset = line.text.indexOf(OBJECT_REPLACEMENT_CHARACTER, offset + 1)
		) {
			if (!atomsByPoint.has(`${line.id}\u0000${offset}`)) {
				throw new RangeError(`Object replacement character at ${line.id}:${offset} has no atom`);
			}
		}
	}
}

function validateFacets(lines: LineSequence, facets: LineFacetStore): void {
	for (const facet of facets.values) {
		if (!lines.get(facet.lineId)) throw new RangeError(`Facet '${facet.id}' refers to missing line '${facet.lineId}'`);
	}
}

function validateRegions(lines: LineSequence, regions: RegionStore): void {
	const intervals = new Map<RegionId, { readonly start: number; readonly end: number }>();
	for (const region of regions.values) {
		const start = lines.indexOf(region.startLineId);
		const end = lines.indexOf(region.endLineId);
		if (start < 0 || end < 0) throw new RangeError(`Region '${region.id}' refers to a missing line`);
		if (end < start) throw new RangeError(`Region '${region.id}' end precedes its start`);
		intervals.set(region.id, { start, end });
	}
	for (const region of regions.values) {
		const interval = intervals.get(region.id)!;
		if (region.parentRegionId !== undefined) {
			const parent = intervals.get(region.parentRegionId);
			if (!parent) throw new RangeError(`Region '${region.id}' refers to missing parent '${region.parentRegionId}'`);
			if (parent.start > interval.start || parent.end < interval.end) {
				throw new RangeError(`Region '${region.id}' falls outside parent '${region.parentRegionId}'`);
			}
		}
		for (const other of regions.values) {
			if (region.id >= other.id) continue;
			const otherInterval = intervals.get(other.id)!;
			if (interval.end < otherInterval.start || otherInterval.end < interval.start) continue;
			const regionContainsOther = interval.start <= otherInterval.start && interval.end >= otherInterval.end;
			const otherContainsRegion = otherInterval.start <= interval.start && otherInterval.end >= interval.end;
			if (!regionContainsOther && !otherContainsRegion) throw new RangeError(`Regions '${region.id}' and '${other.id}' cross`);
			if (regionContainsOther && other.parentRegionId !== region.id) {
				throw new RangeError(`Nested region '${other.id}' must name parent '${region.id}'`);
			}
			if (otherContainsRegion && region.parentRegionId !== other.id) {
				throw new RangeError(`Nested region '${region.id}' must name parent '${other.id}'`);
			}
		}
	}
}

function validateRelations(lines: LineSequence, atoms: PointStore, regions: RegionStore, relations: RelationStore): void {
	for (const relation of relations.values) {
		validateRelationTarget(relation.source, false, relation, lines, atoms, regions);
		validateRelationTarget(relation.target, relation.unresolved === true, relation, lines, atoms, regions);
	}
}

function validateRelationTarget(
	target: LineRelationTarget,
	canBeMissing: boolean,
	relation: LineRelation,
	lines: LineSequence,
	atoms: PointStore,
	regions: RegionStore,
): void {
	let exists = false;
	switch (target.kind) {
		case 'line':
			exists = lines.get(target.lineId) !== undefined;
			break;
		case 'atom':
			exists = atoms.get(target.atomId) !== undefined;
			break;
		case 'region':
			exists = regions.get(target.regionId) !== undefined;
			break;
		case 'external':
			exists = false;
			break;
	}
	if (!exists && !canBeMissing) throw new RangeError(`Relation '${relation.id}' has an unresolved ${target.kind} endpoint`);
}

function validateSemanticIdentities(
	marks: RangeStore,
	atoms: PointStore,
	facets: LineFacetStore,
	regions: RegionStore,
	relations: RelationStore,
): void {
	const identities = new Map<string, string>();
	for (const [kind, values] of [
		['mark', marks.values],
		['atom', atoms.values],
		['facet', facets.values],
		['region', regions.values],
		['relation', relations.values],
	] as const) {
		for (const value of values) {
			const previous = identities.get(value.id);
			if (previous) throw new TypeError(`Semantic id '${value.id}' is shared by a ${previous} and ${kind}`);
			identities.set(value.id, kind);
		}
	}
}

function validatePoint(lines: LineSequence, point: LinePoint, owner: string, allowLineEnd = true): void {
	const line = lines.get(point.lineId);
	if (!line) throw new RangeError(`${owner} refers to missing line '${point.lineId}'`);
	const maximum = allowLineEnd ? line.text.length : line.text.length - 1;
	if (!Number.isSafeInteger(point.offset) || point.offset < 0 || point.offset > maximum) {
		throw new RangeError(`${owner} offset is outside line '${point.lineId}'`);
	}
}

function comparePoints(lines: LineSequence, left: LinePoint, right: LinePoint): number {
	const lineComparison = lines.indexOf(left.lineId) - lines.indexOf(right.lineId);
	return lineComparison || left.offset - right.offset;
}

function pointsEqual(left: LinePoint, right: LinePoint): boolean {
	return left.lineId === right.lineId && left.offset === right.offset;
}

function indexIdentities<T extends { readonly id: string }>(values: readonly T[], kind: string): ReadonlyMap<string, T> {
	const valuesById = new Map<string, T>();
	for (const value of values) {
		if (valuesById.has(value.id)) throw new TypeError(`Duplicate ${kind} id '${value.id}'`);
		valuesById.set(value.id, value);
	}
	return valuesById;
}

function assertIdentity(value: string, owner: string): void {
	if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${owner} id must be a non-empty string`);
}

function assertKind(value: string, owner: string): void {
	if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${owner} kind must be a non-empty string`);
}

const OBJECT_REPLACEMENT_CHARACTER = '\uFFFC';
const EMPTY_ATTRIBUTES: LineSemanticAttributes = Object.freeze({});
