import './chatFixtureLocalization.js';
import '../../../src/ash/workbench/contrib/markdown/browser/markdown.contribution.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IExtensionHostApi } from '../../../src/ash/platform/extensions/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/extensions/browser/extensionHostApi.js';
import { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { ILanguagePackService } from '../../../src/ash/platform/languagePacks/common/languagePacks.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { TestNotificationService } from './notificationFixture.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import { createTestEditorServices, createTestFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { MemoryResourceStore, MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { MainThreadCustomEditors } from '../../../src/ash/workbench/api/browser/mainThreadCustomEditors.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { WebviewEditor } from '../../../src/ash/workbench/contrib/webviewPanel/browser/webviewEditor.js';
import { BufferCollabService } from '../../../src/ash/workbench/services/collab/browser/bufferCollabService.js';
import { IBufferCollabService } from '../../../src/ash/workbench/services/collab/common/bufferCollabService.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
import { createLargeMarkdownDocument } from './markdownLargeDocument.js';

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
const readOnly = new URL(location.href).searchParams.has('readOnly');
const lifetime = new DisposableStore();
window.addEventListener('pagehide', () => lifetime.dispose(), { once: true });
const parent = lifetime.add(createTestEditorServices());
registerCodeEditorServices(parent);
const services = lifetime.add(parent.createChild());
services.registerSingleton(IBufferCollabService, () => services.createInstance(BufferCollabService));
services.registerInstance(IDialogService, lifetime.add(new DialogService()));
const initial = new URL(location.href).searchParams.has('large') ? createLargeMarkdownDocument() : '\uFEFF---\r\ntitle: 中文😀\r\n---\r\n\r\n# 标题\r\n\r\n中文段落 **保留加粗** 和 [引用][id]  \r\n原有换行。\r\n\r\n```rust\r\nlet untouched = "原样";\r\n```\r\n\r\n[id]: <https://example.com>  "标题"\r\n';
const resource = URI.file('/workspace/synthetic.md');
const store = lifetime.add(new MemoryResourceStore([[resource, initial]]));
const models = lifetime.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(IFileTextModelService, models);
services.registerInstance(ITextModelResourceService, models);
services.registerInstance(IFileService, lifetime.add(createTestFileService(new MemoryFileService([[resource, initial]]))));
services.registerInstance(IKeybindingService, { onDidUpdateKeybindings: Event.None } as IKeybindingService);
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => '' } as unknown as IAccessibleViewService);
services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
services.registerInstance(INotificationService, lifetime.add(new TestNotificationService()));
services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
const fixture = createBuiltinExtensionFixture();
const packageChanges = lifetime.add(new Emitter<void>());
const packages: IExtensionApi = {
	onDidChange: packageChanges.event,
	resources: fixture.resources,
	list: async mode => { const catalog = await fixture.list(mode); return { ...catalog, extensions: catalog.extensions.filter(extension => extension.id === 'ash.markdown-language-features') }; },
};
services.registerInstance(IExtensionApi, packages);
services.registerInstance(IExtensionService, { getExtensionPointContributions: () => [] } as unknown as IExtensionService);
const host = {
	...createDisconnectedExtensionHostApi(operation => { throw new Error(`Unexpected backend call ${operation}`); }),
	async reconcile() {
		const response = await fetch(`/__markdown_extension?locale=${locale}`);
		if (!response.ok) throw new Error('Markdown extension unavailable');
		return response.json();
	},
	async list() {
		const response = await fetch('/__markdown_math');
		if (!response.ok) throw new Error('Markdown math extension unavailable');
		return response.json();
	},
	async invoke(request: import('../../../src/ash/platform/extensions/common/extensionHostApi.js').ExtensionHostInvocationRequest, signal: AbortSignal) {
		const math = request.registrationId === 'math.render.v2';
		const response = await fetch(math ? '/__markdown_math' : `/__markdown_render?locale=${locale}&view=${encodeURIComponent(request.registrationId)}`, {
			signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(math ? request.payload : (request.payload as { document: unknown; }).document),
		});
		if (!response.ok) throw new Error('Markdown extension failed');
		return response.json();
	},
};
services.registerInstance(IExtensionHostApi, host);
const registration = lifetime.add(services.createInstance(MainThreadCustomEditors, 30000));
const viewType = new URL(location.href).searchParams.get('view') ?? 'vscode.markdown.editor';
if (viewType === 'vscode.markdown.preview.editor') registration.update(await host.reconcile());
const descriptor = EditorPanes.getEditorPanes().find(pane => pane.id === viewType);
if (!descriptor) throw new Error(`Markdown editor failed to register: ${viewType}`);
const pane = lifetime.add(await descriptor.create({ instantiationService: services }));
pane.create(document.querySelector('#editor')!);
pane.setVisible(true);
pane.layout({ width: innerWidth, height: 850 });
const input = { resource, languageId: 'markdown', readOnly };
await pane.setInput(descriptor.createInput?.(input) ?? input, new AbortController().signal);
const source = lifetime.add(await models.acquire({ resource, languageId: 'markdown' }, new AbortController().signal));
const messages: unknown[] = [];
if (pane instanceof WebviewEditor) lifetime.add(pane.getControl()!.onMessage(({ message }) => messages.push(message)));

window.ashMarkdownHost = {
	initial,
	messages,
	get editable() { return !(pane instanceof WebviewEditor) && !readOnly; },
	get text() { return source.model.getText(); },
	get saved() { return store.text(resource); },
	get saves() { return store.saved.length; },
	get dirty() { return source.isDirty; },
	get sharedModel() { return models.getModels().length === 1 && models.getModel(resource) === source.model; },
	edit(start: number, end: number, text: string) {
		source.model.pushStackElement();
		source.model.pushEditOperations(null, [{ range: Range.fromPositions(source.model.getPositionAt(start), source.model.getPositionAt(end)), text }], null);
		source.model.pushStackElement();
	},
	undo: () => source.model.undo(),
	redo: () => source.model.redo(),
	save: () => source.save(new AbortController().signal),
	disable: () => registration.clear(),
	refreshPackages: () => packageChanges.fire(),
	get registered() { return EditorPanes.getEditorPanes().some(pane => pane.id === 'vscode.markdown.editor'); },
};

declare global {
	interface Window {
		ashMarkdownHost: {
			readonly initial: string; readonly text: string; readonly saved: string; readonly saves: number;
			readonly dirty: boolean; readonly sharedModel: boolean;
			readonly editable: boolean; readonly messages: unknown[];
			edit(start: number, end: number, text: string): void;
			undo(): void; redo(): void;
			save(): Promise<void>;
			disable(): void; readonly registered: boolean;
			refreshPackages(): void;
		};
	}
}
