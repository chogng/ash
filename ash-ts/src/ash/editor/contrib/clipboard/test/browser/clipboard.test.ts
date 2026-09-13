import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService, type IClipboardService as IClipboardServiceContract } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ICodeEditorService } from '../../../../browser/services/codeEditorService.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	navigator: { userAgent: environment.window.navigator.userAgent, clipboard: {} },
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	Event: environment.window.Event,
	InputEvent: environment.window.InputEvent,
	KeyboardEvent: environment.window.KeyboardEvent,
	MouseEvent: environment.window.MouseEvent,
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createEditorBrowserServices } = await import('../../../../browser/services/contribution.js');
const { CopyAction, CutAction, PasteAction } = await import('../../browser/clipboard.js');
assert.ok(CopyAction);
assert.ok(CutAction);
assert.ok(PasteAction);

suiteTeardown(() => environment.window.close());

test('clipboard actions use the focused code editor and platform clipboard service', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha beta');
	using services = new ServiceContainer();
	using contextKeys = new ContextKeyService();
	const browserServices = createEditorBrowserServices();
	const clipboard = new MemoryClipboardService();
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IClipboardService, clipboard);
	services.registerInstance(ICodeEditorService, browserServices.codeEditorService);
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
		codeEditorService: browserServices.codeEditorService,
	});
	editor.focus();
	editor.setSelection(new Selection(1, 1, 1, 6));
	await CopyAction.runCommand(services, undefined);
	assert.equal(clipboard.text, 'alpha');

	clipboard.text = 'omega';
	await PasteAction.runCommand(services, undefined);
	assert.equal(model.getText(), 'omega beta');

	editor.setSelection(new Selection(1, 1, 1, 6));
	await CutAction.runCommand(services, undefined);
	assert.equal(clipboard.text, 'omega');
	assert.equal(model.getText(), ' beta');
	dom.window.close();
});

test('clipboard actions contribute the standard editor and simple-editor menu commands', () => {
	for (const menuId of [MenuId.EditorContext, MenuId.SimpleEditorContext]) {
		const commandIds = MenusRegistry.getMenuItems(menuId)
			.filter(item => 'command' in item)
			.map(item => item.command.id);
		assert.equal(commandIds.includes(CutAction.id), true);
		assert.equal(commandIds.includes(CopyAction.id), true);
		assert.equal(commandIds.includes(PasteAction.id), true);
	}
});

class MemoryClipboardService implements IClipboardServiceContract {
	text = '';
	async readText(): Promise<string> { return this.text; }
	async writeText(value: string): Promise<void> { this.text = value; }
}
