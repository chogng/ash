import './viewCursors.css';
import { h, WindowIntervalTimer } from '../../../../base/browser/dom.js';
import { FastDomNode, createFastDomNode } from '../../../../base/browser/fastDomNode.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { TimeoutTimer } from '../../../../base/common/async.js';
import { EditorOption, TextEditorCursorBlinkingStyle, TextEditorCursorStyle } from '../../../common/config/editorOptions.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { type Selection } from '../../../common/core/selection.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type IViewModel } from '../../../common/viewModel.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type SemanticTokenSource } from '../../../common/tokens/languageTokens.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { CursorPlurality, ViewCursor, type IViewCursorRenderData, type ViewCursorOptions } from './viewCursor.js';
import * as viewEvents from '../../../common/viewEvents.js';

export interface ViewCursorsOptions extends ViewCursorOptions {
	readonly host: HTMLElement;
	readonly semanticTokenSource?: SemanticTokenSource;
}

/** Coordinates active cursors, movement animation, and input composition presentation. */
export class ViewCursors extends ViewPart {
	static readonly BLINK_INTERVAL = 500;

	private readonly domNode: HTMLElement;
	private readonly fastDomNode: FastDomNode<HTMLElement>;
	private readonly model: TextModel;
	private readonly viewModel: IViewModel;
	private readonly semanticTokenSource: SemanticTokenSource | undefined;
	private readonly cursorOptions: ViewCursorOptions;
	private readonly cursors: ViewCursor[] = [];
	private readOnly: boolean;
	private cursorBlinking: TextEditorCursorBlinkingStyle;
	private cursorStyle: TextEditorCursorStyle;
	private cursorSmoothCaretAnimation: 'off' | 'explicit' | 'on';
	private editContextEnabled: boolean;
	private selectionIsEmpty: boolean;
	private isComposingInput = false;
	private isVisible = false;
	private blinkingEnabled = false;
	private editorHasFocus = false;
	private readonly startCursorBlinkAnimation: TimeoutTimer;
	private readonly cursorFlatBlinkInterval: WindowIntervalTimer;
	private pauseMovementAnimation = true;
	private movementRenderGeneration = 0;
	private renderData: IViewCursorRenderData[] = [];

