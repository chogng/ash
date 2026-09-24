import { JSDOM } from 'jsdom';
import { suiteTeardown } from 'mocha';
import { installEditorTestDom } from './editorTestGlobals.js';

/** Provides the shared DOM constructors required while editor test modules load. */
export const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;

class TestResizeObserver implements ResizeObserver {
	public observe(): void {}
	public unobserve(): void {}
	public disconnect(): void {}
}

const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLCanvasElement',
	'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'NodeFilter',
], {
	PointerEvent: browserEnvironment.window.PointerEvent ?? browserEnvironment.window.MouseEvent,
	ResizeObserver: TestResizeObserver,
});

suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});
