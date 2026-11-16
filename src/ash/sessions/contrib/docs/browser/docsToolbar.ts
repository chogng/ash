import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Keybinding, physicalKey, resolveKeybinding, type ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { arkdownTextColors } from './arkdown/arkdownRuntime.js';
import { docsTextColorIds } from './docsColors.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { basename } from '../../../../base/common/resources.js';
import { checkDocsImageSize, readArkdownImage } from './arkdown/arkdownImages.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { ArtifactToolbar, type ArtifactToolbarAction } from '../../artifact/browser/widget/artifactToolbar.js';
import { checklistIcon, tableIcon } from './docsIcons.js';
import { parseDocsDropdown, writeDocsDropdown } from '../common/docsDropdown.js';
import type { ArkdownEditorPane } from './arkdown/arkdownEditorPane.js';
import type { ArkdownEditor } from './arkdown/arkdownEditor.js';
import { DocsFontFamily } from '../common/docsTypography.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { MenuActionViewItem, type MenuActionViewItemOptions } from '../../../../base/browser/ui/menu/menu.js';

export interface DocsSelectionAction extends ArtifactToolbarAction {
	readonly section?: boolean;
	readonly keybinding?: ResolvedKeybinding;
	readonly ariaDescription?: string;
}

class DocsMenuSectionView extends ActionViewItem {
	constructor(action: IAction) { super(action); }
	render(container: HTMLElement): void {
		container.classList.add('ash-docs-menu-section');
		container.setAttribute('role', 'presentation');
		container.textContent = this.action.label;
	}
	setTabbable(): void { }
}

/** The document and selection menus share section labels and accessible group descriptions. */
export function getDocsMenuActionViewItem(action: IAction, options: MenuActionViewItemOptions): ActionViewItem | undefined {
	const item = action as DocsSelectionAction;
	if (item.section) return new DocsMenuSectionView(action);
	if (item.ariaDescription) return new MenuActionViewItem(action, { ...options, ariaDescription: item.ariaDescription });
	return undefined;
}

/** Docs contributes editing actions to the shared toolbar; Arkdown owns every document transaction. */
export class DocsToolbar extends Disposable {
	private readonly actions: WorkbenchToolBar;
	private renderedEditor: ArkdownEditor | undefined;
	private renderedState: string | undefined;

