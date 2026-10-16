import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import { IExtensionHostApi } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/agentHost/browser/extensionHostApi.js';
import { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ILanguagePackService } from '../../../src/ash/platform/languagePacks/common/languagePacks.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import { createTestEditorServices, createTestFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { MemoryResourceStore, MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { MainThreadCustomEditors } from '../../../src/ash/workbench/api/browser/mainThreadCustomEditors.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { WebviewEditor } from '../../../src/ash/workbench/contrib/webviewPanel/browser/webviewEditor.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { createLargeMarkdownDocument } from './markdownLargeDocument.js';

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
setNlsMessages(locale, {});
const lifetime = new DisposableStore();
window.addEventListener('pagehide', () => lifetime.dispose(), { once: true });
const parent = lifetime.add(createTestEditorServices());
const services = lifetime.add(parent.createChild());
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
services.registerInstance(INotificationService, lifetime.add(new NotificationService()));
services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
const fixture = createBuiltinExtensionFixture();
const packages: IExtensionApi = {
	resources: fixture.resources,
	list: async mode => { const catalog = await fixture.list(mode); return { ...catalog, extensions: catalog.extensions.filter(extension => extension.id === 'vscode.markdown-language-features') }; },
};
services.registerInstance(IExtensionApi, packages);
const host = {
	...createDisconnectedExtensionHostApi(operation => { throw new Error(`Unexpected backend call ${operation}`); }),
	async reconcile() {
		const response = await fetch(`/__markdown_extension?locale=${locale}`);
		if (!response.ok) throw new Error('Markdown extension unavailable');
		return response.json();
	},
	async invoke(request: import('../../../src/ash/platform/agentHost/common/extensionHostApi.js').ExtensionHostInvocationRequest, signal: AbortSignal) {
		const response = await fetch(`/__markdown_render?locale=${locale}&view=${encodeURIComponent(request.registrationId)}`, { signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify((request.payload as { document: unknown; }).document) });
		if (!response.ok) throw new Error('Markdown extension failed');
		return response.json();
	},
};
services.registerInstance(IExtensionHostApi, host);
const registration = lifetime.add(services.createInstance(MainThreadCustomEditors, 30000));
const snapshot = await host.reconcile();
registration.update(snapshot);
const viewType = new URL(location.href).searchParams.get('view') ?? 'vscode.markdown.editor';
const descriptor = EditorPanes.getEditorPanes().find(pane => pane.id === viewType);
if (!descriptor) throw new Error(`Markdown editor failed to register: ${JSON.stringify(snapshot)}`);
const pane = lifetime.add(await descriptor.create({}));
if (!(pane instanceof WebviewEditor)) throw new TypeError('Markdown must use the shared webview editor host');
pane.create(document.querySelector('#editor')!);
pane.setVisible(true);
pane.layout({ width: innerWidth, height: 850 });
await pane.setInput({ resource, languageId: 'markdown' }, new AbortController().signal);
const source = lifetime.add(await models.acquire({ resource, languageId: 'markdown' }, new AbortController().signal));
const messages: unknown[] = [];
lifetime.add(pane.getControl()!.onMessage(({ message }) => messages.push(message)));

window.ashMarkdownHost = {
	initial,
	messages,
	get editable() { return pane.isEditable; },
	get text() { return source.model.getText(); },
	get saved() { return store.text(resource); },
	get saves() { return store.saved.length; },
	get dirty() { return source.isDirty; },
	get sharedModel() { return pane.workingCopy?.reference.model === source.model; },
	edit(start: number, end: number, text: string) {
		source.model.pushStackElement();
		source.model.pushEditOperations(null, [{ range: Range.fromPositions(source.model.getPositionAt(start), source.model.getPositionAt(end)), text }], null);
		source.model.pushStackElement();
	},
	undo: () => source.model.undo(),
	redo: () => source.model.redo(),
	disable: () => registration.clear(),
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
			disable(): void; readonly registered: boolean;
		};
	}
}
