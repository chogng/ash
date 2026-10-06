import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../common/editorService.js';
import type { IEditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { type IEditorPartsService as EditorPartsService } from '../../../../browser/parts/editor/editorParts.js';

const environment = new JSDOM('<!doctype html><body></body>');
environment.window.HTMLCanvasElement.prototype.getContext = () => null;
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	Event: environment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
suiteTeardown(() => environment.window.close());

const { createTestCodeEditor } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { IEditorPartsService } = await import('../../../../browser/parts/editor/editorParts.js');
const { CodeEditorService } = await import('../../browser/codeEditorService.js');

test('active code editor follows the pane control when two editors share a model', () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	let control: unknown;
	services.registerInstance(IEditorPartsService, {
		get activePane() { return { getControl: () => control }; },
	} as EditorPartsService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	const service = services.get(ICodeEditorService);
	using model = new TextModel('shared');
	const firstContainer = document.createElement('div');
	const secondContainer = document.createElement('div');
	document.body.append(firstContainer, secondContainer);
	const options = {
		model,
		lineHeight: 20,
		instantiationService: services,
	};
	const first = resources.add(createTestCodeEditor({ ...options, container: firstContainer }));
	const second = resources.add(createTestCodeEditor({ ...options, container: secondContainer }));
	control = first;
	assert.equal(service.getActiveCodeEditor()?.getId(), first.getId());
	control = second;
	assert.equal(service.getActiveCodeEditor()?.getId(), second.getId());
	second.dispose();
	assert.equal(service.getActiveCodeEditor(), null);
	control = first;
	assert.equal(service.getActiveCodeEditor()?.getId(), first.getId());
	control = undefined;
	assert.equal(service.getActiveCodeEditor(), null);
});

test('code editor services require their host and keep registrations within its scope', () => {
	using first = new InstantiationService();
	assert.throws(() => first.createInstance(CodeEditorService), /Unknown service: editorPartsService/);
	using second = new InstantiationService();
	for (const services of [first, second]) {
		services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as EditorPartsService);
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	}
	assert.notEqual(first.get(ICodeEditorService), second.get(ICodeEditorService));
	first.dispose();
	assert.equal(second.get(ICodeEditorService).getActiveCodeEditor(), null);
});

test('code editor resource opening reaches the Workbench group with its selection and focus preferences', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const requests: Array<{ input: IResourceEditorInput; options: EditorOpenOptions; target: EditorOpenTarget; }> = [];
	let control: unknown;
	services.registerInstance(IEditorPartsService, {
		openEditor: async (input: IResourceEditorInput, options: EditorOpenOptions, target: EditorOpenTarget) => {
			requests.push({ input, options, target });
			return { getControl: () => control } as IEditorPane;
		},
	} as unknown as EditorPartsService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	const service = services.get(ICodeEditorService);
	using model = new TextModel('shared');
	const container = document.createElement('div');
	const source = document.createElement('button');
	document.body.append(container, source);
	resources.add(toDisposable(() => { container.remove(); source.remove(); }));
	control = resources.add(createTestCodeEditor({ container, model, instantiationService: services }));
	source.focus();
	const resource = URI.file('/workspace/src/main.ts');
	const editor = await service.openCodeEditor({ resource, options: { pinned: true, preserveFocus: true, selection: { startLineNumber: 12, startColumn: 7, endLineNumber: 13, endColumn: 2 } } }, null, true);
	assert.equal(editor, control);
	assert.equal(requests[0]?.input.resource, resource);
	assert.equal(requests[0]?.target, 'sideGroup');
	assert.deepEqual(requests[0]?.options.selection, new Range(12, 7, 13, 2));
	assert.equal(requests[0]?.options.pinned, true);
	assert.equal(requests[0]?.options.preserveFocus, true);
	assert.equal(requests[0]?.options.selectionSource, TextEditorSelectionSource.NAVIGATION);
	assert.equal(document.activeElement, source);
	await service.openCodeEditor({ resource }, null);
	assert.equal(service.getFocusedCodeEditor(), control);
	assert.equal(requests[1]?.target, 'activeGroup');
});
