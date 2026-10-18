import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileNotFoundError, type IFileChangeEvent } from '../../../../../platform/files/common/files.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { MemoryFileService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { WorkspaceExtensionsConfigService } from '../../common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationsService } from '../../../../contrib/extensions/browser/extensionRecommendationsService.js';
import { ExtensionRecommendationReason } from '../../common/extensionRecommendations.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

type MemoryFileBytes = Awaited<ReturnType<MemoryFileService['readFile']>>;

class RecommendationsFileProvider extends MemoryFileService {
	public override readonly onDidChangeFiles;
	public watches = 0;
	public error: Error | undefined;
	public heldRead: DeferredPromise<MemoryFileBytes> | undefined;
	constructor(private readonly changes: Emitter<IFileChangeEvent>, resources: readonly (readonly [URI, string])[]) { super(resources); this.onDidChangeFiles = changes.event; }
	public override watch(): IDisposable { ++this.watches; return toDisposable(() => { --this.watches; }); }
	public override async readFile(resource: URI): Promise<MemoryFileBytes> {
		if (this.heldRead) { const held = this.heldRead; this.heldRead = undefined; return held.p; }
		if (this.error) { throw this.error; }
		if (!this.has(resource)) { throw new FileNotFoundError(resource); }
		return super.readFile(resource);
	}
	public invalidate(resource: URI): void { this.changes.fire({ resources: [resource] }); }
}

function fixture(resources: readonly (readonly [URI, string])[] = []): { lifetime: DisposableStore; workspace: TestWorkspaceService; files: FileService; provider: RecommendationsFileProvider; configs: WorkspaceExtensionsConfigService; recommendations: ExtensionRecommendationsService; } {
	const lifetime = new DisposableStore();
	const workspace = lifetime.add(new TestWorkspaceService({ id: 'project', uri: URI.file('/project') }));
	const files = lifetime.add(new FileService());
	const changes = lifetime.add(new Emitter<IFileChangeEvent>());
	const provider = new RecommendationsFileProvider(changes, resources);
	lifetime.add(files.registerProvider('file', provider));
	const identity = lifetime.add(new UriIdentityService(files));
	const configs = lifetime.add(new WorkspaceExtensionsConfigService(workspace, files, identity));
	const recommendations = new ExtensionRecommendationsService(configs);
	return { lifetime, workspace, files, provider, configs, recommendations };
}

suite('Workspace extension recommendations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('merges Ash JSONC and multi-root workspace declarations, normalizes IDs and applies exclusions', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const workspaceFile = URI.file('/project.ash-workspace');
		const other = URI.file('/other/.ash/extensions.json');
		const f = fixture([
			[resource, '{ // folder recommendations\n "recommendations": ["Publisher.Sample", "example/web", "example/web",], "unwantedRecommendations": ["excluded.tool"] }'],
			[workspaceFile, '{ "folders": [], "extensions": { "recommendations": ["excluded.tool", "workspace.tool"] } }'],
			[other, '{ "recommendations": ["publisher.sample", "other/tool"], "unwantedRecommendations": ["workspace.tool"] }'],
			[URI.file('/project/.vscode/extensions.json'), '{ "recommendations": ["vscode.only"] }'],
		]);
		using lifetime = f.lifetime;
		f.workspace.updateWorkspace({ id: 'multi', configuration: workspaceFile, folders: [{ id: 'project', name: 'Project', uri: URI.file('/project'), index: 0 }, { id: 'other', name: 'Other', uri: URI.file('/other'), index: 1 }] });
		const snapshot = await f.recommendations.getWorkspaceRecommendations();
		assert.deepEqual(snapshot, {
			recommendations: ['publisher.sample', 'example/web', 'other/tool'].map(extensionId => ({ extensionId, reason: { reasonId: ExtensionRecommendationReason.Workspace, reasonText: 'Recommended by this workspace' } })),
			resources: [workspaceFile, resource, other], diagnostics: [],
		});
		assert.equal(f.provider.watches, 3);
	});

	test('invalid external edits report diagnostics while retaining the last valid declaration; deletion clears it', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const f = fixture([[resource, '{"recommendations":["example/web"]}']]);
		using lifetime = f.lifetime;
		assert.equal((await f.recommendations.getWorkspaceRecommendations()).recommendations.length, 1);
		for (const content of ['{', '{"recommendations":"example/web"}', '{"recommendations":[12]}', '{"unwantedRecommendations":["https://unsafe"]}']) {
			await f.files.writeFile({ resource, content });
			f.provider.invalidate(resource);
			const snapshot = await f.recommendations.getWorkspaceRecommendations();
			assert.deepEqual(snapshot.recommendations.map(item => item.extensionId), ['example/web']);
			assert.equal(snapshot.diagnostics.length, 1);
			assert.ok(snapshot.diagnostics[0]!.includes(resource.toString()));
		}
		await f.files.delete(resource, 'error', 'fileOrEmptyDirectory');
		f.provider.invalidate(resource);
		assert.deepEqual((await f.recommendations.getWorkspaceRecommendations()).recommendations, []);
		assert.deepEqual((await f.recommendations.getWorkspaceRecommendations()).diagnostics, []);
	});

	test('provider errors retain declarations and refresh retries instead of treating errors as missing files', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const f = fixture([[resource, '{"recommendations":["example/web"]}']]);
		using lifetime = f.lifetime;
		await f.configs.getExtensionsConfigs();
		f.provider.error = new Error('Permission denied'); f.provider.invalidate(resource);
		assert.match((await f.recommendations.getWorkspaceRecommendations()).diagnostics[0]!, /Permission denied/u);
		f.provider.error = undefined; f.recommendations.refresh();
		assert.deepEqual((await f.recommendations.getWorkspaceRecommendations()).diagnostics, []);
	});

	test('workspace replacement disposes watches and rejects a pending result from the old workspace', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const f = fixture([[resource, '{"recommendations":["example/web"]}']]);
		using lifetime = f.lifetime;
		await f.configs.getExtensionsConfigs();
		const held = new DeferredPromise<MemoryFileBytes>(); f.provider.heldRead = held; f.recommendations.refresh();
		const old = f.recommendations.getWorkspaceRecommendations();
		const rejected = assert.rejects(old, CancellationError);
		f.workspace.updateWorkspace({ id: 'empty', folders: [] });
		assert.equal(f.provider.watches, 0);
		await held.complete({ resource, bytes: new TextEncoder().encode('{"recommendations":["old/tool"]}'), revision: 'old' });
		await rejected;
		assert.deepEqual(await f.recommendations.getWorkspaceRecommendations(), { recommendations: [], resources: [], diagnostics: [] });
	});
});
