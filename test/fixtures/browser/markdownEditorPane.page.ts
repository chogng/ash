import './chatFixtureLocalization.js';
import '../../../src/ash/workbench/contrib/markdown/browser/markdown.contribution.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { MemoryResourceStore } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { MARKDOWN_EDITOR_ID, MarkdownEditorPane, createMarkdownEditorInput } from '../../../src/ash/workbench/contrib/markdown/browser/markdownEditorPane.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService, type TextModelReference } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';

const lifetime = new DisposableStore();
const parent = lifetime.add(createTestEditorServices());
registerCodeEditorServices(parent);
const services = lifetime.add(parent.createChild());
services.registerInstance(IDialogService, lifetime.add(new DialogService()));
services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
const resource = URI.file('/workspace/document.md');
const store = lifetime.add(new MemoryResourceStore([[resource, '# Shared\n\noriginal']]));
const models = lifetime.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(IFileTextModelService, models);
services.registerInstance(ITextModelResourceService, models);
let pane: MarkdownEditorPane;
let peer: TextModelReference;

const input = createMarkdownEditorInput({ resource });
const descriptor = EditorPanes.getEditorPane(input, { preferredEditorId: MARKDOWN_EDITOR_ID })!;
const created = await descriptor.create({ input, instantiationService: services });
if (!(created instanceof MarkdownEditorPane)) throw new TypeError('Expected the production Markdown editor pane');
pane = lifetime.add(created);
pane.create(document.getElementById('document')!);
pane.setVisible(true);
await pane.setInput(input, new AbortController().signal);
pane.layout({ width: 500, height: 600 });
peer = lifetime.add(await models.acquire({ resource }, new AbortController().signal));
const code = lifetime.add(services.createInstance(CodeEditorWidget, { container: document.getElementById('source')!, model: peer.model, ariaLabel: 'Peer Markdown source' }));
code.layout({ width: 500, height: 600 });

const fixture = {
	get text() { return peer.model.getValue(); },
	get saved() { return store.text(resource); },
	get dirty() { return pane.isDirty; },
	get sharedModel() { return models.getModels().length === 1 && code.getModel() === peer.model && pane.workingCopy?.resource.toString() === resource.toString(); },
	get defaultEditor() { return EditorPanes.getEditorPane({ resource })?.id; },
	get choices() { return EditorPanes.getEditorPanesForInput({ resource }).map(item => item.id); },
	save: () => pane.save(),
	async reopen() { pane.clearInput(); await pane.setInput(input, new AbortController().signal); pane.layout({ width: 500, height: 600 }); },
};
declare global { interface Window { markdownPaneFixture: typeof fixture; } }
window.markdownPaneFixture = fixture;
window.addEventListener('pagehide', () => lifetime.dispose(), { once: true });
document.body.dataset.ready = 'true';
