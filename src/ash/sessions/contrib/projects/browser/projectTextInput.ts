import { addDisposableListener, getActiveElement, getWindow, h, isNode, stopEvent } from '../../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Action, type IAction } from '../../../../base/common/actions.js';
import { AnchorPosition } from '../../../../base/common/layout.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { EditorCoreCommandId } from '../../../../editor/browser/coreCommands.js';
import { ContentWidgetPositionPreference, type IContentWidget } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation } from '../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection, SelectionDirection } from '../../../../editor/common/core/selection.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { PlaceholderTextContribution } from '../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

const blockPrefix = /^([ \t]*)(?:(#{1,6}|[-+*]|\d+[.)])([ \t]+|$))?/u;

function readBlock(line: string): { indent: string; prefix: string; marker: string; } {
	const [, indent, marker = '', space = ''] = blockPrefix.exec(line)!;
	return { indent, marker, prefix: marker + space };
}

function inlineMarker(source: string, start: number, end: number, marker: string): 'outside' | 'inside' | undefined {
	const length = marker.length;
	if (start >= length && source.slice(start - length, start) === marker && source.slice(end, end + length) === marker) return 'outside';
	if (end - start > 2 * length && source.startsWith(marker, start) && source.startsWith(marker, end - length)) return 'inside';
	return undefined;
}

class InlineFormatActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		if (this.action.onDidChange) {
			this._register(this.action.onDidChange(() => {
				this.button.checked = this.action.checked;
				this.button.enabled = this.action.enabled;
			}));
		}
	}
}

