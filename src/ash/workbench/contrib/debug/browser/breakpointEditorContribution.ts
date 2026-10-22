import { canSetBreakpointsIn } from '../common/breakpoints.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import './media/debug.contribution.css';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { MouseTargetType, type ICodeEditor, type IEditorMouseEvent } from '../../../../editor/browser/editorBrowser.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextDecorationCollection, TextDecorationChangeReason, type TextDecorationId } from '../../../../editor/common/model/decorationCollection.js';
import { GlyphMarginLane, TrackedRangeStickiness, type ITextModel } from '../../../../editor/common/model.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { BreakpointWidgetContext, type IBreakpointUpdateData, type IDebugBreakpoint, IDebugService } from '../common/debug.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { BreakpointWidget } from './breakpointWidget.js';

/** Owns breakpoint decorations and gutter interaction for one text editor. */
export class BreakpointEditorContribution extends Disposable {
	private readonly decorations;
	private decorationIds: readonly TextDecorationId[] = Object.freeze([]);
	private readonly hint;
	private hintLine: number | undefined;
	private hintIsMove = false;
	private readonly widget = this._register(new MutableDisposable<BreakpointWidget>());
	private readonly gestureListeners = this._register(new DisposableStore());
	private gesture: { readonly ids: readonly string[]; readonly lineNumber: number; readonly x: number; readonly y: number; readonly shift: boolean; moved: boolean; targetLine?: number; } | undefined;

	constructor(private readonly editor: ICodeEditor, model: TextModel, @IDebugService private readonly debugService: IDebugService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService private readonly context: IContextKeyService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@IQuickInputService private readonly quickInput: IQuickInputService) {
		super();
		const resource = model.uri;
		this.decorations = this._register(new TextDecorationCollection<IDebugBreakpoint>(model));
		this.hint = this._register(new TextDecorationCollection<undefined>(model));
		if (resource.scheme !== 'file' && !isRemoteResource(resource)) return;
		this.updateDecorations();
		this._register(debugService.onDidChangeBreakpoints(() => { this.setHint(undefined); this.updateDecorations(); }));
		this._register(editor.onMouseMove(event => {
			const target = event.target;
			if (this.gesture) { this.moveGesture(event); return; }
			const eligible = (target.type === MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === MouseTargetType.GUTTER_LINE_NUMBERS)
				&& !target.detail.isAfterLines && !event.event.buttons
				&& this.canSetBreakpoints()
				&& this.marginIsAvailable(target.position.lineNumber, target.type === MouseTargetType.GUTTER_GLYPH_MARGIN ? target.detail.glyphMarginLane : undefined);
			this.setHint(eligible ? target.position!.lineNumber : undefined);
		}));
		this._register(editor.onMouseLeave(() => { this.setHint(undefined); if (this.gesture) this.gesture.targetLine = undefined; }));
		this._register(editor.onDidScrollChange(() => this.setHint(undefined)));
		this._register(model.onDidChangeContent(() => { this.cancelGesture(); this.setHint(undefined); }));
		this._register(model.onDidChangeLanguage(() => this.setHint(undefined)));
		this._register(editor.onMouseDown(event => this.beginGesture(event)));
		this._register(editor.onContextMenu(event => {
			const target = event.target;
			if ((target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN && target.type !== MouseTargetType.GUTTER_LINE_NUMBERS)
				|| target.detail.isAfterLines || !this.marginIsAvailable(target.position.lineNumber, target.detail.glyphMarginLane)) return;
			const actions = this.getContextMenuActionsAtPosition(target.position.lineNumber, model);
			if (!actions.length) return;
			event.event.preventDefault(); event.event.stopPropagation();
			this.cancelGesture(); this.setHint(undefined);
			this.contextMenus.showContextMenu({
				getAnchor: () => ({ x: event.event.clientX, y: event.event.clientY, targetWindow: editor.getDomNode()!.ownerDocument.defaultView! }),
				getActions: () => actions, autoSelectFirstItem: true,
				onHide: () => { if (!this.widget.value) editor.focus(); },
			});
		}));
		this._register(this.decorations.onDidChange(event => {
			if (event.reason !== TextDecorationChangeReason.Range) return;
			const updates = new Map<string, IBreakpointUpdateData>();
			for (const decoration of event.decorations) {
				const point = debugService.breakpoints.find(point => point.id === decoration.metadata.id);
				if (!point) continue;
				const lineNumber = decoration.range.startLineNumber;
				const column = point.columnNumber === undefined ? undefined : decoration.range.startColumn;
				if (point.lineNumber !== lineNumber || point.columnNumber !== column) updates.set(point.id, { lineNumber, column });
			}
			if (updates.size) void debugService.updateBreakpoints(resource, updates, true).catch(error => this.notifications.error(error));
		}));
	}

