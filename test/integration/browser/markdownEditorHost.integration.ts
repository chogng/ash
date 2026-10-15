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
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import { createTestEditorServices, createTestFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { MemoryResourceStore, MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { WebWorkerExtensionHost } from '../../../src/ash/workbench/services/extensions/browser/webWorkerExtensionHost.js';
import { createExtensionHostInitialization } from '../../../src/ash/workbench/services/extensions/common/extensionHostProtocol.js';
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
const host = lifetime.add(services.createInstance(WebWorkerExtensionHost, packages, createDisconnectedExtensionHostApi(operation => { throw new Error(`Unexpected backend call ${operation}`); })));
services.registerInstance(IExtensionHostApi, host);
const client = host.registerClientHandler(async raw => {
	const operation = raw as { operation: string; command?: string; arguments?: unknown[]; };
	if (operation.operation === 'readInitialization') return { result: 'initialization', initialization: createExtensionHostInitialization(services.get(IWorkspaceContextService), services.get(IConfigurationService)) };
	if (operation.operation === 'executeCommand' && operation.command === '_markdown.parse') {
		const response = await fetch('/__markdown_parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation.arguments?.[0]) });
		if (!response.ok) throw new Error('Rust parser unavailable');
		return { result: 'command', value: await response.json(), hasValue: true };
	}
	throw new Error(`Unexpected extension client operation ${operation.operation}`);
});
lifetime.add(toDisposable(() => client.dispose()));
const registration = lifetime.add(services.createInstance(MainThreadCustomEditors, 30000));
const snapshot = await host.reconcile('restartFailed');
registration.update(snapshot);
const descriptor = EditorPanes.getEditorPanes().find(pane => pane.id === 'vscode.markdown.editor');
if (!descriptor) throw new Error(`Markdown editor failed to register: ${JSON.stringify(snapshot)}`);
const pane = lifetime.add(await descriptor.create({}));
if (!(pane instanceof WebviewEditor)) throw new TypeError('Markdown must use the shared webview editor host');
pane.create(document.querySelector('#editor')!);
pane.setVisible(true);
pane.layout({ width: innerWidth, height: 850 });
await pane.setInput({ resource, languageId: 'markdown' }, new AbortController().signal);
const source = lifetime.add(await models.acquire({ resource, languageId: 'markdown' }, new AbortController().signal));

window.ashMarkdownHost = {
	initial,
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
};

declare global {
	interface Window {
		ashMarkdownHost: {
			readonly initial: string; readonly text: string; readonly saved: string; readonly saves: number;
			readonly dirty: boolean; readonly sharedModel: boolean;
			edit(start: number, end: number, text: string): void;
			undo(): void; redo(): void;
		};
	}
}
