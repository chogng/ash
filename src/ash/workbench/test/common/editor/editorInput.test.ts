import type { ITextResourceStore } from '../../../services/textmodelResolver/common/textResourceStore.js';
import { TestUriIdentityServices } from '../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextModelResolverService } from '../../../services/textmodelResolver/common/textModelResolverService.js';
import { TextResourceEditorInput } from '../../../common/editor/textResourceEditorInput.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createBinaryDiffEditorInput, createDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { FileEditorInput } from '../../../contrib/files/browser/editors/fileEditorInput.js';
import '../../../contrib/files/browser/editors/fileEditorHandler.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

test('text inputs resolve once and retain shared provider text until the last input closes', async () => {
	using models = uriIdentityServices.createInstance(BrowserTextModelService, { onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '', revision: undefined }), save: async () => ({ revision: undefined }) } satisfies ITextResourceStore, {});
	using services = new InstantiationService();
	services.registerInstance(ITextModelResourceService, models);
	services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
	using text = new TextModel('shared text');
	let calls = 0;
	using provider = services.get(ITextModelService).registerTextModelContentProvider('review', { provideTextContent: async () => { calls++; return text; } });
	const resource = URI.parse('review:/content.txt');
	using first = services.createInstance(TextResourceEditorInput, resource, 'Review');
	using second = services.createInstance(TextResourceEditorInput, resource, undefined);
	const opening = first.resolve();
	assert.equal(first.resolve(), opening);
	const [firstModel, secondModel] = await Promise.all([opening, second.resolve()]);
	assert.deepEqual([calls, first.getName(), second.getName(), firstModel.textEditorModel === secondModel.textEditorModel], [2, 'Review', 'content.txt', true]);
	first.dispose();
	assert.deepEqual([firstModel.isResolved(), secondModel.isResolved(), text.isDisposed()], [false, true, false]);
	second.dispose();
	assert.equal(text.isDisposed(), true);
});

test('text input retries provider failures and releases content arriving after disposal', async () => {
	using models = uriIdentityServices.createInstance(BrowserTextModelService, { onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '', revision: undefined }), save: async () => ({ revision: undefined }) } satisfies ITextResourceStore, {});
	using services = new InstantiationService();
	services.registerInstance(ITextModelResourceService, models);
	services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
	using text = new TextModel('late content');
	let complete!: (model: TextModel) => void;
	let calls = 0;
	using provider = services.get(ITextModelService).registerTextModelContentProvider('review', {
		provideTextContent: async () => {
			if (++calls === 1) throw new Error('Content unavailable');
			return new Promise<TextModel>(resolve => { complete = resolve; });
		},
	});
	using input = services.createInstance(TextResourceEditorInput, URI.parse('review:/content.txt'), undefined);
	await assert.rejects(input.resolve(), /Content unavailable/);
	const retry = input.resolve();
	input.dispose();
	complete(text);
	await assert.rejects(retry, CancellationError);
	assert.deepEqual([calls, text.isDisposed()], [2, true]);
});

test('live file inputs match resource requests while custom views keep their separate identity', () => {
	using input = new FileEditorInput(URI.file('/project/file.txt'), { label: 'Selected name' });
	using renamed = new FileEditorInput(input.resource, { label: 'Other name' });
	using custom = new CustomEditorInput(input, 'example.preview');
	const group = new EditorGroupModel();
	const original = group.openEditor(input).editor;
	assert.ok(input instanceof EditorInput);
	assert.deepEqual([input.matches(renamed), input.matches({ resource: input.resource }), input.matches(custom), custom.matches({ resource: input.resource, editorId: custom.editorId })], [true, true, false, true]);
	group.openEditor(renamed);
	group.openEditor(custom);
	assert.deepEqual([group.entries.length, group.entries[0]!.instanceId, input.getName()], [2, original.instanceId, 'Selected name']);
});

for (const [kind, createInput] of [['text', createDiffEditorInput], ['binary', createBinaryDiffEditorInput]] as const) {
	test(`${kind} comparison names follow their sources and all view subscriptions are released`, () => {
		using originalChanges = new Emitter<void>();
		using modifiedChanges = new Emitter<void>();
		let name = 'Before';
		const original = { resource: URI.file('/project/before.bin'), get label() { return name; }, onDidChangeLabel: originalChanges.event };
		const modified = { resource: URI.file('/project/after.bin'), label: 'After', onDidChangeLabel: modifiedChanges.event };
		using input = createInput(original, modified);
		using firstView = new DisposableStore();
		using secondView = new DisposableStore();
		const labels: string[] = [];
		firstView.add(input.onDidChangeLabel(() => labels.push(`first:${input.label}`)));
		secondView.add(input.onDidChangeLabel(() => labels.push(`second:${input.label}`)));
		firstView.clear();
		name = 'Renamed';
		originalChanges.fire();
		const snapshot = EditorInputSerializers.serialize(input);
		const restored = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(snapshot)));
		assert.ok(restored instanceof EditorInput);
		try {
			assert.deepEqual([labels, restored.label, snapshot.value], [[`second:Renamed ↔ After`], 'Renamed ↔ After', {
				original: EditorInputSerializers.serialize(original), modified: EditorInputSerializers.serialize(modified),
			}]);
		} finally { restored.dispose(); }
		secondView.clear();
		input.dispose();
		assert.deepEqual([originalChanges.hasListeners(), modifiedChanges.hasListeners(), originalChanges.isDisposed, modifiedChanges.isDisposed], [false, false, false, false]);
	});
}
