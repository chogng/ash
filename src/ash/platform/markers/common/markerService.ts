import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import {
	type IMarker,
	type IMarkerData,
	type IMarkerReadOptions,
	type IMarkerService,
	type IResourceMarker,
	MarkerSeverity,
	type MarkerStatistics,
} from './markers.js';

/** Stores normalized diagnostic snapshots once per owner and resource. */
export class MarkerService extends Disposable implements IMarkerService {
	readonly _serviceBrand = undefined;
	private readonly changed = this._register(new Emitter<readonly URI[]>());
	private readonly byOwner = new Map<string, Map<string, IMarker[]>>();
	readonly onMarkerChanged = this.changed.event;

	changeAll(owner: string, data: IResourceMarker[]): void {
		this.assertNotDisposed();
		const resources = new Map<string, URI>();
		for (const [key, markers] of this.byOwner.get(owner) ?? []) {
			resources.set(key, markers[0].resource);
		}
		const next = new Map<string, IMarker[]>();
		for (const { resource, marker } of data) {
			const key = resource.toString();
			const markers = next.get(key) ?? [];
			markers.push(storeMarker(owner, resource, marker));
			next.set(key, markers);
			resources.set(key, resource);
		}
		if (next.size === 0) this.byOwner.delete(owner);
		else this.byOwner.set(owner, next);
		if (resources.size > 0) this.changed.fire([...resources.values()]);
	}

	changeOne(owner: string, resource: URI, markers: IMarkerData[]): void {
		this.assertNotDisposed();
		const key = resource.toString();
		const current = this.byOwner.get(owner);
		if (markers.length === 0) {
			this.remove(owner, [resource]);
			return;
		}
		const next = current ?? new Map<string, IMarker[]>();
		next.set(key, markers.map(marker => storeMarker(owner, resource, marker)));
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
			for (const [resource, markers] of resources) {
				if (key !== undefined && key !== resource) continue;
				for (const marker of markers) {
					if (filter.severities !== undefined && (filter.severities & marker.severity) === 0) continue;
					result.push(marker);
					if (filter.take !== undefined && filter.take > 0 && result.length >= filter.take) return result;
				}
			}
		}
		return result;
	}

	getStatistics(): MarkerStatistics {
		const result: MarkerStatistics = { errors: 0, warnings: 0, infos: 0, unknowns: 0 };
		for (const marker of this.read()) {
			switch (marker.severity) {
				case MarkerSeverity.Error: result.errors++; break;
				case MarkerSeverity.Warning: result.warnings++; break;
				case MarkerSeverity.Info: result.infos++; break;
				default: result.unknowns++; break;
			}
		}
		return result;
	}

	protected override disposeCore(): void {
		this.byOwner.clear();
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
		...(marker.relatedInformation ? { relatedInformation: marker.relatedInformation.map(info => ({ ...info })) } : {}),
	});
}
