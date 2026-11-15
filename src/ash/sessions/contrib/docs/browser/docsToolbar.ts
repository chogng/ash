import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { Icon } from '../../../../base/common/icon.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { ArtifactToolbar, type ArtifactToolbarAction } from '../../artifact/browser/widget/artifactToolbar.js';
import { checklistIcon, tableIcon } from './docsIcons.js';
import { parseDocsDropdown, writeDocsDropdown } from '../common/docsDropdown.js';
import type { ArkdownEditorPane } from './arkdown/arkdownEditorPane.js';
import type { ArkdownEditor } from './arkdown/arkdownEditor.js';

/** Docs contributes editing actions to the shared toolbar; Arkdown owns every document transaction. */
export class DocsToolbar extends Disposable {
	private readonly actions: WorkbenchToolBar;
	private renderedEditor: ArkdownEditor | undefined;
	private renderedState: string | undefined;

	constructor(
		private readonly editor: ArkdownEditorPane,
		toolbar: ArtifactToolbar,
		private readonly getTitle: () => string,
		@IDialogService private readonly dialogs: IDialogService,
		@IChatSessionNavigationService private readonly chats: IChatSessionNavigationService,
		@ISessionsEntryService private readonly entries: ISessionsEntryService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.actions = toolbar.createActionGroup(localize({ bundle: 'ash.docs', key: 'actions' }, 'Docs actions'));
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(ChatAIDisabledSettingId)) this.update(); }));
	}

	update(): void {
		const widget = this.editor.getControl();
		const state = JSON.stringify([this.editor.isReadonly, widget?.getMode(), widget?.getSelectionFormatting(), this.configuration.getValue<boolean>(ChatAIDisabledSettingId)]);
		// Caret movement within one format must not recreate the toolbar's buttons or menus.
		if (this.renderedEditor === widget && this.renderedState === state) return;
		this.renderedEditor = widget;
		this.renderedState = state;
		this.actions.setActions(this.getActions());
	}

	getContextActions(): readonly IAction[] {
		return [...this.editor.getEditingActions(), new Separator(), ...this.getActions().slice(1)];
	}

	private getActions(): readonly ArtifactToolbarAction[] {
		const widget = this.editor.getControl();
		const editable = !!widget && !this.editor.isReadonly && widget.getMode() === 'rich';
		const formatting = widget?.getSelectionFormatting();
		const action = (id: string, label: string, icon: Icon | undefined, run: () => unknown, enabled = editable, checked?: boolean): ArtifactToolbarAction => ({
			id: `sessions.docs.${id}`, label, tooltip: label, icon, enabled, checked,
			run: async () => {
				try { await run(); }
				catch (error) { if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
			},
		});
		const paragraph = localize({ bundle: 'ash.docs', key: 'paragraph' }, 'Paragraph');
		const fontMenu = [
			...this.editor.getEditingActions().slice(0, 2), new Separator(),
			action('paragraph', paragraph, Lxicon.text, () => widget?.setHeading(0), editable, formatting?.heading === 0),
			...[1, 2, 3].map(level => action(`heading${level}`, localize({ bundle: 'ash.docs', key: 'heading' }, 'Heading {0}', level), [Lxicon.heading1, Lxicon.heading2, Lxicon.heading3][level - 1], () => widget?.setHeading(level), editable, formatting?.heading === level)),
		];
		const more = [
			action('bulletedList', localize({ bundle: 'ash.docs', key: 'bulletedList' }, 'Bulleted list'), Lxicon.listUnordered, () => widget?.setListKind('bullet'), editable, formatting?.list === 'bullet'),
			action('numberedList', localize({ bundle: 'ash.docs', key: 'numberedList' }, 'Numbered list'), Lxicon.listOrdered, () => widget?.setListKind('ordered'), editable, formatting?.list === 'ordered'),
			new Separator(),
			action('codeBlock', localize({ bundle: 'ash.docs', key: 'codeBlock' }, 'Code block'), Lxicon.bracket, () => widget?.insertBlock('```\n\n```')),
			action('divider', localize({ bundle: 'ash.docs', key: 'divider' }, 'Divider'), Lxicon.remove, () => widget?.insertBlock('---')),
			new Separator(),
			action('date', localize({ bundle: 'ash.docs', key: 'date' }, 'Date'), Lxicon.calendar, () => widget?.insertBlock(new Date().toLocaleDateString())),
			new Separator(),
			...this.editor.getEditingActions().slice(2),
		];
		const canAsk = !!widget && this.configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true;
		return [
			{ ...action('font', localize({ bundle: 'ash.docs', key: 'font' }, 'Font'), Lxicon.font, () => undefined), menu: fontMenu },
			action('table', localize({ bundle: 'ash.docs', key: 'insertTable' }, 'Insert table'), tableIcon, () => {
				const columns = [1, 2, 3].map(index => localize({ bundle: 'ash.docs', key: 'column' }, 'Column {0}', index));
				widget?.insertBlock(`| ${columns.join(' | ')} |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |`);
			}),
			action('image', localize({ bundle: 'ash.docs', key: 'insertImage' }, 'Insert image'), Lxicon.imageSimple, () => this.insertImage()),
			action('checklist', localize({ bundle: 'ash.docs', key: 'checklist' }, 'Checklist'), checklistIcon, () => widget?.setListKind('task'), editable, formatting?.list === 'task'),
			action('dropdown', localize({ bundle: 'ash.docs', key: 'insertDropdown' }, 'Insert dropdown'), Lxicon.dropdown, () => this.insertDropdown()),
			{ ...action('more', localize({ bundle: 'ash.docs', key: 'more' }, 'More'), Lxicon.ellipsis, () => undefined, !!widget), menu: more },
			action('discussion', localize({ bundle: 'ash.docs', key: 'discussion' }, 'Discuss document'), Lxicon.commentSession, () => this.entries.setConversationVisible(true), !!widget),
			{ ...action('askAsh', localize({ bundle: 'ash.docs', key: 'askAsh' }, 'Ask Ash'), undefined, () => this.askAsh(), canAsk), iconOnly: false, presentation: 'secondary' },
		];
	}

	private async insertImage(): Promise<void> {
		const widget = this.editor.getControl();
		if (!widget) return;
		const result = await this.dialogs.input({
			title: localize({ bundle: 'ash.docs', key: 'insertImage' }, 'Insert image'),
			message: localize({ bundle: 'ash.docs', key: 'imageUrl' }, 'Enter an image URL and description.'),
			inputs: [{ placeholder: 'https://' }, { placeholder: localize({ bundle: 'ash.docs', key: 'imageDescription' }, 'Image description') }],
		});
		if (!result.confirmed || widget !== this.editor.getControl() || widget.isDisposed || this.isDisposed) return;
		let url: URL;
		try { url = new URL(result.values?.[0]?.trim() ?? ''); } catch { throw new Error(localize({ bundle: 'ash.docs', key: 'invalidImageUrl' }, 'Enter an HTTP or HTTPS image URL.')); }
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(localize({ bundle: 'ash.docs', key: 'invalidImageUrl' }, 'Enter an HTTP or HTTPS image URL.'));
		const description = (result.values?.[1] ?? '').replace(/[\\\[\]]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
		widget.insertBlock(`![${description}](<${url.href.replace(/>/gu, '%3E')}>)`);
	}

	private async insertDropdown(): Promise<void> {
		const widget = this.editor.getControl();
		if (!widget) return;
		const result = await this.dialogs.input({
			title: localize({ bundle: 'ash.docs', key: 'insertDropdown' }, 'Insert dropdown'),
			message: localize({ bundle: 'ash.docs', key: 'dropdownOptions' }, 'Enter a label and 2–20 options separated by commas.'),
			inputs: [{ value: localize({ bundle: 'ash.docs', key: 'dropdownLabel' }, 'Choose an option') }, { value: localize({ bundle: 'ash.docs', key: 'dropdownDefaults' }, 'Option 1, Option 2, Option 3') }],
		});
		if (!result.confirmed || widget !== this.editor.getControl() || widget.isDisposed || this.isDisposed) return;
		const dropdown = parseDocsDropdown({ label: result.values?.[0]?.trim(), options: result.values?.[1]?.split(/[,，]/u).map(value => value.trim()), selected: 0 });
		if (!dropdown) throw new Error(localize({ bundle: 'ash.docs', key: 'invalidDropdown' }, 'Enter a label and 2–20 non-empty options, each up to 100 characters.'));
		widget.insertBlock(writeDocsDropdown(dropdown));
	}

	private async askAsh(): Promise<void> {
		const widget = this.editor.getControl();
		if (!widget || this.configuration.getValue<boolean>(ChatAIDisabledSettingId) === true) return;
		const content = widget.getSelectedText() || widget.getText();
		const prompt = localize({ bundle: 'ash.docs', key: 'askPrompt' }, 'Help with this document: {0}\n\n{1}\n\nRequest: ', this.getTitle(), content);
		await this.entries.setConversationVisible(true);
		if (widget !== this.editor.getControl() || this.isDisposed) return;
		await this.chats.appendToActiveDraft(prompt);
	}
}
