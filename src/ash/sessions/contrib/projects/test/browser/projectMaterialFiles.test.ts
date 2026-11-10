import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileNotFoundError } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { projectMaterialFilesKey, projectMaterialFilesScheme } from '../../../../../platform/projects/common/projectMaterialFiles.js';
import { ProjectMaterialFiles } from '../../browser/projectMaterialFiles.js';

const root = URI.file('/project-files');
const project = 'project';
const missing = { id: 'missing', name: 'missing.txt' };
const saved = { id: 'saved', name: 'saved.txt' };

function resource(file: typeof missing): URI {
	return URI.from({
		scheme: projectMaterialFilesScheme,
		authority: projectMaterialFilesKey(root.fsPath),
		path: `/${projectMaterialFilesKey(project)}/${projectMaterialFilesKey(file.id)}/${file.name}`,
	});
}

function createFileService(store: DisposableStore): FileService {
	const files = store.add(new FileService());
	const provider = store.add(new InMemoryFileSystemProvider());
	store.add(files.registerProvider(projectMaterialFilesScheme, provider));
	return files;
}

suite('Project material files', () => {
	test('opens a saved copy before an unrelated download finishes', async () => {
		using store = new DisposableStore();
		const files = createFileService(store);
		const materials = store.add(new ProjectMaterialFiles(files, root, project));
		const target = resource(saved);
		await files.createDirectory(dirname(target));
		await files.writeFileBytes(target, new TextEncoder().encode('saved copy'));
		const started = new DeferredPromise<void>();
		const response = new DeferredPromise<Blob>();
		const syncing = materials.ensure(missing, () => {
			void started.complete();
			return response.p;
		});
		try {
			await started.p;
			const open = await materials.ensure(saved, async () => assert.fail('A saved copy should skip the download'));
			assert.equal(open.toString(), target.toString());
			assert.equal((await materials.ensure(saved, undefined)).toString(), target.toString());
		} finally {
			const cancelled = assert.rejects(syncing, CancellationError);
			materials.dispose();
			await cancelled;
		}
	});

	test('cancels active and queued downloads and allows a fresh scope to retry', async () => {
		using store = new DisposableStore();
		const files = createFileService(store);
		using scope = new MutableDisposable<ProjectMaterialFiles>();
		const materials = scope.value = new ProjectMaterialFiles(files, root, project);
		const started = new DeferredPromise<AbortSignal>();
		const response = new DeferredPromise<Blob>();
		const active = assert.rejects(materials.ensure(missing, signal => {
			void started.complete(signal);
			return response.p;
		}), CancellationError);
		const queued = assert.rejects(materials.ensure(saved, async () => assert.fail('A retired scope should skip queued downloads')), CancellationError);
		const signal = await started.p;
		const retry = scope.value = new ProjectMaterialFiles(files, root, project);
		await Promise.all([active, queued]);
		assert.equal(signal.aborted, true);
		await response.complete(new Blob(['old response']));
		await assert.rejects(files.stat(resource(missing)), FileNotFoundError);

		await files.createDirectory(dirname(resource(missing)));
		let downloads = 0;
		const download = async () => {
			downloads++;
			return new Blob(['fresh response']);
		};
		const [first, second] = await Promise.all([retry.ensure(missing, download), retry.ensure(missing, download)]);
		assert.equal(first.toString(), second.toString());
		assert.equal(downloads, 1);
		assert.equal((await files.readFile(first)).content, 'fresh response');
	});
});
