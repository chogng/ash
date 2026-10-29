import { StatusbarService } from '../../../../browser/parts/statusbar/statusbarPart.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { after, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { createTestCodeEditor, registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { ColorDetector } from '../../../../../editor/contrib/colorPicker/browser/colorDetector.js';
import { FoldingController } from '../../../../../editor/contrib/folding/browser/folding.js';
import '../../../../../editor/contrib/colorPicker/browser/colorPickerContribution.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { LimitIndicatorContribution } from '../../browser/limitIndicator.contribution.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextMenuService, IContextViewService, type IContextMenuMenuDelegate } from '../../../../../platform/contextview/browser/contextView.js';
import { ILanguageStatusService } from '../../../../services/languageStatus/common/languageStatusService.js';
import { LanguageStatusContribution } from '../../../languageStatus/browser/languageStatus.js';
import { DiagnosticDecorationLimitReporter } from '../../browser/limitIndicator.contribution.js';
import { IMarkerDecorationsService } from '../../../../../editor/common/services/markerDecorations.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import '../../../../../editor/common/config/editorConfigurationSchema.js';

test('real color and folding limits retain separate Configure actions in one language status entry', async () => {
	using resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	resources.add(toDisposable(() => dom.window.close()));
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const services = resources.add(new InstantiationService());
	const changed = resources.add(new Emitter<void>());
	let active: unknown;
	services.registerInstance(IEditorService, {
		onDidActiveEditorChange: changed.event,
		get activeEditorPane() {
			return active ? { getControl: () => active } : undefined;
		},
	} as IEditorService);
	const statusbar = resources.add(new StatusbarService());
	services.registerInstance(IStatusbarService, statusbar);
	let menu: IContextMenuMenuDelegate | undefined;
	services.registerInstance(IContextViewService, { container: dom.window.document.body } as IContextViewService);
	services.registerInstance(IContextMenuService, {
		showContextMenu: delegate => {
			menu = delegate;
		},
	} as IContextMenuService);
	const commands: unknown[][] = [];
	services.registerInstance(ICommandService, {
		onWillExecuteCommand: Event.None,
		onDidExecuteCommand: Event.None,
		executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => {
			commands.push([id, ...args]);
			return undefined as T;
		},
	});
	registerCodeEditorServices(services);
	const features = resources.add(new LanguageFeaturesService());
	resources.add(
		features.colorProvider.register('*', {
			provideDocumentColors: () =>
				[1, 6, 11].map(column => ({
					range: new Range(5, column, 5, column + 4),
					color: { red: 1, green: 0, blue: 0, alpha: 1 },
				})),
			provideColorPresentations: () => [],
		}),
	);
	const model = resources.add(new TextModel('first\n  child\nsecond\n  child\n#f00 #f00 #f00\n' + Array.from({ length: 10 }, (_, index) => `section${index}\n  child`).join('\n')));
	const editor = resources.add(
		createTestCodeEditor({
			container: dom.window.document.querySelector<HTMLElement>('main')!,
			model,
			languageFeaturesService: features,
			instantiationService: services,
		}),
	);
	editor.updateOptions({ colorDecoratorsLimit: 1, foldingMaximumRegions: 10, foldingStrategy: 'indentation' });
	editor.layout({ width: 500, height: 180 });
	editor.focus();
	active = editor;
	const contribution = resources.add(services.createInstance(LimitIndicatorContribution));
	resources.add(services.createInstance(LanguageStatusContribution));
	const statuses = services.get(ILanguageStatusService);
	await waitFor(() => ColorDetector.get(editor)?.limitReporter.computed === 3 && statusbar.getEntries(StatusbarAlignment.Right).length === 1);
	const entry = () => statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry;
	assert.equal(ColorDetector.get(editor)?.limitReporter.computed, 3);
	assert.equal(FoldingController.get(editor)?.limitReporter.computed, 12);
	assert.match(entry()!.tooltip!, /Color decorators: only 1 shown/);
	assert.match(entry()!.tooltip!, /Folding ranges: only 10 shown/);
	assert.deepEqual(
		statuses
			.getLanguageStatus(model)
			.map(status => status.id)
			.sort(),
		['decoratorsLimitInfo', 'foldingLimitInfo'],
	);
	const anchor = dom.window.document.createElement('a');
	anchor.className = 'ash-statusbar-item-label';
	const item = dom.window.document.createElement('div');
	item.dataset.statusbarItemId = LanguageStatusContribution.Id;
	item.append(anchor);
	dom.window.document.body.append(item);
	await entry()!.run!();
	const configure = menu!.getActions!().filter(action => action.enabled && action.id.endsWith('.configure'));
	assert.equal(configure.length, 2);
	for (const action of configure) await action.run();
	assert.deepEqual(commands, [
		['workbench.action.openSettings', 'editor.colorDecoratorsLimit'],
		['workbench.action.openSettings', 'editor.foldingMaximumRegions'],
	]);
	editor.updateOptions({ colorDecoratorsLimit: 10, foldingMaximumRegions: 20 });
	await waitFor(() => statusbar.getEntries(StatusbarAlignment.Right).length === 0);
	const plain = resources.add(new TextModel('plain'));
	editor.setModel(plain);
	changed.fire();
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
	contribution.dispose();
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
});

