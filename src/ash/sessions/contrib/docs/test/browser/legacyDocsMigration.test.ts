import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { createDefaultDocumentSchema } from '../../../../../../../extensions/academy/common/model/documentSchema.js';
import { serializeDocument } from '../../../../../../../extensions/academy/common/model/documentSerialization.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { BrowserWorkingCopyService } from '../../../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyBackupService, InMemoryWorkingCopyBackupService } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { createTestFileService } from '../../../../../workbench/test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { migrateLegacyDocsInput } from '../../browser/legacyDocsMigration.js';
import { legacyDocsToMarkdown } from '../../browser/docsImport.js';
import { DOCS_ARKDOWN_EDITOR_ID } from '../../common/docs.js';

const environment = new JSDOM('<!doctype html>', { url: 'https://docs-migration.test' });
suiteTeardown(() => environment.window.close());
const resource = URI.file('/legacy.ash-doc');
const target = URI.file('/legacy.md');

function legacy(text = 'Original'): string {
	const schema = createDefaultDocumentSchema();
	return serializeDocument(schema.createDocument([schema.createNode('paragraph', { content: [schema.createText(text)] })]), schema);
}

class MigrationFixture extends Disposable {
	readonly provider = this._register(new InMemoryFileSystemProvider());
	readonly files = this._register(createTestFileService(this.provider));
	readonly services = this._register(new TestUriIdentityServices(this.files));
	readonly backups = this._register(new InMemoryWorkingCopyBackupService('migration'));
	readonly storage = this._register(new BrowserStorageService({ ownerWindow: environment.window as unknown as Window, workspaceId: crypto.randomUUID(), profileId: crypto.randomUUID(), flushInterval: 0 }));
	constructor() {
		super();
		this.services.registerInstance(IWorkingCopyBackupService, this.backups);
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(IWorkingCopyService, this._register(this.services.createInstance(BrowserWorkingCopyService)));
	}
	async seed(content = legacy()): Promise<void> {
		await this.files.createDirectory(URI.file('/'));
		await this.files.writeFile({ resource, content });
	}
	open(input: IResourceEditorInput = { resource }) {
		return this.services.invokeFunction(accessor => migrateLegacyDocsInput(input, accessor));
	}
}

test('legacy Docs creates Markdown once, retains the source and honors later Markdown edits', async () => {
	using fixture = new MigrationFixture();
	const serialized = legacy();
	await fixture.seed(serialized);
	const input = await fixture.open();
	assert.equal(input.resource.toString(), target.toString());
	assert.equal(input.editorId, DOCS_ARKDOWN_EDITOR_ID);
	assert.equal((await fixture.files.readFile(resource)).content, serialized);
	assert.equal((await fixture.files.readFile(target)).content.trim(), 'Original');
	await fixture.files.writeFile({ resource: target, content: '# Edited in Arkdown' });
	await fixture.open();
	assert.equal((await fixture.files.readFile(target)).content, '# Edited in Arkdown');
	assert.equal(fixture.storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE).length, 1);
});

test('legacy Docs preserves checked tasks and header tables through the shared converter', () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = (text: string) => schema.createNode('paragraph', { content: [schema.createText(text)] });
	const document = schema.createDocument([
		schema.createNode('bulletList', { content: [true, false].map(checked => schema.createNode('listItem', { attrs: { checked }, content: [paragraph('Task')] })) }),
		schema.createNode('table', { attrs: { markdownHeader: true }, content: ['Header', 'Body'].map(text => schema.createNode('tableRow', { content: [schema.createNode('tableCell', { content: [paragraph(text)] })] })) }),
	]);
	const text = legacyDocsToMarkdown(serializeDocument(document, schema));
	assert.match(text, /- \[x\] Task/u);
	assert.match(text, /- \[ \] Task/u);
	assert.match(text, /\| Header \|\n\| --- \|\n\| Body \|/u);
});

test('legacy Docs recovers a dirty file backup separately from its saved baseline', async () => {
	using fixture = new MigrationFixture();
	await fixture.seed();
	await fixture.backups.store({ resource, kind: 'structuredDocument', content: legacy('Unsaved'), updatedAt: 7 });
	await fixture.open();
	assert.equal((await fixture.files.readFile(target)).content.trim(), 'Original');
	assert.equal((await fixture.backups.resolve(target))?.content.trim(), 'Unsaved');
	assert.equal((await fixture.backups.resolve(target))?.kind, 'text');
	assert.equal(await fixture.backups.resolve(resource), undefined);
	await fixture.open();
	assert.equal((await fixture.backups.resolve(target))?.content.trim(), 'Unsaved');
});

