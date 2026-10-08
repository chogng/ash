import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { WorkbenchConfigurationService } from '../../../../services/configuration/browser/configurationService.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { EndOfLineSequence } from '../../../../../editor/common/model.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { LanguageDiagnosticSeverity, type LanguageCodeAction, type LanguageCodeActionRequest } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { SnippetController2 } from '../../../../../editor/contrib/snippet/browser/snippetController2.js';
import { parseSnippet } from '../../../../../editor/contrib/snippet/common/snippetParser.js';
import { registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IMarkerService, MarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { SaveReason } from '../../../../common/editor.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { CodeEditorService } from '../../../../services/editor/browser/codeEditorService.js';
import { IFileTextModelService, TextModelConflictError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { TextResourceConflictError } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { BulkEditTestServices } from '../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { SaveParticipantsContribution } from '../../browser/saveParticipants.js';
import '../../browser/codeEditor.contribution.js';
import '../../../codeActions/browser/codeActions.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();
const resource = URI.file('/workspace/main.ts');
const signal = () => new AbortController().signal;

test('save cleanup waits for editor parts before creating the Workbench editor service', async () => {
	using bulk = new BulkEditTestServices([[resource, 'original  ']]);
	using configuration = new WorkbenchConfigurationService();
	using features = new LanguageFeaturesService();
	using markers = new MarkerService();
	using services = new InstantiationService();
	services.registerInstance(IFileTextModelService, bulk.models);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILanguageFeaturesService, features);
	services.registerInstance(IBulkEditService, bulk.service);
	services.registerInstance(IMarkerService, markers);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [SaveParticipantsContribution.ID]);
	// Match the production startup order: editor Parts do not exist at BlockStartup.
	host.advance(WorkbenchPhase.BlockStartup);
	services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
	host.advance(WorkbenchPhase.BlockRestore);
	await configuration.updateValue('files.trimTrailingWhitespace', true);
	await configuration.updateValue('files.insertFinalNewline', true);
	using reference = await bulk.models.acquire({ resource }, signal());
	await reference.save(signal());
	assert.equal(bulk.store.text(resource), 'original\n');
});

class SaveTestServices extends Disposable {
	readonly bulk = this._register(new BulkEditTestServices([[resource, 'original'], [URI.file('/workspace/other.ts'), 'other']]));
	readonly configuration = this._register(new WorkbenchConfigurationService());
	readonly features = this._register(new LanguageFeaturesService());
	readonly markers = this._register(new MarkerService());
	readonly services = this._register(new InstantiationService());
	readonly host;
	constructor() {
		super();
		this.services.registerInstance(IFileTextModelService, this.bulk.models);
		this.services.registerInstance(IConfigurationService, this.configuration);
		this.services.registerInstance(ILanguageFeaturesService, this.features);
		this.services.registerInstance(IBulkEditService, this.bulk.service);
		this.services.registerInstance(IMarkerService, this.markers);
		registerCodeEditorServices(this.services);
		this.host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, [SaveParticipantsContribution.ID]));
		this.host.advance(WorkbenchPhase.BlockRestore);
	}
}

/** Supplies editor-owned state to the real registry; product tests cover its view. */
class SaveTestEditor extends Disposable {
	private static nextId = 0;
	private selections = [new Selection(1, 1, 1, 1)];
	readonly editor: ICodeEditor;
	readonly snippets: SnippetController2;
	constructor(model: TextModel, services: InstantiationService) {
		super();
		const id = `save-test-${SaveTestEditor.nextId++}`;
		let currentModel: TextModel | null = model;
		const modelChanges = this._register(new Emitter<void>());
		this.editor = {
			getId: () => id,
			getModel: () => this.isDisposed ? null : currentModel,
			setModel: (value: TextModel | null) => { currentModel = value; modelChanges.fire(); },
			getSelections: () => this.selections,
			getSelection: () => this.selections[0] ?? null,
			setSelections: (selections: readonly Selection[]) => { this.selections = [...selections]; },
			getDomNode: () => null,
			onDidChangeModel: modelChanges.event,
			onDidFocusEditorText: Event.None,
			onDidFocusEditorWidget: Event.None,
			hasTextFocus: () => false,
			hasWidgetFocus: () => false,
			pushUndoStop: () => { model.pushStackElement(); return true; },
			getContribution: (id: string) => id === SnippetController2.ID ? this.snippets : null,
		} as unknown as ICodeEditor;
		this.snippets = this._register(new SnippetController2(this.editor));
		const registry = services.get(ICodeEditorService);
		registry.addCodeEditor(this.editor);
		this._register(toDisposable(() => registry.removeCodeEditor(this.editor)));
	}
	setSelection(selection: Selection): void { this.editor.setSelections([selection]); }
	getSelections(): readonly Selection[] | null { return this.editor.getSelections(); }
}

