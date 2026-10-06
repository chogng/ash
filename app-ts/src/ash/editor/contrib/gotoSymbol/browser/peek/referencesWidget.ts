import './referencesWidget.css';
import { h, addDisposableListener, stopEvent } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, type IReference } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../nls.js';
import { EmbeddedCodeEditorWidget } from '../../../../browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { ITextModelService, type IResolvedTextEditorModel } from '../../../../common/services/resolverService.js';
import { Range } from '../../../../common/core/range.js';
import { PeekViewWidget } from '../../../peekView/browser/peekView.js';
import { ReferencesModel, FileReferences, OneReference } from '../referencesModel.js';
import { DataSource } from './referencesTree.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { basename } from '../../../../../base/common/resources.js';

export class ReferenceWidget extends PeekViewWidget {
	private readonly modelReference = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly selection = this._register(new Emitter<OneReference>());
	public readonly onDidSelectReference = this.selection.event;
	private readonly tree: ReferencesTree;
	private readonly preview: EmbeddedCodeEditorWidget;
	private selectedReference: OneReference | undefined;
	private model: ReferencesModel | undefined;
	private selectionVersion = 0;

	constructor(
		editor: ICodeEditor,
		onError: (error: unknown) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITextModelService private readonly textModels: ITextModelService,
	) {
		super(editor);
		const body = h(this.element.ownerDocument, 'div');
		this.tree = this._register(new ReferencesTree(body));
		const host = h(this.element.ownerDocument, 'div');
		host.className = 'stanza-editor-language-preview';
		body.append(host);
		this.preview = this._register(instantiationService.createInstance(EmbeddedCodeEditorWidget,
			host,
			{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false },
			{ container: host, model: editor.getModel(), presentation: 'embedded', ariaLabel: localize('references.previewLabel', 'Reference preview') },
			editor,
		));
		this.setBody(body);
		this._register(this.tree.onDidSelectReference(reference => this.selection.fire(reference)));
		this._register(this.tree.onDidFocusReference(reference => {
			if (reference !== this.selectedReference) {
				void this.setSelection(reference).catch(onError);
			}
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'F6') {
				stopEvent(event);
				if (this.preview.hasWidgetFocus()) { this.focusOnReferenceTree(); }
				else { this.focusOnPreviewEditor(); }
			}
			if (event.key === 'F4' && this.model && this.selectedReference) {
				stopEvent(event);
				const reference = this.model.nextOrPreviousReference(this.selectedReference, !event.shiftKey);
				void this.setSelection(reference).catch(onError);
				this.tree.focus(reference);
			}
		}));
	}

	public async setModel(model: ReferencesModel | undefined): Promise<void> {
		this.model = model;
		this.tree.setInput(model);
		if (!model) {
			this.selectedReference = undefined;
			this.selectionVersion++;
			this.preview.setModel(null);
			this.modelReference.clear();
			return;
		}
		this.setTitle(model.title, model.ariaMessage);
		const first = model.references.find(reference => extUri.isEqual(reference.uri, this.editor.getModel()!.uri)) ?? model.firstReference();
		if (first) { await this.setSelection(first); }
	}

	public async setSelection(reference: OneReference): Promise<void> {
		this.selectedReference = reference;
		const version = ++this.selectionVersion;
		const source = this.editor.getModel();
		if (source && extUri.isEqual(source.uri, reference.uri)) {
			this.preview.setModel(source);
			this.modelReference.clear();
		} else {
			const resolved = await this.textModels.createModelReference(reference.uri);
			// A slower resource lookup must not replace a newer selection or retain a closed widget's model.
			if (this.isDisposed || version !== this.selectionVersion) {
				resolved.dispose();
				return;
			}
			this.preview.setModel(resolved.object.textEditorModel);
			this.modelReference.value = resolved;
		}
		this.preview.setSelection(reference.range);
		this.preview.revealRange(Range.lift(reference.range));
	}
	public focusOnReferenceTree(): void { this.tree.focus(this.selectedReference); }
	public focusOnPreviewEditor(): void { this.preview.focus(); }
}

/** Retains result controls and their keyboard focus while the preview changes. */
class ReferencesTree extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly rows = this._register(new DisposableStore());
	private readonly selected = this._register(new Emitter<OneReference>());
	public readonly onDidSelectReference = this.selected.event;
	private readonly focused = this._register(new Emitter<OneReference>());
	public readonly onDidFocusReference = this.focused.event;
	private readonly buttons = new Map<OneReference, HTMLButtonElement>();
	private readonly source = new DataSource();

	constructor(container: HTMLElement) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'stanza-editor-language-locations';
		this.domNode.setAttribute('role', 'listbox');
		container.append(this.domNode);
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { return; }
			stopEvent(event);
			const buttons = [...this.buttons.values()];
			const index = buttons.indexOf(this.domNode.ownerDocument.activeElement as HTMLButtonElement);
			buttons[(index + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length]?.focus();
		}));
	}

	public setInput(model: ReferencesModel | undefined): void {
		this.rows.clear();
		this.buttons.clear();
		this.domNode.replaceChildren();
		if (!model) { return; }
		this.domNode.setAttribute('aria-label', model.title);
		for (const group of this.source.getChildren(model) as FileReferences[]) {
			const section = h(this.domNode.ownerDocument, 'section');
			section.setAttribute('role', 'group');
			section.setAttribute('aria-label', group.ariaMessage);
			this.domNode.append(section);
			for (const reference of this.source.getChildren(group) as OneReference[]) {
				const button = this.rows.add(new Button(section, {
					label: `${basename(reference.uri)}:${reference.range.startLineNumber}:${reference.range.startColumn}`,
					ariaLabel: reference.ariaMessage,
					presentation: 'quiet',
				}));
				button.domNode.classList.add('stanza-editor-language-location');
				button.domNode.setAttribute('role', 'option');
				button.domNode.setAttribute('aria-selected', 'false');
				this.buttons.set(reference, button.domNode);
				this.rows.add(button.onDidClick(() => this.selected.fire(reference)));
				this.rows.add(addDisposableListener(button.domNode, 'focus', () => {
					for (const candidate of this.buttons.values()) { candidate.setAttribute('aria-selected', String(candidate === button.domNode)); }
					this.focused.fire(reference);
				}));
			}
		}
	}
	public focus(reference?: OneReference): void {
		(reference ? this.buttons.get(reference) : this.buttons.values().next().value)?.focus({ preventScroll: true });
	}
}
