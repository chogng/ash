import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { ISessionsEntryService } from '../../../../services/layout/common/sessionsEntryService.js';
import type { ArtifactToolbar, ArtifactToolbarAction } from '../../../artifact/browser/widget/artifactToolbar.js';
import type { ArkdownEditorPane } from '../../browser/arkdown/arkdownEditorPane.js';
import { DocsToolbar } from '../../browser/docsToolbar.js';
import { defaultDocsTypography, DocsFontFamily, type DocsTypography } from '../../common/docsTypography.js';

function fixture(options: { readonly readOnly?: boolean; readonly tableSelection?: boolean; readonly fileDialogs?: IFileDialogService; } = {}): { toolbar: DocsToolbar; actions: () => readonly ArtifactToolbarAction[]; } {
	let actions: readonly ArtifactToolbarAction[] = [];
	let wide = false;
	let typography = defaultDocsTypography;
	const edits: IAction[] = [
		{ id: 'arkdown.editor.bold', label: 'Bold', tooltip: 'Bold', enabled: true, run: () => { } },
		{ id: 'arkdown.editor.italic', label: 'Italic', tooltip: 'Italic', enabled: true, run: () => { } },
		{ id: 'arkdown.editor.toggleMode', label: 'Show Markdown source', tooltip: 'Show Markdown source', enabled: true, run: () => { } },
	];
	const widget = {
		hasTableSelection: options.tableSelection === true,
		get isPageWide() { return wide; }, togglePageWidth: () => { wide = !wide; },
		getMode: () => 'rich', getSelectionFormatting: () => ({ list: 'task', heading: 0 }), canIndentList: () => true,
		getTypography: () => typography, setTypography: (part: keyof DocsTypography, family: DocsFontFamily) => { typography = { ...typography, [part]: family }; },
		insertImages: (read: () => Promise<unknown>) => read(),
	};
	const editor = { isReadonly: options.readOnly === true, getEditingActions: () => edits, getControl: () => widget } as unknown as ArkdownEditorPane;
	const host = { createActionGroup: () => ({ setActions: (value: readonly ArtifactToolbarAction[]) => { actions = value; } }) } as unknown as ArtifactToolbar;
	const configuration = { onDidChangeConfiguration: Event.None, getValue: () => false } as unknown as IConfigurationService;
	const toolbar = new DocsToolbar(editor, host, () => 'Document', () => { }, {} as IDialogService, {} as IChatSessionNavigationService, {} as ISessionsEntryService, configuration, { error: (error: unknown) => { throw error; } } as unknown as INotificationService, options.fileDialogs ?? {} as IFileDialogService, {} as IFileService);
	toolbar.update();
	return { toolbar, actions: () => actions };
}

test('text style dropdown omits the inline actions already visible in the selection toolbar', () => {
	const value = fixture();
	try {
		const font = value.toolbar.getSelectionActions().find(action => action.id === 'sessions.docs.font')!;
		assert.deepEqual(font.menu!.map(action => action.id), ['sessions.docs.paragraph', 'sessions.docs.heading1', 'sessions.docs.heading2', 'sessions.docs.heading3']);
	} finally { value.toolbar.dispose(); }
});

test('image insertion opens the shared file chooser and cancellation does not read or insert files', async () => {
	let request: Parameters<IFileDialogService['showOpenDialog']>[0] | undefined;
	const value = fixture({ fileDialogs: { showOpenDialog: async options => { request = options; return undefined; } } as IFileDialogService });
	try {
		await value.actions().find(action => action.id === 'sessions.docs.image')!.run();
		assert.equal(request?.canSelectFiles, true); assert.equal(request?.canSelectFolders, false); assert.equal(request?.canSelectMany, true);
		assert.deepEqual(request?.filters?.[0].extensions, ['png', 'jpg', 'jpeg', 'gif', 'webp']);
	} finally { value.toolbar.dispose(); }
});

test('checklist insertion stays unpressed while the selection list menu reports task format', () => {
	const value = fixture();
	try {
		assert.equal(value.actions().find(action => action.id === 'sessions.docs.checklist')!.checked, undefined);
		const list = value.toolbar.getSelectionActions().find(action => action.id === 'sessions.docs.lists')!;
		assert.equal(list.menu!.find(action => action.id === 'sessions.docs.checklist')!.checked, true);
	} finally { value.toolbar.dispose(); }
});

