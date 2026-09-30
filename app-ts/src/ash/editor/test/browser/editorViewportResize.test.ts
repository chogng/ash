import './testEditorDom.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { EditorZoom } from "../../common/config/editorZoom.js";
import { TextModel } from "../../common/model/textModel.js";
import { installEditorTestGlobals } from './editorTestGlobals.js';
import { scheduleAtNextAnimationFrame } from '../../../base/browser/scheduler.js';
import { EditorLineWrapping } from '../../common/config/editorOptions.js';
import { ContentWidgetPositionPreference } from '../../browser/editorBrowser.js';
import { Position } from '../../common/core/position.js';
import { Selection } from '../../common/core/selection.js';

const { TestView: View } = await import("./viewModel/testViewModel.js");

test('resizing publishes geometry immediately and renders the final size in one frame', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('short line\n' + 'long line '.repeat(100));
	using viewport = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false } });
	try {
		viewport.layout({ width: 400, height: 100 });
		viewport.render(true, false);
		const content = requiredElement<HTMLElement>(viewport.domNode.domNode, '.stanza-editor-content');
		const line = requiredElement(viewport.domNode.domNode, '.view-line');
		const mapping = viewport.getVisualLineProjection();
		const initialWidth = content.style.width;

		viewport.layout({ width: 360, height: 100 });
		viewport.layout({ width: 320, height: 100 });
		assert.equal(viewport.viewportLayout.viewportSize.width, 320);
		assert.equal(content.style.width, initialWidth);
		assert.strictEqual(viewport.getVisualLineProjection(), mapping);

		await new Promise<void>(resolve => {
			const frame = scheduleAtNextAnimationFrame(dom.window as unknown as Window, () => {
				frame.dispose();
				resolve();
			}, -1);
		});
		assert.equal(content.style.width, `${viewport.viewportLayout.contentSize.width}px`);
		assert.strictEqual(requiredElement(viewport.domNode.domNode, '.view-line'), line);
		assert.strictEqual(viewport.getVisualLineProjection(), mapping);

		viewport.setLineWrapping(EditorLineWrapping.On);
		assert.notStrictEqual(viewport.getVisualLineProjection(), mapping);
		assert.ok(viewport.getVisualLineProjection().visualLineCount > model.lineCount);
	} finally {
		viewport.dispose();
		dom.window.close();
	}
});

test('same-window editors finish text and widget measurements before writing widget positions', async () => {
	const dom = new JSDOM('<!doctype html><body><main id="first"></main><main id="second"></main></body>', { pretendToBeVisual: true });
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using firstModel = new TextModel('first');
	using secondModel = new TextModel('second');
	using first = new View({ container: requiredElement(dom.window.document, '#first'), model: firstModel, minimap: { enabled: false } });
	using second = new View({ container: requiredElement(dom.window.document, '#second'), model: secondModel, minimap: { enabled: false } });
	const phases: string[] = [];
	const measuredText: string[][] = [];
	const lineWidthSnapshots: string[][] = [];
	try {
		for (const [name, view] of [['first', first], ['second', second]] as const) {
			view.addContentWidget({
				getId: () => name,
				getDomNode: () => dom.window.document.createElement('div'),
				getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
				beforeRender: () => {
					phases.push(`measure ${name}`);
					measuredText.push([first, second].map(editor => requiredElement(editor.domNode.domNode, '.stanza-editor-line-text').textContent ?? ''));
					return { width: 10, height: 10 };
				},
				afterRender: () => { phases.push(`write ${name}`); },
			});
			view.layout({ width: 400, height: 100 });
			view.render(true, false);
		}
		phases.length = 0;
		measuredText.length = 0;
		for (const view of [first, second]) {
			const text = requiredElement(view.domNode.domNode, '.stanza-editor-line-text');
			text.getBoundingClientRect = () => {
				lineWidthSnapshots.push([first, second].map(editor => requiredElement(editor.domNode.domNode, '.stanza-editor-line-text').textContent ?? ''));
				return new dom.window.DOMRect(0, 0, 100, 20);
			};
		}
		firstModel.setValue('first updated');
		secondModel.setValue('second updated');
		first.layout({ width: 360, height: 100 });
		second.layout({ width: 320, height: 100 });
		first.layout({ width: 300, height: 100 });
		await nextEditorFrame(dom.window as unknown as Window);
		assert.deepEqual({ phases, measuredText }, {
			phases: ['measure first', 'measure second', 'write first', 'write second'],
			measuredText: [['first updated', 'second updated'], ['first updated', 'second updated']],
		});
		assert.ok(lineWidthSnapshots.length > 0);
		assert.deepEqual(lineWidthSnapshots, lineWidthSnapshots.map(() => ['first updated', 'second updated']));
	} finally {
		first.dispose();
		second.dispose();
		dom.window.close();
	}
});

test('clean editor parts stay untouched and immediate rendering cancels queued work', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('text');
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false } });
	let measurements = 0;
	try {
		view.addContentWidget({
			getId: () => 'widget',
			getDomNode: () => dom.window.document.createElement('div'),
			getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
			beforeRender: () => { measurements += 1; return { width: 10, height: 10 }; },
		});
		view.layout({ width: 400, height: 100 });
		view.render(true, false);
		measurements = 0;
		view.layout({ width: 300, height: 100 });
		view.render(true, false);
		assert.equal(measurements, 1);
		await nextEditorFrame(dom.window as unknown as Window);
		view.render(false, false);
		await nextEditorFrame(dom.window as unknown as Window);
		assert.equal(measurements, 1);
		view.controller.setSelection(new Selection(1, 2, 1, 2));
		await nextEditorFrame(dom.window as unknown as Window);
		assert.equal(measurements, 1);

		view.render(false, true);
		view.dispose();
		await nextEditorFrame(dom.window as unknown as Window);
		assert.equal(measurements, 1);
	} finally {
		view.dispose();
		dom.window.close();
	}
});

