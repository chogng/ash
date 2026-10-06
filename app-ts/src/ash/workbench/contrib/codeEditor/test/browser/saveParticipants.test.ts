import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity, type LanguageCodeAction, type LanguageCodeActionRequest } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IMarkerService, MarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { SaveReason } from '../../../../common/editor.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { BulkEditTestServices } from '../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { SaveParticipantsContribution } from '../../browser/saveParticipants.js';
import '../../browser/codeEditor.contribution.js';
import '../../../codeActions/browser/codeActions.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();
const resource = URI.file('/workspace/main.ts');
const signal = () => new AbortController().signal;

class SaveTestServices extends Disposable {
	readonly bulk = this._register(new BulkEditTestServices([[resource, 'original'], [URI.file('/workspace/other.ts'), 'other']]));
	readonly features = this._register(new LanguageFeaturesService());
	readonly markers = this._register(new MarkerService());
	readonly services = this._register(new InstantiationService());
	readonly host;
	constructor() {
		super();
		this.services.registerInstance(IFileTextModelService, this.bulk.models);
		this.services.registerInstance(IConfigurationService, this.bulk.configuration);
		this.services.registerInstance(ILanguageFeaturesService, this.features);
		this.services.registerInstance(IBulkEditService, this.bulk.service);
		this.services.registerInstance(IMarkerService, this.markers);
		this.host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, [SaveParticipantsContribution.ID]));
		this.host.advance(WorkbenchPhase.BlockStartup);
	}
}

function action(request: LanguageCodeActionRequest, text: string, kind = request.only![0]): LanguageCodeAction {
	return { title: kind, kind, edit: { entries: [{ kind: 'textDocument', resource: request.resource,
		version: request.snapshot.version, expectedText: request.snapshot.getText(), edits: [{ range: request.range, text }] }] } };
}

test('save contribution runs fixes before imports on the shared model, persists their result and retains undo', async () => {
	using fixture = new SaveTestServices();
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.organizeImports': 'explicit', 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	using second = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	fixture.markers.changeOne('test', resource, [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 6 } }, severity: MarkerSeverity.Warning, message: 'unused', source: 'test', code: 42 }]);
	const requests: LanguageCodeActionRequest[] = [];
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => {
		requests.push(request);
		return [action(request, request.snapshot.getText() + (request.only![0] === 'source.fixAll' ? '-fixed' : '-sorted'))];
	} });
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
		await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.global': 'always' });
		await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit', 'source.organizeImports': 'always', 'source.disabled': 'never' }, { overrideIdentifier: 'plaintext' });
		using reference = await fixture.bulk.models.acquire({ resource }, signal());
		reference.model.setValue('edited');
		const kinds: string[] = [];
		using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => {
			kinds.push(request.only![0]);
			return [action(request, request.snapshot.getText() + '-action')];
		} });
		await reference.save(signal(), { reason });
		assert.deepEqual(kinds, reason === SaveReason.AUTO ? [] : reason === SaveReason.EXPLICIT ? ['source.fixAll', 'source.organizeImports'] : ['source.organizeImports']);
		assert.equal(fixture.bulk.store.text(resource), reason === SaveReason.AUTO ? 'edited' : reason === SaveReason.EXPLICIT ? 'edited-action-action' : 'edited-action');
	});
}

test('parent save kinds query once and never exclusions reject disabled descendants', async () => {
	using fixture = new SaveTestServices();
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { source: 'explicit', 'source.organizeImports': 'explicit', 'source.fixAll': 'never' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	const kinds: string[] = [];
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => {
		kinds.push(request.only![0]);
		return [action(request, 'forbidden', 'source.fixAll.tool'), { title: 'disabled', kind: 'source.organizeImports', disabledReason: 'unavailable' }, { title: 'resolved imports', kind: 'source.organizeImports' }];
	}, resolveCodeAction: (_original, request) => action(request, 'sorted', 'source.organizeImports') });
	await reference.save(signal());
	assert.deepEqual(kinds, ['source']);
	assert.equal(fixture.bulk.store.text(resource), 'sorted');
});

for (const phase of ['query', 'resolve'] as const) {
	test(`editing during ${phase} cancels save without writing stale results`, async () => {
		using fixture = new SaveTestServices();
		await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
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
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
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
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: () => { throw new Error('provider failed'); } });
	await assert.rejects(reference.save(signal()), /provider failed/);
	assert.equal(fixture.bulk.store.text(resource), 'original');
	assert.equal(reference.isDirty, true);
});

test('workspace edits persist unopened files without recursively running save actions', async () => {
	using fixture = new SaveTestServices();
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	let requests = 0;
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => {
		requests++;
		const current = action(request, 'fixed');
		return [{ ...current, edit: { entries: [...current.edit!.entries, { kind: 'textDocument', resource: URI.file('/workspace/other.ts'), expectedText: 'other', edits: [{ range: new Range(1, 1, 1, 6), text: 'other-fixed' }] }] } }];
	} });
	await reference.save(signal());
	assert.equal(requests, 1);
	assert.equal(fixture.bulk.store.text(resource), 'fixed');
	assert.equal(fixture.bulk.store.text(URI.file('/workspace/other.ts')), 'other-fixed');
});

test('Save As runs on the target model before writing and leaves the original file intact', async () => {
	using fixture = new SaveTestServices();
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
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
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
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
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
	using reference = await fixture.bulk.models.acquire({ resource }, signal());
	reference.model.setValue('edited');
	fixture.bulk.store.failNextSave = new Error('write failed');
	using provider = fixture.features.codeActionProvider.register('*', { provideCodeActions: request => {
		const current = action(request, 'fixed');
		return [{ ...current, edit: { entries: [...current.edit!.entries, { kind: 'textDocument', resource: URI.file('/workspace/other.ts'), expectedText: 'other', edits: [{ range: new Range(1, 1, 1, 6), text: 'other-fixed' }] }] } }];
	} });
	await assert.rejects(reference.save(signal()), /write failed/);
	assert.equal(reference.model.getText(), 'edited');
	assert.equal(reference.isDirty, true);
	assert.equal(fixture.bulk.store.text(resource), 'original');
	assert.equal(fixture.bulk.store.text(URI.file('/workspace/other.ts')), 'other');
});

test('disposing the file model service cancels an unfinished save query before writing', async () => {
	using fixture = new SaveTestServices();
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
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
	await fixture.bulk.configuration.updateValue('editor.codeActionsOnSave', { 'source.fixAll': 'explicit' });
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
