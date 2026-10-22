import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileService, FileSystemProviderErrorCode, createFileSystemProviderError } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { WorkbenchOpenerContribution } from '../../browser/opener.contribution.js';

test('registered folder opener reveals directories, preserves file fallback and does not swallow access errors', async () => {
	using fixture = new OpenerFixture();
	const folder = URI.file('/project/nested');
	await fixture.provider.createDirectory(folder);
	await fixture.provider.writeFile(URI.file('/project/file.txt'), new Uint8Array([65]), { create: true, overwrite: false });
	assert.equal(await fixture.opener.open(URI.file('/project/other/../nested').with({ fragment: '3,1' })), true);
	assert.deepEqual(fixture.commands.map(call => [call[0], (call[1] as URI).path]), [['revealInExplorer', '/project/nested']]);
	assert.equal(fixture.fallback.length, 0);
	assert.equal(await fixture.opener.open(URI.file('/project/file.txt')), false);
	assert.equal(await fixture.opener.open(URI.file('/project/missing')), false);
	assert.equal(await fixture.opener.open(URI.file('/outside')), false);
	assert.equal(fixture.fallback.length, 3);
	fixture.files.failure = createFileSystemProviderError('denied', FileSystemProviderErrorCode.NoPermissions);
	await assert.rejects(fixture.opener.open(folder), /denied/);
	assert.equal(fixture.fallback.length, 3);
	fixture.contribution.dispose();
	fixture.files.failure = undefined;
	assert.equal(await fixture.opener.open(folder), false);
	assert.equal(fixture.fallback.length, 4);
});

test('pending stat cannot reveal after disposal; only native Sessions reveals an outside local folder', async () => {
	using fixture = new OpenerFixture();
	const folder = URI.file('/project/nested');
	await fixture.provider.createDirectory(folder);
	const barrier = new DeferredPromise<void>();
	fixture.files.barrier = barrier.p;
	const pending = fixture.opener.open(folder);
	fixture.contribution.dispose();
	await barrier.complete();
	assert.equal(await pending, false);
	assert.equal(fixture.commands.length, 0);
	fixture.files.barrier = undefined;
	const outside = URI.file('/outside');
	await fixture.provider.createDirectory(outside);
	const revealed: URI[] = [];
	using native = fixture.services.createInstance(WorkbenchOpenerContribution, async (resource: URI) => { revealed.push(resource); });
	assert.equal(await native.open(outside), false);
	IsSessionsWindowContext.bindTo(fixture.context).set(true);
	assert.equal(await native.open(outside), true);
	assert.deepEqual(revealed, [outside]);
	assert.equal(await native.open(outside, { openExternal: true }), false);
});

class ControlledFileService extends FileService {
	barrier: Promise<void> | undefined;
	failure: Error | undefined;
	override async stat(resource: URI) {
		await this.barrier;
		if (this.failure) throw this.failure;
		return super.stat(resource);
	}
}

class OpenerFixture extends DisposableStore {
	readonly services = this.add(new InstantiationService());
	readonly files = this.add(new ControlledFileService());
	readonly provider = this.add(new InMemoryFileSystemProvider());
	readonly context = this.add(new ContextKeyService());
	readonly commands: unknown[][] = [];
	readonly fallback: URI[] = [];
	readonly opener: OpenerService;
	readonly contribution: WorkbenchOpenerContribution;
	constructor() {
		super();
		this.add(this.files.registerProvider('file', this.provider));
		const workspace = this.add(new TestWorkspaceService({ id: 'project', folders: [{ id: 'root', uri: URI.file('/project'), name: 'project', index: 0 }] }));
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IWorkspaceContextService, workspace);
		this.services.registerInstance(IContextKeyService, this.context);
		const editors = this.add(new StandaloneCodeEditorService());
		this.add(editors.registerCodeEditorOpenHandler(async input => { this.fallback.push(input.resource); return null; }));
		this.services.registerInstance(ICodeEditorService, editors);
		this.services.registerInstance(ICommandService, {
			onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None,
			executeCommand: async <T>(id: string, ...args: unknown[]): Promise<T> => { this.commands.push([id, ...args]); return undefined as T; },
		});
		this.opener = this.add(this.services.createInstance(OpenerService));
		this.services.registerInstance(IOpenerService, this.opener);
		this.contribution = this.add(this.services.createInstance(WorkbenchOpenerContribution, undefined));
	}
}