function diagnosticFixture() {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const services = resources.add(new InstantiationService());
	registerCodeEditorServices(services);
	const changed = resources.add(new Emitter<void>());
	let active: unknown;
	services.registerInstance(IEditorService, {
		onDidActiveEditorChange: changed.event,
		get activeEditorPane() {
			return active ? { getControl: () => active } : undefined;
		},
	} as IEditorService);
	const statuses = services.get(ILanguageStatusService);
	const markers = services.get(IMarkerService);
	const decorations = services.get(IMarkerDecorationsService);
	const model = () => resources.add(new TextModel(Array.from({ length: 5100 }, () => 'value').join('\n')));
	const createEditor = (value = model()) => {
		const container = dom.window.document.body.appendChild(dom.window.document.createElement('main'));
		return resources.add(createTestCodeEditor({ container, model: value, instantiationService: services }));
	};
	const editor = createEditor();
	active = editor;
	const contribution = resources.add(services.createInstance(LimitIndicatorContribution));
	return {
		resources,
		services,
		editor,
		createEditor,
		model,
		contribution,
		statuses,
		markers,
		decorations,
		activate(control: unknown) {
			active = control;
			changed.fire();
		},
		setMarkers(value: TextModel, count: number, truncated = false) {
			markers.changeOne(
				'test',
				value.uri,
				Array.from({ length: count }, (_, index) => ({
					severity: MarkerSeverity.Error,
					message: `problem ${index}`,
					startLineNumber: index + 1,
					startColumn: 1,
					endLineNumber: index + 1,
					endColumn: 2,
				})),
				{ isTruncated: truncated },
			);
		},
		details(value = editor.getModel()!) {
			return statuses.getLanguageStatus(value).map(status => status.detail);
		},
	};
}

test('diagnostic source truncation and the 5000 decoration budget remain distinct', () => {
	const fixture = diagnosticFixture();
	using resources = fixture.resources;
	const model = fixture.editor.getModel()!;
	fixture.setMarkers(model, 5000);
	assert.deepEqual(fixture.details(), []);
	fixture.setMarkers(model, 5001);
	assert.equal(fixture.decorations.getLiveMarkers(model.uri).length, 5000);
	assert.deepEqual(fixture.details(), ['Only 5000 problems are rendered in the editor for performance reasons.']);
	const status = fixture.statuses.getLanguageStatus(model)[0];
	fixture.setMarkers(model, 5100);
	assert.equal(fixture.statuses.getLanguageStatus(model)[0], status);
	assert.equal(status.command, undefined);
	fixture.setMarkers(model, 1001, true);
	assert.deepEqual(fixture.details(), ['Some problems are not shown in the problems view for performance reasons.']);
	fixture.setMarkers(model, 5001, true);
	assert.deepEqual(fixture.details(), ['Some problems are not shown in the problems view, and only 5000 problems are rendered in the editor for performance reasons.']);
	fixture.setMarkers(model, 5000);
	assert.deepEqual(fixture.details(), []);
});

test('diagnostic limits follow model changes, empty editors, split panes and the modified diff side', () => {
	const fixture = diagnosticFixture();
	using resources = fixture.resources;
	const original = fixture.editor.getModel()!;
	fixture.setMarkers(original, 5001);
	assert.equal(fixture.details().length, 1);
	const other = fixture.createEditor();
	fixture.activate(other);
	assert.deepEqual(fixture.details(), []);
	fixture.setMarkers(original, 5100);
	assert.deepEqual(fixture.details(), []);
	fixture.activate(fixture.editor);
	assert.equal(fixture.details().length, 1);
	fixture.activate({ getOriginalEditor: () => fixture.editor, getModifiedEditor: () => other });
	assert.deepEqual(fixture.details(), []);
	fixture.setMarkers(other.getModel()!, 5001);
	assert.equal(fixture.details().length, 1);
	const plain = fixture.model();
	other.setModel(plain);
	assert.deepEqual(fixture.details(), []);
	other.setModel(original);
	assert.equal(fixture.details().length, 1);
	other.setModel(null);
	assert.deepEqual(fixture.details(), []);
	other.setModel(original);
	original.dispose();
	assert.deepEqual(fixture.details(plain), []);
	fixture.activate(undefined);
	assert.deepEqual(fixture.details(plain), []);
});

