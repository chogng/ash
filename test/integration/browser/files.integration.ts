import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { BinaryResourceDiffEditor } from '../../../src/ash/workbench/browser/parts/editor/binaryDiffEditor.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../src/ash/workbench/common/editor.js';
import { createBinaryDiffEditorInput } from '../../../src/ash/workbench/common/editor/diffEditorInput.js';
import { EditorInputSerializers } from '../../../src/ash/workbench/services/editor/common/editorInputSerializer.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Schemas } from '../../../src/ash/base/common/network.js';
import { IndexedDBFileSystemProvider } from '../../../src/ash/platform/files/browser/indexedDBFileSystemProvider.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { ITextModelService } from '../../../src/ash/editor/common/services/resolverService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../src/ash/workbench/browser/parts/editor/textResourceEditor.js';
import { matchCodeEditor } from '../../../src/ash/workbench/contrib/codeEditor/browser/codeEditorInput.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { EditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { EditorPaneRegistry } from '../../../src/ash/workbench/browser/editor.js';
import { binaryDiffEditorDescriptor } from '../../../src/ash/workbench/browser/parts/editor/binaryDiffEditor.js';
import { createTestFileService, createTestEditorServices, registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { BrowserExtensionHostApi, createDisconnectedExtensionHostApi } from '../../../src/ash/platform/extensionHost/browser/extensionHostApi.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IAppServerApi } from '../../../src/ash/platform/app-server/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';

const provider = await IndexedDBFileSystemProvider.create(indexedDB, Schemas.vscodeUserData);
const files = new FileService();
const registration = files.registerProvider(Schemas.vscodeUserData, provider);
const resource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/test.jsonc' });
let changes = 0;
const listener = files.onDidChangeFiles(() => changes++);
window.addEventListener('pagehide', () => { listener.dispose(); registration.dispose(); files.dispose(); provider.dispose(); }, { once: true });
const binaryResources = new DisposableStore();
window.addEventListener('pagehide', () => binaryResources.dispose(), { once: true });
let comparisonGroups: EditorPart | undefined;
let comparisonChanges: Emitter<void> | undefined;
let originalName = 'Before';
let textGroups: EditorPart | undefined;
let sharedText: TextModel | undefined;
let textResolutions = 0;
const textInput = { resource: URI.parse('review:/content.txt'), label: 'Provider text', languageId: 'plaintext' };
const integration = {
	get changes(): number { return changes; },
	async offlineExtensionFolders(): Promise<unknown> {
		using lifetime = new DisposableStore();
		const browserRoot = resource.with({ path: '/offline-project' });
		const backendRoot = URI.file('/disconnected-workspace');
		const unknownRoot = URI.parse('unregistered:///workspace');
		await files.createDirectory(browserRoot);
		lifetime.add(files.registerProvider(Schemas.file, new MemoryFileService([])));
		const services = lifetime.add(new InstantiationService());
		services.registerInstance(IFileService, files);
		services.registerInstance(ICommandService, {
			onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None,
			executeCommand: async () => { throw new Error('Unexpected extension command'); },
		});
		services.registerInstance(IAppServerApi, {
			getConnectionState: async () => 'stopped', getSlashCommands: async () => [], onConnectionState: () => toDisposable(() => { }),
		});
		services.registerInstance(IWorkspaceContextService, lifetime.add(new WorkspaceContextService({
			id: 'offline-folders', folders: [browserRoot, backendRoot, unknownRoot].map((uri, index) => ({ uri, index, id: String(index), name: `Root ${index}` })),
		})));
		const host = lifetime.add(new BrowserExtensionHostApi({
			list: async () => ({
				generation: 1, diagnostics: [], extensions: [{
					id: 'offline-folders', name: 'folders', publisher: 'test', displayName: 'Folders', version: '1', sourceKind: 'builtIn',
					manifestJson: JSON.stringify({ browser: 'main.js' }), manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'b'.repeat(64)}`,
				}]
			}),
			readResource: async () => new TextEncoder().encode(`export function activate(api) {
				api.register({ kind: 'command', registrationId: 'folders', command: 'folders', title: 'Folders' },
					() => api.clientRequest({ operation: 'workspaceFolders' }));
			}`),
		}, createDisconnectedExtensionHostApi(operation => { throw new Error(`Unexpected remote operation ${operation}`); }), services));
		const runtime = (await host.reconcile('refresh')).extensions[0]!;
		if (runtime.lifecycle !== 'ready') throw new Error(`Extension activation failed: ${JSON.stringify(runtime.failure)}`);
		return await host.invoke({
			extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation!,
			registrationId: 'folders', operation: 'command', payload: null, deadlineUnixMillis: Date.now() + 5_000
		}, new AbortController().signal);
	},
	async showBinaryComparison(restored: boolean): Promise<{ primary: string; secondary: string; }> {
		binaryResources.clear();
		const files = binaryResources.add(await IndexedDBFileSystemProvider.create(indexedDB, Schemas.file));
		const before = URI.file('/binary/before.bin');
		const after = URI.file('/binary/after.bin');
		if (!restored) {
			await files.writeFile(before, new Uint8Array([0x48, 0x69]), { create: true, overwrite: false });
			await files.writeFile(after, new Uint8Array([0x48, 0x69, 0x00, 0xff]), { create: true, overwrite: false });
			const input = createBinaryDiffEditorInput({ resource: before }, { resource: after }, 'Review bytes');
			localStorage.setItem('binary-comparison', JSON.stringify(EditorInputSerializers.serialize(input)));
		}
		const input = EditorInputSerializers.deserialize(JSON.parse(localStorage.getItem('binary-comparison')!));
		const services = binaryResources.add(new InstantiationService());
		services.registerSingleton(IFileService, () => createTestFileService(files));
		const pane = binaryResources.add(registerTestComponentServices(services).createInstance(BinaryResourceDiffEditor));
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
	async showComparisonGroups(restored: boolean): Promise<void> {
		binaryResources.clear();
		const files = binaryResources.add(await IndexedDBFileSystemProvider.create(indexedDB, Schemas.file));
		const originalResource = URI.file('/binary/before.bin');
		const modifiedResource = URI.file('/binary/after.bin');
		comparisonChanges = binaryResources.add(new Emitter<void>());
		originalName = 'Before';
		const original = { resource: originalResource, get label() { return originalName; }, onDidChangeLabel: comparisonChanges.event };
		const input = restored
			? binaryResources.add(EditorInputSerializers.deserialize(JSON.parse(localStorage.getItem('comparison-groups')!)) as ReturnType<typeof createBinaryDiffEditorInput>)
			: binaryResources.add(createBinaryDiffEditorInput(original, { resource: modifiedResource, label: 'After' }));
		if (!restored) {
			await files.writeFile(originalResource, new Uint8Array([0x48, 0x69]), { create: true, overwrite: false });
			await files.writeFile(modifiedResource, new Uint8Array([0x48, 0x69, 0xff]), { create: true, overwrite: false });
		}
		const parent = binaryResources.add(new InstantiationService());
		parent.registerSingleton(IFileService, () => createTestFileService(files));
		const services = binaryResources.add(createTestEditorServices(undefined, parent));
		const registry = new EditorPaneRegistry();
		registry.registerEditorPane(binaryDiffEditorDescriptor());
		const container = document.createElement('div');
		container.id = 'comparison-groups';
		document.body.append(container);
		binaryResources.add(toDisposable(() => container.remove()));
		comparisonGroups = binaryResources.add(registerTestComponentServices(services).createInstance(EditorPart, container, { registry }));
		comparisonGroups.layout({ width: 960, height: 480 });
		await comparisonGroups.openEditor(input);
		if (!restored) await comparisonGroups.openEditor(input, {}, 'sideGroup');
	},
	renameComparison(name: string): void {
		originalName = name;
		comparisonChanges!.fire();
	},
	async closeFirstComparisonGroup(): Promise<void> {
		const group = comparisonGroups!.groups[0]!;
		await group.closeEditor(group.activeInput!);
	},
	async saveAndCloseComparisons(): Promise<boolean> {
		localStorage.setItem('comparison-groups', JSON.stringify(EditorInputSerializers.serialize(comparisonGroups!.activeInput!)));
		await comparisonGroups!.closeAllEditors();
		return comparisonChanges!.hasListeners();
	},
	async showTextGroups(): Promise<void> {
		binaryResources.clear();
		textResolutions = 0;
		const services = binaryResources.add(createTestEditorServices());
		registerCodeEditorServices(services);
		binaryResources.add(services.get(ITextModelService).registerTextModelContentProvider('review', {
			provideTextContent: async () => {
				textResolutions++;
				if (!sharedText || sharedText.isDisposed()) sharedText = new TextModel('Provider content');
				return sharedText;
			},
		}));
		binaryResources.add(toDisposable(() => sharedText?.dispose()));
		const store: ITextResourceStore = {
			onDidChange: Event.None,
			resolve: async request => ({ resource: request.resource, text: '', revision: undefined }),
			save: async () => { throw new Error('Provider content is read-only'); },
		};
		const registry = new EditorPaneRegistry();
		binaryResources.add(registry.registerEditorPane({
			id: CODE_EDITOR_ID,
			name: 'Text editor',
			canOpen: matchCodeEditor,
			create: options => options.instantiationService!.createInstance(TextResourceEditor, store, {}),
		}));
		const container = document.createElement('div');
		container.id = 'text-groups';
		document.body.append(container);
		binaryResources.add(toDisposable(() => container.remove()));
		textGroups = binaryResources.add(registerTestComponentServices(services).createInstance(EditorPart, container, { registry }));
		textGroups.layout({ width: 960, height: 480 });
		await textGroups.openEditor(textInput);
		await textGroups.openEditor(textInput, {}, 'sideGroup');
	},
	getTextState(): { disposed: boolean; resolutions: number; values: string[]; sameModel: boolean; } {
		const panes = textGroups!.groups.map(group => group.activePane).filter((pane): pane is TextResourceEditor => pane instanceof TextResourceEditor);
		return {
			disposed: sharedText!.isDisposed(),
			resolutions: textResolutions,
			values: panes.map(pane => pane.getValue()),
			sameModel: panes.every(pane => pane.getControl()!.getModel() === sharedText),
		};
	},
	async closeFirstTextGroup(): Promise<void> {
		const group = textGroups!.groups[0]!;
		await group.closeEditor(group.activeInput!);
		sharedText!.setValue('Remaining view');
	},
	async closeTextGroups(): Promise<void> {
		await textGroups!.closeAllEditors();
	},
	async reopenText(): Promise<void> {
		await textGroups!.openEditor(textInput);
	},
	read: () => files.readFile(resource),
	readBytes: async (name: string): Promise<number[]> => Array.from((await files.readFileBytes(URI.joinPath(resource, '..', name))).bytes),
	async importBytes(name: string, bytes: number[]): Promise<string> {
		try { await files.writeFileBytes(URI.joinPath(resource, '..', name), new Uint8Array(bytes)); return 'saved'; }
		catch (error) { return error instanceof Error ? error.message : String(error); }
	},
	async write(content: string, expectedRevision?: string): Promise<string> {
		try { await files.writeFile({ resource, content, expectedRevision }); return 'saved'; }
		catch (error) { return error instanceof Error ? error.name : String(error); }
	},
	async copyAndRename(): Promise<string[]> {
		const copy = URI.joinPath(resource, '../copy.jsonc');
		const moved = resource.with({ path: '/user/moved.jsonc' });
		await files.copy(resource, copy);
		await files.rename(copy, moved, 'error');
		const contents = [(await files.readFile(resource)).content, (await files.readFile(moved)).content];
		await files.delete(moved, 'error', 'fileOrEmptyDirectory');
		return contents;
	},
};

declare global { interface Window { ashFilesIntegration: typeof integration; } }
window.ashFilesIntegration = integration;
