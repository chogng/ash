import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { type IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { Event } from '../../../../../base/common/event.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { type IContextMenuMenuDelegate, type IContextMenuService as IContextMenuServiceContract } from '../../../../../platform/contextview/browser/contextView.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
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
const { ContextMenuController } = await import('../../browser/contextmenu.js');
const { IContextMenuService } = await import('../../../../../platform/contextview/browser/contextView.js');

suiteTeardown(() => environment.window.close());

test('ContextMenuController opens the host menu at the active cursor from Shift+F10', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha\nbeta');
	const requests: Array<IContextMenuDelegate | IContextMenuMenuDelegate> = [];
	const contextMenuService: IContextMenuServiceContract = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: request => { requests.push(request); },
		hideContextMenu() {},
	};
	using services = new ServiceContainer();
	services.registerInstance(IContextMenuService, contextMenuService);
	using editor = new CodeEditorWidget({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
	});
	editor.layout({ width: 400, height: 100 });
	editor.setSelection(Selection.fromPositions(new Position(2, 3)));
	const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F10', shiftKey: true });
	editor.view.element.dispatchEvent(event);

	assert.equal(event.defaultPrevented, true);
	assert.equal(requests.length, 1);
	const request = requests[0]! as IContextMenuMenuDelegate;
	assert.strictEqual(request.menuId, MenuId.EditorContext);
	const anchor = request.getAnchor();
	assert.equal('x' in anchor && Number.isFinite(anchor.x), true);
	assert.equal('y' in anchor && Number.isFinite(anchor.y), true);
	assert.ok(ContextMenuController.get(editor));
	dom.window.close();
});
