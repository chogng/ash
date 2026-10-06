import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { IMarkerService, MarkerSeverity, type MarkerInput } from '../../../platform/markers/common/markers.js';
import type { ExtensionClientSource, ExtensionDiagnosticEntry, ExtensionHostFleetSnapshot } from '../../../platform/extensionHost/common/extensionHostApi.js';

/** Marker ownership includes the broker-supplied incarnation; extensions cannot clear each other's collections. */
export class MainThreadDiagnostics extends Disposable {
	private readonly collections = this._register(new DisposableMap<string, IDisposable>());
	private sources = new Set<string>();

	constructor(@IMarkerService private readonly markers: IMarkerService, @IModelService private readonly models: IModelService) { super(); }

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		this.sources = new Set(snapshot.extensions.filter(runtime => runtime.lifecycle === 'ready' && runtime.incarnation !== undefined).map(runtime => JSON.stringify([runtime.id, runtime.activationGeneration, runtime.incarnation])));
		for (const key of this.collections.keys()) {
			const [source] = JSON.parse(key) as [string, string];
			if (!this.sources.has(source)) this.collections.deleteAndDispose(key);
		}
	}

	public set(source: ExtensionClientSource, collection: string, entries: readonly ExtensionDiagnosticEntry[]): void {
		const identity = JSON.stringify([source.extensionId, source.activationGeneration, source.incarnation]);
		if (!this.sources.has(identity)) throw new Error('Diagnostic request belongs to a retired extension');
		if (!collection || collection.length > 256 || entries.length > 1024) throw new TypeError('Invalid diagnostic collection');
		const values: MarkerInput[] = [];
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
				values.push({
					resource, range: { start: { lineIndex: start.line, columnIndex: start.character }, end: { lineIndex: end.line, columnIndex: end.character } },
					message: diagnostic.message, severity: diagnosticSeverity(diagnostic.severity),
					...(diagnostic.source === null ? {} : { source: diagnostic.source }), ...(diagnostic.code === null ? {} : { code: diagnostic.code }),
				});
			}
		}
		if (values.length > 10000) throw new RangeError('Diagnostic collection exceeds 10000 markers');
		// Reject the whole replacement so an old callback cannot clear a newer result on another resource.
		if (stale) return;
		const key = JSON.stringify([identity, collection]);
		const owner = `extensionHost.diagnostics.${key}`;
		if (entries.length === 0) { this.collections.deleteAndDispose(key); return; }
		const isNew = !this.collections.has(key);
		if (isNew) {
			if ([...this.collections.keys()].filter(value => (JSON.parse(value) as [string, string])[0] === identity).length >= 128) throw new RangeError('Extension diagnostic collection quota exceeded');
		}
		this.markers.set(owner, values);
		if (isNew) this.collections.set(key, toDisposable(() => this.markers.remove(owner)));
	}

	public clear(): void { this.collections.clearAndDisposeAll(); this.sources.clear(); }
}

function diagnosticSeverity(value: ExtensionDiagnosticEntry['diagnostics'][number]['severity']): MarkerSeverity {
	switch (value) {
		case 'error': return MarkerSeverity.Error;
		case 'warning': return MarkerSeverity.Warning;
		case 'information': return MarkerSeverity.Information;
		case 'hint': return MarkerSeverity.Hint;
	}
}
