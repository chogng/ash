import { TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';

import { MouseTargetType, type ICodeEditor, type IEditorMouseEvent } from '../../../../../editor/browser/editorBrowser.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { type IDebugBreakpoint, type IDebugService } from '../../common/debug.js';
import { BreakpointEditorContribution } from '../../browser/breakpointEditorContribution.js';
import { GlyphMarginLane } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';

test('Breakpoint editor contribution projects semantic glyph-margin decorations', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editorNode = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editorNode);
	const resource = URI.file('C:\\project\\main.ts');
	using model = new TextModel('first\nsecond\nthird', { resource });
	using debug = new BreakpointDebugService(resource);
	using mouseDown = new Emitter<IEditorMouseEvent>();
	using extensions = new TestExtensionService();
	using configuration = new TestConfigurationService();
	using context = new ContextKeyService();
	using instantiation = new InstantiationService(new ServiceCollection());
	using contribution = new BreakpointEditorContribution(
		{
			focus: () => editorNode.focus(),
			getDomNode: () => editorNode,
			onMouseDown: mouseDown.event,
			onMouseMove: Event.None,
			onMouseLeave: Event.None,
			onDidScrollChange: Event.None,
			onContextMenu: Event.None,
		} as unknown as ICodeEditor,
		model,
		debug as unknown as IDebugService,
		extensions,
		configuration,
		context,
		instantiation,
		{} as IContextMenuService,
		{} as INotificationService,
		{} as IQuickInputService,
	);

	assert.deepEqual(decorationState(model), [
		{
			lineNumber: 2,
			lane: GlyphMarginLane.Left,
			persistLane: true,
			className: 'ash-debug-breakpoint-gutter enabled verified',
		},
	]);

	debug.setBreakpoints([{ id: 'second', resource, lineNumber: 3, enabled: false, verified: false }]);
	assert.deepEqual(decorationState(model), [
		{
			lineNumber: 3,
			lane: GlyphMarginLane.Left,
			persistLane: true,
			className: 'ash-debug-breakpoint-gutter disabled unverified',
		},
	]);
	debug.setBreakpoints([
		{ id: 'condition', resource, lineNumber: 2, enabled: true, verified: true, condition: 'counter > 0' },
		{ id: 'log', resource, lineNumber: 3, enabled: true, verified: true, logMessage: 'counter={counter}' },
	]);
	assert.deepEqual(decorationState(model), [
		{
			lineNumber: 2,
			lane: GlyphMarginLane.Left,
			persistLane: true,
			className: 'ash-debug-breakpoint-gutter enabled verified conditional',
		},
		{
			lineNumber: 3,
			lane: GlyphMarginLane.Left,
			persistLane: true,
			className: 'ash-debug-breakpoint-gutter enabled verified logpoint',
		},
	]);
	dom.window.close();
});

test('Debug breakpoint controller consumes the public glyph-margin mouse target', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const editorNode = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(editorNode);
	const resource = URI.file('/project/main.ts');
	using model = new TextModel('first\nsecond', { resource });
	using debug = new BreakpointDebugService(resource);
	using mouseDown = new Emitter<IEditorMouseEvent>();
	using extensions = new TestExtensionService();
	using configuration = new TestConfigurationService();
	using context = new ContextKeyService();
	using instantiation = new InstantiationService(new ServiceCollection());
	editorNode.getBoundingClientRect = () => ({
		left: 0,
		top: 0,
		right: 100,
		bottom: 100,
		width: 100,
		height: 100,
		x: 0,
		y: 0,
		toJSON() {
			return {};
		},
	});
	using contribution = new BreakpointEditorContribution(
		{
			focus: () => editorNode.focus(),
			getDomNode: () => editorNode,
			onMouseDown: mouseDown.event,
			onMouseMove: Event.None,
			onMouseLeave: Event.None,
			onDidScrollChange: Event.None,
			onContextMenu: Event.None,
		} as unknown as ICodeEditor,
		model,
		debug as unknown as IDebugService,
		extensions,
		configuration,
		context,
		instantiation,
		{} as IContextMenuService,
		{} as INotificationService,
		{} as IQuickInputService,
	);
	const browserEvent = new dom.window.MouseEvent('pointerdown', {
		bubbles: true,
		cancelable: true,
		button: 0,
		buttons: 1,
	});
	mouseDown.fire({
		event: new StandardMouseEvent(browserEvent as unknown as MouseEvent),
		target: {
			type: MouseTargetType.GUTTER_GLYPH_MARGIN,
			element: editorNode,
			mouseColumn: 1,
			position: new Position(2, 1),
			range: Range.fromPositions(new Position(2, 1)),
			detail: {
				isAfterLines: false,
				glyphMarginLeft: 0,
				glyphMarginWidth: 20,
				glyphMarginLane: GlyphMarginLane.Left,
				lineNumbersWidth: 0,
				offsetX: 4,
			},
		},
	});
	dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { button: 0, clientX: 4, clientY: 10 }));
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
