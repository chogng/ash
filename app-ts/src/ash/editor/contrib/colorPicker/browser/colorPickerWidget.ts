import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { localize } from '../../../../nls.js';
import { type Color } from '../../../../base/common/color.js';
import { ColorPicker } from '../../../../base/browser/ui/colorPicker/colorPicker.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { bindColorTheme } from '../../../../platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { type Position } from '../../../common/core/position.js';
import { type ColorPickerModel } from './colorPickerModel.js';

const focusedWidgets = new WeakMap<HTMLElement, ColorPickerWidget>();

/** Owns the editor popup; the shared picker owns color controls and the editor owns placement. */
export class ColorPickerWidget extends Disposable implements IContentWidget {
	readonly domNode: HTMLDivElement;
	public readonly allowEditorOverflow = true;
	public readonly suppressMouseDown = true;
	private readonly picker: ColorPicker;
	private readonly presentationSelect: HTMLSelectElement;
	private readonly applyButton: Button;
	private readonly modelListeners = this._register(new DisposableStore());
	private model: ColorPickerModel | undefined;
	private position: Position | undefined;
	private focusPending = false;
	private registered = true;

	constructor(private readonly editor: ICodeEditor, private readonly onColorChange: (color: Color) => void, onApply: () => void, onCancel: () => void, @IThemeService themeService: IThemeService) {
		super();
		const ownerDocument = editor.getDomNode()!.ownerDocument;
		this.picker = this._register(new ColorPicker(ownerDocument, 'embedded'));
		this.presentationSelect = h(ownerDocument, 'select', {
			className: 'stanza-editor-color-picker-presentation',
			attributes: { 'aria-label': localize('colorPicker.documentFormat', 'Document color format') },
		});
		const heading = h(ownerDocument, 'div', { className: 'stanza-editor-color-picker-header' }, this.presentationSelect);
		this._register(new Button(heading, { label: localize('colorPicker.close', 'Close'), size: 'small', onClick: onCancel }));
		const actions = h(ownerDocument, 'div', { className: 'stanza-editor-color-picker-actions' });
		this._register(new Button(actions, {
			label: localize('colorPicker.restore', 'Restore original color'), size: 'small', onClick: () => {
				if (this.model) {
					this.model.color = this.model.originalColor;
					this.onColorChange(this.model.color);
					this.model.flushColor();
				}
			}
		}));
		this.applyButton = this._register(new Button(actions, { label: localize('apply', 'Apply'), presentation: 'primary', size: 'small', onClick: onApply }));
		this.applyButton.domNode.classList.add('stanza-editor-color-picker-apply');
		this.domNode = h(ownerDocument, 'div', {
			className: 'stanza-editor-color-picker',
			attributes: { role: 'dialog', 'aria-label': localize('colorPicker.title', 'Color picker'), 'aria-modal': 'false' },
			properties: { hidden: true },
		}, heading, this.picker.domNode, actions);
		focusedWidgets.set(this.domNode, this);
		this._register(bindColorTheme(themeService, this.domNode));
		this._register(this.picker.onDidChangeColor(color => {
			if (!this.model) { return; }
			this.model.color = color;
			this.onColorChange(color);
		}));
		this._register(this.picker.onDidCommitColor(() => this.model?.flushColor()));
		this._register(addDisposableListener(this.presentationSelect, 'change', () => this.selectPresentation(this.presentationSelect.selectedIndex)));
		// Let the controls receive pointer input before isolating it from editor selection handling.
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'mousedown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape') {
				stopEvent(event);
				onCancel();
			}
		}));
		editor.addContentWidget(this);
		this._register(observeResize(this.domNode, () => {
			if (this.visible && this.registered) { this.editor.layoutContentWidget(this); }
		}));
	}

	public getId(): string { return 'editor.contrib.colorPickerWidget'; }
	public getDomNode(): HTMLElement { return this.domNode; }
	public getPosition(): IContentWidgetPosition | null {
		return this.position ? { position: this.position, preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE] } : null;
	}

	public static getFocused(element: HTMLElement): ColorPickerWidget | undefined {
		const root = element.closest<HTMLElement>('.stanza-editor-color-picker');
		return root ? focusedWidgets.get(root) : undefined;
	}

	public getAccessibleContent(): string {
		return this.picker.getAccessibleContent() + '\n' + localize('colorPicker.documentValue', 'Document value: {0}', this.model?.presentation?.label ?? '');
	}

	public focus(): void { this.picker.focus(); }

	public afterRender(position: ContentWidgetPositionPreference | null): void {
		if (position !== null && this.focusPending) {
			this.focusPending = false;
			this.focus();
		}
	}

	get visible(): boolean {
		return !this.domNode.hidden;
	}

	show(model: ColorPickerModel, position: Position, focus: boolean): void {
		this.domNode.classList.remove('hover');
		this.applyButton.hidden = false;
		if (!this.registered) { this.editor.addContentWidget(this); this.registered = true; }
		this.bindModel(model);
		this.position = position;
		this.domNode.hidden = false;
		this.focusPending = focus;
		this.editor.layoutContentWidget(this);
	}

	public showHover(model: ColorPickerModel, container: HTMLElement): void {
		if (this.registered) { this.editor.removeContentWidget(this); this.registered = false; }
		// Content-widget positioning belongs to the old host; the hover lays out this root in normal flow.
		for (const property of ['display', 'visibility', 'position', 'left', 'top', 'max-width']) { this.domNode.style.removeProperty(property); }
		this.bindModel(model);
		this.position = undefined;
		this.focusPending = false;
		this.domNode.classList.add('hover');
		this.applyButton.hidden = true;
		container.append(this.domNode);
		this.domNode.hidden = false;
	}

	private bindModel(model: ColorPickerModel): void {
		this.modelListeners.clear();
		this.model = model;
		this.modelListeners.add(model.onDidChangeColor(color => {
			// An echo from the picker must not reset its active pointer capture.
			if (!this.picker.color.equals(color)) { this.picker.setColor(color); }
		}));
		this.modelListeners.add(model.onDidChangePresentation(() => {
			this.renderPresentations();
			this.renderSelectedPresentation();
		}));
		this.picker.setColor(model.color);
		this.renderPresentations();
	}

	hide(): void {
		this.modelListeners.clear();
		if (this.model) { this.picker.setColor(this.model.originalColor); }
		this.model = undefined;
		this.position = undefined;
		this.focusPending = false;
		this.domNode.hidden = true;
		if (this.registered) { this.editor.layoutContentWidget(this); }
	}

	private selectPresentation(index: number): void {
		if (!this.model || index < 0 || index >= this.model.colorPresentations.length) return;
		this.model.selectColorPresentation(index);
	}

	private renderPresentations(): void {
		const presentations = this.model?.colorPresentations ?? [];
		this.presentationSelect.replaceChildren(...presentations.map(presentation => h(this.domNode.ownerDocument, 'option', {}, presentation.label)));
		this.applyButton.enabled = presentations.length > 0;
		this.presentationSelect.disabled = presentations.length === 0;
		this.renderSelectedPresentation();
	}

	private renderSelectedPresentation(): void {
		const selected = this.model?.colorPresentations.length ? this.model.presentation : undefined;
		if (!selected) return;
		const index = this.model!.colorPresentations.indexOf(selected);
		if (index >= 0) this.presentationSelect.selectedIndex = index;
	}

	protected override disposeCore(): void {
		this.hide();
		if (this.registered) { this.editor.removeContentWidget(this); }
		focusedWidgets.delete(this.domNode);
		this.domNode.remove();
		super.disposeCore();
	}
}
