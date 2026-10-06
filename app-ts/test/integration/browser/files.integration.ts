import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { BinaryResourceDiffEditor } from '../../../src/ash/workbench/browser/parts/editor/binaryDiffEditor.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../src/ash/workbench/common/editor.js';
import { createBinaryDiffEditorInput } from '../../../src/ash/workbench/common/editor/diffEditorInput.js';
import { EditorInputSerializers } from '../../../src/ash/workbench/services/editor/common/editorInputSerializer.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Schemas } from '../../../src/ash/base/common/network.js';
import { IndexedDBFileSystemProvider } from '../../../src/ash/platform/files/browser/indexedDBFileSystemProvider.js';

const provider = await IndexedDBFileSystemProvider.create(indexedDB, Schemas.vscodeUserData);
const resource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/test.jsonc' });
let changes = 0;
const listener = provider.onDidChangeFiles(() => changes++);
window.addEventListener('pagehide', () => { listener.dispose(); provider.dispose(); }, { once: true });
const binaryResources = new DisposableStore();
window.addEventListener('pagehide', () => binaryResources.dispose(), { once: true });
const integration = {
	get changes(): number { return changes; },
	async showBinaryComparison(restored: boolean): Promise<{ primary: string; secondary: string; }> {
		binaryResources.clear();
		const files = binaryResources.add(await IndexedDBFileSystemProvider.create(indexedDB, Schemas.file));
		const before = URI.file('/binary/before.bin');
		const after = URI.file('/binary/after.bin');
		if (!restored) {
			await files.writeFileBytes(before, new Uint8Array([0x48, 0x69]));
			await files.writeFileBytes(after, new Uint8Array([0x48, 0x69, 0x00, 0xff]));
			const input = createBinaryDiffEditorInput({ resource: before }, { resource: after }, 'Review bytes');
			localStorage.setItem('binary-comparison', JSON.stringify(EditorInputSerializers.serialize(input)));
		}
		const input = EditorInputSerializers.deserialize(JSON.parse(localStorage.getItem('binary-comparison')!));
		const services = binaryResources.add(new InstantiationService());
		services.registerInstance(IFileService, files);
		const pane = binaryResources.add(services.createInstance(BinaryResourceDiffEditor));
		const container = document.createElement('div');
		container.id = 'binary-comparison';
		container.style.width = '640px';
		container.style.height = '480px';
		document.body.append(container);
		binaryResources.add(toDisposable(() => container.remove()));
		pane.create(container);
		await pane.setInput(input, new AbortController().signal);
		pane.layout({ width: 640, height: 480 });
		pane.focus();
		const sides = EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.BOTH }) as { primary: URI; secondary: URI; };
		return { primary: sides.primary.path, secondary: sides.secondary.path };
	},
	read: () => provider.readFile(resource),
	async write(content: string, expectedRevision?: string): Promise<string> {
		try { await provider.writeFile({ resource, content, expectedRevision }); return 'saved'; }
		catch (error) { return error instanceof Error ? error.name : String(error); }
	},
	async copyAndRename(): Promise<string[]> {
		const copy = URI.joinPath(resource, '../copy.jsonc');
		const moved = resource.with({ path: '/user/moved.jsonc' });
		await provider.copy(resource, copy);
		await provider.rename(copy, moved, 'error');
		const contents = [(await provider.readFile(resource)).content, (await provider.readFile(moved)).content];
		await provider.delete(moved, 'error', 'fileOrEmptyDirectory');
		return contents;
	},
};

declare global { interface Window { ashFilesIntegration: typeof integration; } }
window.ashFilesIntegration = integration;
