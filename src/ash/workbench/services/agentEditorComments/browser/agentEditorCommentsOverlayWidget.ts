import { addDisposableListener, h, isHTMLElement } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import type { URI } from '../../../../base/common/uri.js';
import { OverlayWidgetPositionPreference, type ICodeEditor, type IOverlayWidget } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ReviewZoneWidget } from '../../../contrib/comments/browser/commentThreadZoneWidget.js';
import { IAgentEditorCommentsBridge, type IAgentEditorComment } from '../common/agentEditorComments.js';
import './media/agentEditorCommentsOverlayWidget.css';

export class AgentEditorCommentsEditorContribution extends Disposable {
	static readonly ID = 'workbench.contrib.agentEditorComments';
	private readonly editors = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	constructor(
		@ICodeEditorService editors: ICodeEditorService,
		@IAgentEditorCommentsBridge private readonly comments: IAgentEditorCommentsBridge,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(editors.onCodeEditorAdd(editor => this.attach(editor)));
		this._register(editors.onCodeEditorRemove(editor => this.editors.deleteAndDispose(editor)));
		for (const editor of editors.listCodeEditors()) this.attach(editor);
	}

	private attach(editor: ICodeEditor): void {
		if (editor.isSimpleWidget || this.editors.has(editor)) return;
		const resources = new DisposableStore();
		this.editors.set(editor, resources);
		const widget = resources.add(new MutableDisposable<AgentEditorCommentsOverlayWidget>());
		const update = () => {
			const resource = editor.getModel()?.uri;
			if (widget.value?.resource === resource) {
				if (resource && !this.comments.acceptsComments(resource)) widget.clear();
				return;
			}
			widget.clear();
			if (resource && this.comments.acceptsComments(resource)) {
				widget.value = this.instantiation.createInstance(AgentEditorCommentsOverlayWidget, editor, resource);
			}
		};
		resources.add(editor.onDidChangeModel(update));
		resources.add(this.comments.onDidChangeComments(resource => {
			if (resource.toString() === editor.getModel()?.uri.toString()) update();
		}));
		update();
	}
}

