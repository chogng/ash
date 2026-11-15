import './chatFixtureLocalization.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { loadArkdown } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownRuntime.js';
import { ArkdownEditor } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownEditor.js';
import type { DocsEditorMode } from '../../../src/ash/sessions/contrib/docs/common/docs.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';

const services = createTestEditorServices();
registerCodeEditorServices(services);
const backgroundEditors = new DisposableStore();
const backgroundEditorLifetimes: DisposableStore[] = [];
window.addEventListener('pagehide', () => { backgroundEditors.dispose(); editor?.dispose(); model?.dispose(); services.dispose(); }, { once: true });

let model: TextModel | undefined;
let editor: ArkdownEditor | undefined;
const errors: string[] = [];
const fixture = {
	async backgroundHighlights(count: number) {
		backgroundEditors.clear();
		backgroundEditorLifetimes.length = 0;
		const runtime = await loadArkdown();
		for (let index = 0; index < count; index++) {
			const lifetime = backgroundEditors.add(new DisposableStore());
			backgroundEditorLifetimes.push(lifetime);
			const parent = document.createElement('div');
			parent.hidden = true;
			document.body.append(parent);
			lifetime.add(toDisposable(() => parent.remove()));
			const model = lifetime.add(new TextModel('Remote shared document'));
			const editor = lifetime.add(services.createInstance(ArkdownEditor, parent, model, runtime, 'rich', (error: unknown) => errors.push(String(error)), () => {}));
			editor.setRemoteChanges(Array.from({ length: 6 }, (_, slot) => ({ id: slot, clientId: String(slot), start: 0, end: 6, inserted: 'Remote', removed: '' })));
		}
	},
	closeBackgroundEditor() { backgroundEditorLifetimes.pop()?.dispose(); },
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
