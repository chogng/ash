import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IFileTextModelService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { IMarkerService, MarkerSeverity, type IResourceMarker } from '../../../platform/markers/common/markers.js';
import type { ExtensionClientSource, ExtensionHostFleetSnapshot } from '../../../platform/agentHost/common/extensionHostApi.js';
import type { ExtensionDiagnosticEntry } from '../common/extHost.protocol.js';

/** Marker ownership includes the broker-supplied incarnation; extensions cannot clear each other's collections. */
export class MainThreadDiagnostics extends Disposable {
	private readonly collections = this._register(new DisposableMap<string, IDisposable>());
	private sources = new Set<string>();

	constructor(@IMarkerService private readonly markers: IMarkerService, @IFileTextModelService private readonly models: IFileTextModelService) { super(); }

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		this.sources = new Set(snapshot.extensions.filter(runtime => runtime.lifecycle === 'ready' && runtime.incarnation !== undefined).map(runtime => JSON.stringify([runtime.id, runtime.activationGeneration, runtime.incarnation])));
		for (const key of this.collections.keys()) {
			const [source] = JSON.parse(key) as [string, string];
			if (!this.sources.has(source)) this.collections.deleteAndDispose(key);
		}
	}

	public set(source: ExtensionClientSource, collection: string, entries: readonly ExtensionDiagnosticEntry[], merge = false): void {
		const identity = JSON.stringify([source.extensionId, source.activationGeneration, source.incarnation]);
		if (!this.sources.has(identity)) throw new Error('Diagnostic request belongs to a retired extension');
		if (!collection || collection.length > 256 || entries.length > 1024) throw new TypeError('Invalid diagnostic collection');
		const values: IResourceMarker[] = [];
		const resources = new Set<string>();
		let stale = false;
		for (const entry of entries) {
			const resource = URI.parse(entry.uri);
			if (!resource.scheme || resources.has(resource.toString())) throw new TypeError('Diagnostic resources must be distinct URIs');
			resources.add(resource.toString());
			if (entry.version !== null) {
				if (!Number.isSafeInteger(entry.version) || entry.version < 1) throw new TypeError('Invalid diagnostic document version');
				stale ||= this.models.getModel(resource)?.getVersionId() !== entry.version;
			}
			for (const diagnostic of entry.diagnostics) {
				const { start, end } = diagnostic;
				if ([start.line, start.character, end.line, end.character].some(value => !Number.isSafeInteger(value) || value < 0) || start.line > end.line || start.line === end.line && start.character > end.character) throw new TypeError('Invalid diagnostic UTF-16 range');
				if (typeof diagnostic.message !== 'string' || !diagnostic.message.trim()) throw new TypeError('Diagnostic message must not be empty');
				values.push({
					resource,
					marker: {
						startLineNumber: start.line + 1,
						startColumn: start.character + 1,
						endLineNumber: end.line + 1,
						endColumn: end.character + 1,
						message: diagnostic.message,
						severity: diagnosticSeverity(diagnostic.severity),
						...(entry.version === null ? {} : { modelVersionId: entry.version }),
						...(diagnostic.source === null ? {} : { source: diagnostic.source }),
						...(diagnostic.code === null ? {} : { code: diagnostic.code }),
					},
				});
			}
		}
		if (values.length > 10000) throw new RangeError('Diagnostic collection exceeds 10000 markers');
		// Reject the whole replacement so an old callback cannot clear a newer result on another resource.
		if (stale) return;
		const key = JSON.stringify([identity, collection]);
		const owner = `extensionHost.diagnostics.${key}`;
		if (entries.length === 0) {
			if (!merge) this.collections.deleteAndDispose(key);
			return;
		}
		const isNew = !this.collections.has(key);
		if (isNew) {
			if ([...this.collections.keys()].filter(value => (JSON.parse(value) as [string, string])[0] === identity).length >= 128) throw new RangeError('Extension diagnostic collection quota exceeded');
		}
		if (merge) {
			const retained = this.markers.read({ owner }).filter(marker => !resources.has(marker.resource.toString())).length;
			if (retained + values.length > 10000) throw new RangeError('Diagnostic collection exceeds 10000 markers');
			const byResource = new Map<string, IResourceMarker['marker'][]>();
			for (const value of values) {
				const key = value.resource.toString();
				const markers = byResource.get(key) ?? [];
				markers.push(value.marker);
				byResource.set(key, markers);
			}
			for (const entry of entries) {
				const resource = URI.parse(entry.uri);
				this.markers.changeOne(owner, resource, byResource.get(resource.toString()) ?? []);
			}
		} else { this.markers.changeAll(owner, values); }
		if (isNew) this.collections.set(key, toDisposable(() => this.markers.changeAll(owner, [])));
	}

	public clear(): void { this.collections.clearAndDisposeAll(); this.sources.clear(); }
}

function diagnosticSeverity(value: ExtensionDiagnosticEntry['diagnostics'][number]['severity']): MarkerSeverity {
	switch (value) {
		case 'error': return MarkerSeverity.Error;
		case 'warning': return MarkerSeverity.Warning;
		case 'information': return MarkerSeverity.Info;
		case 'hint': return MarkerSeverity.Hint;
		default: throw new TypeError('Unknown diagnostic severity');
	}
}