test('cell selections expose inline formatting and disable block and link actions', () => {
	const value = fixture({ tableSelection: true });
	try {
		const selection = value.toolbar.getSelectionActions();
		assert.equal(selection.some(action => action.id === 'sessions.docs.font'), false);
		assert.equal(selection.find(action => action.id === 'sessions.docs.link')!.enabled, false);
		assert.equal(selection.find(action => action.id === 'sessions.docs.underline')!.enabled, true);
		assert.equal(value.actions().find(action => action.id === 'sessions.docs.typography')!.enabled, true);
		for (const id of ['table', 'image', 'checklist', 'dropdown']) {
			assert.equal(value.actions().find(action => action.id === `sessions.docs.${id}`)!.enabled, false);
		}
	} finally { value.toolbar.dispose(); }
});

test('document typography changes headings and body independently of selection formatting', async () => {
	const value = fixture();
	try {
		const menu = () => value.actions().find(action => action.id === 'sessions.docs.typography')!.menu!;
		assert.deepEqual(menu().map(action => action instanceof Separator ? '|' : action.id.slice('sessions.docs.typography.'.length)), ['headings', 'headings.serif', 'headings.sans', '|', 'text', 'text.serif', 'text.sans']);
		await menu().find(action => action.id.endsWith('headings.serif'))!.run(); value.toolbar.update();
		assert.equal(menu().find(action => action.id.endsWith('headings.serif'))!.checked, true);
		assert.equal(menu().find(action => action.id.endsWith('text.sans'))!.checked, true);
		assert.deepEqual(value.toolbar.getSelectionActions().find(action => action.id === 'sessions.docs.font')!.menu!.map(action => action.id), ['sessions.docs.paragraph', 'sessions.docs.heading1', 'sessions.docs.heading2', 'sessions.docs.heading3']);
	} finally { value.toolbar.dispose(); }
	const readOnly = fixture({ readOnly: true });
	try { assert.equal(readOnly.actions().find(action => action.id === 'sessions.docs.typography')!.enabled, false); }
	finally { readOnly.toolbar.dispose(); }
});

test('context More uses the standard submenu action consumed by the shared Menu', () => {
	const value = fixture();
	try {
		const more = value.toolbar.getContextActions().find(action => action.id === 'sessions.docs.more');
		assert.ok(more instanceof SubmenuAction);
		assert.ok(more.actions.some(action => action.id === 'sessions.docs.codeBlock'));
	} finally { value.toolbar.dispose(); }
});

test('More follows the insertion menu layout and document view actions remain reachable', () => {
	const value = fixture();
	try {
		const more = value.actions().find(action => action.id === 'sessions.docs.more')!;
		assert.deepEqual(more.menu!.map(action => action instanceof Separator ? '|' : action.id.slice('sessions.docs.'.length)),
			['bulletedList', 'numberedList', '|', 'codeBlock', 'divider', '|', 'date', '|', 'pageWidth']);
		assert.deepEqual(value.toolbar.getDocumentActions().map(action => action.id), ['arkdown.editor.toggleMode', 'sessions.docs.discussion']);
		assert.ok(value.toolbar.getContextActions().some(action => action.id === 'arkdown.editor.toggleMode'));
	} finally { value.toolbar.dispose(); }
});

test('page width is available for read-only documents and refreshes its menu label', async () => {
	const value = fixture({ readOnly: true });
	try {
		const before = value.actions().find(action => action.id === 'sessions.docs.more')!.menu!.find(action => action.id === 'sessions.docs.pageWidth')!;
		assert.equal(before.enabled, true);
		await before.run(); value.toolbar.update();
		const after = value.actions().find(action => action.id === 'sessions.docs.more')!.menu!.find(action => action.id === 'sessions.docs.pageWidth')!;
		assert.notEqual(after.label, before.label);
		await after.run(); value.toolbar.update();
		assert.equal(value.actions().find(action => action.id === 'sessions.docs.more')!.menu!.find(action => action.id === 'sessions.docs.pageWidth')!.label, before.label);
	} finally { value.toolbar.dispose(); }
});
