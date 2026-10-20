import { registerTestCodeEditorFeatures } from '../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { type URI } from '../../../../base/common/uri.js';
import { LanguageDiagnosticSeverity } from '../../../common/languages.js';
import { LanguageDiagnosticDecorationBridge } from '../../../contrib/gotoError/common/diagnosticDecorations.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../platform/markers/common/markerService.js';
import { MarkerDecorationsService } from '../../../common/services/markerDecorationsService.js';
import { TextModel } from '../../../common/model/textModel.js';
import { Range } from '../../../common/core/range.js';

function fixture() {
	const container = new InstantiationService();
	const markers = new MarkerService();
	container.registerInstance(IMarkerService, markers);
	return { container, markers, service: container.createInstance(MarkerDecorationsService) };
}

test('numeric marker severities retain decoration styles and structured code text', () => {
	const setup = fixture();
	using container = setup.container;
	using markers = setup.markers;
	using service = setup.service;
	using model = new TextModel('abcdef');
	markers.changeOne('test', model.uri, [MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info, MarkerSeverity.Hint].map(severity => ({
		startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4,
		severity, message: 'problem', source: 'compiler',
		code: { value: '0', target: model.uri },
	})));
	using reference = service.acquire(model);
	const decorations = model.getAllDecorations().filter(value => value.options.description === 'marker-decoration');
	assert.deepEqual(decorations.map(value => value.options.className), ['squiggly-error', 'squiggly-warning', 'squiggly-info', 'squiggly-hint']);
	assert.deepEqual(decorations.map(value => value.options.hoverMessage), Array(4).fill({ value: 'compiler 0: problem' }));
});

test('marker decorations are shared until the last editor releases the model', () => {
	const setup = fixture();
	using container = setup.container;
	using markers = setup.markers;
	using service = setup.service;
	using model = new TextModel('abcdef');
	markers.changeAll('test', [{ resource: model.uri, marker: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4, severity: MarkerSeverity.Error, message: 'problem' } }]);
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
	markers.changeAll('test', [{ resource: model.uri, marker: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4, severity: MarkerSeverity.Warning, message: 'warning' } }]);
	using reference = service.acquire(model);
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'X' }]);
	assert.deepEqual(service.getLiveMarkers(model.uri).map(([range]) => range), [new Range(1, 3, 1, 5)]);
	const suppression = service.addMarkerSuppression(model.uri, new Range(1, 3, 1, 5));
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-warning').length, 0);
	assert.deepEqual(service.getLiveMarkers(model.uri), []);
	suppression.dispose();
	assert.deepEqual(service.getLiveMarkers(model.uri).map(([range]) => range), [new Range(1, 3, 1, 5)]);
	markers.changeAll('test', []);
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
	markers.changeAll('test', [{ resource: model.uri, marker: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, severity: MarkerSeverity.Hint, message: 'hint' } }]);
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
	using navigation = new LanguageDiagnosticDecorationBridge(model.diagnostics.results, source, model.uri, false);
	markers.changeAll('language', [{ resource: model.uri, marker: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4, severity: MarkerSeverity.Error, message: diagnostic.message } }]);
	using reference = service.acquire(model, source);
	assert.equal(navigation.decorations.size, 1);
	assert.equal(service.getLiveMarkers(model.uri).length, 1);
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-error').length, 1);
	using suppression = service.addMarkerSuppression(model.uri, range);
	assert.equal(model.getAllDecorations().filter(value => value.options.className === 'squiggly-error').length, 0);
	assert.equal(navigation.decorations.size, 1);
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
