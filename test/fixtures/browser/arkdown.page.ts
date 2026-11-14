import './chatFixtureLocalization.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { loadArkdown } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownRuntime.js';
import { ArkdownEditor } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownEditor.js';
import type { DocsEditorMode } from '../../../src/ash/sessions/contrib/docs/common/docs.js';

const services = createTestEditorServices();
registerCodeEditorServices(services);
window.addEventListener('pagehide', () => { editor?.dispose(); model?.dispose(); services.dispose(); }, { once: true });

let model: TextModel | undefined;
let editor: ArkdownEditor | undefined;
const errors: string[] = [];
const fixture = {
	async mount(source: string, mode: DocsEditorMode = 'rich', inFrame = false) {
		editor?.dispose(); model?.dispose(); errors.length = 0;
		const runtime = await loadArkdown();
		model = new TextModel(source);
		let parent = document.getElementById('root')!;
		if (inFrame) {
			const frame = document.createElement('iframe');
			frame.title = 'Document window';
			parent.replaceChildren(frame);
			parent = frame.contentDocument!.body;
		}
		editor = services.createInstance(ArkdownEditor, parent, model, runtime, mode, (error: unknown) => errors.push(String(error)), () => {});
		if (inFrame) {
			const outside = parent.ownerDocument.createElement('button');
			outside.textContent = 'Outside document';
			parent.append(outside);
		}
		editor.focus();
	},
	get source() { return model!.getValue(); },
	get plainText() { return editor!.getPlainText(); },
	get errors() { return [...errors]; },
	mode(value: DocsEditorMode) { editor!.setMode(value); },
	readOnly(value: boolean) { editor!.setReadOnly(value); },
	external(source: string) { model!.setValue(source); },
};
declare global { interface Window { arkdownFixture: typeof fixture; } }
window.arkdownFixture = fixture;
document.getElementById('bold')!.onclick = () => editor!.format('**');
document.body.dataset.ready = 'true';