	private canSetBreakpoints(): boolean {
		if (this.isDisposed) return false;
		const model = this.decorations.textModel;
		return (model.uri.scheme === 'file' || isRemoteResource(model.uri)) && canSetBreakpointsIn(model.getLanguageId(), this.extensions, this.configuration, this.context);
	}

	private pointsAt(lineNumber: number): readonly IDebugBreakpoint[] {
		return this.debugService.breakpoints.filter(point => point.resource.toString() === this.decorations.textModel.uri.toString() && point.lineNumber === lineNumber);
	}

	public showBreakpointWidget(lineNumber: number, column: number | undefined, context?: BreakpointWidgetContext): void {
		if (this.isDisposed || this.decorations.textModel.isDisposed()) return;
		if (!this.canSetBreakpoints() && !this.pointsAt(lineNumber).length) return;
		this.closeBreakpointWidget();
		this.widget.value = this.instantiation.createInstance(BreakpointWidget, this.editor, lineNumber, column, context, () => this.closeBreakpointWidget());
	}

	public closeBreakpointWidget(): void { this.widget.clear(); this.editor.focus(); }

	public getContextMenuActionsAtPosition(lineNumber: number, model: ITextModel): IAction[] {
		if (model !== this.decorations.textModel) return [];
		const points = this.pointsAt(lineNumber);
		if (!points.length) return this.canSetBreakpoints() ? [
			breakpointAction({ id: 'addBreakpoint', label: localize('debug.addSourceBreakpoint', 'Add Breakpoint'), run: async () => this.debugService.toggleBreakpoint(model.uri, lineNumber) }),
			breakpointAction({ id: 'addConditionalBreakpoint', label: localize('debug.addConditionalBreakpoint', 'Add Conditional Breakpoint...'), run: async () => this.showBreakpointWidget(lineNumber, undefined, BreakpointWidgetContext.CONDITION) }),
			breakpointAction({ id: 'addLogPoint', label: localize('debug.addLogpoint', 'Add Logpoint...'), run: async () => this.showBreakpointWidget(lineNumber, undefined, BreakpointWidgetContext.LOG_MESSAGE) }),
		] : [];
		const actionsFor = (point: IDebugBreakpoint): IAction[] => [
			breakpointAction({ id: 'debug.removeBreakpoint', label: localize('debug.removeBreakpoint', 'Remove breakpoint'), run: async () => this.debugService.removeBreakpoint(point.id) }),
			breakpointAction({
				id: 'workbench.debug.action.editBreakpointAction', label: localize('debug.editBreakpointMenu', 'Edit Breakpoint...'), run: async () => {
					const current = this.debugService.breakpoints.find(candidate => candidate.id === point.id);
					if (current) this.showBreakpointWidget(current.lineNumber, current.columnNumber);
				}
			}),
			breakpointAction({ id: 'workbench.debug.viewlet.action.toggleBreakpoint', label: point.enabled ? localize('debug.disableBreakpoint', 'Disable Breakpoint') : localize('debug.enableBreakpointMenu', 'Enable Breakpoint'), run: async () => this.debugService.updateBreakpoint(point.id, { enabled: !point.enabled }) }),
			breakpointAction({
				id: 'debug.moveBreakpoint', label: localize('debug.moveBreakpoint', 'Move Breakpoint...'), run: async () => {
					const value = await this.quickInput.input({
						title: localize('debug.moveBreakpoint', 'Move Breakpoint...'), value: String(point.lineNumber),
						placeHolder: localize('debug.breakpointTargetLine', 'Enter a source line number'),
						validateInput: async value => this.validTargetLine(value) ? undefined : localize('debug.invalidBreakpointLine', 'Enter a valid line number in this file.'),
					});
					if (value === undefined || model.isDisposed() || !this.validTargetLine(value)) return;
					await this.debugService.updateBreakpoints(model.uri, new Map([[point.id, { lineNumber: Number(value) }]]), false);
				}
			}),
		];
		return points.length === 1 ? actionsFor(points[0]) : points.map(point => new SubmenuAction(point.id,
			point.columnNumber === undefined ? localize('debug.lineBreakpoint', 'Line breakpoint') : localize('debug.columnBreakpoint', 'Column {0}', point.columnNumber), actionsFor(point)));
	}

