import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';

import { MouseTargetType, type IEditorMouseEvent } from '../../../../../editor/browser/editorBrowser.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { type IDebugBreakpoint, type IDebugService } from '../../../../services/debug/common/debugService.js';
import { BreakpointEditorContribution } from '../../browser/breakpointEditorContribution.js';
import { GlyphMarginLane } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';

test('Breakpoint editor contribution projects semantic glyph-margin decorations', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editorNode = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editorNode);
	const resource = URI.file('C:\\project\\main.ts');
	using model = new TextModel('first\nsecond\nthird');
	using debug = new BreakpointDebugService(resource);
	using mouseDown = new Emitter<IEditorMouseEvent>();
	using contribution = new BreakpointEditorContribution(contributionContext(model, resource, editorNode, mouseDown), debug as unknown as IDebugService);

	assert.deepEqual(decorationState(model), [{ lineNumber: 2, lane: GlyphMarginLane.Left, persistLane: true, className: 'ash-debug-breakpoint-gutter enabled verified' }]);

	debug.setBreakpoints([{ id: 'second', resource, lineNumber: 3, enabled: false, verified: false }]);
	assert.deepEqual(decorationState(model), [{ lineNumber: 3, lane: GlyphMarginLane.Left, persistLane: true, className: 'ash-debug-breakpoint-gutter disabled unverified' }]);
	dom.window.close();
});

test('Debug breakpoint controller consumes the public glyph-margin mouse target', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editorNode = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editorNode);
	const resource = URI.file('/project/main.ts');
	using model = new TextModel('first\nsecond');
	using debug = new BreakpointDebugService(resource);
	using mouseDown = new Emitter<IEditorMouseEvent>();
	using contribution = new BreakpointEditorContribution(contributionContext(model, resource, editorNode, mouseDown), debug as unknown as IDebugService);
	const browserEvent = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 });
	mouseDown.fire({
		event: new StandardMouseEvent(browserEvent as unknown as MouseEvent),
		target: {
			type: MouseTargetType.GUTTER_GLYPH_MARGIN,
			element: editorNode,
			mouseColumn: 1,
			position: new Position(2, 1),
			range: Range.fromPositions(new Position(2, 1)),
			detail: { isAfterLines: false, glyphMarginLeft: 0, glyphMarginWidth: 20, glyphMarginLane: GlyphMarginLane.Left, lineNumbersWidth: 0, offsetX: 4 },
		},
	});
	assert.deepEqual(debug.toggled, [{ resource: resource.toString(), lineNumber: 2 }]);
	dom.window.close();
});

function decorationState(model: TextModel): readonly unknown[] {
	return model.getAllDecorations().map(decoration => ({
		lineNumber: decoration.range.getStartPosition().lineNumber,
		lane: decoration.options.glyphMargin?.position,
		persistLane: decoration.options.glyphMargin?.persistLane,
		className: decoration.options.glyphMarginClassName,
	}));
}

function contributionContext(model: TextModel, resource: URI, editorNode: HTMLElement, mouseDown: Emitter<IEditorMouseEvent>) {
	return {
		model,
		options: { input: { resource } },
		editor: { onMouseDown: mouseDown.event },
		viewport: { domNode: { domNode: editorNode } },
	} as never;
}

class BreakpointDebugService extends Disposable {
	private readonly breakpointEmitter = this._register(new Emitter<readonly IDebugBreakpoint[]>());
	public breakpoints: readonly IDebugBreakpoint[];
	public readonly onDidChangeBreakpoints = this.breakpointEmitter.event;
	public readonly toggled: Array<{ readonly resource: string; readonly lineNumber: number }> = [];

	constructor(resource: URI) {
		super();
		this.breakpoints = Object.freeze([{ id: 'first', resource, lineNumber: 2, enabled: true, verified: true }]);
	}

	public setBreakpoints(breakpoints: readonly IDebugBreakpoint[]): void {
		this.breakpoints = Object.freeze([...breakpoints]);
		this.breakpointEmitter.fire(this.breakpoints);
	}

	public toggleBreakpoint(resource: URI, lineNumber: number): void {
		this.toggled.push({ resource: resource.toString(), lineNumber });
	}
}
