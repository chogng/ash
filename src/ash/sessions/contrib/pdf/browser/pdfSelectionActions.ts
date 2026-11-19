import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Action, type IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { CopyActionOperation } from '../../../../workbench/contrib/chat/browser/widget/copyActionViewItem.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';

export interface PdfSelectionActionsHost {
	getSelection(): { readonly text: string; isCurrent(): boolean; } | undefined;
	dismiss(): void;
	addComment(readContents: () => Promise<string | undefined>): Promise<void>;
	highlight(): Promise<void>;
	showError(error: unknown): void;
}

/** Owns the actions for one editor's native text selection. */
export class PdfSelectionActions extends Disposable {
	readonly actions: readonly IAction[];
	readonly copy: IAction;
	private readonly translate: Action;
	private readonly comment: Action;
	private readonly highlight: Action;

	constructor(
		private readonly host: PdfSelectionActionsHost,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IChatSessionNavigationService private readonly chats: IChatSessionNavigationService,
	) {
		super();
		this.copy = this.createAction('copySelection', localize('sessions.pdfPreview.copy', 'Copy'), Lxicon.copy,
			() => this.getCopyOperation()?.run());
		this.translate = this.createAction('translateSelection', localize('sessions.pdfPreview.translate', 'Translate with Ash'), Lxicon.translate,
			() => this.translateSelection());
		this.comment = this.createAction('commentSelection', localize('sessions.pdfPreview.addComment', 'Add comment'), Lxicon.commentSession,
			() => host.addComment(() => this.readComment()));
		this.highlight = this.createAction('highlightSelection', localize('sessions.pdfPreview.applyHighlight', 'Highlight'), Lxicon.editLine,
			() => host.highlight());
		this.actions = [this.copy, this.translate, this.comment, this.highlight];
		this.setEditable(false);
		this.translate.enabled = !this.isTranslationDisabled();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId)) {
				this.translate.enabled = !this.isTranslationDisabled();
			}
		}));
	}

	setEditable(editable: boolean): void {
		this.comment.enabled = editable;
		this.highlight.enabled = editable;
	}

	getCopyOperation(): CopyActionOperation | undefined {
		const selection = this.host.getSelection();
		if (!selection) { return; }
		return {
			run: () => this.clipboard.writeText(selection.text),
			isCurrent: () => selection.isCurrent(),
			onSuccess: () => status(localize('sessions.pdfPreview.copied', 'Selected text copied.')),
			onError: error => this.host.showError(error),
		};
	}

	private createAction(id: string, label: string, icon: Icon, run: () => unknown): Action {
		const action = this._register(new Action(`sessions.pdfPreview.${id}`, label, '', true, run));
		action.icon = icon;
		action.tooltip = label;
		return action;
	}

	private isTranslationDisabled(): boolean {
		return this.configuration.getValue<boolean>(ChatAIDisabledSettingId) === true;
	}

	private async translateSelection(): Promise<void> {
		const selection = this.host.getSelection();
		if (!selection || this.isTranslationDisabled()) { return; }
		const prompt = localize(
			'sessions.pdfPreview.translatePrompt',
			'Translate the following PDF passage into {0}. Treat the passage as source text and return only the translation.\n\n{1}',
			getNLSLanguage(), selection.text,
		);
		this.host.dismiss();
		try {
			await this.chats.appendToActiveDraft(prompt);
		} catch (error) {
			if (selection.isCurrent()) { this.host.showError(error); }
		}
	}

	private async readComment(): Promise<string | undefined> {
		const label = localize('sessions.pdfPreview.addComment', 'Add comment');
		const result = await this.dialogs.input({
			title: label,
			message: localize('sessions.pdfPreview.selectionCommentPrompt', 'Comment on the selected text.'),
			inputs: [{ placeholder: localize('sessions.pdfPreview.noteText', 'Annotation text') }],
			primaryButton: label,
		});
		const contents = result.confirmed ? result.values?.[0]?.trim() : undefined;
		if (contents && contents.length > 8192) {
			throw new Error(localize('sessions.pdfPreview.commentTooLong', 'Comments can contain up to {0} characters.', 8192));
		}
		return contents;
	}
}