/** An editable Markdown source field with selection actions and an always reachable block menu. */
export class ProjectTextInput extends Disposable {
	readonly element: HTMLElement;
	private readonly editor: CodeEditorWidget;
	private readonly model;
	private readonly selectionToolbar: WorkbenchToolBar;
	private readonly selectionWidget: IContentWidget;
	private blockMenu!: DropdownMenuActionViewItem;
	private readonly linkAction: Action;
	private readonly linkField: HTMLElement;
	private readonly linkInput: InputBox;
	private readonly inlineActions: readonly { action: Action; marker: string; }[];
	private readonly blocks = [
		{ label: localize('projects.formatText', 'Text'), prefix: () => '', matches: (marker: string) => marker === '' },
		{ label: localize('projects.formatHeading1', 'Heading 1'), prefix: () => '# ', matches: (marker: string) => marker === '#' },
		{ label: localize('projects.formatHeading2', 'Heading 2'), prefix: () => '## ', matches: (marker: string) => marker === '##' },
		{ label: localize('projects.formatHeading3', 'Heading 3'), prefix: () => '### ', matches: (marker: string) => /^#{3,6}$/u.test(marker) },
		{ label: localize('projects.formatNumberedList', 'Numbered list'), prefix: (number: number) => `${number}. `, matches: (marker: string) => /^\d/u.test(marker) },
		{ label: localize('projects.formatBulletedList', 'Bulleted list'), prefix: () => '- ', matches: (marker: string) => /^[-+*]$/u.test(marker) },
	];
	private selecting = false;
	private dismissed = false;
	private showAtCaret = false;
	private focusToolbarOnRender = false;
	private readOnly = false;
	private menuOpen = false;
	private linkOpen = false;
	private displayedBlock: (typeof this.blocks)[number] | undefined;

	constructor(
		owner: HTMLElement,
		@IInstantiationService instantiation: IInstantiationService,
		@IModelService models: IModelService,
		@ILanguageService languages: ILanguageService,
		@IContextMenuService menus: IContextMenuService,
	) {
		super();
		const document = owner.ownerDocument;
		const label = localize('projects.textContent', 'Content');
		const formatting = localize('projects.textFormatting', 'Markdown formatting');
		const header = h(document, 'div', { className: 'ash-project-text-field-header' }, label);
		const host = h(document, 'div', { className: 'ash-project-text-viewport' });
		const source = h(document, 'div', { className: 'ash-project-text-source' }, host);
		this.element = h(document, 'div', { className: 'ash-project-text-field' }, header, source);
		const style = getWindow(owner).getComputedStyle(owner);
		const fontSize = Number.parseFloat(style.fontSize);
		this.model = this._register(models.createModel('', languages.createById('markdown'), undefined, true));
		this.editor = this._register(instantiation.createInstance(CodeEditorWidget, {
			container: host,
			model: this.model,
			presentation: 'embedded',
			ariaLabel: label,
			placeholder: localize('projects.textContentPlaceholder', 'Type or paste in content…'),
			fontFamily: style.fontFamily,
			fontSize,
			lineHeight: Math.round(fontSize * 1.5),
			automaticLayout: true,
			tabFocusMode: true,
			multiCursorLimit: 1,
			lineNumbers: 'off',
			lineDecorationsWidth: 0,
			minimap: { enabled: false },
			folding: false,
			glyphMargin: false,
			overviewRulerLanes: 0,
			renderLineHighlight: 'none',
			wordWrap: 'on',
			scrollBeyondLastLine: false,
			padding: { top: 12, bottom: 12 },
			contributionIds: [EditorCoreCommandId.selectAll, 'editor.contrib.codeServices'],
			contributions: [{ id: PlaceholderTextContribution.ID, ctor: PlaceholderTextContribution, instantiation: EditorContributionInstantiation.Eager }],
		}));
		const input = this.editor.controller.textArea ?? this.editor.controller.element;
		input.setAttribute('aria-description', localize('projects.textFormattingHint', 'Select text for inline formatting. Right-click or press Shift+F10 or Alt+F10 to open formatting controls at the cursor.'));
		const blockAction: IAction = { id: 'projects.markdown.block', label: this.blocks[0].label, enabled: true, tooltip: formatting, run: () => { } };
		const popup = h(document, 'div', { className: 'ash-project-text-selection-toolbar' });
		this.selectionToolbar = this._register(new WorkbenchToolBar(popup, menus, {
			ariaLabel: formatting,
			highlightToggledItems: true,
			actionViewItemProvider: (action, options) => {
				if (action !== blockAction) return action instanceof Action ? new InlineFormatActionViewItem(action, options) : undefined;
				const blockMenus: IContextMenuProvider = {
					showContextMenu: delegate => menus.showContextMenu({
						...delegate, anchorPosition: AnchorPosition.Above, iconPlacement: 'leading-with-trailing-check', getCheckedActionsRepresentation: () => 'radio',
					}),
				};
				const menu = this.blockMenu = new DropdownMenuActionViewItem(action, () => this.blockActions(), blockMenus, options);
				this._register(menu.onDidChangeVisibility(open => {
					this.menuOpen = open;
					queueMicrotask(() => this.refreshToolbar());
				}));
				return menu;
			},
		}));
		this.inlineActions = [
			{ id: 'bold', label: localize('projects.formatBold', 'Bold'), icon: Lxicon.bold, marker: '**' },
			{ id: 'italic', label: localize('projects.formatItalic', 'Italic'), icon: Lxicon.italic, marker: '_' },
		].map(({ id, label, icon, marker }) => {
			const action = this._register(new Action(`projects.markdown.${id}`, label, '', true, () => this.toggleInline(marker)));
			action.tooltip = label;
			action.icon = icon;
			action.checked = false;
			return { action, marker };
		});
		const insertLink = localize('projects.formatLink', 'Insert link');
		this.linkAction = this._register(new Action('projects.markdown.link', insertLink, '', true, () => this.openLink()));
		this.linkAction.tooltip = insertLink;
		this.linkAction.icon = Lxicon.link;
		this.selectionToolbar.setActions([
			this.linkAction,
			...this.inlineActions.map(({ action }) => action),
			blockAction,
		]);
		this.linkField = h(document, 'div', { className: 'ash-project-text-link-field', properties: { hidden: true } });
		popup.append(this.linkField);
		this.linkInput = this._register(new InputBox(this.linkField, {
			inputBoxStyles: defaultInputBoxStyles, presentation: 'compact',
			ariaLabel: localize('projects.linkUrl', 'Link URL'), placeholder: 'https://example.com',
		}));
		this.linkInput.inputElement.inputMode = 'url';
		const applyLink = localize('projects.applyLink', 'Apply link');
		const confirmLink = this._register(new Button(this.linkField, {
			...defaultButtonStyles, label: applyLink, title: applyLink, icon: Lxicon.check, iconOnly: true,
			enabled: false, onClick: () => this.applyLink(),
		}));
		this._register(this.linkInput.onDidChange(value => {
			confirmLink.enabled = !!value.trim();
			this.linkInput.showValidation('');
		}));
		// Native caret placement in the URL field must not be handled as an editor gesture.
		this._register(addDisposableListener(this.linkField, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.linkField, 'mousedown', event => event.stopPropagation()));
		this._register(addDisposableListener(confirmLink.domNode, 'mousedown', event => {
			if (event.button === 0) event.preventDefault();
		}));
		this.selectionWidget = {
			suppressMouseDown: true,
			getId: () => 'projects.markdown.selectionToolbar',
			getDomNode: () => popup,
			getPosition: () => {
				const selection = this.editor.getSelection();
				return !popup.hidden && selection ? {
					position: selection.getStartPosition(),
					preference: [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW],
				} : null;
			},
			afterRender: position => {
				if (position === null || !this.focusToolbarOnRender) return;
				this.focusToolbarOnRender = false;
				if (!this.editor.hasTextFocus()) return;
				if (this.linkAction.enabled) this.selectionToolbar.focus(0);
				else this.blockMenu.focus();
			},
		};
		popup.hidden = true;
		this.editor.addContentWidget(this.selectionWidget);
		this._register(toDisposable(() => this.editor.removeContentWidget(this.selectionWidget)));
		this._register(this.editor.onDidChangeCursorSelection(() => {
			this.dismissed = false;
			this.showAtCaret = false;
			this.focusToolbarOnRender = false;
			this.refreshToolbar();
		}));
		this._register(this.model.onDidChangeContent(() => this.refreshToolbar()));
		this._register(addDisposableListener(this.element, 'focusin', () => this.refreshToolbar()));
		this._register(addDisposableListener(this.element, 'focusout', event => {
			if (isNode(event.relatedTarget) && popup.contains(event.relatedTarget)) return;
			queueMicrotask(() => {
				if (this.isDisposed) return;
				if (this.linkOpen && !this.linkField.contains(getActiveElement(document))) this.closeLink();
				this.refreshToolbar();
			});
		}));
		this._register(this.editor.onContextMenu(({ event, target }) => {
			if (this.readOnly || popup.contains(event.target as Node)) return;
			event.preventDefault();
			event.stopPropagation();
			if (this.editor.getSelection()?.isEmpty() && target.position) this.editor.setPosition(target.position);
			this.editor.focus();
			this.dismissed = false;
			this.showAtCaret = true;
			this.refreshToolbar();
		}));
		this._register(addDisposableListener(source, 'pointerdown', event => {
			if (event.button === 0 && !popup.contains(event.target as Node)) {
				this.selecting = true;
				this.dismissed = false;
				this.showAtCaret = false;
				this.refreshToolbar();
			}
		}));
		for (const event of ['pointerup', 'pointercancel']) {
			this._register(addDisposableListener(document, event, () => {
				if (!this.selecting) return;
				this.selecting = false;
				this.refreshToolbar();
			}, true));
		}
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.isComposing || this.readOnly) return;
			if (this.linkOpen && event.key === 'Escape') {
				stopEvent(event);
				this.closeLink();
				this.selectionToolbar.focus(0);
			} else if (this.linkOpen && event.key === 'Enter' && event.target === this.linkInput.inputElement) {
				stopEvent(event);
				this.applyLink();
			} else if ((event.altKey && event.key === 'F10' || event.shiftKey && event.key === 'F10' || event.key === 'ContextMenu') && this.editor.hasTextFocus()) {
				stopEvent(event);
				this.dismissed = false;
				this.showAtCaret = true;
				this.focusToolbarOnRender = true;
				this.refreshToolbar();
			} else if (event.key === 'Escape' && !popup.hidden && !this.menuOpen) {
				stopEvent(event);
				this.dismissed = true;
				this.focusToolbarOnRender = false;
				this.editor.focus();
				this.refreshToolbar();
			}
		}, true));
		this.refreshToolbar();
	}

	get onDidChange() { return this.model.onDidChangeContent; }
	get value(): string { return this.model.getValue(); }

	setReadOnly(readOnly: boolean): void {
		this.readOnly = readOnly;
		this.editor.updateOptions({ readOnly, domReadOnly: readOnly });
		if (readOnly && this.linkOpen) this.closeLink();
		this.refreshToolbar();
	}

	private refreshToolbar(): void {
		if (this.isDisposed) return;
		const popup = this.selectionWidget.getDomNode();
		const selection = this.editor.getSelection();
		const focused = this.editor.hasTextFocus() || popup.contains(getActiveElement(this.element.ownerDocument));
		popup.hidden = this.readOnly || this.dismissed || this.selecting || !selection || selection.isEmpty() && !this.showAtCaret || !(focused || this.menuOpen || this.linkOpen);
		if (!popup.hidden && selection) {
			const source = this.model.getValue();
			const start = this.model.getOffsetAt(selection.getStartPosition());
			const end = this.model.getOffsetAt(selection.getEndPosition());
			const hasText = !!source.slice(start, end).trim();
			this.linkAction.enabled = hasText;
			for (const { action, marker } of this.inlineActions) {
				action.enabled = hasText;
				action.checked = hasText && inlineMarker(source, start, end, marker) !== undefined;
			}
		}
		this.editor.layoutContentWidget(this.selectionWidget);
		const block = this.currentBlock();
		if (block === this.displayedBlock) return;
		this.displayedBlock = block;
		const label = localize('projects.formatBlockLabel', 'Block style: {0}', block.label);
		this.blockMenu.setLabel(block.label, label);
	}

	private currentBlock() {
		const line = Math.min(this.editor.getSelection()?.startLineNumber ?? 1, this.model.getLineCount());
		const { marker } = readBlock(this.model.getLineContent(line));
		return this.blocks.find(block => block.matches(marker)) ?? this.blocks[0];
	}

	private blockActions(): IAction[] {
		const current = this.currentBlock();
		return this.blocks.map((block, index) => ({
			id: `projects.markdown.block.${index}`, label: block.label, tooltip: '', checked: block === current, enabled: true,
			run: () => this.applyBlock(block.prefix),
		}));
	}

	private applyBlock(prefix: (number: number) => string): void {
		const selection = this.editor.getSelection();
		if (!selection || this.readOnly) return;
		// A selection ending at the start of the next line does not include that line.
		const endLine = selection.endLineNumber - Number(selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber);
		const edits = [];
		const changes = new Map<number, { start: number; previous: number; next: number; }>();
		let number = 0;
		for (let line = selection.startLineNumber; line <= endLine; line++) {
			const source = this.model.getLineContent(line);
			if (endLine !== selection.startLineNumber && !source.trim()) continue;
			const { indent, prefix: previous } = readBlock(source);
			const next = prefix(++number);
			if (next === previous) continue;
			const start = indent.length + 1;
			edits.push({ range: new Range(line, start, line, start + previous.length), text: next });
			changes.set(line, { start, previous: previous.length, next: next.length });
		}
		const move = (position: Position) => {
			const change = changes.get(position.lineNumber);
			if (!change || position.column < change.start) return position;
			const tail = Math.max(0, position.column - change.start - change.previous);
			return new Position(position.lineNumber, change.start + change.next + tail);
		};
		if (edits.length) {
			this.editor.pushUndoStop();
			this.editor.executeEdits('projectMarkdownBlock', edits, [Selection.fromPositions(move(selection.getSelectionStart()), move(selection.getPosition()))]);
			this.editor.pushUndoStop();
		}
		this.editor.focus();
	}

	private toggleInline(marker: string): void {
		const selection = this.editor.getSelection();
		if (!selection || selection.isEmpty() || this.readOnly) return;
		const start = this.model.getOffsetAt(selection.getStartPosition());
		const end = this.model.getOffsetAt(selection.getEndPosition());
		const source = this.model.getValue();
		const text = source.slice(start, end);
		const length = marker.length;
		const applied = inlineMarker(source, start, end, marker);
		if (applied === 'outside') {
			this.replace(start - length, end + length, text, 0, text.length, selection.getDirection());
		} else if (applied === 'inside') {
			const inner = text.slice(length, -length);
			this.replace(start, end, inner, 0, inner.length, selection.getDirection());
		} else {
			const leading = /^\s*/u.exec(text)![0];
			const trailing = /\s*$/u.exec(text)![0];
			if (!text.trim()) return;
			const replacement = leading + marker + text.trim() + marker + trailing;
			this.replace(start, end, replacement, leading.length + length, replacement.length - trailing.length - length, selection.getDirection());
		}
	}

	private openLink(): void {
		this.linkOpen = true;
		this.linkInput.value = '';
		this.linkInput.showValidation('');
		this.linkField.hidden = false;
		this.selectionToolbar.element.hidden = true;
		this.editor.layoutContentWidget(this.selectionWidget);
		this.linkInput.focus();
	}

	private closeLink(): void {
		this.linkOpen = false;
		this.linkField.hidden = true;
		this.selectionToolbar.element.hidden = false;
	}

	private applyLink(): void {
		const url = this.linkInput.value.trim();
		if (!isLink(url)) {
			this.linkInput.showValidation(localize('projects.invalidLink', 'Enter an HTTP, HTTPS, or mailto URL.'));
			this.editor.layoutContentWidget(this.selectionWidget);
			this.linkInput.focus();
			return;
		}
		const selection = this.editor.getSelection();
		if (!selection || selection.isEmpty() || this.readOnly) return;
		const text = this.model.getValueInRange(selection);
		const label = text.trim().replace(/\s*\n\s*/gu, ' ').replace(/[\\[\]]/gu, '\\$&');
		const target = url.replace(/[\\()]/gu, '\\$&');
		const link = `[${label}](${target})`;
		const start = this.model.getOffsetAt(selection.getStartPosition()) + text.length - text.trimStart().length;
		const end = this.model.getOffsetAt(selection.getEndPosition()) - (text.length - text.trimEnd().length);
		this.closeLink();
		this.replace(start, end, link, link.length, link.length);
	}

	private replace(start: number, end: number, text: string, from: number, to: number, direction = SelectionDirection.LTR): void {
		const range = Range.fromPositions(this.model.getPositionAt(start), this.model.getPositionAt(end));
		this.editor.pushUndoStop();
		this.editor.executeEdits('projectMarkdownInline', [{ range, text }], () => {
			const first = this.model.getPositionAt(start + from);
			const last = this.model.getPositionAt(start + to);
			return [direction === SelectionDirection.LTR ? Selection.fromPositions(first, last) : Selection.fromPositions(last, first)];
		});
		this.editor.pushUndoStop();
		this.editor.focus();
	}
}

function isLink(value: string): boolean {
	if (/\s/u.test(value)) return false;
	try {
		return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}
