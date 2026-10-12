import './media/themeEditor.css';
import '../../../../base/browser/ui/splitview/splitview.css';
import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color } from '../../../../base/common/color.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { findNodeAtLocation, parseTree } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Colors } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService, type IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../common/editor.js';
import { IUserThemeService } from '../../../common/userThemes.js';
import { parseColorThemeDocument, userThemeId } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';

export const ThemeEditorId = 'workbench.editor.themeEditor';
export const ThemeEditorFocused = new RawContextKey<boolean>('themeEditorFocused', false);

export function createThemeEditorInput(input: IResourceEditorInput): IResourceEditorInput {
	return { ...input, editorId: ThemeEditorId, languageId: 'jsonc' };
}

/** The embedded text pane owns the document, history, working copy and file revision. */
export class ThemeEditor extends EditorPane {
	public readonly id = ThemeEditorId;
	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private list: HTMLElement | undefined;
	private message: HTMLElement | undefined;
	private search: InputBox | undefined;
	private category: HTMLSelectElement | undefined;
	private scrollable: ScrollableElement | undefined;
	private split: SplitView | undefined;
	private previewButton: Button | undefined;
	private readonly rows = new Map<string, ThemeColorRow>();
	private readonly inputLifetime = this._register(new DisposableStore());
	private readonly preview = this._register(new MutableDisposable<ReturnType<IWorkbenchThemeService['previewColorTheme']>>());
	private readonly nameDialog = this._register(new MutableDisposable<DisposableStore>());
	private readonly refresh = this._register(new RunOnceScheduler(() => { void this.updatePreview(); }, 60));
	private readonly copiesChanged = this._register(new Emitter<void>());
	public readonly onDidChangeWorkingCopies = this.copiesChanged.event;
	private input: IResourceEditorInput | undefined;
	private compiled: IColorTheme | undefined;
	private valid = false;
	private previewEnabled = true;
	private operation = 0;
	private saving = false;
	private dimension: IDimension = { width: 0, height: 0 };
	private initialSplitLayout = true;

	constructor(
		private readonly textEditor: TextResourceEditor,
		@IWorkbenchThemeService private readonly themes: IWorkbenchThemeService,
		@IUserThemeService private readonly userThemes: IUserThemeService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IEditorPartsService private readonly editorParts: IEditorPartsService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(ThemeEditorId, themeService, storageService);
		this._register(toDisposable(() => this.clearInput()));
		this._register(textEditor);
		this._register(toDisposable(() => { for (const row of this.rows.values()) row.dispose(); this.rows.clear(); }));
		// Validate every save path, including Save All and another JSON view of this file.
		this._register(models.addSaveParticipant({ participate: async model => {
			if (model !== this.getControl()?.getModel()) return;
			const input = this.input;
			let source: string;
			do { source = model.getText(); await this.compile(source, input); } while (model.getText() !== source);
		} }));
		this._register(Colors.onDidChange(() => this.renderRows()));
		this._register(themes.onDidColorThemeChange(() => this.renderRows()));
	}

