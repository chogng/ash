import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../common/core/position.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { MouseTarget } from '../../../browser/controller/mouseTarget.js';
import { DragScrolling, DragScrollingOperation } from '../../../browser/controller/dragScrolling.js';
import { EditorMouseEvent } from '../../../browser/editorDom.js';
import { type IPointerHandlerHelper } from '../../../browser/controller/mouseHandler.js';
import { type MouseTargetFactory } from '../../../browser/controller/mouseTarget.js';
import { type IMouseTarget, type IMouseTargetOutsideEditor } from '../../../browser/editorBrowser.js';
import { type NavigationCommandRevealType } from '../../../browser/coreCommands.js';

test('DragScrolling reuses one operation for pointer updates and stops its frame loop', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const element = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(element);
	const positions: IMouseTargetOutsideEditor[] = [];
	let operationCount = 0;
	let executions = 0;

	class TestOperation extends DragScrollingOperation {
		protected override _execute(): void {
			executions += 1;
			positions.push(this._position);
			this._tick();
		}
	}

	class TestDragScrolling extends DragScrolling {
		protected override _createDragScrollingOperation(position: IMouseTargetOutsideEditor, mouseEvent: EditorMouseEvent): DragScrollingOperation {
			operationCount += 1;
			return new TestOperation(this._context, this._viewHelper, this._mouseTargetFactory, this._dispatchMouse, position, mouseEvent);
		}
	}

	const scrolling = new TestDragScrolling(
		{} as ViewContext,
		{} as IPointerHandlerHelper,
		{} as MouseTargetFactory,
		(_target: IMouseTarget, _inSelectionMode: boolean, _revealType: NavigationCommandRevealType) => {},
	);
	const event = new EditorMouseEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10, view: dom.window as unknown as Window }), true, element);
	const above = MouseTarget.createOutsideEditor(1, new Position(1, 1), 'above', 10);
	const below = MouseTarget.createOutsideEditor(1, new Position(2, 1), 'below', 20);
	scrolling.start(above, event);
	scrolling.start(below, event);
	await delay(dom.window, 25);
	assert.equal(operationCount, 1);
	assert.equal(positions[0], below);
	assert.ok(executions > 0);

	scrolling.stop();
	const stoppedExecutions = executions;
	await delay(dom.window, 25);
	assert.equal(executions, stoppedExecutions);
	scrolling.dispose();
	assert.throws(() => scrolling.start(above, event), /already disposed/);
	dom.window.close();
});

function delay(targetWindow: Pick<Window, 'setTimeout'>, duration: number): Promise<void> {
	return new Promise(resolve => targetWindow.setTimeout(resolve, duration));
}