	constructor(context: ViewContext, options: ViewCursorsOptions, model: TextModel, viewModel: IViewModel) {
		super(context);
		const configuration = context.configuration.options;
		this.readOnly = configuration.get(EditorOption.readOnly);
		this.cursorBlinking = configuration.get(EditorOption.cursorBlinking);
		this.cursorStyle = configuration.get(EditorOption.effectiveCursorStyle);
		this.cursorSmoothCaretAnimation = configuration.get(EditorOption.cursorSmoothCaretAnimation);
		this.editContextEnabled = configuration.get(EditorOption.effectiveEditContext);
		const selections = viewModel.getCursorStates().map(state => state.viewState.selection);
		this.selectionIsEmpty = selections[0]?.isEmpty() ?? true;
		this.domNode = h(options.host.ownerDocument, 'div');
		this.fastDomNode = createFastDomNode(this.domNode);
		this.domNode.setAttribute('role', 'presentation');
		this.domNode.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => this.domNode.remove()));
		this.model = model;
		this.viewModel = viewModel;
		this.semanticTokenSource = options.semanticTokenSource;
		this.cursorOptions = options;
		this.startCursorBlinkAnimation = this._register(new TimeoutTimer());
		this.cursorFlatBlinkInterval = this._register(new WindowIntervalTimer(this.domNode));
		this.reconcileCursors(selections, true);
		this.updateDomClassName();
		this.updateBlinking();
		this._register(toDisposable(() => {
			this.cursors.splice(0);
		}));
	}

	public override dispose(): void {
		super.dispose();
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this.fastDomNode;
	}

	public override prepareRender(context: RenderingContext): void {
		for (const cursor of this.cursors) cursor.prepareRender(context);
	}

	public render(context: RenderingContext): void {
		this.renderData = [];
		for (const cursor of this.cursors) {
			const renderData = cursor.render(context);
			if (renderData) this.renderData.push(renderData);
		}
	}

	public getLastRenderData(): IViewCursorRenderData[] {
		return this.renderData;
	}

	private resetMovementAnimation(): void {
		for (const animation of this.domNode.getAnimations?.() ?? []) animation.currentTime = 0;
		const generation = ++this.movementRenderGeneration;
		queueMicrotask(() => {
			if (generation === this.movementRenderGeneration) this.pauseMovementAnimation = true;
		});
	}

	private reconcileCursors(selections: readonly Selection[], pauseMovementAnimation: boolean): void {
		const selectionCount = selections.length;
		while (this.cursors.length < selectionCount) {
			const selectionIndex = this.cursors.length;
			this.cursors.push(new ViewCursor(
				this._context,
				this.domNode,
				selectionIndex,
				this.cursorOptions,
				this.model,
				this.semanticTokenSource,
				cursorPlurality(selectionIndex, selectionCount, 0),
			));
		}
		while (this.cursors.length > selectionCount) this.cursors.pop()!.getDomNode().domNode.remove();
		this.updateCursorPositions(selections, pauseMovementAnimation);
	}

	private updateCursorPositions(selections: readonly Selection[], pauseMovementAnimation: boolean): void {
		for (let selectionIndex = 0; selectionIndex < this.cursors.length; selectionIndex += 1) {
			const plurality = cursorPlurality(selectionIndex, this.cursors.length, 0);
			const cursor = this.cursors[selectionIndex]!;
			cursor.setPlurality(plurality);
			cursor.onCursorPositionChanged(selections[selectionIndex]!.getPosition(), pauseMovementAnimation);
		}
	}

	private shouldAnimateMovement(reason: CursorChangeReason, selectionCount: number): boolean {
		if (this.cursorSmoothCaretAnimation === 'off' || selectionCount !== this.cursors.length) return false;
		if (this.cursorSmoothCaretAnimation === 'on') return true;
		return reason === CursorChangeReason.Explicit;
	}

	public override onCompositionStart(_event: viewEvents.ViewCompositionStartEvent): boolean {
		this.isComposingInput = true;
		this.updateBlinking();
		return true;
	}

	public override onCompositionEnd(_event: viewEvents.ViewCompositionEndEvent): boolean {
		this.isComposingInput = false;
		this.updateBlinking();
		return true;
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		this.readOnly = options.get(EditorOption.readOnly);
		this.cursorBlinking = options.get(EditorOption.cursorBlinking);
		this.cursorStyle = options.get(EditorOption.effectiveCursorStyle);
		this.cursorSmoothCaretAnimation = options.get(EditorOption.cursorSmoothCaretAnimation);
		this.editContextEnabled = options.get(EditorOption.effectiveEditContext);
		for (const cursor of this.cursors) cursor.onConfigurationChanged(event);
		this.updateBlinking();
		this.updateDomClassName();
		return true;
	}

	public override onCursorStateChanged(event: viewEvents.ViewCursorStateChangedEvent): boolean {
		this.pauseMovementAnimation = !this.shouldAnimateMovement(event.reason, event.selections.length);
		this.reconcileCursors(event.selections, this.pauseMovementAnimation);
		this.selectionIsEmpty = event.selections[0]?.isEmpty() ?? true;
		this.updateBlinking();
		this.updateDomClassName();
		this.resetMovementAnimation();
		return true;
	}

	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onFocusChanged(event: viewEvents.ViewFocusChangedEvent): boolean {
		this.editorHasFocus = event.isFocused;
		this.updateBlinking();
		return false;
	}
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(_event: viewEvents.ViewScrollChangedEvent): boolean { return true; }
	public override onTokensChanged(event: viewEvents.ViewTokensChangedEvent): boolean {
		return this.cursors.some(cursor => event.ranges.some(range => range.fromLineNumber <= cursor.getPosition().lineNumber && cursor.getPosition().lineNumber <= range.toLineNumber));
	}
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	private getCursorBlinking(): TextEditorCursorBlinkingStyle {
		if (this.isComposingInput && !this.editContextEnabled) return TextEditorCursorBlinkingStyle.Hidden;
		if (!this.editorHasFocus) return TextEditorCursorBlinkingStyle.Hidden;
		if (this.readOnly) return TextEditorCursorBlinkingStyle.Solid;
		return this.cursorBlinking;
	}

	private updateBlinking(): void {
		this.startCursorBlinkAnimation.cancel();
		this.cursorFlatBlinkInterval.cancel();
		const blinking = this.getCursorBlinking();
		const hidden = blinking === TextEditorCursorBlinkingStyle.Hidden;
		const solid = blinking === TextEditorCursorBlinkingStyle.Solid;
		if (hidden) this.hide();
		else this.show();
		this.blinkingEnabled = false;
		this.updateDomClassName();
		if (hidden || solid) return;
		if (blinking === TextEditorCursorBlinkingStyle.Blink) {
			this.cursorFlatBlinkInterval.cancelAndSet(() => this.isVisible ? this.hide() : this.show(), ViewCursors.BLINK_INTERVAL);
			return;
		}
		this.startCursorBlinkAnimation.setIfNotSet(() => {
			this.blinkingEnabled = true;
			this.updateDomClassName();
		}, ViewCursors.BLINK_INTERVAL);
	}

	private updateDomClassName(): void {
		const classes = ['cursors-layer', 'stanza-editor-cursors-layer'];
		if (!this.selectionIsEmpty) classes.push('has-selection');
		classes.push(cursorStyleClass(this.cursorStyle));
		classes.push(this.blinkingEnabled ? cursorBlinkingClass(this.getCursorBlinking()) : 'cursor-solid');
		if (this.cursorSmoothCaretAnimation !== 'off') classes.push('cursor-smooth-caret-animation');
		this.fastDomNode.setClassName(classes.join(' '));
	}

	private show(): void {
		for (const cursor of this.cursors) cursor.show();
		this.isVisible = true;
	}

	private hide(): void {
		for (const cursor of this.cursors) cursor.hide();
		this.isVisible = false;
	}
}

function cursorPlurality(selectionIndex: number, selectionCount: number, primaryIndex: number): CursorPlurality {
	if (selectionCount === 1) return CursorPlurality.Single;
	return selectionIndex === primaryIndex ? CursorPlurality.MultiPrimary : CursorPlurality.MultiSecondary;
}

function cursorBlinkingClass(blinking: TextEditorCursorBlinkingStyle): string {
	switch (blinking) {
		case TextEditorCursorBlinkingStyle.Smooth: return 'cursor-smooth';
		case TextEditorCursorBlinkingStyle.Phase: return 'cursor-phase';
		case TextEditorCursorBlinkingStyle.Expand: return 'cursor-expand';
		case TextEditorCursorBlinkingStyle.Blink: return 'cursor-blink';
		default: return 'cursor-solid';
	}
}

function cursorStyleClass(style: TextEditorCursorStyle): string {
	switch (style) {
		case TextEditorCursorStyle.Block: return 'cursor-block-style';
		case TextEditorCursorStyle.Underline: return 'cursor-underline-style';
		case TextEditorCursorStyle.LineThin: return 'cursor-line-thin-style';
		case TextEditorCursorStyle.BlockOutline: return 'cursor-block-outline-style';
		case TextEditorCursorStyle.UnderlineThin: return 'cursor-underline-thin-style';
		default: return 'cursor-line-style';
	}
}