	public override create(parent: HTMLElement): void {
		const doc = parent.ownerDocument;
		const root = h(doc, 'div');
		root.className = 'ash-theme-editor';
		root.setAttribute('aria-label', localize('themeEditor.title', 'Theme Editor'));
		parent.append(root);
		super.create(root);
		this.root = root;
		this._register(toDisposable(() => root.remove()));
		const scoped = this._register(this.contextKeys.createScoped(root));
		const focused = ThemeEditorFocused.bindTo(scoped);
		this._register(addDisposableListener<FocusEvent>(root, 'focusin', event => {
			focused.set(true);
			if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) {
				const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ThemeEditor);
				if (hint) status(hint);
			}
		}));
		this._register(addDisposableListener<FocusEvent>(root, 'focusout', event => {
			if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) focused.reset();
		}));
		this._register(addDisposableListener<KeyboardEvent>(root, 'keydown', event => {
			if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'F1') {
				stopEvent(event);
				this.accessibleViews.show(AccessibleViewType.Help, root);
				return;
			}
			if (!event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
				stopEvent(event);
				this.runAction(() => event.shiftKey ? this.saveThemeAs() : this.save());
			}
		}, { capture: true }));
		const toolbar = h(doc, 'div');
		toolbar.className = 'ash-theme-editor-toolbar';
		const title = h(doc, 'h1');
		title.textContent = localize('themeEditor.title', 'Theme Editor');
		toolbar.append(title);
		this.previewButton = this._register(new Button(toolbar, {
			label: localize('themeEditor.preview', 'Live preview'), presentation: 'quiet', checked: true,
			onClick: () => {
				this.previewEnabled = !this.previewEnabled;
				this.previewButton!.checked = this.previewEnabled;
				this.applyPreview();
			},
		}));
		this._register(new Button(toolbar, { label: localize('themeEditor.save', 'Save'), presentation: 'primary', onClick: () => this.runAction(() => this.save()) }));
		this._register(new Button(toolbar, { label: localize('themeEditor.saveAs', 'Save as…'), presentation: 'quiet', onClick: () => this.runAction(() => this.saveThemeAs()) }));
		this.message = h(doc, 'p');
		this.message.className = 'ash-theme-editor-message';
		this.message.setAttribute('role', 'status');
		this.message.textContent = localize('themeEditor.description', 'Adjust colors here and observe the main window. Changes stay unsaved until you save.');
		this.body = h(doc, 'div');
		this.body.className = 'ash-theme-editor-body';
		root.append(toolbar, this.message, this.body);
		const panel = h(doc, 'section');
		panel.className = 'ash-theme-editor-colors';
		this.search = this._register(new InputBox(panel, { type: 'search', placeholder: localize('themeEditor.search', 'Search colors'), ariaLabel: localize('themeEditor.search', 'Search colors') }));
		this._register(this.search.onDidChange(() => this.renderRows()));
		this.category = h(doc, 'select');
		this.category.className = 'ash-theme-editor-category';
		this.category.setAttribute('aria-label', localize('themeEditor.category', 'Color category'));
		panel.append(this.category);
		this._register(addDisposableListener(this.category, 'change', () => this.renderRows()));
		const scrollHost = h(doc, 'div');
		scrollHost.className = 'ash-theme-editor-scroll';
		panel.append(scrollHost);
		this.scrollable = this._register(new ScrollableElement(scrollHost, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		this.list = h(doc, 'div');
		this.list.className = 'ash-theme-editor-list';
		this.scrollable.append(this.list);
		scrollHost.append(this.scrollable.element);
		const json = h(doc, 'section');
		json.className = 'ash-theme-editor-json';
		json.setAttribute('aria-label', localize('themeEditor.json', 'Theme JSON'));
		this.textEditor.create(json);
		this.split = this._register(new SplitView(this.body, 'horizontal'));
		this.split.addView({ element: panel, minimumSize: 260, maximumSize: 560, onDidChange: Event.None, layout: () => this.scrollable?.layout() }, 340);
		this.split.addView({ element: json, minimumSize: 260, maximumSize: Infinity, onDidChange: Event.None, layout: (width, _offset, height) => this.textEditor.layout({ width, height }) }, { type: 'distribute' });
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.input = input;
		await this.textEditor.setInput(input, signal);
		if (signal.aborted || this.input !== input) throw new CancellationError();
		const control = this.getControl()!;
		this.inputLifetime.add(control.onDidChangeModelContent(() => { this.valid = false; this.refresh.schedule(); }));
		this.inputLifetime.add(control.onDidChangeCursorSelection(() => this.syncSelection()));
		this.copiesChanged.fire();
		await this.updatePreview();
		this.layout(this.dimension);
	}

	public override clearInput(): void {
		this.operation++;
		this.refresh.cancel();
		this.inputLifetime.clear();
		this.nameDialog.clear();
		this.preview.clear();
		this.compiled = undefined;
		this.input = undefined;
		this.valid = false;
		this.textEditor.clearInput();
		this.copiesChanged.fire();
	}

	public get workingCopy() { return this.textEditor.workingCopy; }
	public override getControl() { return this.textEditor.getControl(); }
	public override focus(): void { this.search?.focus(); }
	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (this.body) {
			this.split?.layout(dimension.width, Math.max(0, dimension.height - this.body.offsetTop + (this.root?.offsetTop ?? 0)));
			if (this.initialSplitLayout && dimension.width > 520 && this.split) {
				this.initialSplitLayout = false;
				this.split.resizeView(0, 340);
			}
		}
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.textEditor.setVisible(visible);
		this.applyPreview();
	}
	public revealRange(range: Range): void { this.textEditor.revealRange(range); }
	public getAccessibleContent(): string {
		return [this.message?.textContent ?? '', ...[...this.rows.values()].filter(row => !row.element.hidden).map(row => row.accessibleText)].join('\n');
	}

	public async save(options?: ISaveOptions): Promise<void> {
		const input = this.input;
		if (!input) return;
		if (input.resource.scheme === 'untitled') return this.saveThemeAs();
		await this.compile(this.textEditor.getValue());
		if (this.input !== input) throw new CancellationError();
		await this.textEditor.save(options);
		await this.userThemes.reload();
		this.showMessage(localize('themeEditor.saved', 'Theme saved.'));
	}

	public async saveAs(resource: URI): Promise<void> {
		const input = this.input;
		await this.compile(this.textEditor.getValue());
		if (this.input !== input) throw new CancellationError();
		await this.textEditor.saveAs(resource);
		await this.userThemes.reload();
	}

	private async saveThemeAs(): Promise<void> {
		const input = this.input;
		const model = this.getControl()?.getModel();
		if (!input || !model) return;
		const name = await this.promptName();
		if (name === undefined || this.input !== input) return;
		const source = model.getText();
		const candidate = applyEdits(source, setProperty(source, ['name'], name.trim(), { insertSpaces: true, tabSize: 2 }));
		await this.compile(candidate);
		const saved = await this.userThemes.saveAs(candidate);
		// A slow write must not replace a document that acquired newer edits meanwhile.
		if (this.input !== input || model.getText() !== source) {
			this.showMessage(localize('themeEditor.copySaved', 'Saved {0}. Newer edits remain in this editor.', saved.file));
			return;
		}
		const group = this.editorParts.groups.find(group => group.inputs.some(candidate => candidate === input));
		if (group) await this.editorParts.replaceEditorResource(group, input, createThemeEditorInput({ resource: URI.file(this.userThemes.directory! + '/' + saved.file), label: saved.file }));
		await this.themes.setColorTheme(saved.theme.id);
	}

	private async promptName(): Promise<string | undefined> {
		if (!this.root) return undefined;
		const lifetime = new DisposableStore();
		this.nameDialog.value = lifetime;
		const content = h(this.root.ownerDocument, 'div');
		const name = lifetime.add(new InputBox(content, { ariaLabel: localize('themeEditor.name', 'Theme name'), placeholder: localize('themeEditor.name', 'Theme name') }));
		const label = this.compiled?.label ?? localize('themeEditor.title', 'Theme Editor');
		name.value = this.input?.resource.scheme === 'untitled' ? label : localize('themeEditor.copyName', '{0} Copy', label);
		const hint = h(content.ownerDocument, 'p');
		hint.textContent = localize('themeEditor.invalidName', 'Enter a theme name of 1 to 256 characters.');
		content.append(hint);
		const actions = h(content.ownerDocument, 'div'); actions.className = 'ash-theme-editor-name-actions'; content.append(actions);
		const dialog = lifetime.add(new Dialog(this.root, { title: localize('themeEditor.saveAs', 'Save as…'), content }));
		const accept = (): void => { if (name.value.trim().length > 0 && name.value.trim().length <= 256) dialog.close('save'); };
		const save = lifetime.add(new Button(actions, { label: localize('themeEditor.save', 'Save'), presentation: 'primary', onClick: accept }));
		lifetime.add(new Button(actions, { label: localize('themeEditor.cancel', 'Cancel'), presentation: 'quiet', onClick: () => dialog.close() }));
		lifetime.add(name.onDidChange(value => { save.enabled = value.trim().length > 0 && value.trim().length <= 256; }));
		lifetime.add(name.onKeyDown(event => { if (event.key === 'Enter') { stopEvent(event); accept(); } }));
		try { return await dialog.show() === 'save' ? name.value.trim() : undefined; }
		finally { if (this.nameDialog.value === lifetime) this.nameDialog.clear(); }
	}

	private compile(source: string, input = this.input): Promise<IColorTheme> {
		const resource = input?.resource;
		const candidateId = resource?.scheme === 'file' ? userThemeId(resource.path.split('/').at(-1)!.replace(/\.json$/iu, '')) : undefined;
		const existing = candidateId ? this.userThemes.sourceFor(candidateId) : undefined;
		// A JSON file outside the profile must not borrow a same-named user theme's includes.
		const id = existing && URI.file(this.userThemes.directory! + '/' + existing.file).toString() === resource?.toString() ? candidateId : undefined;
		return this.userThemes.resolve(source, id);
	}

	private async updatePreview(): Promise<void> {
		const operation = ++this.operation;
		const source = this.textEditor.getValue();
		if (!this.input) return;
		try {
			const theme = await this.compile(source);
			if (operation !== this.operation || this.textEditor.getValue() !== source) return;
			this.compiled = theme;
			this.valid = true;
			this.applyPreview();
			this.renderRows();
			this.showMessage(localize('themeEditor.description', 'Adjust colors here and observe the main window. Changes stay unsaved until you save.'));
		} catch (error) {
			if (operation !== this.operation || this.textEditor.getValue() !== source) return;
			this.valid = false;
			this.showMessage(localize('themeEditor.invalidJson', 'Cannot preview this JSON. The last valid preview is retained. {0}', error instanceof Error ? error.message : String(error)), true);
			this.renderRows();
		}
	}

	private applyPreview(): void {
		if (!this.previewEnabled || !this.isVisible()) { this.preview.clear(); return; }
		if (!this.compiled) return;
		if (this.preview.value) this.preview.value.update(this.compiled);
		else this.preview.value = this.themes.previewColorTheme(this.compiled);
	}

	private renderRows(): void {
		if (!this.list || !this.category) return;
		let colors: Readonly<Record<string, string>> = {};
		try { colors = parseColorThemeDocument(parseJsonc(this.textEditor.getValue(), 'Color theme')).colors ?? {}; } catch { }
		const entries = Colors.getColors();
		const categories = [...new Set(entries.map(entry => entry.id.split('.')[0]!))].sort();
		const selected = this.category.value;
		if (this.category.options.length !== categories.length + 1) {
			this.category.replaceChildren();
			const all = h(this.category.ownerDocument, 'option');
			all.value = ''; all.textContent = localize('themeEditor.allColors', 'All colors'); this.category.append(all);
			for (const category of categories) { const option = h(this.category.ownerDocument, 'option'); option.value = category; option.textContent = category; this.category.append(option); }
			this.category.value = selected;
		}
		const query = (this.search?.value ?? '').toLowerCase();
		const current = this.preview.value ? this.themes.getColorTheme() : this.compiled;
		for (const entry of entries) {
			let row = this.rows.get(entry.id);
			if (!row) {
				row = new ThemeColorRow(this.list.ownerDocument, entry.id, entry.description, this.hoverService,
					value => this.editColor(entry.id, value), () => this.revealColor(entry.id));
				this.rows.set(entry.id, row);
				this.list.append(row.element);
			}
			row.element.hidden = (!!this.category.value && !entry.id.startsWith(this.category.value + '.')) || (!!query && !`${entry.id} ${entry.description}`.toLowerCase().includes(query));
			row.update(colors[entry.id], current?.getColor(entry.id), this.valid && !this.input?.readOnly);
		}
		const identifiers = new Set(entries.map(entry => entry.id));
		for (const [id, row] of this.rows) if (!identifiers.has(id)) { row.dispose(); this.rows.delete(id); }
		this.scrollable?.layout();
	}

	private editColor(id: string, value: string | undefined): void {
		if (!this.valid || this.input?.readOnly) return;
		const control = this.getControl();
		const model = control?.getModel();
		if (!model || !control) return;
		const edits = setProperty(model.getText(), ['colors', id], value, { insertSpaces: !/^\t/mu.test(model.getText()), tabSize: 2, eol: model.getText().includes('\r\n') ? '\r\n' : '\n' });
		model.pushStackElement();
		control.executeEdits('themeEditor.color', edits.map(edit => ({ range: Range.fromPositions(model.getPositionAt(edit.offset), model.getPositionAt(edit.offset + edit.length)), text: edit.content })));
		model.pushStackElement();
		// The synchronous document edit is complete; a second color gesture can proceed.
		this.valid = true;
		this.revealColor(id, false);
	}

	private revealColor(id: string, focus = true): void {
		const control = this.getControl(); const model = control?.getModel();
		if (!control || !model) return;
		const node = findNodeAtLocation(parseTree(model.getText()), ['colors', id]);
		if (!node) return;
		const range = Range.fromPositions(model.getPositionAt(node.offset), model.getPositionAt(node.offset + node.length));
		control.setSelection(range); control.revealRange?.(range);
		if (focus) control.focus();
	}

	private syncSelection(): void {
		const model = this.getControl()?.getModel(); const selection = this.getControl()?.getSelections()?.[0];
		if (!model || !selection) return;
		const offset = model.getOffsetAt(selection.getStartPosition());
		const colors = findNodeAtLocation(parseTree(model.getText()), ['colors']);
		let selected: string | undefined;
		for (const property of colors?.children ?? []) if (offset >= property.offset && offset <= property.offset + property.length) selected = String(property.children?.[0]?.value);
		for (const [id, row] of this.rows) row.element.classList.toggle('selected', id === selected);
	}

	private runAction(action: () => Promise<void>): void {
		if (this.saving) return;
		this.saving = true;
		void action().catch(error => this.showMessage(localize('themeEditor.saveError', 'Could not save the theme. {0}', error instanceof Error ? error.message : String(error)), true)).finally(() => { this.saving = false; });
	}
	private showMessage(message: string, error = false): void {
		if (!this.message) return;
		this.message.textContent = message;
		this.message.classList.toggle('error', error);
		this.layout(this.dimension);
	}
}

