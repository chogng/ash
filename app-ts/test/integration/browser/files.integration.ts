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
import { createTestEditorServices, registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';

const provider = await IndexedDBFileSystemProvider.create(indexedDB, Schemas.vscodeUserData);
const resource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/test.jsonc' });
let changes = 0;
const listener = provider.onDidChangeFiles(() => changes++);
window.addEventListener('pagehide', () => { listener.dispose(); provider.dispose(); }, { once: true });
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
			await files.writeFileBytes(originalResource, new Uint8Array([0x48, 0x69]));
			await files.writeFileBytes(modifiedResource, new Uint8Array([0x48, 0x69, 0xff]));
		}
		const services = binaryResources.add(createTestEditorServices());
		services.registerInstance(IFileService, files);
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
