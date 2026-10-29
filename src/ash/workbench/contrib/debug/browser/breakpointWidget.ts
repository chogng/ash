import './media/breakpointWidget.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ZoneWidget } from '../../../../editor/contrib/zoneWidget/browser/zoneWidget.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { BreakpointWidgetContext, IDebugService } from '../common/debug.js';

/** Edits one source breakpoint draft in space owned by the editor's ZoneWidget. */
export class BreakpointWidget extends ZoneWidget {
	private readonly values = new Map<BreakpointWidgetContext, string>();
	private readonly breakpointId: string | undefined;
	private readonly resource;
	private input: InputBox<true> | undefined;
	private selector: SelectBox | undefined;
	private help: HTMLElement | undefined;
	private context: BreakpointWidgetContext;
	private heightInRows = 4;
	private saving = false;
	private composing = false;
	private awaitingFocus = true;

	constructor(editor: ICodeEditor, lineNumber: number, private readonly column: number | undefined,
		context: BreakpointWidgetContext | undefined, private readonly close: () => void,
		@IDebugService private readonly debug: IDebugService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService) {
		super(editor, { className: 'ash-breakpoint-widget', showArrow: false, showFrame: true, isAccessible: true, keepEditorSelection: true });
		this.resource = editor.getModel()!.uri;
		const breakpoint = debug.breakpoints.find(point => point.resource.toString() === this.resource.toString()
			&& point.lineNumber === lineNumber && point.columnNumber === column);
		this.breakpointId = breakpoint?.id;
		this.values.set(BreakpointWidgetContext.CONDITION, breakpoint?.condition ?? '');
		this.values.set(BreakpointWidgetContext.HIT_COUNT, breakpoint?.hitCondition ?? '');
		this.values.set(BreakpointWidgetContext.LOG_MESSAGE, breakpoint?.logMessage ?? '');
		this.context = context ?? (breakpoint?.logMessage ? BreakpointWidgetContext.LOG_MESSAGE
			: breakpoint?.hitCondition && !breakpoint.condition ? BreakpointWidgetContext.HIT_COUNT : BreakpointWidgetContext.CONDITION);
		this.create();
		this.show(new Position(lineNumber, column ?? 1), this.heightInRows);
		this._register(debug.onDidChangeBreakpoints(() => {
			if (!this.saving && this.breakpointId && !debug.breakpoints.some(point => point.id === this.breakpointId)) this.close();
		}));
	}