	constructor(
		private readonly editor: ArkdownEditorPane,
		toolbar: ArtifactToolbar,
		private readonly getTitle: () => string,
		private readonly showComments: () => void,
		@IDialogService private readonly dialogs: IDialogService,
		@IChatSessionNavigationService private readonly chats: IChatSessionNavigationService,
		@ISessionsEntryService private readonly entries: ISessionsEntryService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
	) {
		super();
		this.actions = toolbar.createActionGroup(localize({ bundle: 'ash.docs', key: 'actions' }, 'Docs actions'));
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(ChatAIDisabledSettingId)) this.update(); }));
	}

	update(): void {
		const widget = this.editor.getControl();
		const state = JSON.stringify([this.editor.isReadonly, widget?.getMode(), widget?.isPageWide, widget?.hasTableSelection, !!widget?.selectedImage, widget?.getSelectionFormatting(), widget?.getTypography(), this.configuration.getValue<boolean>(ChatAIDisabledSettingId)]);
		// Caret movement within one format must not recreate the toolbar's buttons or menus.
		if (this.renderedEditor === widget && this.renderedState === state) return;
		this.renderedEditor = widget;
		this.renderedState = state;
		this.actions.setActions(this.getActions());
	}

	getContextActions(): readonly IAction[] {
		return [...this.editor.getEditingActions().slice(0, 2), new Separator(),
		...this.getActions().map(action => action.menu ? new SubmenuAction(action.id, action.label, action.menu, action.icon) : action),
		new Separator(), ...this.getDocumentActions()];
	}

	getDocumentActions(): readonly IAction[] {
		return [...this.editor.getEditingActions().slice(2), {
			id: 'sessions.docs.discussion', label: localize({ bundle: 'ash.docs', key: 'discussion' }, 'Discuss document'),
			tooltip: localize({ bundle: 'ash.docs', key: 'discussion' }, 'Discuss document'), icon: Lxicon.commentSession,
			enabled: !!this.editor.getControl(), run: () => this.entries.setConversationVisible(true),
		}];
	}

	getSelectionActions(): readonly DocsSelectionAction[] {
		const widget = this.editor.getControl();
		if (widget?.selectedImage) {
			const actions = widget.selectedImage.getActions(widget.isPageWide);
			return [...actions.alignment, new Separator(), { id: 'sessions.docs.imageMore', label: localize({ bundle: 'ash.docs', key: 'more' }, 'More'), tooltip: localize({ bundle: 'ash.docs', key: 'more' }, 'More'), enabled: true, icon: Lxicon.ellipsis, menu: actions.more, run: () => undefined }];
		}
		const tableSelection = widget?.hasTableSelection === true;
		const actions = this.getActions();
		const formatting = widget?.getSelectionFormatting();
		const format = (id: string, label: string, icon: Icon, run: () => unknown, checked?: boolean): ArtifactToolbarAction => ({
			id: `sessions.docs.${id}`, label, tooltip: label, icon, enabled: !!widget && !this.editor.isReadonly, checked,
			run: async () => {
				try { await run(); }
				catch (error) { if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
			},
		});
		const textStyles = tableSelection ? [] : [{
			...format('font', localize({ bundle: 'ash.docs', key: 'textStyle' }, 'Text style'), Lxicon.font, () => undefined),
			menu: [
				format('paragraph', localize({ bundle: 'ash.docs', key: 'paragraph' }, 'Paragraph'), Lxicon.text, () => widget?.setHeading(0), formatting?.heading === 0),
				...[1, 2, 3].map(level => format(`heading${level}`, localize({ bundle: 'ash.docs', key: 'heading' }, 'Heading {0}', level), [Lxicon.heading1, Lxicon.heading2, Lxicon.heading3][level - 1], () => widget?.setHeading(level), formatting?.heading === level)),
			],
		}, new Separator()];
		const lists = actions.find(action => action.id === 'sessions.docs.more')!.menu!.slice(0, 2);
		const section = (id: string, label: string): DocsSelectionAction => ({ id, label, tooltip: label, enabled: false, section: true, run: () => undefined });
		const palette: readonly DocsSelectionAction[] = [
			section('sessions.docs.textSection', localize({ bundle: 'ash.docs', key: 'textSection' }, 'Text')),
			format('defaultTextColor', localize({ bundle: 'ash.docs', key: 'defaultColor' }, 'Default'), Lxicon.primitiveSquareFilled, () => widget?.setTextColor(undefined), formatting?.textColor === undefined),
			...arkdownTextColors.map(color => ({
				...format(`color.${color}`, {
					red: localize({ bundle: 'ash.docs', key: 'red' }, 'Red'),
					yellow: localize({ bundle: 'ash.docs', key: 'yellow' }, 'Yellow'),
					green: localize({ bundle: 'ash.docs', key: 'green' }, 'Green'),
					teal: localize({ bundle: 'ash.docs', key: 'teal' }, 'Teal'),
					purple: localize({ bundle: 'ash.docs', key: 'purple' }, 'Purple'),
				}[color], Lxicon.primitiveSquareFilled, () => widget?.setTextColor(color), formatting?.textColor === color),
				iconColor: `var(${colorCssVariable(docsTextColorIds[color])})`,
			})),
			new Separator(),
			section('sessions.docs.highlightSection', localize({ bundle: 'ash.docs', key: 'highlightSection' }, 'Highlight')),
			{ ...format('noHighlight', localize({ bundle: 'ash.docs', key: 'noHighlight' }, 'No highlight'), Lxicon.primitiveSquare, () => widget?.setHighlight(false), !formatting?.highlight && !formatting?.mixedHighlight), class: 'ash-docs-no-highlight' },
			{ ...format('yellowHighlight', localize({ bundle: 'ash.docs', key: 'yellow' }, 'Yellow'), Lxicon.primitiveSquareFilled, () => widget?.setHighlight(true), formatting?.highlight), iconColor: 'var(--ash-sessions-docs-highlightBackground)' },
		];
		let group = '';
		const describedPalette = palette.map(action => {
			if (action.section) group = action.label;
			return action instanceof Separator || action.section ? action : { ...action, ariaDescription: group };
		});
		const listMenu: readonly DocsSelectionAction[] = [
			...lists.map(action => ({ ...action, enabled: action.enabled && !tableSelection })), { ...actions.find(action => action.id === 'sessions.docs.checklist')!, checked: formatting?.list === 'task', enabled: !tableSelection && !this.editor.isReadonly }, new Separator(),
			{ ...format('increaseIndent', localize({ bundle: 'ash.docs', key: 'increaseIndent' }, 'Increase indent'), Lxicon.arrowRight, () => widget?.indentList('increase')), enabled: widget?.canIndentList('increase') ?? false, keybinding: resolveKeybinding(Keybinding.single(physicalKey('Tab'))) },
			{ ...format('decreaseIndent', localize({ bundle: 'ash.docs', key: 'decreaseIndent' }, 'Decrease indent'), Lxicon.arrowLeft, () => widget?.indentList('decrease')), enabled: widget?.canIndentList('decrease') ?? false, keybinding: resolveKeybinding(Keybinding.single(physicalKey('Tab', { shiftKey: true }))) },
		];
		return [
			format('addComment', localize({ bundle: 'ash.docs', key: 'addComment' }, 'Add comment'), Lxicon.commentSession, () => widget?.requestComment()),
			new Separator(),
			...textStyles,
			...this.editor.getEditingActions().slice(0, 2),
			format('underline', localize({ bundle: 'ash.docs', key: 'underline' }, 'Underline'), Lxicon.underline, () => widget?.toggleUnderline(), formatting?.underline),
			format('strikethrough', localize({ bundle: 'ash.docs', key: 'strikethrough' }, 'Strikethrough'), Lxicon.strikethrough, () => widget?.format('~~'), formatting?.strikethrough),
			format('inlineCode', localize({ bundle: 'ash.docs', key: 'inlineCode' }, 'Inline code'), Lxicon.bracket, () => widget?.format('`'), formatting?.code),
			{ ...format('colors', localize({ bundle: 'ash.docs', key: 'textAndHighlight' }, 'Text color and highlight'), Lxicon.symbolColor, () => undefined), menu: describedPalette },
			new Separator(),
			{ ...format('lists', localize({ bundle: 'ash.docs', key: 'lists' }, 'Lists'), formatting?.list === 'ordered' ? Lxicon.listOrdered : formatting?.list === 'task' ? checklistIcon : Lxicon.listUnordered, () => undefined, !!formatting?.list), class: 'ash-docs-list-selector', menu: listMenu },
			new Separator(),
			{ ...format('link', localize({ bundle: 'ash.docs', key: 'insertLink' }, 'Insert link'), Lxicon.link, () => this.insertLink()), enabled: !!widget && !tableSelection && !this.editor.isReadonly },
		];
	}

	private async insertLink(): Promise<void> {
		const widget = this.editor.getControl();
		if (!widget) return;
		const result = await this.dialogs.input({
			title: localize({ bundle: 'ash.docs', key: 'insertLink' }, 'Insert link'),
			message: localize({ bundle: 'ash.docs', key: 'linkUrl' }, 'Enter a link URL.'),
			inputs: [{ placeholder: 'https://' }],
		});
		if (!result.confirmed || widget !== this.editor.getControl() || widget.isDisposed || this.isDisposed) return;
		let url: URL;
		try { url = new URL(result.values?.[0]?.trim() ?? ''); } catch { throw new Error(localize({ bundle: 'ash.docs', key: 'invalidLinkUrl' }, 'Enter an HTTP, HTTPS or email link.')); }
		if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error(localize({ bundle: 'ash.docs', key: 'invalidLinkUrl' }, 'Enter an HTTP, HTTPS or email link.'));
		widget.setLink(url.href.replace(/[<>]/gu, value => encodeURIComponent(value)));
	}

	private getActions(): readonly ArtifactToolbarAction[] {
		const widget = this.editor.getControl();
		const editable = !!widget && !this.editor.isReadonly && widget.getMode() === 'rich' && !widget.hasTableSelection && !widget.selectedImage;
		const formatting = widget?.getSelectionFormatting();
		const action = (id: string, label: string, icon: Icon | undefined, run: () => unknown, enabled = editable, checked?: boolean): ArtifactToolbarAction => ({
			id: `sessions.docs.${id}`, label, tooltip: label, icon, enabled, checked,
			run: async () => {
				try { await run(); }
				catch (error) { if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
			},
		});
		const typography = widget?.getTypography();
		const canStyle = !!widget && !this.editor.isReadonly && widget.getMode() === 'rich';
		const typographyMenu: DocsSelectionAction[] = [];
		for (const part of ['headings', 'text'] as const) {
			const label = part === 'headings' ? localize({ bundle: 'ash.docs', key: 'headings' }, 'Headings') : localize({ bundle: 'ash.docs', key: 'typographyText' }, 'Text');
			if (typographyMenu.length) typographyMenu.push(new Separator());
			typographyMenu.push({ ...action(`typography.${part}`, label, undefined, () => undefined, false), section: true });
			for (const family of [DocsFontFamily.Serif, DocsFontFamily.Sans]) {
				typographyMenu.push({ ...action(`typography.${part}.${family}`, family === DocsFontFamily.Serif ? localize({ bundle: 'ash.docs', key: 'serif' }, 'Serif') : localize({ bundle: 'ash.docs', key: 'sans' }, 'Sans'), undefined, () => widget?.setTypography(part, family), canStyle, typography?.[part] === family), ariaDescription: label });
			}
		}
		const more = [
			action('bulletedList', localize({ bundle: 'ash.docs', key: 'bulletedList' }, 'Bulleted list'), Lxicon.listUnordered, () => widget?.setListKind('bullet'), editable, formatting?.list === 'bullet'),
			action('numberedList', localize({ bundle: 'ash.docs', key: 'numberedList' }, 'Numbered list'), Lxicon.listOrdered, () => widget?.setListKind('ordered'), editable, formatting?.list === 'ordered'),
			new Separator(),
			action('codeBlock', localize({ bundle: 'ash.docs', key: 'codeBlock' }, 'Code block'), Lxicon.code, () => widget?.insertBlock('```\n\n```')),
			action('divider', localize({ bundle: 'ash.docs', key: 'divider' }, 'Divider'), Lxicon.remove, () => widget?.insertBlock('---')),
			new Separator(),
			action('date', localize({ bundle: 'ash.docs', key: 'date' }, 'Date'), Lxicon.calendar, () => widget?.insertBlock(new Date().toLocaleDateString())),
			new Separator(),
			action('pageWidth', widget?.isPageWide
				? localize({ bundle: 'ash.docs', key: 'makePageNarrow' }, 'Make page narrow')
				: localize({ bundle: 'ash.docs', key: 'makePageWide' }, 'Make page wide'), Lxicon.arrowSwap, () => widget?.togglePageWidth(), !!widget && widget.getMode() === 'rich'),
		];
		const canAsk = !!widget && !widget.selectedImage && this.configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true;
		return [
			{ ...action('typography', localize({ bundle: 'ash.docs', key: 'typography' }, 'Typography'), Lxicon.font, () => undefined, canStyle), menu: typographyMenu },
			action('table', localize({ bundle: 'ash.docs', key: 'insertTable' }, 'Insert table'), tableIcon, () => {
				const columns = [1, 2, 3].map(index => localize({ bundle: 'ash.docs', key: 'column' }, 'Column {0}', index));
				widget?.insertBlock(`| ${columns.join(' | ')} |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |`);
			}),
			action('image', localize({ bundle: 'ash.docs', key: 'insertImage' }, 'Insert image'), Lxicon.imageSimple, () => this.insertImage()),
			action('checklist', localize({ bundle: 'ash.docs', key: 'checklist' }, 'Checklist'), checklistIcon, () => widget?.setListKind('task')),
			action('dropdown', localize({ bundle: 'ash.docs', key: 'insertDropdown' }, 'Insert dropdown'), Lxicon.dropdown, () => this.insertDropdown()),
			{ ...action('more', localize({ bundle: 'ash.docs', key: 'more' }, 'More'), Lxicon.ellipsis, () => undefined, !!widget), menu: more },
			action('comments', localize({ bundle: 'ash.docs', key: 'comments' }, 'Comments'), Lxicon.commentSession, () => this.showComments(), !!widget),
			{ ...action('askAsh', localize({ bundle: 'ash.docs', key: 'askAsh' }, 'Ask Ash'), undefined, () => this.askAsh(), canAsk), iconOnly: false, presentation: 'secondary' },
		];
	}

	private async insertImage(): Promise<void> {
		const widget = this.editor.getControl();
		if (!widget) return;
		await widget.insertImages(async () => {
			const resources = await this.fileDialogs.showOpenDialog({ title: localize({ bundle: 'ash.docs', key: 'insertImage' }, 'Insert image'), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: [{ name: localize({ bundle: 'ash.docs', key: 'images' }, 'Images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
			if (!resources?.length || widget !== this.editor.getControl() || widget.isDisposed || this.isDisposed) return;
			const images = [];
			for (const resource of resources) {
				checkDocsImageSize((await this.files.stat(resource)).sizeBytes);
				const { bytes } = await this.files.readFileBytes(resource);
				images.push(await readArkdownImage(bytes, basename(resource)));
			}
			if (widget !== this.editor.getControl() || this.isDisposed) return;
			return images;
		});
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
