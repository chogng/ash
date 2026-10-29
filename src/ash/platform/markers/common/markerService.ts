import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import {
	type IMarker,
	type IMarkerData,
	type IMarkerChangeOptions,
	type IMarkerReadOptions,
	type IMarkerService,
	type IResourceMarker,
	MarkerSeverity,
	type MarkerStatistics,
} from './markers.js';

interface MarkerSnapshot {
	readonly resource: URI;
	readonly markers: IMarker[];
	readonly truncated: boolean;
}

/** Stores normalized diagnostic snapshots once per owner and resource. */
export class MarkerService extends Disposable implements IMarkerService {
	readonly _serviceBrand = undefined;
	private readonly changed = this._register(new Emitter<readonly URI[]>());
	private readonly byOwner = new Map<string, Map<string, MarkerSnapshot>>();
	private readonly filters = new Map<string, Set<symbol>>();
	readonly onMarkerChanged = this.changed.event;

	changeAll(owner: string, data: IResourceMarker[]): void {
		this.assertNotDisposed();
		const resources = new Map<string, URI>();
		for (const [key, snapshot] of this.byOwner.get(owner) ?? []) {
			resources.set(key, snapshot.resource);
		}
		const next = new Map<string, MarkerSnapshot>();
		for (const { resource, marker } of data) {
			const key = resource.toString();
			const snapshot = next.get(key) ?? { resource, markers: [], truncated: false };
			snapshot.markers.push(storeMarker(owner, resource, marker));
			next.set(key, snapshot);
			resources.set(key, resource);
		}
		if (next.size === 0) this.byOwner.delete(owner);
		else this.byOwner.set(owner, next);
		if (resources.size > 0) this.changed.fire([...resources.values()]);
	}

	changeOne(owner: string, resource: URI, markers: IMarkerData[], options?: IMarkerChangeOptions): void {
		this.assertNotDisposed();
		const key = resource.toString();
		const current = this.byOwner.get(owner);
		if (markers.length === 0 && !options?.isTruncated) {
			this.remove(owner, [resource]);
			return;
		}
		const next = current ?? new Map<string, MarkerSnapshot>();
		next.set(key, {
			resource,
			markers: markers.map(marker => storeMarker(owner, resource, marker)),
			truncated: options?.isTruncated === true,
		});
		this.byOwner.set(owner, next);
		this.changed.fire([resource]);
	}

	remove(owner: string, resources: URI[]): void {
		this.assertNotDisposed();
		const markers = this.byOwner.get(owner);
		if (!markers) return;
		const changed = new Map<string, URI>();
		for (const resource of resources) {
			const key = resource.toString();
			if (markers.delete(key)) changed.set(key, resource);
		}
		if (markers.size === 0) this.byOwner.delete(owner);
		if (changed.size > 0) this.changed.fire([...changed.values()]);
	}

	read(filter: IMarkerReadOptions = {}): IMarker[] {
		this.assertNotDisposed();
		const result: IMarker[] = [];
		const key = filter.resource?.toString();
		for (const [owner, resources] of this.byOwner) {
			if (filter.owner !== undefined && filter.owner !== owner) continue;
			for (const [resource, snapshot] of resources) {
				if (key !== undefined && key !== resource) continue;
				if (!filter.ignoreResourceFilters && this.filters.has(resource)) continue;
				for (const marker of snapshot.markers) {
					if (filter.severities !== undefined && (filter.severities & marker.severity) === 0) continue;
					result.push(marker);
					if (filter.take !== undefined && filter.take > 0 && result.length >= filter.take) return result;
				}
			}
		}
		return result;
	}

	isSourceTruncated(resource: URI): boolean {
		const key = resource.toString();
		return !this.filters.has(key) && [...this.byOwner.values()].some(resources => resources.get(key)?.truncated);
	}

	installResourceFilter(resource: URI, reason: string): IDisposable {
		this.assertNotDisposed();
		const key = resource.toString();
		const token = Symbol(reason);
		const filters = this.filters.get(key) ?? new Set<symbol>();
		filters.add(token);
		this.filters.set(key, filters);
		this.changed.fire([resource]);
		return toDisposable(() => {
			if (!filters.delete(token)) return;
			if (!filters.size) this.filters.delete(key);
			this.changed.fire([resource]);
		});
	}

	getStatistics(): MarkerStatistics {
		const result: MarkerStatistics = { errors: 0, warnings: 0, infos: 0, unknowns: 0 };
		for (const marker of this.read()) {
			switch (marker.severity) {
				case MarkerSeverity.Error:
					result.errors++;
					break;
				case MarkerSeverity.Warning:
					result.warnings++;
					break;
				case MarkerSeverity.Info:
					result.infos++;
					break;
				default:
					result.unknowns++;
					break;
			}
		}
		return result;
	}

	protected override disposeCore(): void {
		this.byOwner.clear();
		this.filters.clear();
		super.disposeCore();
	}
}

function storeMarker(owner: string, resource: URI, marker: IMarkerData): IMarker {
	// Snapshot mutable metadata so a producer's next update cannot silently change stored diagnostics.
	return Object.freeze({
		...marker,
		owner,
		resource,
		...(typeof marker.code === 'object' ? { code: { ...marker.code } } : {}),
		...(marker.tags ? { tags: [...marker.tags] } : {}),
		...(marker.relatedInformation
			? { relatedInformation: marker.relatedInformation.map(info => ({ ...info })) }
			: {}),
	});
}
