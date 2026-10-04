import { URI } from '../../../src/ash/base/common/uri.js';
import { Schemas } from '../../../src/ash/base/common/network.js';
import { IndexedDBFileSystemProvider } from '../../../src/ash/platform/files/browser/indexedDBFileSystemProvider.js';

const provider = await IndexedDBFileSystemProvider.create(indexedDB, Schemas.vscodeUserData);
const resource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/test.jsonc' });
let changes = 0;
const listener = provider.onDidChangeFiles(() => changes++);
window.addEventListener('pagehide', () => { listener.dispose(); provider.dispose(); }, { once: true });
const integration = {
	get changes(): number { return changes; },
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
