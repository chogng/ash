import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity } from '../../../../../editor/common/languages.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { LanguageDiagnosticsMarkerBridge } from '../../browser/languageDiagnosticsMarkerBridge.js';
import type { ILanguageDiagnosticsService, LanguageDiagnosticSnapshot } from '../../common/languageDiagnosticsService.js';

test('language diagnostics bridge projects current diagnostics into markers', () => {
	const resource = URI.file('C:\\project\\src\\main.rs');
	using changes = new Emitter<URI>();
	let snapshots: readonly LanguageDiagnosticSnapshot[] = [snapshot(resource, LanguageDiagnosticSeverity.Error, 'broken')];
	const diagnostics = {
		onDidChangeDiagnostics: changes.event,
		getAllDiagnostics: () => snapshots,
	} as unknown as ILanguageDiagnosticsService;
	using markerService = new MarkerService();
	using bridge = new LanguageDiagnosticsMarkerBridge(diagnostics, markerService);

	assert.deepEqual(markerService.read().map(marker => ({
		severity: marker.severity,
		message: marker.message,
		source: marker.source,
		code: marker.code,
		modelVersionId: marker.modelVersionId,
		startLineNumber: marker.startLineNumber, startColumn: marker.startColumn, endLineNumber: marker.endLineNumber, endColumn: marker.endColumn,
	})), [{
		severity: MarkerSeverity.Error,
		message: 'broken',
		source: 'rust-analyzer',
		code: '0',
		modelVersionId: 1,
		startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6,
	}]);

	snapshots = [{ ...snapshot(resource, LanguageDiagnosticSeverity.Warning, 'unused'), revision: 0 }];
	changes.fire(resource);
	assert.deepEqual(markerService.read().map(marker => ({ severity: marker.severity, message: marker.message })), [{ severity: MarkerSeverity.Warning, message: 'unused' }]);
	assert.equal(markerService.read()[0].modelVersionId, undefined);

	bridge.dispose();
	snapshots = [];
	changes.fire(resource);
	assert.equal(markerService.read().length, 0);
});

function snapshot(resource: URI, severity: LanguageDiagnosticSeverity, message: string): LanguageDiagnosticSnapshot {
	return {
		resource,
		revision: 1,
		diagnostics: [{
			range: Range.fromPositions(new Position((1) + 1, (2) + 1), new Position((1) + 1, (5) + 1)),
			severity,
			message,
			source: 'rust-analyzer',
			code: 0,
		}],
	};
}