	protected override _fillContainer(container: HTMLElement): void {
		const document = container.ownerDocument;
		const form = h(document, 'form');
		form.className = 'ash-breakpoint-widget-form';
		form.setAttribute('aria-label', localize('debug.breakpointEditor', 'Breakpoint editor'));
		const controls = h(document, 'div');
		controls.className = 'ash-breakpoint-widget-controls';
		form.append(controls);
		const modes = [
			{ value: String(BreakpointWidgetContext.CONDITION), label: localize('debug.breakpointCondition', 'Expression condition') },
			{ value: String(BreakpointWidgetContext.HIT_COUNT), label: localize('debug.breakpointHitCondition', 'Hit count condition') },
			{ value: String(BreakpointWidgetContext.LOG_MESSAGE), label: localize('debug.breakpointLogMessage', 'Log message') },
		];
		this.selector = this._register(new SelectBox(controls, {
			options: modes, selectedValue: String(this.context), presentation: 'field', contextViewProvider: this.contextViews,
			ariaLabel: localize('debug.breakpointType', 'Breakpoint type'),
		}, defaultSelectBoxStyles));
		this.input = this._register(new InputBox(controls, { inputBoxStyles: defaultInputBoxStyles, flexibleHeight: true, presentation: 'field' }));
		this.help = h(document, 'p');
		this.help.className = 'ash-breakpoint-widget-help';
		form.append(this.help);
		const actions = h(document, 'div');
		actions.className = 'ash-breakpoint-widget-actions';
		form.append(actions);
		this._register(new Button(actions, { ...defaultButtonStyles, label: localize('debug.saveBreakpoint', 'Save breakpoint'), type: 'submit', presentation: 'primary' }));
		this._register(new Button(actions, { ...defaultButtonStyles, label: localize('debug.cancelBreakpoint', 'Cancel breakpoint edit'), onClick: () => this.close() }));
		container.append(form);
		const updateField = () => {
			const label = modes.find(mode => Number(mode.value) === this.context)!.label;
			this.input!.value = this.values.get(this.context)!;
			this.input!.inputElement.setAttribute('aria-label', label);
			this.input!.inputElement.placeholder = label;
			this.help!.textContent = this.context === BreakpointWidgetContext.LOG_MESSAGE
				? localize('debug.logpointInputHelp', 'Log a message without stopping. Put expressions in braces, for example: value = {value}. Enter saves; Shift+Enter adds a line; Escape cancels.')
				: this.context === BreakpointWidgetContext.HIT_COUNT
					? localize('debug.hitCountInputHelp', 'Break when the hit count condition is met. Enter saves; Shift+Enter adds a line; Escape cancels.')
					: localize('debug.conditionInputHelp', 'Break when the expression evaluates to true. Enter saves; Shift+Enter adds a line; Escape cancels.');
			const binding = this.keybindings.lookupKeybinding('editor.action.accessibilityHelp');
			const shortcut = binding ? getKeybindingLabel(binding) : undefined;
			const hint = this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Debug) === false ? '' : shortcut
				? localize('debug.breakpointHelpShortcut', 'Press {0} for breakpoint editing help.', shortcut)
				: localize('debug.breakpointHelpHint', 'Open Accessibility Help for breakpoint editing instructions.');
			this.input!.inputElement.setAttribute('aria-description', [this.help!.textContent, hint].filter(Boolean).join(' '));
		};
		this._register(this.input.onDidChange(value => this.values.set(this.context, value)));
		this._register(this.selector.onDidSelect(event => {
			this.context = Number(event.value) as BreakpointWidgetContext;
			updateField();
			this.input!.focus();
		}));
		updateField();
		this._register(this.configuration.onDidChangeConfiguration(() => updateField()));
		this._register(addDisposableListener(form, 'keydown', event => {
			if (event.isComposing || this.composing) return;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
			if (event.key === 'Enter' && !event.shiftKey && event.target === this.input!.inputElement) {
				event.preventDefault(); event.stopPropagation(); void this.save();
			}
		}));
		this._register(addDisposableListener(this.input.inputElement, 'compositionstart', () => { this.composing = true; }));
		this._register(addDisposableListener(this.input.inputElement, 'compositionend', () => { this.composing = false; }));
		this._register(addDisposableListener(form, 'submit', event => { event.preventDefault(); void this.save(); }));
		this._register(observeResize(form, () => {
			const rows = Math.max(4, Math.ceil(form.scrollHeight / this.editor.getOption(EditorOption.lineHeight)) + 1);
			if (rows !== this.heightInRows) { this.heightInRows = rows; this._relayout(rows); }
			// ViewZones attaches cells hidden until its next render. Focus only after
			// the projected form participates in layout, without a timing-based retry.
			if (this.awaitingFocus && form.offsetHeight > 0) { this.awaitingFocus = false; this.input!.focus(); }
		}));
	}

	protected override _doLayout(_heightInPixels: number, _widthInPixels: number): void { }

	private async save(): Promise<void> {
		if (this.saving || this.composing) return;
		const position = this.position;
		if (!position) return;
		this.saving = true;
		try {
			const condition = this.values.get(BreakpointWidgetContext.CONDITION)!;
			const hitCondition = this.values.get(BreakpointWidgetContext.HIT_COUNT)!;
			const logMessage = this.values.get(BreakpointWidgetContext.LOG_MESSAGE)!;
			if (this.breakpointId) {
				await this.debug.updateBreakpoints(this.resource, new Map([[this.breakpointId, { condition, hitCondition, logMessage }]]), false);
			} else {
				this.debug.addBreakpoints([{
					id: generateUuid(), resource: this.resource, lineNumber: position.lineNumber,
					...(this.column === undefined ? {} : { columnNumber: position.column }),
					enabled: true, verified: false, condition, hitCondition, logMessage,
				}]);
			}
			if (!this.isDisposed) this.close();
		} catch (error) {
			if (!this.isDisposed) this.input!.showValidation(error instanceof Error ? error.message : String(error));
		} finally { this.saving = false; }
	}
}
