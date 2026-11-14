import { IBufferCollabService } from '../../../src/ash/workbench/services/collab/common/bufferCollabService.js';
import { BufferCollabService } from '../../../src/ash/workbench/services/collab/browser/bufferCollabService.js';
import './chatFixtureLocalization.js';
import '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdown.contribution.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { MemoryResourceStore } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { ArkdownEditorPane } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownEditorPane.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService, type TextModelReference } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';

const lifetime = new DisposableStore();
const parent = lifetime.add(createTestEditorServices());
registerCodeEditorServices(parent);
const services = lifetime.add(parent.createChild());
services.registerSingleton(IBufferCollabService, () => services.createInstance(BufferCollabService));
services.registerInstance(IDialogService, lifetime.add(new DialogService()));
services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
const resource = URI.file('/workspace/document.md');
const store = lifetime.add(new MemoryResourceStore([[resource, '# Shared\n\noriginal']]));
const models = lifetime.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(IFileTextModelService, models);
services.registerInstance(ITextModelResourceService, models);
let pane: ArkdownEditorPane;
let peer: TextModelReference;

const input = { resource, languageId: 'markdown', contentType: 'text/markdown' };
pane = lifetime.add(services.createInstance(ArkdownEditorPane, { id: 'test.arkdown.docs' }));
pane.create(document.getElementById('document')!);
pane.setVisible(true);
await pane.setInput(input, new AbortController().signal);
pane.layout({ width: 500, height: 600 });
peer = lifetime.add(await models.acquire({ resource }, new AbortController().signal));
const code = lifetime.add(services.createInstance(CodeEditorWidget, { container: document.getElementById('source')!, model: peer.model, ariaLabel: 'Peer Markdown source' }));
code.layout({ width: 500, height: 600 });

const fixture = {
	get help() { return pane.getAccessibilityHelp(); },
	get text() { return peer.model.getValue(); },
	get saved() { return store.text(resource); },
	get dirty() { return pane.isDirty; },
	get sharedModel() { return models.getModels().length === 1 && code.getModel() === peer.model && pane.workingCopy?.resource.toString() === resource.toString(); },
	get defaultEditor() { return EditorPanes.getEditorPane({ resource })?.id; },
	get choices() { return EditorPanes.getEditorPanesForInput({ resource }).map(item => item.id); },
	save: () => pane.save(),
	async reopen() { pane.clearInput(); await pane.setInput(input, new AbortController().signal); pane.layout({ width: 500, height: 600 }); },
};
declare global { interface Window { arkdownPaneFixture: typeof fixture; } }
window.arkdownPaneFixture = fixture;
window.addEventListener('pagehide', () => lifetime.dispose(), { once: true });
document.body.dataset.ready = 'true';
