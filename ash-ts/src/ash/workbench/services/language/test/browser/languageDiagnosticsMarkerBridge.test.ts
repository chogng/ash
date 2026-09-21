import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageDiagnosticSeverity } from '../../../../../editor/common/languages.js';
import { MarkerService, MarkerSeverity } from "../../../../../platform/markers/common/markers.js";
import { LanguageDiagnosticsMarkerBridge } from "../../browser/languageDiagnosticsMarkerBridge.js";
import type { ILanguageDiagnosticsService, LanguageDiagnosticSnapshot } from "../../common/languageDiagnosticsService.js";

test("language diagnostics bridge projects current diagnostics into markers", () => {
	const resource = URI.file("C:\\project\\src\\main.rs");
	const changes = new Emitter<URI>();
	let snapshots: readonly LanguageDiagnosticSnapshot[] = [snapshot(resource, LanguageDiagnosticSeverity.Error, "broken")];
	const diagnostics = {
		onDidChangeDiagnostics: changes.event,
		getAllDiagnostics: () => snapshots,
	} as unknown as ILanguageDiagnosticsService;
	using markerService = new MarkerService();
	using bridge = new LanguageDiagnosticsMarkerBridge(diagnostics, markerService);

	assert.deepEqual(markerService.getAll().map(marker => ({
		severity: marker.severity,
		message: marker.message,
		source: marker.source,
		range: marker.range,
	})), [{
		severity: MarkerSeverity.Error,
		message: "broken",
		source: "rust-analyzer",
		range: { start: { lineIndex: 1, columnIndex: 2 }, end: { lineIndex: 1, columnIndex: 5 } },
	}]);

	snapshots = [snapshot(resource, LanguageDiagnosticSeverity.Warning, "unused")];
	changes.fire(resource);
	assert.deepEqual(markerService.getAll().map(marker => ({ severity: marker.severity, message: marker.message })), [{ severity: MarkerSeverity.Warning, message: "unused" }]);

	bridge.dispose();
	snapshots = [];
	changes.fire(resource);
	assert.equal(markerService.getAll().length, 0);
});

function snapshot(resource: URI, severity: LanguageDiagnosticSeverity, message: string): LanguageDiagnosticSnapshot {
	return {
		resource,
		revision: 1,
		diagnostics: [{
			range: Range.fromPositions(new Position((1) + 1, (2) + 1), new Position((1) + 1, (5) + 1)),
			severity,
			message,
			source: "rust-analyzer",
		}],
	};
}