class ThemeColorRow extends Disposable {
	public readonly element: HTMLElement;
	private readonly hex: InputBox;
	private readonly picker: HTMLInputElement;
	private readonly alpha: HTMLInputElement;
	private readonly reset: Button;
	private readonly source: HTMLElement;
	private color: Color | undefined;
	private documentValue: string | undefined;
	private updating = false;
	public get accessibleText(): string { return `${this.id}: ${this.hex.value}. ${this.source.textContent ?? ''}`; }

	constructor(doc: Document, private readonly id: string, description: string, hover: IHoverService, edit: (value: string | undefined) => void, reveal: () => void) {
		super();
		this.element = h(doc, 'div'); this.element.className = 'ash-theme-color';
		const name = this._register(new Button(this.element, { label: id, presentation: 'quiet', onClick: reveal }));
		name.domNode.classList.add('ash-theme-color-name');
		this._register(hover.setupHover({ target: name.domNode, content: `${id}\n${description}` }));
		const fields = h(doc, 'div'); fields.className = 'ash-theme-color-fields'; this.element.append(fields);
		this.picker = h(doc, 'input'); this.picker.type = 'color'; this.picker.className = 'ash-theme-color-picker';
		this.picker.setAttribute('aria-label', localize('themeEditor.pickColor', 'Choose color for {0}', id)); fields.append(this.picker);
		this.hex = this._register(new InputBox(fields, { ariaLabel: localize('themeEditor.hexColor', 'Hex color for {0}', id) }));
		this.hex.element.classList.add('ash-theme-color-hex');
		this._register(this.hex.onDidChange(value => {
			if (this.updating) return;
			const valid = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value);
			this.hex.inputElement.setAttribute('aria-invalid', String(!valid));
			if (valid) edit(value);
		}));
		this.reset = this._register(new Button(fields, { label: localize('themeEditor.reset', 'Reset'), presentation: 'quiet', ariaLabel: localize('themeEditor.resetColor', 'Remove the override for {0}', id), onClick: () => edit(undefined) }));
		this.alpha = h(doc, 'input'); this.alpha.type = 'range'; this.alpha.min = '0'; this.alpha.max = '100';
		this.alpha.className = 'ash-theme-color-alpha';
		this.alpha.setAttribute('aria-label', localize('themeEditor.opacity', 'Opacity for {0}', id)); this.element.append(this.alpha);
		const update = (): void => {
			const rgb = this.picker.value;
			const alpha = Math.round(Number(this.alpha.value) * 255 / 100).toString(16).padStart(2, '0');
			edit(Number(this.alpha.value) === 100 ? rgb : rgb + alpha);
		};
		this._register(addDisposableListener(this.picker, 'input', update));
		this._register(addDisposableListener(this.alpha, 'input', update));
		this.source = h(doc, 'p'); this.source.className = 'ash-theme-color-source'; this.element.append(this.source);
		this._register(toDisposable(() => this.element.remove()));
	}

	public update(authored: string | undefined, effective: Color | undefined, enabled: boolean): void {
		this.color = authored ? Color.fromHex(authored) : effective;
		const value = authored ?? (effective ? Color.Format.CSS.formatHexA(effective, true) : '');
		// Document changes (including Undo in JSON) win over the focused control.
		// An incomplete hex input survives unrelated preview/catalog refreshes.
		if (this.documentValue !== value || this.element.ownerDocument.activeElement !== this.hex.inputElement) {
			this.updating = true;
			try { this.hex.value = value; } finally { this.updating = false; }
			this.hex.inputElement.removeAttribute('aria-invalid');
		}
		this.documentValue = value;
		if (this.color) {
			this.picker.value = Color.Format.CSS.formatHex(this.color);
			if (this.element.ownerDocument.activeElement !== this.alpha) this.alpha.value = String(Math.round(this.color.rgba.a * 100));
		} else {
			this.picker.value = Color.Format.CSS.formatHex(Color.black);
			this.alpha.value = '100';
		}
		this.picker.disabled = !enabled;
		this.alpha.disabled = !enabled;
		this.hex.enabled = enabled;
		this.reset.enabled = enabled && authored !== undefined;
		this.source.textContent = authored === undefined ? localize('themeEditor.inherited', 'Inherited / default') : localize('themeEditor.explicit', 'Set in this file');
		const final = effective ? Color.Format.CSS.formatHexA(effective, true) : undefined;
		if (authored && final && !Color.fromHex(authored).equals(effective!)) this.source.textContent += ' · ' + localize('themeEditor.effective', 'Effective: {0}', final);
	}
}