test('save cleanup runs on the shared model without a pane and groups both edits for undo', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('alpha  \n beta\t');
	reference.model.pushStackElement();
	await reference.save(signal());
	assert.deepEqual([reference.model.getText(), fixture.bulk.store.text(resource), reference.isDirty], ['alpha\n beta\n', 'alpha\n beta\n', false]);
	reference.model.undo();
	assert.deepEqual([reference.model.getText(), reference.isDirty], ['alpha  \n beta\t', true]);
});

test('undoing save cleanup preserves the immediately preceding user edit', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.pushEditOperations(null, [{ range: new Range(1, 9, 1, 9), text: '  ' }], null);
	await reference.save(signal());
	assert.equal(fixture.bulk.store.text(resource), 'original\n');
	reference.model.undo();
	assert.deepEqual([reference.model.getText(), reference.isDirty], ['original  ', true]);
});

test('save cleanup uses current language overrides and preserves CRLF across repeated saves', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', false);
	await fixture.configuration.updateValue('files.insertFinalNewline', false);
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true, { overrideIdentifier: 'plaintext' });
	await fixture.configuration.updateValue('files.insertFinalNewline', true, { overrideIdentifier: 'plaintext' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setEOL(EndOfLineSequence.CRLF);
	reference.model.setValue('alpha  \r\n beta\t');
	await reference.save(signal(), { reason: SaveReason.FOCUS_CHANGE });
	assert.equal(fixture.bulk.store.text(resource), 'alpha\r\n beta\r\n');
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', false, { overrideIdentifier: 'plaintext' });
	await fixture.configuration.updateValue('files.insertFinalNewline', false, { overrideIdentifier: 'plaintext' });
	reference.model.setValue('later  ');
	await reference.save(signal(), { reason: SaveReason.WINDOW_CHANGE });
	assert.equal(fixture.bulk.store.text(resource), 'later  ');
});

test('save cleanup runs before code actions and inserts the final newline after their current result', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('alpha  \n beta\t');
	using provider = fixture.features.codeActionProvider.register('*', {
		provideCodeActions: request => {
			assert.equal(request.snapshot.getText(), 'alpha\n beta');
			return [action(request, 'fixed')];
		}
	});
	await reference.save(signal());
	assert.equal(fixture.bulk.store.text(resource), 'fixed\n');
});

test('AUTO cleanup protects all matching editor cursors without borrowing another model selection', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	using other = await fixture.bulk.models.acquire({ resource: URI.file('/workspace/other.ts') }, signal());
	reference.model.setValue('first  \n  \nthird  \nlast  ');
	using first = new SaveTestEditor(reference.model, fixture.services);
	using second = new SaveTestEditor(reference.model, fixture.services);
	using unrelated = new SaveTestEditor(other.model, fixture.services);
	first.setSelection(new Selection(1, 8, 1, 8));
	second.setSelection(new Selection(2, 2, 2, 2));
	unrelated.setSelection(new Selection(1, 6, 1, 6));
	const selections = [first.getSelections(), second.getSelections(), unrelated.getSelections()];
	await reference.save(signal(), { reason: SaveReason.AUTO });
	assert.deepEqual([fixture.bulk.store.text(resource), first.getSelections(), second.getSelections(), unrelated.getSelections()], ['first  \n \nthird\nlast', ...selections]);
});