/** Shows controls for a single commentable editor model. The provider owns saved comments. */
class AgentEditorCommentsOverlayWidget extends Disposable implements IOverlayWidget {
	private readonly domNode: HTMLElement;
	private readonly add: HTMLButtonElement;
	private readonly previous: HTMLButtonElement;
	private readonly next: HTMLButtonElement;
	private readonly count: HTMLElement;
	private readonly zone: ReviewZoneWidget;
	private readonly drafts = new Map<number, { text: string; range: Range; }>();
	private selected: string | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		readonly resource: URI,
		@IAgentEditorCommentsBridge private readonly comments: IAgentEditorCommentsBridge,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
	) {
		super();
		const document = editor.getContainerDomNode().ownerDocument;
		this.add = this.button(document, localize('agentEditorComments.add', 'Add comment'), () => this.addComment());
		this.previous = this.button(document, localize('agentEditorComments.previous', 'Previous comment'), () => this.navigate(-1));
		this.next = this.button(document, localize('agentEditorComments.next', 'Next comment'), () => this.navigate(1));
		this.count = h(document, 'span', { attributes: { role: 'status' } });
		this.domNode = h(document, 'div', {
			className: 'ash-agent-editor-comments-overlay',
			attributes: { role: 'group', 'aria-label': localize('agentEditorComments.label', 'Agent comments') },
		}, this.add, this.previous, this.next, this.count);

		const glyphMargin = editor.getOption(EditorOption.glyphMargin);
		editor.updateOptions({ glyphMargin: true });
		this.zone = this._register(new ReviewZoneWidget(editor, {
			canAdd: () => comments.acceptsComments(resource),
			onOpen: () => { this.selected = undefined; },
			render: (line, body, resources) => this.renderThread(line, body, resources),
		}));
		editor.addOverlayWidget(this);
		this._register(toDisposable(() => {
			editor.removeOverlayWidget(this);
			if (!glyphMargin) editor.updateOptions({ glyphMargin });
		}));
		this._register(editor.onKeyDown(event => {
			if (event.isComposing || event.repeat || !event.matches({ code: 'KeyM', altKey: true, ctrlKey: !isMacintosh, metaKey: isMacintosh })) return;
			if (this.addComment()) event.stop({ preventDefault: true });
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				editor.focus();
			}
		}));
		this._register(addDisposableListener(this.domNode, 'focusin', () => {
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.AgentEditorComments);
			if (hint) this.domNode.setAttribute('aria-description', hint);
			else this.domNode.removeAttribute('aria-description');
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 115, name: `agentEditorComments.${editor.getId()}.${type}`,
				getProvider: () => {
					const focused = document.activeElement;
					if (!isHTMLElement(focused) || !editor.getContainerDomNode().contains(focused)) return undefined;
					return new AccessibleContentProvider(
						AccessibleViewProviderId.AgentEditorComments, { type },
						() => this.accessibleContent(type),
						() => focused.isConnected ? focused.focus() : editor.focus(),
						AccessibilityVerbositySettingId.AgentEditorComments,
					);
				},
			}));
		}
		this._register(comments.onDidChangeComments(changed => {
			if (resource.toString() === changed.toString()) this.refresh();
		}));
		this.refresh();
	}

	getId(): string { return 'agentEditorComments'; }
	getDomNode(): HTMLElement { return this.domNode; }
	getPosition(): { preference: OverlayWidgetPositionPreference; } {
		return { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER };
	}

	private button(document: Document, label: string, run: () => void, resources = this._store): HTMLButtonElement {
		const button = h(document, 'button', {
			className: 'ash-button ash-button-secondary',
			properties: { type: 'button' },
		}, label);
		resources.add(addDisposableListener(button, 'click', run));
		return button;
	}

	private orderedComments(): readonly IAgentEditorComment[] {
		return [...this.comments.getComments(this.resource)].sort((first, second) => Range.compareRangesUsingEnds(first.range, second.range));
	}

	private location(comment: IAgentEditorComment): string {
		const { startLineNumber, endLineNumber } = comment.range;
		return startLineNumber === endLineNumber
			? localize('agentEditorComments.line', 'Line {0}', startLineNumber)
			: localize('agentEditorComments.lines', 'Lines {0}–{1}', startLineNumber, endLineNumber);
	}

	private accessibleContent(type: AccessibleViewType): string {
		if (type === AccessibleViewType.Help) {
			return localize('agentEditorComments.help', 'Select text or move to a line. Choose Add comment or press Control+Alt+M (Command+Option+M on macOS). Save the comment to add it to the review draft. Use Previous comment and Next comment to browse comments. Press Escape to return to the editor.');
		}
		return this.orderedComments().map(comment => localize('agentEditorComments.text', '{0}: {1}', this.location(comment), comment.body)).join('\n\n')
			|| localize('agentEditorComments.empty', 'No comments.');
	}

	private addComment(): boolean {
		const selection = this.editor.getSelection();
		if (!selection) return false;
		const model = this.editor.getModel();
		if (!model) return false;
		const endsAtNextLine = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1;
		const line = selection.endLineNumber - Number(endsAtNextLine);
		const range = new Range(selection.startLineNumber, selection.startColumn, line,
			endsAtNextLine ? model.getLineMaxColumn(line) : selection.endColumn);
		if (!this.drafts.get(line)?.text) {
			this.zone.close();
			this.drafts.set(line, { text: '', range });
		}
		return this.zone.show(line, true);
	}

	private navigate(delta: number): void {
		const comments = this.orderedComments();
		if (!comments.length) return;
		const current = comments.findIndex(comment => comment.id === this.selected);
		const index = current === -1 ? (delta < 0 ? comments.length - 1 : 0) : (current + delta + comments.length) % comments.length;
		const target = comments[index]!;
		this.zone.show(target.range.endLineNumber);
		this.selected = target.id;
		this.editor.setSelection(Range.lift(target.range));
		status(localize('agentEditorComments.text', '{0}: {1}', this.location(target), target.body));
	}

	private refresh(): void {
		const comments = this.orderedComments();
		this.count.textContent = localize('agentEditorComments.count', 'Comments: {0}', comments.length);
		this.previous.disabled = this.next.disabled = comments.length === 0;
		this.zone.update(new Set(comments.map(comment => comment.range.endLineNumber)));
	}

	private renderThread(line: number, body: HTMLElement, resources: DisposableStore): HTMLElement {
		const document = body.ownerDocument;
		for (const comment of this.orderedComments().filter(comment => comment.range.endLineNumber === line)) {
			const remove = this.button(document, localize('agentEditorComments.delete', 'Delete comment'), () => {
				this.comments.deleteComment(this.resource, comment.id);
				body.querySelector('textarea')?.focus();
			}, resources);
			remove.setAttribute('aria-label', localize('agentEditorComments.deleteNamed', 'Delete comment: {0}', comment.body));
			body.append(h(document, 'div', { className: 'ash-agent-editor-comment' }, h(document, 'strong', this.location(comment)), h(document, 'p', comment.body), remove));
		}
		const draft = this.drafts.get(line) ?? { text: '', range: new Range(line, 1, line, 1) };
		const composer = h(document, 'textarea', {
			className: 'ash-agent-editor-comment-input',
			properties: { rows: 2, value: draft.text },
			attributes: { 'aria-label': localize('agentEditorComments.draft', 'Comment for the agent') },
		});
		const save = this.button(document, localize('agentEditorComments.save', 'Save comment'), () => {
			const text = composer.value.trim();
			if (!text) return;
			this.drafts.delete(line);
			if (!this.comments.addComment(this.resource, draft.range, text)) {
				this.drafts.set(line, draft);
				return;
			}
			body.querySelector('textarea')?.focus();
		}, resources);
		save.disabled = !draft.text.trim();
		resources.add(addDisposableListener(composer, 'input', () => {
			draft.text = composer.value;
			this.drafts.set(line, draft);
			save.disabled = !draft.text.trim();
		}));
		body.append(composer, save);
		return composer;
	}
}
