import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Severity used by resource markers. */
export enum MarkerSeverity {
	Error = "error",
	Warning = "warning",
	Information = "information",
	Hint = "hint",
}

export interface MarkerPosition {
	readonly lineIndex: number;
	readonly columnIndex: number;
}

export interface MarkerRange {
	readonly start: MarkerPosition;
	readonly end: MarkerPosition;
}

/** A marker without the owner assigned by the service. */
export interface MarkerInput {
	readonly resource: URI;
	readonly range: MarkerRange;
	readonly severity: MarkerSeverity;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
	readonly id?: string;
}

/** Stored marker with a stable owner and identifier. */
export interface Marker extends MarkerInput {
	readonly owner: string;
	readonly id: string;
}

export interface MarkerChange {
	readonly owner: string;
	readonly resources: readonly URI[];
}

/** Cross-resource marker aggregation service. */
export interface IMarkerService {
	readonly onDidChange: Event<MarkerChange>;

	set(owner: string, markers: readonly MarkerInput[]): void;
	changeOne(owner: string, resource: URI, markers: readonly Omit<MarkerInput, "resource">[]): void;
	remove(owner: string, resource?: URI): void;
	read(resource?: URI, owner?: string): readonly Marker[];
	getAll(): readonly Marker[];
}

export const IMarkerService = createServiceIdentifier<IMarkerService>("markerService");

/** In-memory marker store shared by Workbench views and editor projections. */
export class MarkerService extends Disposable implements IMarkerService {
	private readonly _onDidChange = this._register(new Emitter<MarkerChange>());
	private readonly byOwner = new Map<string, Map<string, readonly Marker[]>>();

	readonly onDidChange: Event<MarkerChange> = this._onDidChange.event;

	set(owner: string, markers: readonly MarkerInput[]): void {
		this.assertNotDisposed();
		validateOwner(owner);
		const previous = this.byOwner.get(owner) ?? new Map<string, readonly Marker[]>();
		const next = new Map<string, Marker[]>();
		markers.forEach((input, index) => {
			validateMarker(input);
			const key = input.resource.toString();
			const resourceMarkers = next.get(key) ?? [];
			resourceMarkers.push(Object.freeze({
				...input,
				owner,
				id: input.id ?? `${owner}:${key}:${index}`,
			}));
			next.set(key, resourceMarkers);
		});
		const resources = new Map<string, URI>();
		for (const [key] of previous) resources.set(key, URI.parse(key));
		for (const input of markers) resources.set(input.resource.toString(), input.resource);
		this.byOwner.set(owner, next);
		if (resources.size > 0) this._onDidChange.fire({ owner, resources: [...resources.values()] });
	}

	changeOne(owner: string, resource: URI, markers: readonly Omit<MarkerInput, "resource">[]): void {
		this.assertNotDisposed();
		validateOwner(owner);
		const values = markers.map((marker, index) => {
			const input = { ...marker, resource };
			validateMarker(input);
			return Object.freeze({ ...input, owner, id: input.id ?? `${owner}:${resource.toString()}:${index}` });
		});
		const key = resource.toString();
		const current = this.byOwner.get(owner);
		if (values.length === 0 && !current?.has(key)) return;
		const next = new Map(current);
		if (values.length === 0) next.delete(key);
		else next.set(key, values);
		if (next.size === 0) this.byOwner.delete(owner);
		else this.byOwner.set(owner, next);
		this._onDidChange.fire({ owner, resources: [resource] });
	}

	remove(owner: string, resource?: URI): void {
		this.assertNotDisposed();
		validateOwner(owner);
		const ownerMarkers = this.byOwner.get(owner);
		if (!ownerMarkers) return;
		if (!resource) {
			const resources = [...ownerMarkers.keys()].map(key => URI.parse(key));
			this.byOwner.delete(owner);
			if (resources.length > 0) this._onDidChange.fire({ owner, resources });
			return;
		}
		const key = resource.toString();
		if (!ownerMarkers.delete(key)) return;
		if (ownerMarkers.size === 0) this.byOwner.delete(owner);
		this._onDidChange.fire({ owner, resources: [resource] });
	}

	read(resource?: URI, owner?: string): readonly Marker[] {
		this.assertNotDisposed();
		const owners = owner ? [[owner, this.byOwner.get(owner)] as const] : [...this.byOwner.entries()];
		const result: Marker[] = [];
		for (const [, markers] of owners) {
			if (!markers) continue;
			for (const [key, values] of markers) {
				if (!resource || resource.toString() === key) result.push(...values);
			}
		}
		return result;
	}

	getAll(): readonly Marker[] {
		return this.read();
	}

	protected override disposeCore(): void {
		this.byOwner.clear();
		super.disposeCore();
	}
}

function validateOwner(owner: string): void {
	if (typeof owner !== "string" || owner.trim().length === 0) throw new TypeError("Marker owner must not be empty");
}

function validateMarker(marker: MarkerInput): void {
	if (!(marker.resource instanceof URI)) throw new TypeError("Marker resource must be a URI");
	if (!Object.values(MarkerSeverity).includes(marker.severity)) throw new TypeError("Unknown marker severity");
	if (typeof marker.message !== "string" || marker.message.trim().length === 0) throw new TypeError("Marker message must not be empty");
	validatePosition(marker.range.start);
	validatePosition(marker.range.end);
	if (comparePositions(marker.range.start, marker.range.end) > 0) throw new RangeError("Marker range end must not precede its start");
}

function validatePosition(position: MarkerPosition): void {
	if (!Number.isSafeInteger(position.lineIndex) || position.lineIndex < 0) throw new RangeError("Marker line index must be non-negative");
	if (!Number.isSafeInteger(position.columnIndex) || position.columnIndex < 0) throw new RangeError("Marker column index must be non-negative");
}

function comparePositions(left: MarkerPosition, right: MarkerPosition): number {
	return left.lineIndex - right.lineIndex || left.columnIndex - right.columnIndex;
}