test('AUTO cleanup preserves the whole active snippet and still trims a literal line after its explicit final stop', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	const snippet = parseSnippet('${1:    }\n${2:  }\n$0\noutside  ');
	reference.model.setValue(snippet.text);
	using editor = new SaveTestEditor(reference.model, fixture.services);
	const controller = SnippetController2.get(editor.editor)!;
	controller.startSession(reference.model, [0], snippet);
	const before = editor.getSelections();
	await reference.save(signal(), { reason: SaveReason.AUTO });
	assert.deepEqual([fixture.bulk.store.text(resource), controller.isInSnippet(), editor.getSelections()], ['    \n  \n\noutside', true, before]);
	controller.next();
	assert.deepEqual(editor.getSelections(), [new Selection(2, 1, 2, 3)]);
	await reference.save(signal(), { reason: SaveReason.EXPLICIT });
	assert.equal(fixture.bulk.store.text(resource), '\n\n\noutside');
});

test('save cleanup leaves an empty file empty and unregisters with its contribution owner', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('');
	await reference.save(signal());
	assert.equal(fixture.bulk.store.text(resource), '');
	fixture.host.dispose();
	reference.model.setValue('later  ');
	await reference.save(signal());
	assert.equal(fixture.bulk.store.text(resource), 'later  ');
});

for (const reason of [SaveReason.EXPLICIT, SaveReason.AUTO, SaveReason.FOCUS_CHANGE, SaveReason.WINDOW_CHANGE]) {
	test(`save cleanup applies both settings and retains undo for reason ${reason}`, async () => {
		using fixture = new SaveTestServices();
		await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
		await fixture.configuration.updateValue('files.insertFinalNewline', true);
		using reference = await fixture.bulk.models.acquire({ resource }, signal());
		reference.model.setValue('first  \nlast  ');
		reference.model.pushStackElement();
		using editor = new SaveTestEditor(reference.model, fixture.services);
		editor.setSelection(new Selection(1, 8, 1, 8));
		await reference.save(signal(), { reason });
		assert.deepEqual([fixture.bulk.store.text(resource), reference.isDirty], [reason === SaveReason.AUTO ? 'first  \nlast\n' : 'first\nlast\n', false]);
		reference.model.undo();
		assert.deepEqual([reference.model.getText(), reference.isDirty], ['first  \nlast  ', true]);
	});
}

test('snippet save protection follows mirrors, transforms and multiple insertions through edits and releases on model replacement', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	using other = await fixture.bulk.models.acquire({ resource: URI.file('/workspace/other.ts') }, signal());
	const snippet = parseSnippet('${1:  }\n$1\n${1/(.*)/$1/}\n${2:x}\n$0\noutside  ');
	const separator = '\nbetween  \n';
	reference.model.setValue(snippet.text + separator + snippet.text);
	using editor = new SaveTestEditor(reference.model, fixture.services);
	editor.snippets.startSession(reference.model, [0, snippet.text.length + separator.length], snippet);
	assert.deepEqual(editor.snippets.getSessionEnclosingRange(), new Range(1, 1, 12, 1));
	reference.model.pushEditOperations(null, [{ range: new Range(1, 1, 1, 1), text: 'prefix\n' }], null);
	assert.deepEqual(editor.snippets.getSessionEnclosingRange(), new Range(2, 1, 13, 1));
	await reference.save(signal(), { reason: SaveReason.AUTO });
	assert.equal(fixture.bulk.store.text(resource), 'prefix\n' + snippet.text + separator + snippet.text.trimEnd());
	editor.snippets.next();
	assert.deepEqual(editor.getSelections(), [new Selection(5, 1, 5, 2), new Selection(12, 1, 12, 2)]);
	editor.editor.setModel(other.model);
	assert.deepEqual([editor.snippets.getSessionEnclosingRange(), editor.snippets.isInSnippet()], [undefined, false]);
	await reference.save(signal(), { reason: SaveReason.AUTO });
	assert.equal(fixture.bulk.store.text(resource), 'prefix\n\n\n\nx\n\noutside\nbetween\n\n\n\nx\n\noutside');
});

