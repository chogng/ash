import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities, type IFileWriteOptions, type IFileWriteResult } from '../../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { MemoryFileService } from '../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { createTestTextFileService } from '../../../../test/common/testEditorServices.js';
import { BrowserTextResourceStore } from '../../browser/browserTextResourceStore.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { EditorGroupModel } from '../../../../common/editor/editorGroupModel.js';
import { FileEditorInput } from '../../../files/browser/editors/fileEditorInput.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';

suite('File model provider identity', () => {
	test('concurrent case aliases share one model, edits and save queue through the file service', async () => {
		const resource = URI.file('/workspace/Main.txt');
		const alias = URI.file('/workspace/MAIN.txt');
		const provider = new InsensitiveFileProvider([[resource, 'disk']]);
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		const [first, second] = await Promise.all([models.acquire({ resource }, signal), models.acquire({ resource: alias }, signal)]);
		using firstReference = first;
		using secondReference = second;
		assert.equal(first.model, second.model);
		first.model.applyEdits([{ range: first.model.getFullModelRange(), text: 'edited' }]);
		assert.deepEqual([models.getModels().length, models.getModel(alias), second.model.getText(), second.isDirty], [1, first.model, 'edited', true]);
		await Promise.all([first.save(signal), second.saveAs(alias, signal)]);
		assert.deepEqual([provider.text(resource), first.isDirty, second.isDirty, models.hasPendingSaveRecovery(alias)], ['edited', false, false, false]);
		first.dispose();
		assert.equal(second.model.isDisposed(), false);
		second.dispose();
		assert.deepEqual([models.getModel(alias), first.model.isDisposed()], [null, true]);
	});

	test('case-sensitive files retain independent models and tab identities', async () => {
		const firstResource = URI.file('/workspace/Main.txt');
		const secondResource = URI.file('/workspace/MAIN.txt');
		const provider = new MemoryFileService([[firstResource, 'first'], [secondResource, 'second']]);
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using first = await models.acquire({ resource: firstResource }, signal);
		using second = await models.acquire({ resource: secondResource }, signal);
		assert.notEqual(first.model, second.model);
		assert.deepEqual(models.getModels().map(model => model.getText()), ['first', 'second']);
		const group = new EditorGroupModel(undefined, undefined, services.get(IUriIdentityService).extUri);
		using firstInput = new FileEditorInput(firstResource);
		using secondInput = new FileEditorInput(secondResource);
		group.openEditor(firstInput);
		group.openEditor(secondInput);
		assert.equal(group.entries.length, 2);
	});

	test('typed and untyped file aliases reuse the tab without merging custom editor identities', () => {
		using files = new FileService();
		using registration = files.registerProvider('file', new InsensitiveFileProvider([]));
		using services = new TestUriIdentityServices(files);
		const group = new EditorGroupModel(undefined, undefined, services.get(IUriIdentityService).extUri);
		using input = new FileEditorInput(URI.file('/workspace/Main.txt'));
		group.openEditor(input, { pinned: true });
		const instanceId = group.entries[0].instanceId;
		group.openEditor({ resource: URI.file('/workspace/MAIN.txt') }, { pinned: true });
		assert.deepEqual([group.entries.length, group.entries[0].instanceId], [1, instanceId]);
		group.openEditor({ resource: input.resource, editorId: 'custom.editor' });
		assert.equal(group.entries.length, 2);
	});

	test('capability changes keep existing model references releasable and reject ambiguous edited models', async () => {
		const lower = URI.file('/workspace/main.txt');
		const upper = URI.file('/workspace/MAIN.txt');
		using changes = new Emitter<void>();
		const provider = new MutableFileProvider([[lower, 'lower'], [upper, 'upper']], changes);
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using first = await models.acquire({ resource: lower }, signal);
		using second = await models.acquire({ resource: upper }, signal);
		first.model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'edited ' }]);
		provider.capabilities &= ~FileSystemProviderCapabilities.PathCaseSensitive;
		changes.fire();
		initializeTestLocalization('zh-CN');
		try {
			await assert.rejects(models.acquire({ resource: upper }, signal), { message: `文件系统中的“${upper.toString()}”对应多个已打开的文档。请关闭重复文档后重新打开。` });
		} finally {
			resetNlsResolver();
		}
		assert.deepEqual([first.model.getText(), second.model.getText()], ['edited lower', 'upper']);
		await second.revert(signal);
		second.dispose();
		assert.equal(models.getModel(upper), first.model);
		first.dispose();
		assert.equal(models.getModels().length, 0);
	});

	test('canonical cache eviction does not duplicate a model that remains open', async () => {
		const resource = URI.file('/workspace/Main.txt');
		using files = new FileService();
		using registration = files.registerProvider('file', new InsensitiveFileProvider([[resource, 'disk']]));
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using first = await models.acquire({ resource }, signal);
		for (let index = 0; index < 4096; index++) services.get(IUriIdentityService).asCanonicalUri(URI.file(`/transient/${index}`));
		using alias = await models.acquire({ resource: URI.file('/workspace/MAIN.txt') }, signal);
		assert.equal(alias.model, first.model);
	});

	test('a changed casing policy cannot combine unresolved recovery from distinct closed files', async () => {
		const lower = URI.file('/workspace/main.txt');
		const upper = URI.file('/workspace/MAIN.txt');
		const alias = URI.file('/workspace/Main.txt');
		using changes = new Emitter<void>();
		const provider = new MutableFileProvider([[lower, 'lower'], [upper, 'upper'], [alias, 'alias']], changes);
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using participant = models.addSaveCompletionParticipant({ prepare: async () => async () => { throw new Error('Recovery failed'); } });
		for (const resource of [lower, upper]) {
			using reference = await models.acquire({ resource }, signal);
			await assert.rejects(reference.save(signal));
		}
		provider.capabilities &= ~FileSystemProviderCapabilities.PathCaseSensitive;
		changes.fire();
		using reopened = await models.acquire({ resource: alias }, signal);
		reopened.model.setValue('new edit');
		assert.throws(() => reopened.save(signal), /multiple pending recovery records/);
		assert.deepEqual([models.hasPendingSaveRecovery(lower), provider.text(alias), reopened.isDirty], [true, 'alias', true]);
	});

	test('reopening an evicted case alias retains the saved undo history', async () => {
		const resource = URI.file('/workspace/Main.txt');
		using files = new FileService();
		using registration = files.registerProvider('file', new InsensitiveFileProvider([[resource, 'disk']]));
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using first = await models.acquire({ resource }, signal);
		first.model.pushEditOperations(null, [{ range: first.model.getFullModelRange(), text: 'saved' }], () => null);
		await first.save(signal);
		first.dispose();
		for (let index = 0; index < 4096; index++) services.get(IUriIdentityService).asCanonicalUri(URI.file(`/transient/${index}`));
		using reopened = await models.acquire({ resource: URI.file('/workspace/MAIN.txt') }, signal);
		reopened.model.undo();
		assert.deepEqual([reopened.model.getText(), reopened.isDirty], ['disk', true]);
	});
});

class InsensitiveFileProvider extends MemoryFileService {
	public override readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	private readonly fileResources: readonly URI[];

	constructor(resources: readonly (readonly [URI, string])[]) {
		super(resources);
		this.fileResources = resources.map(([resource]) => resource);
	}

	public override stat(resource: URI): ReturnType<MemoryFileService['stat']> { return super.stat(this.fileResource(resource)); }
	public override readFile(resource: URI): ReturnType<MemoryFileService['readFile']> { return super.readFile(this.fileResource(resource)); }
	public override writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> { return super.writeFile(this.fileResource(resource), bytes, options); }

	private fileResource(resource: URI): URI {
		return this.fileResources.find(candidate => extUriIgnorePathCase.isEqual(candidate, resource)) ?? resource;
	}
}

class MutableFileProvider extends MemoryFileService {
	public override capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	public override readonly onDidChangeCapabilities;

	constructor(resources: readonly (readonly [URI, string])[], changes: Emitter<void>) {
		super(resources);
		this.onDidChangeCapabilities = changes.event;
	}
}