test('diagnostic warnings respect validation visibility, read-only state, filtering and disposal', () => {
	const fixture = diagnosticFixture();
	using resources = fixture.resources;
	const model = fixture.editor.getModel()!;
	fixture.setMarkers(model, 5001);
	assert.equal(fixture.details().length, 1);
	fixture.editor.updateOptions({ renderValidationDecorations: 'off' });
	assert.deepEqual(fixture.details(), []);
	fixture.editor.updateOptions({ renderValidationDecorations: 'on', readOnly: true });
	assert.equal(fixture.details().length, 1);
	fixture.editor.updateOptions({ renderValidationDecorations: 'editable' });
	assert.deepEqual(fixture.details(), []);
	fixture.editor.updateOptions({ readOnly: false });
	assert.equal(fixture.details().length, 1);
	const filter = fixture.markers.installResourceFilter(model.uri, 'test');
	assert.deepEqual(fixture.details(), []);
	assert.equal(fixture.decorations.getLiveMarkers(model.uri).length, 0);
	filter.dispose();
	assert.equal(fixture.details().length, 1);
	fixture.contribution.dispose();
	fixture.setMarkers(model, 5100, true);
	fixture.activate(fixture.editor);
	fixture.editor.updateOptions({ renderValidationDecorations: 'off' });
	assert.deepEqual(fixture.details(), []);
});

test('source truncation belongs to each producer and nested filters restore the current snapshot', () => {
	const fixture = diagnosticFixture();
	using resources = fixture.resources;
	const model = fixture.editor.getModel()!;
	fixture.setMarkers(model, 1);
	fixture.markers.changeOne('truncated', model.uri, [], { isTruncated: true });
	assert.equal(fixture.details().length, 1);
	const first = fixture.markers.installResourceFilter(model.uri, 'hide');
	const second = fixture.markers.installResourceFilter(model.uri, 'hide');
	assert.deepEqual(fixture.details(), []);
	assert.equal(fixture.markers.read({ resource: model.uri }).length, 0);
	assert.equal(fixture.markers.read({ resource: model.uri, ignoreResourceFilters: true }).length, 1);
	first.dispose();
	assert.deepEqual(fixture.details(), []);
	fixture.markers.changeAll('truncated', []);
	second.dispose();
	assert.deepEqual(fixture.details(), []);
	assert.equal(fixture.decorations.getLiveMarkers(model.uri).length, 1);
	fixture.setMarkers(model, 1, true);
	assert.equal(fixture.details().length, 1);
	fixture.markers.remove('test', [model.uri]);
	assert.deepEqual(fixture.details(), []);
});

test('existing diagnostic overflow is reported when the contribution starts', () => {
	const fixture = diagnosticFixture();
	using resources = fixture.resources;
	fixture.contribution.dispose();
	fixture.setMarkers(fixture.editor.getModel()!, 5001);
	assert.notEqual(DiagnosticDecorationLimitReporter.get(fixture.editor)?.limited, false);
	resources.add(fixture.services.createInstance(LimitIndicatorContribution));
	assert.equal(fixture.details().length, 1);
});

test('limit contribution requires the production service registrations', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(LimitIndicatorContribution), /Unknown service/);
});

test('folding budget configuration rejects invalid values and preserves the last valid value', async () => {
	using configuration = new InMemoryConfigurationService();
	assert.equal(configuration.getValue('editor.foldingMaximumRegions'), 5000);
	await configuration.updateValue('editor.foldingMaximumRegions', 10);
	for (const value of [0, -1, 1, 9, 10.5, 65001, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(configuration.updateValue('editor.foldingMaximumRegions', value), /integer between 10 and 65000/);
		assert.equal(configuration.getValue('editor.foldingMaximumRegions'), 10);
	}
	await configuration.updateValue('editor.foldingMaximumRegions', 65000);
	assert.equal(configuration.getValue('editor.foldingMaximumRegions'), 65000);
});

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, 'limit state reaches the status bar');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

const features = registerTestCodeEditorFeatures(['editor.contrib.colorPicker', 'editor.contrib.folding', 'editor.contrib.markerDecorations', DiagnosticDecorationLimitReporter.ID]);
after(() => features.dispose());