test('implicit snippet final stop is protected until cancellation and disposal', async () => {
	using fixture = new SaveTestServices();
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	const snippet = parseSnippet('${1:  }\nlast  ');
	reference.model.setValue(snippet.text);
	using editor = new SaveTestEditor(reference.model, fixture.services);
	editor.snippets.startSession(reference.model, [0], snippet);
	assert.deepEqual(editor.snippets.getSessionEnclosingRange(), new Range(1, 1, 2, 7));
	editor.snippets.cancel();
	assert.equal(editor.snippets.getSessionEnclosingRange(), undefined);
	editor.snippets.startSession(reference.model, [0], snippet);
	editor.dispose();
	assert.equal(editor.snippets.getSessionEnclosingRange(), undefined);
});

test('cancelled cleanup retains undo and the save queue can retry with current configuration', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited  ');
	reference.model.pushStackElement();
	const started = new DeferredPromise<void>();
	const ready = new DeferredPromise<readonly LanguageCodeAction[]>();
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: () => { void started.complete(); return ready.p; } });
	const controller = new AbortController();
	const saving = reference.save(controller.signal);
	await started.p;
	controller.abort();
	await assert.rejects(saving, isCancellationError);
	assert.deepEqual([reference.model.getText(), fixture.bulk.store.text(resource), reference.isDirty], ['edited', 'original', true]);
	reference.model.undo();
	assert.equal(reference.model.getText(), 'edited  ');
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', false);
	provider.dispose();
	await ready.complete([]);
	await reference.save(signal());
	assert.deepEqual([reference.model.getText(), fixture.bulk.store.text(resource), reference.isDirty], ['edited  \n', 'edited  \n', false]);
});

test('conflicting cleanup keeps the cleaned draft undoable and never advances the persisted baseline', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited  ');
	reference.model.pushStackElement();
	fixture.bulk.store.failNextSave = new TextResourceConflictError(resource);
	await assert.rejects(reference.save(signal()), TextModelConflictError);
	assert.deepEqual([reference.model.getText(), fixture.bulk.store.text(resource), reference.isDirty, reference.hasExternalChange], ['edited\n', 'original', true, true]);
	reference.model.undo();
	assert.equal(reference.model.getText(), 'edited  ');
	await reference.save(signal());
	assert.deepEqual([fixture.bulk.store.text(resource), reference.isDirty, reference.hasExternalChange], ['edited\n', false, false]);
});

test('Save As cleans the destination and leaves the source draft intact', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('files.trimTrailingWhitespace', true);
	await fixture.configuration.updateValue('files.insertFinalNewline', true);
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('copy  ');
	const target = URI.file('/workspace/clean-copy.txt');
	await reference.saveAs(target, signal());
	assert.deepEqual([fixture.bulk.store.text(target), fixture.bulk.store.text(resource), reference.model.getText(), reference.isDirty], ['copy\n', 'original', 'copy  ', true]);
});

function action(request: LanguageCodeActionRequest, text: string, kind = request.only![0]): LanguageCodeAction {
	return {
		title: kind, kind, edit: {
			entries: [{
				kind: 'textDocument', resource: request.resource,
				version: request.snapshot.version, expectedText: request.snapshot.getText(), edits: [{ range: request.range, text }]
			}]
		}
	};
}

test('save contribution runs fixes before imports on the shared model, persists their result and retains undo', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.organizeImports': 'explicit', 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	using second = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	fixture.markers.changeOne('test', resource, [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 6 } }, severity: MarkerSeverity.Warning, message: 'unused', source: 'test', code: 42 }]);
	const requests: LanguageCodeActionRequest[] = [];
	using provider = fixture.features.codeActionProvider.register('*', {
		provideCodeActions: request => {
			requests.push(request);
			return [action(request, request.snapshot.getText() + (request.only![0] === 'source.fixAll' ? '-fixed' : '-sorted'))];
		}
	});
	await reference.save(signal());
	assert.deepEqual(requests.map(request => [request.only![0], request.snapshot.getText()]), [['source.fixAll', 'edited'], ['source.organizeImports', 'edited-fixed']]);
	assert.equal(requests[0].diagnostics[0].severity, LanguageDiagnosticSeverity.Warning);
	assert.deepEqual(requests[0].diagnostics[0].range, new Range(1, 1, 1, 7));
	assert.equal(fixture.bulk.store.text(resource), 'edited-fixed-sorted');
	assert.equal(second.model.getText(), 'edited-fixed-sorted');
	assert.equal(second.isDirty, false);
	assert.equal(fixture.bulk.store.saved.length, 1);
	reference.model.undo();
	assert.equal(reference.model.getText(), 'edited-fixed');
	assert.equal(reference.isDirty, true);
});

