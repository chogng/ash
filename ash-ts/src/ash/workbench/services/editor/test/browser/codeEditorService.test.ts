import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
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
	const services = resources.add(new ServiceContainer());
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
	using first = new ServiceContainer();
	assert.throws(() => first.createInstance(CodeEditorService), /Unknown service: editorPartsService/);
	using second = new ServiceContainer();
	for (const services of [first, second]) {
		services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as EditorPartsService);
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	}
	assert.notEqual(first.get(ICodeEditorService), second.get(ICodeEditorService));
	first.dispose();
	assert.equal(second.get(ICodeEditorService).getActiveCodeEditor(), null);
});
