import { Emitter } from '../../../../base/common/event.js';
import { type URI } from '../../../../base/common/uri.js';
import { LanguageDiagnosticSeverity } from '../../../common/languages/languageResults.js';
import { LanguageDiagnosticDecorationBridge } from '../../../contrib/gotoError/common/diagnosticDecorations.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ServiceContainer } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { MarkerDecorationsService } from '../../../common/services/markerDecorationsService.js';
import { TextModel } from '../../../common/model/textModel.js';
import { Range } from '../../../common/core/range.js';

function fixture() {
	const container = new ServiceContainer();
	const markers = new MarkerService();
	container.registerInstance(IMarkerService, markers);
	return { container, markers, service: container.createInstance(MarkerDecorationsService) };
}

test('marker decorations are shared until the last editor releases the model', () => {
	const setup = fixture();
	using container = setup.container;
	using markers = setup.markers;
	using service = setup.service;
	using model = new TextModel('abcdef');
	markers.set('test', [{ resource: model.uri, range: { start: { lineIndex: 0, columnIndex: 1 }, end: { lineIndex: 0, columnIndex: 3 } }, severity: MarkerSeverity.Error, message: 'problem' }]);
	const first = service.acquire(model);
	const second = service.acquire(model);
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-error').length, 1);
	const decoration = model.getAllDecorations().find(value => value.options.className === 'squiggly-error')!;
	assert.equal(service.getMarker(model.uri, decoration)?.message, 'problem');
	first.dispose();
	assert.equal(service.getLiveMarkers(model.uri).length, 1);
	second.dispose();
	assert.deepEqual(service.getLiveMarkers(model.uri), []);
	assert.equal(model.getAllDecorations().length, 0);
});

test('markers follow edits and suppression restores the live range', () => {
	const setup = fixture();
	using container = setup.container;
	using markers = setup.markers;
	using service = setup.service;
	using model = new TextModel('abcdef');
	markers.set('test', [{ resource: model.uri, range: { start: { lineIndex: 0, columnIndex: 1 }, end: { lineIndex: 0, columnIndex: 3 } }, severity: MarkerSeverity.Warning, message: 'warning' }]);
	using reference = service.acquire(model);
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'X' }]);
	assert.deepEqual(service.getLiveMarkers(model.uri).map(([range]) => range), [new Range(1, 3, 1, 5)]);
	const suppression = service.addMarkerSuppression(model.uri, new Range(1, 3, 1, 5));
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-warning').length, 0);
	assert.deepEqual(service.getLiveMarkers(model.uri), []);
	suppression.dispose();
	assert.deepEqual(service.getLiveMarkers(model.uri).map(([range]) => range), [new Range(1, 3, 1, 5)]);
	markers.remove('test');
	assert.deepEqual(service.getLiveMarkers(model.uri), []);
});

test('disposing a model releases marker listeners and outstanding suppressions', () => {
	const setup = fixture();
	using container = setup.container;
	using markers = setup.markers;
	using service = setup.service;
	const model = new TextModel('abc');
	using reference = service.acquire(model);
	using suppression = service.addMarkerSuppression(model.uri, new Range(1, 1, 1, 2));
	model.dispose();
	markers.set('test', [{ resource: model.uri, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } }, severity: MarkerSeverity.Hint, message: 'hint' }]);
	assert.deepEqual(service.getLiveMarkers(model.uri), []);
});

test('language diagnostics and platform markers produce one visible decoration', () => {
	const setup = fixture();
	using container = setup.container;
	using markers = setup.markers;
	using service = setup.service;
	using model = new TextModel('abcdef');
	const range = new Range(1, 2, 1, 4);
	const diagnostic = { range, severity: LanguageDiagnosticSeverity.Error, message: 'same problem' };
	using changed = new Emitter<URI>();
	const source = {
		onDidChangeDiagnostics: changed.event,
		getDiagnostics: () => ({ resource: model.uri, revision: model.getVersionId(), diagnostics: [diagnostic] }),
	};
	using navigation = new LanguageDiagnosticDecorationBridge(model.tokenization.syntaxService.diagnostics, source, model.uri, false);
	markers.set('language', [{ resource: model.uri, range: { start: { lineIndex: 0, columnIndex: 1 }, end: { lineIndex: 0, columnIndex: 3 } }, severity: MarkerSeverity.Error, message: diagnostic.message }]);
	using reference = service.acquire(model, source);
	assert.equal(navigation.decorations.size, 1);
	assert.equal(service.getLiveMarkers(model.uri).length, 1);
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-error').length, 1);
	using suppression = service.addMarkerSuppression(model.uri, range);
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-error').length, 0);
	assert.equal(navigation.decorations.size, 1);
});