for (const reason of [SaveReason.EXPLICIT, SaveReason.AUTO, SaveReason.FOCUS_CHANGE, SaveReason.WINDOW_CHANGE]) {
	test(`save modes and language overrides select actions for reason ${reason}`, async () => {
		using fixture = new SaveTestServices();
		await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.global': 'always' });
		await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit', 'source.organizeImports': 'always', 'source.disabled': 'never' }, { overrideIdentifier: 'plaintext' });
		using reference = await fixture.bulk.models.acquire({ resource }, signal());
		reference.model.setValue('edited');
		const kinds: string[] = [];
		using provider = fixture.features.codeActionProvider.register('*', {
			provideCodeActions: request => {
				kinds.push(request.only![0]);
				return [action(request, request.snapshot.getText() + '-action')];
			}
		});
		await reference.save(signal(), { reason });
		assert.deepEqual(kinds, reason === SaveReason.AUTO ? [] : reason === SaveReason.EXPLICIT ? ['source.fixAll', 'source.organizeImports'] : ['source.organizeImports']);
		assert.equal(fixture.bulk.store.text(resource), reason === SaveReason.AUTO ? 'edited' : reason === SaveReason.EXPLICIT ? 'edited-action-action' : 'edited-action');
	});
}

test('parent save kinds query once and never exclusions reject disabled descendants', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { source: 'explicit', 'source.organizeImports': 'explicit', 'source.fixAll': 'never' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const kinds: string[] = [];
	using provider = fixture.features.codeActionProvider.register('*', {
		provideCodeActions: request => {
			kinds.push(request.only![0]);
			return [action(request, 'forbidden', 'source.fixAll.tool'), { title: 'disabled', kind: 'source.organizeImports', disabledReason: 'unavailable' }, { title: 'resolved imports', kind: 'source.organizeImports' }];
		}, resolveCodeAction: (_original, request) => action(request, 'sorted', 'source.organizeImports')
	});
	await reference.save(signal());
	assert.deepEqual(kinds, ['source']);
	assert.equal(fixture.bulk.store.text(resource), 'sorted');
});

for (const phase of ['query', 'resolve'] as const) {
	test(`editing during ${phase} cancels save without writing stale results`, async () => {
		using fixture = new SaveTestServices();
		await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
		using reference = await fixture.bulk.models.acquire({ resource }, signal());
		reference.model.setValue('edited');
		const started = new DeferredPromise<void>();
		const ready = new DeferredPromise<void>();
		using provider = fixture.features.codeActionProvider.register('*', {
			provideCodeActions: async request => {
				if (phase === 'query') { await started.complete(); await ready.p; return [action(request, 'stale')]; }
				return [{ title: 'resolve', kind: 'source.fixAll' }];
			}, resolveCodeAction: async (_original, request) => { await started.complete(); await ready.p; return action(request, 'stale'); },
		});
		const saving = reference.save(signal());
		await started.p;
		reference.model.setValue('latest user text');
		await ready.complete();
		await assert.rejects(saving, isCancellationError);
		assert.equal(fixture.bulk.store.saved.length, 0);
		assert.equal(reference.model.getText(), 'latest user text');
		assert.equal(reference.isDirty, true);
	});
}

test('cancelled providers release the save queue, and removing the contribution stops save actions', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const started = new DeferredPromise<void>();
	const ready = new DeferredPromise<readonly LanguageCodeAction[]>();
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: () => { void started.complete(); return ready.p; } });
	const controller = new AbortController();
	const saving = reference.save(controller.signal);
	await started.p;
	controller.abort();
	await assert.rejects(saving, isCancellationError);
	assert.equal(fixture.bulk.store.saved.length, 0);
	fixture.host.dispose();
	await reference.save(signal());
	await ready.complete([]);
	assert.equal(fixture.bulk.store.text(resource), 'edited');
});

