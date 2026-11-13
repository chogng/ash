import './chatFixtureLocalization.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { loadArkdown } from '../../../src/ash/workbench/contrib/markdown/browser/arkdown.js';
import { ArkdownEditor, type ArkdownEditorMode } from '../../../src/ash/workbench/contrib/markdown/browser/arkdownEditor.js';

const services = createTestEditorServices();
registerCodeEditorServices(services);
window.addEventListener('pagehide', () => { editor?.dispose(); model?.dispose(); services.dispose(); }, { once: true });

let model: TextModel | undefined;
let editor: ArkdownEditor | undefined;
const errors: string[] = [];
const fixture = {
	async mount(source: string, mode: ArkdownEditorMode = 'rich') {
		editor?.dispose(); model?.dispose(); errors.length = 0;
		const runtime = await loadArkdown();
		model = new TextModel(source);
		editor = services.createInstance(ArkdownEditor, document.getElementById('root')!, model, runtime, mode, (error: unknown) => errors.push(String(error)), () => {});
		editor.focus();
	},
	get source() { return model!.getValue(); },
	get plainText() { return editor!.getPlainText(); },
	get errors() { return [...errors]; },
	mode(value: ArkdownEditorMode) { editor!.setMode(value); },
	readOnly(value: boolean) { editor!.setReadOnly(value); },
	external(source: string) { model!.setValue(source); },
};
declare global { interface Window { arkdownFixture: typeof fixture; } }
window.arkdownFixture = fixture;
document.getElementById('bold')!.onclick = () => editor!.format('**');
document.body.dataset.ready = 'true';
