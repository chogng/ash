import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { EditSources } from '../../../common/textModelEditSource.js';
import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';

import * as languages from '../../../common/languages.js';
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type View } from "../../../browser/view.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeActionTriggerType } from '../../../common/languages.js';
import { CodeActionAutoApply, CodeActionTriggerSource, type CodeActionItem, type CodeActionFilter } from '../common/types.js';
import { CodeActionModel, CodeActionsState } from './codeActionModel.js';
import { CodeActionKeybindingResolver } from './codeActionKeybindingResolver.js';
import { toMenuItems } from './codeActionMenu.js';
import { LightBulbWidget } from './lightBulbWidget.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { localize } from '../../../../nls.js';
import { IBulkEditService, type IBulkEditOptions } from '../../../browser/services/bulkEditService.js';

/** Owns action presentation and edit submission; CodeActionModel owns request validity. */
export class CodeActionController extends Disposable {
	static readonly ID = 'editor.contrib.codeActionController';
	static get(editor: ICodeEditor): CodeActionController | null {
		return editor.getContribution<CodeActionController>(CodeActionController.ID);
	}
	private menuContext: languages.LanguageCodeActionRequest | undefined;
	private readonly model: CodeActionModel;
	private readonly lightbulb: LightBulbWidget;
	private readonly keybindings: CodeActionKeybindingResolver;
	private actions: readonly CodeActionItem[] = [];
	private get context(): languages.LanguageCodeActionRequest | undefined {
		return this.model.state.type === CodeActionsState.Type.Triggered ? this.model.state.context : undefined;
	}

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly diagnostics: TextDecorationCollection<languages.LanguageDiagnostic>,
		private readonly applyWorkspaceEdit: ((edit: languages.LanguageWorkspaceEdit, options?: IBulkEditOptions) => void | boolean | Promise<void | boolean>) | undefined,
		private readonly onError: (error: unknown) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IAccessibilitySignalService private readonly signals: IAccessibilitySignalService,
	) {
		super();
		if (diagnostics.textModel !== viewport.textModel || editor.getModel() !== viewport.textModel) {
			throw new TypeError("Code action dependencies must share one text model");
		}
		this.model = this._register(instantiationService.createInstance(CodeActionModel, editor, diagnostics, onError));
		this.lightbulb = this._register(instantiationService.createInstance(LightBulbWidget, editor));
		this.keybindings = instantiationService.createInstance(CodeActionKeybindingResolver);
		this._register(this.model.onDidChangeState(state => {
			this.hideMenu();
			this.lightbulb.hide();
			if (state.type === CodeActionsState.Type.Triggered && state.trigger.type === CodeActionTriggerType.Auto) {
				void state.actions.then(actions => {
					if (this.model.state === state) { this.lightbulb.update(actions, state.trigger, state.position); }
				}).catch(onError);
			}
		}));
		this._register(this.lightbulb.onClick(trigger => {
			void this.manualTriggerAtCurrentPosition(localize('codeAction.empty', 'No code actions available.'),
				CodeActionTriggerSource.Lightbulb, { ...trigger.filter, includeSourceActions: true }).catch(onError);
		}));
		this._register(toDisposable(() => this.close()));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === "Escape" && this.context) {
				stopEvent(event);
				this.close();
				return;
			}
			if (event.altKey || (!event.ctrlKey && !event.metaKey) || event.key !== ".") return;
			if (!editor.getAction('editor.action.quickFix')?.isSupported()) return;
			stopEvent(event);
			editor.trigger('keyboard', 'editor.action.quickFix', {});
		}));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(editor.onDidScrollChange(() => this.close()));
		this._register(editor.onDidLayoutChange(() => this.close()));
	}

	public async manualTriggerAtCurrentPosition(notAvailableMessage: string, triggerAction: CodeActionTriggerSource, filter?: CodeActionFilter, autoApply = CodeActionAutoApply.Never): Promise<void> {
		this.close();
		const state = this.model.trigger({
			type: CodeActionTriggerType.Invoke, triggerAction, filter, autoApply,
		});
		if (!state) { return; }
		void this.signals.playSignal(AccessibilitySignal.codeActionTriggered);
		try {
			const actions = await state.actions;
			if (this.model.state !== state) { return; }
			if (actions.allActions.length === 0) {
				this.viewport.announceAccessibilityStatus(notAvailableMessage);
				this.close();
				return;
			}
			this.actions = actions.allActions;
			if (actions.validActions.length > 0 && (autoApply === CodeActionAutoApply.First
				|| autoApply === CodeActionAutoApply.IfSingle && actions.validActions.length === 1)) {
				await this.apply(actions.validActions[0]!);
				return;
			}
			this.render();
		} catch (error) {
			if (this.model.state === state) { this.close(); this.onError(error); }
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
		const items = toMenuItems(this.actions, true, this.keybindings.getResolver());
		const groups = new Map<string, IActionListItem<CodeActionItem>[]>();
		for (const item of items) {
			if (item.kind !== ActionListItemKind.Action) { continue; }
			const title = item.group!.title;
			let group = groups.get(title);
			if (!group) { group = []; groups.set(title, group); }
			group.push(item);
		}
		const groupEntries = [...groups.entries()];
		this.actionWidgetService.show(CodeActionController.ID, this.bulkEditService.hasPreviewHandler(), items, {
			onSelect: (entry, preview) => this.apply(entry, preview),
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

	private async apply(entry: CodeActionItem, preview = false): Promise<void> {
		const context = this.context;
		if (!entry || !context || !languages.isLanguageFeatureRequestCurrent(context) || entry.action.disabledReason !== undefined) return;
		let editDispatched = false;
		let applied = false;
		try {
			const resolved = entry.action.edit || !entry.provider.resolveCodeAction
				? entry.action : (await entry.resolve(context)).action;
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
				applied = (await this.bulkEditService.apply(resolved.edit, { ...options, token: context.signal })).isApplied;
			} else if (this.applyWorkspaceEdit) {
				editDispatched = true;
				applied = await this.applyWorkspaceEdit(resolved.edit, options) === true;
			} else {
				const documentEdit = resolved.edit.entries.find(edit => edit.kind === "textDocument" && edit.resource.toString() === context.resource.toString());
				if (resolved.edit.entries.length !== 1 || !documentEdit || documentEdit.kind !== "textDocument") throw new Error("This editor host cannot apply a multi-resource code action");
				if (documentEdit.version !== undefined && documentEdit.version !== context.snapshot.version) {
					throw new Error("Code action edit does not match the requested document version");
				}
				if (documentEdit.edits.length > 0) {
					editDispatched = true;
					this.editor.pushUndoStop();
					applied = this.editor.executeEdits('editor.action.codeAction', [...documentEdit.edits]);
					this.editor.pushUndoStop();
				}
			}
			if (applied && !this.isDisposed) { void this.signals.playSignal(AccessibilitySignal.codeActionApplied); }
			if (this.context === context) this.close();
		} catch (error) {
			if (editDispatched || languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
			if (preview && this.context === context) this.close();
		}
	}

	private hideMenu(): void {
		if (this.menuContext) {
			this.menuContext = undefined;
			this.actionWidgetService.hide();
		}
		this.actions = [];
	}
	private close(): void {
		this.hideMenu();
		this.model.reset();
		this.lightbulb.hide();
	}
}