test('save action failures preserve dirty text and propagate before persistence', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: () => { throw new Error('provider failed'); } });
	await assert.rejects(reference.save(signal()), /provider failed/);
	assert.equal(fixture.bulk.store.text(resource), 'original');
	assert.equal(reference.isDirty, true);
});

test('workspace edits persist unopened files without recursively running save actions', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	let requests = 0;
	using provider = fixture.features.codeActionProvider.register('*', {
		provideCodeActions: request => {
			requests++;
			const current = action(request, 'fixed');
			return [{ ...current, edit: { entries: [...current.edit!.entries, { kind: 'textDocument', resource: URI.file('/workspace/other.ts'), expectedText: 'other', edits: [{ range: new Range(1, 1, 1, 6), text: 'other-fixed' }] }] } }];
		}
	});
	await reference.save(signal());
	assert.equal(requests, 1);
	assert.equal(fixture.bulk.store.text(resource), 'fixed');
	assert.equal(fixture.bulk.store.text(URI.file('/workspace/other.ts')), 'other-fixed');
});

test('Save As runs on the target model before writing and leaves the original file intact', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const target = URI.file('/workspace/copy.ts');
	const requested: string[] = [];
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => { requested.push(request.resource.toString()); return [action(request, 'fixed copy')]; } });
	await reference.saveAs(target, signal());
	assert.deepEqual(requested, [target.toString()]);
	assert.equal(fixture.bulk.store.text(target), 'fixed copy');
	assert.equal(fixture.bulk.store.text(resource), 'original');
	assert.equal(reference.model.getText(), 'edited');
	assert.equal(reference.isDirty, true);
});

test('sequential providers receive the current version when fixing the same save kind', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const queried: string[] = [];
	using second = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => { queried.push(request.snapshot.getText()); return [action(request, request.snapshot.getText() + '-second')]; } });
	using first = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => { queried.push(request.snapshot.getText()); return [action(request, request.snapshot.getText() + '-first')]; } });
	await reference.save(signal());
	assert.deepEqual(queried, ['edited', 'edited-first']);
	assert.equal(fixture.bulk.store.text(resource), 'edited-first-second');
});

test('a failed workspace write rolls back save edits without reentering the save queue', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	fixture.bulk.store.failNextSave = new Error('write failed');
	using provider = fixture.features.codeActionProvider.register('*', {
		provideCodeActions: request => {
			const current = action(request, 'fixed');
			return [{ ...current, edit: { entries: [...current.edit!.entries, { kind: 'textDocument', resource: URI.file('/workspace/other.ts'), expectedText: 'other', edits: [{ range: new Range(1, 1, 1, 6), text: 'other-fixed' }] }] } }];
		}
	});
	await assert.rejects(reference.save(signal()), /write failed/);
	assert.equal(reference.model.getText(), 'edited');
	assert.equal(reference.isDirty, true);
	assert.equal(fixture.bulk.store.text(resource), 'original');
	assert.equal(fixture.bulk.store.text(URI.file('/workspace/other.ts')), 'other');
});

test('disposing the file model service cancels an unfinished save query before writing', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const started = new DeferredPromise<void>();
	const ready = new DeferredPromise<readonly LanguageCodeAction[]>();
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: () => { void started.complete(); return ready.p; } });
	const saving = reference.save(signal());
	await started.p;
	fixture.bulk.models.dispose();
	await assert.rejects(saving, isCancellationError);
	await ready.complete([]);
	assert.equal(fixture.bulk.store.saved.length, 0);
});

test('save retains the shared model after its last pane closes until the action and write finish', async () => {
	using fixture = new SaveTestServices();
	await fixture.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const started = new DeferredPromise<void>();
	const ready = new DeferredPromise<void>();
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: async request => { await started.complete(); await ready.p; return [action(request, 'fixed')]; } });
	const saving = reference.save(signal());
	await started.p;
	reference.dispose();
	assert.equal(reference.model.isDisposed(), false);
	await ready.complete();
	await saving;
	assert.equal(fixture.bulk.store.text(resource), 'fixed');
	assert.equal(reference.model.isDisposed(), true);
});