async function nextEditorFrame(targetWindow: Window): Promise<void> {
	await new Promise<void>(resolve => {
		const frame = scheduleAtNextAnimationFrame(targetWindow, () => {
			frame.dispose();
			resolve();
		}, -1);
	});
}

test('rendering one window leaves another window queued until its own frame', () => {
	const firstDom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	const secondDom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	const frames: FrameRequestCallback[][] = [[], []];
	const windows = [firstDom.window, secondDom.window];
	const requestFrames = windows.map(window => window.requestAnimationFrame);
	for (const [index, window] of windows.entries()) {
		window.HTMLCanvasElement.prototype.getContext = () => null;
		window.requestAnimationFrame = callback => frames[index]!.push(callback);
	}
	using firstModel = new TextModel('first');
	using secondModel = new TextModel('second');
	using first = new View({ container: requiredElement(firstDom.window.document, 'main'), model: firstModel, minimap: { enabled: false } });
	using second = new View({ container: requiredElement(secondDom.window.document, 'main'), model: secondModel, minimap: { enabled: false } });
	const measurements = [0, 0];
	try {
		for (const [index, view] of [first, second].entries()) {
			const node = view.domNode.domNode.ownerDocument.createElement('div');
			view.addContentWidget({
				getId: () => 'widget',
				getDomNode: () => node,
				getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
				beforeRender: () => { measurements[index]! += 1; return { width: 10, height: 10 }; },
			});
			view.layout({ width: 300, height: 100 });
		}
		frames[0]!.shift()!(0);
		assert.deepEqual(measurements, [1, 0]);
		frames[1]!.shift()!(0);
		assert.deepEqual(measurements, [1, 1]);
	} finally {
		first.dispose();
		second.dispose();
		for (const [index, window] of windows.entries()) window.requestAnimationFrame = requestFrames[index]!;
		firstDom.window.close();
		secondDom.window.close();
	}
});


test("Stanza viewport automatic layout uses the observed content box", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	let resizeListener: ResizeObserverCallback | undefined;
	class TestResizeObserver {
		constructor(listener: ResizeObserverCallback) {
			resizeListener = listener;
		}

		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
	using installedObserver = installEditorTestGlobals({ ResizeObserver: TestResizeObserver });
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel();
	using viewport = new View({ container, model, lineHeight: 20, automaticLayout: true });
	Object.defineProperties(viewport.domNode.domNode, {
		clientWidth: { configurable: true, value: 383 },
		clientHeight: { configurable: true, value: 62 },
	});

	resizeListener?.([{ contentRect: { width: 383.3875, height: 46.7875 } } as ResizeObserverEntry], {} as ResizeObserver);
	viewport.render(true, false);

	assert.deepEqual(viewport.viewportLayout.viewportSize, { width: 383, height: 46 });
	assert.equal(viewport.domNode.domNode.style.width, "383px");
	assert.equal(viewport.domNode.domNode.style.height, "46px");
	assert.equal(viewport.domNode.domNode.classList.contains("horizontally-scrollable"), false);
	assert.equal(viewport.domNode.domNode.classList.contains("vertically-scrollable"), false);
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="horizontal"]').hidden, true);
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="vertical"]').hidden, true);
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-content").style.width, "383px");
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-content").style.height, "46px");
	dom.window.close();
});

test("Stanza viewport enables scrollbars only for model-backed overflow", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel(`${"x".repeat(100)}\nsecond line`);
	using viewport = new View({ container, model, lineHeight: 20 });

	viewport.layout({ width: 50, height: 20 });
	viewport.render(true, false);

	assert.equal(viewport.domNode.domNode.style.width, "50px");
	assert.equal(viewport.domNode.domNode.style.height, "20px");
	assert.equal(viewport.domNode.domNode.classList.contains("horizontally-scrollable"), true);
	assert.equal(viewport.domNode.domNode.classList.contains("vertically-scrollable"), true);
	const horizontalScrollbar = requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="horizontal"]');
	const verticalScrollbar = requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="vertical"]');
	assert.equal(horizontalScrollbar.hidden, false);
	assert.equal(verticalScrollbar.hidden, false);
	assert.equal(horizontalScrollbar.getAttribute("role"), "scrollbar");
	assert.equal(verticalScrollbar.getAttribute("aria-controls"), requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-content").id);
	assert.equal(horizontalScrollbar.style.height, "12px");
	assert.equal(verticalScrollbar.style.width, "14px");
	assert.equal(horizontalScrollbar.style.right, "14px");
	assert.equal(verticalScrollbar.style.bottom, "12px");
	dom.window.close();
});

test("Stanza viewport applies recomputed font configuration", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("text");
	const viewport = new View({ container, model, lineHeight: 20, minimap: { enabled: false } });
	try {
		EditorZoom.setZoomLevel(1);
		assert.equal(viewport.fontInfo.lineHeight, 22);
		assert.equal(viewport.currentLayout.lineHeight, 22);
		assert.equal(viewport.domNode.domNode.style.lineHeight, "22px");
	} finally {
		viewport.dispose();
		EditorZoom.setZoomLevel(0);
		dom.window.close();
	}
});

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
