import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	MarkerSeverity,
	type IMarkerService,
	type IResourceMarker,
} from '../../../../platform/markers/common/markers.js';
import type { ILanguageDiagnosticsService } from '../common/languageDiagnosticsService.js';

const LanguageDiagnosticsOwner = 'language';

/** Projects editor diagnostics into the platform-wide resource marker store. */
export class LanguageDiagnosticsMarkerBridge extends Disposable {
	constructor(
		private readonly diagnosticsService: ILanguageDiagnosticsService,
		private readonly markerService: IMarkerService,
	) {
		super();
		this._register(diagnosticsService.onDidChangeDiagnostics(() => this.update()));
		this.update();
	}

	private update(): void {
		const markers: IResourceMarker[] = [];
		for (const snapshot of this.diagnosticsService.getAllDiagnostics()) {
			for (const diagnostic of snapshot.diagnostics) {
				markers.push({
					resource: snapshot.resource,
					marker: {
						startLineNumber: diagnostic.range.startLineNumber,
						startColumn: diagnostic.range.startColumn,
						endLineNumber: diagnostic.range.endLineNumber,
						endColumn: diagnostic.range.endColumn,
						severity: toMarkerSeverity(diagnostic.severity),
						message: diagnostic.message,
						// Unopened resources use revision 0, which does not identify an editor model version.
						...(snapshot.revision === 0 ? {} : { modelVersionId: snapshot.revision }),
						...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
						...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
					},
				});
			}
		}
		this.markerService.changeAll(LanguageDiagnosticsOwner, markers);
	}

	protected override disposeCore(): void {
		this.markerService.changeAll(LanguageDiagnosticsOwner, []);
		super.disposeCore();
	}
}

function toMarkerSeverity(value: string): MarkerSeverity {
	switch (value) {
		case 'error':
			return MarkerSeverity.Error;
		case 'warning':
			return MarkerSeverity.Warning;
		case 'information':
			return MarkerSeverity.Info;
		case 'hint':
			return MarkerSeverity.Hint;
		default:
			throw new TypeError(`Unknown language diagnostic severity: ${value}`);
	}
}
