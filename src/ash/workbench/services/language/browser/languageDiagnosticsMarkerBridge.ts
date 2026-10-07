import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	MarkerSeverity,
	type IMarkerService,
	type MarkerInput,
} from "../../../../platform/markers/common/markers.js";
import type { ILanguageDiagnosticsService } from "../common/languageDiagnosticsService.js";

const LanguageDiagnosticsOwner = "language";

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
		const markers: MarkerInput[] = [];
		for (const snapshot of this.diagnosticsService.getAllDiagnostics()) {
			for (const diagnostic of snapshot.diagnostics) {
				markers.push({
					resource: snapshot.resource,
					range: {
						start: {
							lineIndex: diagnostic.range.getStartPosition().lineNumber - 1,
							columnIndex: diagnostic.range.getStartPosition().column - 1,
						},
						end: {
							lineIndex: diagnostic.range.getEndPosition().lineNumber - 1,
							columnIndex: diagnostic.range.getEndPosition().column - 1,
						},
					},
					severity: toMarkerSeverity(diagnostic.severity),
					message: diagnostic.message,
					...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
					...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
				});
			}
		}
		this.markerService.set(LanguageDiagnosticsOwner, markers);
	}

	protected override disposeCore(): void {
		this.markerService.remove(LanguageDiagnosticsOwner);
		super.disposeCore();
	}
}

function toMarkerSeverity(value: string): MarkerSeverity {
	switch (value) {
		case "error": return MarkerSeverity.Error;
		case "warning": return MarkerSeverity.Warning;
		case "information": return MarkerSeverity.Information;
		case "hint": return MarkerSeverity.Hint;
		default: throw new TypeError(`Unknown language diagnostic severity: ${value}`);
	}
}