test('legacy Docs restores untitled crash backups to stable Markdown draft identities', async () => {
	using fixture = new MigrationFixture();
	const untitled = URI.parse('untitled:/draft/legacy.ash-doc');
	await fixture.backups.store({ resource: untitled, kind: 'structuredDocument', content: legacy('Recovered draft'), updatedAt: 9 });
	const input = await fixture.open({ resource: untitled });
	assert.equal(input.resource.toString(), 'untitled:/draft/legacy.md');
	assert.equal(input.initialText?.trim(), 'Recovered draft');
	assert.equal(await fixture.backups.resolve(untitled), undefined);
	assert.equal((await fixture.open({ resource: untitled, initialText: legacy('Recovered draft') })).resource.toString(), input.resource.toString());
});

for (const output of ['unrelated target', '']) test(`legacy Docs preserves an existing ${output ? 'different' : 'empty'} Markdown target`, async () => {
	using fixture = new MigrationFixture();
	await fixture.seed();
	await fixture.files.writeFile({ resource: target, content: output });
	await assert.rejects(fixture.open(), /conflicting changes/u);
	assert.equal((await fixture.files.readFile(target)).content, output);
	assert.equal((await fixture.files.readFile(resource)).content, legacy());
});

test('legacy Docs accepts an equal target after interruption and serializes concurrent opens safely', async () => {
	using fixture = new MigrationFixture();
	await fixture.seed();
	await fixture.files.writeFile({ resource: target, content: legacyDocsToMarkdown(legacy()) });
	const inputs = await Promise.all([fixture.open(), fixture.open()]);
	assert.equal(inputs[0].resource.toString(), inputs[1].resource.toString());
});

test('legacy Docs handles opaque provider create failures without overwriting an existing target', async () => {
	using fixture = new MigrationFixture();
	await fixture.seed();
	await fixture.files.writeFile({ resource: target, content: 'Existing target' });
	fixture.files.writeFile = async () => { throw new Error('FileSystemOperationFailed'); };
	await assert.rejects(fixture.open(), /conflicting changes/u);
	assert.equal((await fixture.files.readFile(target)).content, 'Existing target');
});

test('legacy Docs preserves unsupported formatting, invalid source and recovery conflicts', async () => {
	using fixture = new MigrationFixture();
	const schema = createDefaultDocumentSchema();
	const styled = schema.createDocument([schema.createNode('paragraph', { content: [schema.createText('Styled', { marks: [{ type: 'textStyle', attrs: { fontFamily: 'serif' } }] })] })]);
	const serialized = serializeDocument(styled, schema);
	await fixture.seed(serialized);
	await assert.rejects(fixture.open(), /Cannot preserve/u);
	await assert.rejects(fixture.files.stat(target));
	assert.equal((await fixture.files.readFile(resource)).content, serialized);
	await fixture.files.writeFile({ resource, content: '{invalid' });
	await assert.rejects(fixture.open());
	await fixture.files.writeFile({ resource, content: legacy() });
	await fixture.backups.store({ resource: target, kind: 'text', content: 'Different recovered draft', updatedAt: 3 });
	await assert.rejects(fixture.open(), /conflicting changes/u);
	assert.equal((await fixture.backups.resolve(target))?.content, 'Different recovered draft');
});

test('legacy Docs retries after receipt flush or old backup cleanup fails', async () => {
	using fixture = new MigrationFixture();
	await fixture.seed();
	await fixture.backups.store({ resource, kind: 'structuredDocument', content: legacy('Dirty'), updatedAt: 3 });
	const flush = fixture.storage.flush.bind(fixture.storage);
	fixture.storage.flush = async () => { throw new Error('Receipt flush failed'); };
	await assert.rejects(fixture.open(), /Receipt flush failed/u);
	assert.ok(await fixture.backups.resolve(resource));
	fixture.storage.flush = flush;
	await fixture.open();
	assert.equal(await fixture.backups.resolve(resource), undefined);
	assert.equal((await fixture.backups.resolve(target))?.content.trim(), 'Dirty');
});

for (const content of ['', '   ']) test(`legacy Docs migrates a blank file containing ${content.length} characters`, async () => {
	using fixture = new MigrationFixture();
	await fixture.seed(content);
	await fixture.open();
	assert.equal((await fixture.files.readFile(target)).content, '');
	assert.equal((await fixture.files.readFile(resource)).content, content);
});

test('concurrent legacy draft migrations create one target backup', async () => {
	using fixture = new MigrationFixture();
	await fixture.seed();
	await fixture.backups.store({ resource, kind: 'structuredDocument', content: legacy('Dirty'), updatedAt: 2 });
	let writes = 0;
	const store = fixture.backups.store.bind(fixture.backups);
	fixture.backups.store = async backup => { writes++; await store(backup); };
	await Promise.all([fixture.open(), fixture.open()]);
	assert.equal(writes, 1);
	assert.equal((await fixture.backups.resolve(target))?.content.trim(), 'Dirty');
});
