import { EditSources } from '../../../common/textModelEditSource.js';
import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { Range } from "../../../common/core/range.js";
import * as languages from '../../../common/languages.js';
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type View } from "../../../browser/view.js";
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { localize } from '../../../../nls.js';
import { IBulkEditService, type IBulkEditOptions } from '../../../browser/services/bulkEditService.js';

interface CodeActionEntry {
	readonly action: languages.LanguageCodeAction;
	readonly original: languages.LanguageCodeAction;
	readonly provider: languages.LanguageCodeActionProvider;
}

/** Owns code-action requests and routes selected edits through cursor commands. */
export class CodeActionController extends Disposable {
	static readonly ID = 'editor.contrib.codeActionController';
	static get(editor: ICodeEditor): CodeActionController | null {
		return editor.getContribution<CodeActionController>(CodeActionController.ID);
	}
	private menuContext: languages.LanguageCodeActionRequest | undefined;
	private request: AbortController | undefined;
	private context: languages.LanguageCodeActionRequest | undefined;
	private actions: readonly CodeActionEntry[] = [];

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly diagnostics: TextDecorationCollection<languages.LanguageDiagnostic>,
		private readonly applyWorkspaceEdit: ((edit: languages.LanguageWorkspaceEdit, options?: IBulkEditOptions) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
	) {
		super();
		if (diagnostics.textModel !== viewport.textModel || editor.getModel() !== viewport.textModel) {
			throw new TypeError("Code action dependencies must share one text model");
		}
		this._register(toDisposable(() => this.close()));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === "Escape" && this.request) {
				stopEvent(event);
				this.close();
				return;
			}
			if (event.altKey || (!event.ctrlKey && !event.metaKey) || event.key !== ".") return;
			if (!editor.getAction('editor.action.quickFix')?.isSupported()) return;
			stopEvent(event);
			editor.trigger('keyboard', 'editor.action.quickFix', {});
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.close()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.close()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(editor.onDidChangeCursorSelection(() => this.close()));
		this._register(editor.onDidScrollChange(() => this.close()));
		this._register(editor.onDidLayoutChange(() => this.close()));
		this._register(languageFeaturesService.codeActionProvider.onDidChange(() => this.close()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly)) this.close();
		}));
	}

	public async manualTriggerAtCurrentPosition(only?: readonly string[]): Promise<void> {
		this.close();
		const model = this.viewport.textModel;
		if (this.isDisposed || model.isDisposed() || this.editor.getOption(EditorOption.readOnly)) return;
		const range = this.editor.getSelection();
		if (!range) return;
		const controller = this.request = new AbortController();
		const context = this.context = {
			...languages.createLanguageFeatureRequest(model, model.getLanguageId(), controller.signal),
			resource: model.uri,
			range,
			only,
			diagnostics: this.diagnostics.decorations
				.filter(decoration => Range.areIntersectingOrTouching(decoration.range, range))
				.map(decoration => decoration.metadata),
		};
		try {
			const actions: CodeActionEntry[] = [];
			for (const provider of this.languageFeaturesService.codeActionProvider.ordered(model)) {
				if (!languages.isLanguageFeatureRequestCurrent(context)) return;
				try {
					const provided = await provider.provideCodeActions(context, controller.signal);
					if (!languages.isLanguageFeatureRequestCurrent(context)) return;
					for (const original of provided) {
						const action = normalizeLanguageCodeAction(original);
						// Providers can return broader results than requested; the selected action family controls the list.
						if (only && !only.some(kind => action.kind === kind || action.kind?.startsWith(`${kind}.`))) continue;
						actions.push({ action, original, provider });
					}
				} catch (error) {
					if (!languages.isLanguageFeatureRequestCurrent(context)) return;
					this.onError(error);
				}
			}
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			if (actions.length === 0) {
				this.viewport.announceAccessibilityStatus(localize('codeAction.empty', 'No code actions available.'));
				this.close();
				return;
			}
			this.actions = actions;
			this.render();
		} catch (error) {
			if (languages.isLanguageFeatureRequestCurrent(context)) {
				this.close();
				this.onError(error);
			}
		}
	}

	private render(): void {
		const position = this.editor.getSelection()?.getStartPosition();
		const context = this.context;
		if (!position || !context) return;
		const coordinates = this.editor.getScrolledVisiblePosition(position);
		if (!coordinates) return;
		const bounds = this.viewport.domNode.domNode.getBoundingClientRect();
		this.menuContext = context;
		const groups = new Map<string, IActionListItem<number>[]>();
		this.actions.forEach((entry, index) => {
			const title = codeActionGroupTitle(entry.action.kind);
			let items = groups.get(title);
			if (!items) {
				items = [];
				groups.set(title, items);
			}
			items.push({
				kind: ActionListItemKind.Action,
				item: index,
				group: { title },
				label: entry.action.disabledReason
					? localize('codeAction.disabled', '{0} ({1})', entry.action.title, entry.action.disabledReason)
					: entry.action.title,
				disabled: entry.action.disabledReason !== undefined,
				canPreview: entry.action.edit !== undefined || entry.provider.resolveCodeAction !== undefined,
			});
		});
		const items: IActionListItem<number>[] = [];
		for (const [title, groupItems] of groups) {
			if (groups.size > 1) {
				items.push({ kind: ActionListItemKind.Header, label: title });
			}
			items.push(...groupItems);
		}
		const groupEntries = [...groups.entries()];
		this.actionWidgetService.show(CodeActionController.ID, this.bulkEditService.hasPreviewHandler(), items, {
			onSelect: (index, preview) => this.apply(index, preview),
			onHide: didCancel => {
				this.menuContext = undefined;
				if (this.context === context && didCancel !== false) this.close();
			},
		}, {
			left: bounds.left + coordinates.left,
			top: bounds.top + coordinates.top,
			width: 0,
			height: coordinates.height,
		}, { showFilter: true }, groups.size > 1 ? {
			tabs: [
				{ id: 'all', label: localize('codeAction.allActions', 'All actions') },
				...groupEntries.map(([title], index) => ({ id: String(index), label: title })),
			],
			initialTab: 'all',
			createActionList: id => ({ items: id === 'all' ? items : groupEntries[Number(id)]![1] }),
		} : undefined);
	}

	private async apply(index: number, preview = false): Promise<void> {
		const entry = this.actions[index];
		const context = this.context;
		if (!entry || !context || !languages.isLanguageFeatureRequestCurrent(context) || entry.action.disabledReason !== undefined) return;
		let editDispatched = false;
		try {
			const resolved = !entry.action.edit && entry.provider.resolveCodeAction
				? normalizeLanguageCodeAction(await entry.provider.resolveCodeAction(entry.original, context, context.signal))
				: entry.action;
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			if (resolved.disabledReason !== undefined) {
				this.viewport.announceAccessibilityStatus(resolved.disabledReason);
				this.close();
				return;
			}
			if (!resolved.edit) {
				this.viewport.announceAccessibilityStatus(localize('codeAction.noEdit', '{0} has no text edit.', resolved.title));
				this.close();
				return;
			}
			const options: IBulkEditOptions = {
				editor: this.editor, label: resolved.title, quotableLabel: resolved.title,
				code: 'undoredo.codeAction', respectAutoSaveConfig: true, showPreview: preview,
				reason: EditSources.codeAction({ kind: resolved.kind, providerId: undefined }),
			};
			if (preview) {
				// Dismissing the menu hands focus to the preview without cancelling its version-bound request.
				this.actionWidgetService.hide(false);
				editDispatched = true;
				await this.bulkEditService.apply(resolved.edit, { ...options, token: context.signal });
			} else if (this.applyWorkspaceEdit) {
				editDispatched = true;
				await this.applyWorkspaceEdit(resolved.edit, options);
			} else {
				const documentEdit = resolved.edit.entries.find(edit => edit.kind === "textDocument" && edit.resource.toString() === context.resource.toString());
				if (resolved.edit.entries.length !== 1 || !documentEdit || documentEdit.kind !== "textDocument") throw new Error("This editor host cannot apply a multi-resource code action");
				if (documentEdit.version !== undefined && documentEdit.version !== context.snapshot.version) {
					throw new Error("Code action edit does not match the requested document version");
				}
				if (documentEdit.edits.length > 0) {
					editDispatched = true;
					this.editor.pushUndoStop();
					this.editor.executeEdits('editor.action.codeAction', [...documentEdit.edits]);
					this.editor.pushUndoStop();
				}
			}
			if (this.context === context) this.close();
		} catch (error) {
			if (editDispatched || languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
			if (preview && this.context === context) this.close();
		}
	}

	private close(): void {
		if (this.menuContext) {
			this.menuContext = undefined;
			this.actionWidgetService.hide();
		}
		this.request?.abort();
		this.request = undefined;
		this.context = undefined;
		this.actions = [];
	}
}

function codeActionGroupTitle(kind: string | undefined): string {
	switch (kind?.split('.')[0]) {
		case 'quickfix': return localize('codeAction.group.quickfix', 'Quick Fix');
		case 'refactor': return localize('codeAction.group.refactor', 'Refactor');
		case 'source': return localize('codeAction.group.source', 'Source Action');
		default: return localize('codeAction.group.other', 'Other Actions');
	}
}

function normalizeLanguageCodeAction(action: languages.LanguageCodeAction): languages.LanguageCodeAction {
	if (!action || typeof action !== "object" || typeof action.title !== "string" || action.title.trim().length === 0) {
		throw new TypeError("Code action title must be a non-empty string");
	}
	return Object.freeze({
		title: action.title,
		...(action.kind !== undefined ? { kind: action.kind } : {}),
		...(action.isPreferred !== undefined ? { isPreferred: action.isPreferred } : {}),
		...(action.disabledReason !== undefined ? { disabledReason: action.disabledReason } : {}),
		...(action.edit ? { edit: languages.normalizeLanguageWorkspaceEdit(action.edit) } : {}),
		...(action.data !== undefined ? { data: action.data } : {}),
	});
}