	private validTargetLine(value: string): boolean {
		if (this.isDisposed) return false;
		const model = this.decorations.textModel;
		return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= model.lineCount;
	}

	private beginGesture(event: IEditorMouseEvent): void {
		this.setHint(undefined);
		const target = event.target;
		if (!event.event.leftButton || isMacintosh && event.event.ctrlKey
			|| target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || target.detail.isAfterLines
			|| !this.marginIsAvailable(target.position.lineNumber, target.detail.glyphMarginLane)) return;
		const points = this.pointsAt(target.position.lineNumber);
		if (!points.length && !this.canSetBreakpoints()) return;
		event.event.preventDefault(); event.event.stopPropagation();
		if (event.event.altKey) { this.showBreakpointWidget(target.position.lineNumber, points[0]?.columnNumber); return; }
		this.cancelGesture();
		this.editor.focus();
		this.gesture = { ids: points.map(point => point.id), lineNumber: target.position.lineNumber, x: event.event.clientX, y: event.event.clientY, shift: event.event.shiftKey, moved: false, targetLine: target.position.lineNumber };
		const ownerWindow = this.editor.getDomNode()!.ownerDocument.defaultView!;
		this.gestureListeners.add(addDisposableListener(ownerWindow, 'pointerup', event => this.finishGesture(event)));
		this.gestureListeners.add(addDisposableListener(ownerWindow, 'pointercancel', () => this.cancelGesture()));
		this.gestureListeners.add(addDisposableListener(ownerWindow, 'blur', () => this.cancelGesture()));
		this.gestureListeners.add(addDisposableListener(ownerWindow, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancelGesture(); }
		}, true));
	}

	private moveGesture(event: IEditorMouseEvent): void {
		const gesture = this.gesture!;
		gesture.moved ||= Math.hypot(event.event.clientX - gesture.x, event.event.clientY - gesture.y) >= 4;
		const target = event.target;
		gesture.targetLine = target.type === MouseTargetType.GUTTER_GLYPH_MARGIN && !target.detail.isAfterLines
			&& this.marginIsAvailable(target.position.lineNumber, target.detail.glyphMarginLane) ? target.position.lineNumber : undefined;
		if (gesture.moved && gesture.ids.length) this.setHint(gesture.targetLine, true);
	}

	private finishGesture(event: PointerEvent): void {
		const gesture = this.gesture;
		if (!gesture || event.button !== 0) return;
		const bounds = this.editor.getDomNode()!.getBoundingClientRect();
		this.cancelGesture();
		if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom || gesture.targetLine === undefined) return;
		const points = this.debugService.breakpoints.filter(point => gesture.ids.includes(point.id));
		if (gesture.moved) {
			if (gesture.targetLine === gesture.lineNumber || !points.length || this.pointsAt(gesture.targetLine).length) return;
			void this.debugService.updateBreakpoints(this.decorations.textModel.uri, new Map(points.map(point => [point.id, { lineNumber: gesture.targetLine }])), false).catch(error => this.notifications.error(error));
		} else if (points.length && (gesture.shift || !points.some(point => point.enabled))) {
			const enabled = !points.some(point => point.enabled);
			for (const point of points) this.debugService.updateBreakpoint(point.id, { enabled });
		} else {
			this.debugService.toggleBreakpoint(this.decorations.textModel.uri, gesture.lineNumber);
		}
	}

	private cancelGesture(): void { this.gesture = undefined; this.gestureListeners.clear(); this.setHint(undefined); }

	private marginIsAvailable(lineNumber: number, lane?: GlyphMarginLane): boolean {
		return !this.decorations.textModel.getLineDecorations(lineNumber).some(decoration => {
			if (!decoration.options.glyphMarginClassName || decoration.options.description?.startsWith('debug-')) return false;
			return lane === undefined || (decoration.options.glyphMargin?.position ?? GlyphMarginLane.Center) === lane;
		});
	}

	private setHint(lineNumber: number | undefined, move = false): void {
		if (lineNumber !== undefined && this.debugService.breakpoints.some(breakpoint => breakpoint.resource.toString() === this.decorations.textModel.uri.toString() && breakpoint.lineNumber === lineNumber)) lineNumber = undefined;
		if (this.hintLine === lineNumber && this.hintIsMove === move) return;
		this.hintLine = lineNumber;
		this.hintIsMove = move;
		this.hint.replaceAll(lineNumber === undefined ? [] : [{
			range: Range.fromPositions(new Position(lineNumber, 1)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: {
				description: 'debug-breakpoint-hint', glyphMarginClassName: 'ash-debug-breakpoint-gutter hint',
				glyphMargin: { position: GlyphMarginLane.Left },
				glyphMarginHoverMessage: { value: move ? localize('debug.breakpointMoveHint', 'Move breakpoint to line {0}', lineNumber) : localize('debug.breakpointHint', 'Click to add a breakpoint') }, zIndex: 1,
			},
			metadata: undefined,
		}]);
	}

	private updateDecorations(): void {
		const model = this.decorations.textModel;
		const resource = model.uri;
		const breakpoints = this.debugService.breakpoints.filter(candidate =>
			candidate.resource.toString() === resource.toString()
			&& candidate.lineNumber >= 1
			&& candidate.lineNumber <= model.lineCount
		);
		this.decorationIds = this.decorations.deltaDecorations(this.decorationIds, breakpoints.map(breakpoint => ({
			range: Range.fromPositions(model.validatePosition(new Position(breakpoint.lineNumber, breakpoint.columnNumber ?? 1))),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: breakpointDecoration(breakpoint),
			metadata: breakpoint,
		})));
	}
}

function breakpointAction(action: Pick<IAction, 'id' | 'label' | 'run'>): IAction {
	return { ...action, tooltip: '', enabled: true };
}

function breakpointDecoration(breakpoint: IDebugBreakpoint) {
	const label = breakpoint.enabled
		? localize('debug.removeBreakpointAtLine', 'Remove breakpoint at line {0}', breakpoint.lineNumber)
		: localize('debug.enableBreakpointAtLine', 'Enable breakpoint at line {0}', breakpoint.lineNumber);
	return {
		description: 'debug-breakpoint',
		glyphMarginClassName: ['ash-debug-breakpoint-gutter', breakpoint.enabled ? 'enabled' : 'disabled', breakpoint.verified ? 'verified' : 'unverified', ...(breakpoint.logMessage ? ['logpoint'] : breakpoint.condition || breakpoint.hitCondition ? ['conditional'] : [])].join(' '),
		glyphMargin: { position: GlyphMarginLane.Left, persistLane: true },
		glyphMarginHoverMessage: { value: [breakpoint.message ?? label, breakpoint.condition, breakpoint.hitCondition, breakpoint.logMessage].filter(Boolean).join('\n') },
		zIndex: 10,
	};
}
