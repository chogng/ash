import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { type IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { Event } from '../../../../../base/common/event.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { type IContextMenuMenuDelegate, type IContextMenuService as IContextMenuServiceContract } from '../../../../../platform/contextview/browser/contextView.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { installEditorTestDom } from '../../../../test/browser/editorTestGlobals.js';

const environment = new JSDOM('<!doctype html><body></body>');
const installedGlobals = installEditorTestDom(environment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent',
], {
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
});

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { ContextMenuController } = await import('../../browser/contextmenu.js');
const { IContextMenuService } = await import('../../../../../platform/contextview/browser/contextView.js');

suiteTeardown(() => {
	installedGlobals.dispose();
	environment.window.close();
});

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
	using editor = createTestCodeEditor({
		container,
		model,
		lineHeight: 20,
		instantiationService: services,
	});
	editor.layout({ width: 400, height: 100 });
	editor.setSelection(Selection.fromPositions(new Position(2, 3)));
	editor.focus();
	const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F10', shiftKey: true });
	editor.controller.element.dispatchEvent(event);

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

test('ContextMenuController opens minimap settings from the scrollbar and closes with the editor', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha\nbeta');
	const requests: Array<IContextMenuDelegate | IContextMenuMenuDelegate> = [];
	let hideCount = 0;
	let onHide: ((didCancel: boolean) => void) | undefined;
	const contextMenuService: IContextMenuServiceContract = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu(request) {
			requests.push(request);
			onHide = request.onHide;
		},
		hideContextMenu() {
			hideCount++;
			onHide?.(true);
		},
	};
	using services = new ServiceContainer();
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextMenuService, contextMenuService);
	using editor = createTestCodeEditor({ container, model, instantiationService: services });
	editor.layout({ width: 400, height: 100 });
	const scrollbar = editor.getDomNode()!.querySelector<HTMLElement>('.ash-scrollbar-track-vertical')!;
	assert.ok(scrollbar);
	scrollbar.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 390, clientY: 20 }));

	const menu = requests.at(-1)! as IContextMenuDelegate;
	assert.equal('getActions' in menu, true);
	const toggle = menu.getActions().find(action => action.id === 'editor.minimap.enabled')!;
	assert.ok(toggle);
	await toggle.run();
	assert.equal(editor.getOption(EditorOption.minimap).enabled, false);
	assert.equal(configuration.getValue('editor.minimap.enabled'), false);

	editor.controller.element.dispatchEvent(new dom.window.WheelEvent('wheel', { bubbles: true, deltaY: 10 }));
	assert.equal(hideCount, 1);
	scrollbar.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 390, clientY: 20 }));
	const disabledMenu = requests.at(-1)! as IContextMenuDelegate;
	for (const id of ['editor.minimap.renderCharacters', 'editor.minimap.size', 'editor.minimap.showSlider', 'editor.minimap.side']) {
		assert.equal(disabledMenu.getActions().find(action => action.id === id)?.enabled, false);
	}
	editor.dispose();
	assert.equal(hideCount, 2);
	dom.window.close();
});
