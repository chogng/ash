import { exportDocsDocument, getDocsExportFormats } from '../../../src/ash/sessions/contrib/docs/browser/docsImportExport.js';
import './chatFixtureLocalization.js';
import '../../../src/ash/sessions/browser/media/style.css';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { bindTestColorTheme } from './themeFixture.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { loadArkdown } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownRuntime.js';
import { ArkdownEditor } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownEditor.js';
import type { DocsEditorMode } from '../../../src/ash/sessions/contrib/docs/common/docs.js';
import type { ArkdownTextColor } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownRuntime.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { DocsCommentsWidget } from '../../../src/ash/sessions/contrib/docs/browser/docsCommentsWidget.js';
import { DocsCommentState } from '../../../src/ash/sessions/contrib/docs/common/docsComments.js';
import type { DocsCommentDraft } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownComments.js';
import { ArkdownComments } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownComments.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { TestNotificationService } from '../../../src/ash/workbench/services/notification/test/common/testNotificationService.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { readArkdownImage, type ArkdownImageSource } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownImages.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { DocsSelectionToolbar } from '../../../src/ash/sessions/contrib/docs/browser/docsSelectionToolbar.js';
import '../../../src/ash/sessions/contrib/docs/browser/docsEditorPane.css';

const services = createTestEditorServices();
const dialogs = new DialogService();
const dialogHandler = new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body));
services.registerInstance(IDialogService, dialogs);
const notifications = new TestNotificationService();
services.registerInstance(INotificationService, notifications);
notifications.error = error => { errors.push(String(error)); };
const fixtureTheme = bindTestColorTheme(services.get(IThemeService), document.body);
const aria = setARIAContainer(document.body);
registerCodeEditorServices(services);
const backgroundEditors = new DisposableStore();
const imageToolbarResources = new DisposableStore();
const backgroundEditorLifetimes: DisposableStore[] = [];
window.addEventListener('pagehide', () => { comments?.dispose(); imageToolbarResources.dispose(); backgroundEditors.dispose(); editor?.dispose(); model?.dispose(); fixtureTheme.dispose(); aria.dispose(); notifications.dispose(); dialogHandler.dispose(); dialogs.dispose(); services.dispose(); }, { once: true });

let model: TextModel | undefined;
let editor: ArkdownEditor | undefined;
let comments: DocsCommentsWidget | undefined;
const errors: string[] = [];
const fixture = {
	async backgroundHighlights(count: number) {
		backgroundEditors.clear();
		backgroundEditorLifetimes.length = 0;
		const runtime = await loadArkdown();
		for (let index = 0; index < count; index++) {
			const lifetime = backgroundEditors.add(new DisposableStore());
			backgroundEditorLifetimes.push(lifetime);
			const parent = document.createElement('div');
			parent.hidden = true;
			document.body.append(parent);
			lifetime.add(toDisposable(() => parent.remove()));
			const model = lifetime.add(new TextModel('Remote shared document'));
			const editor = lifetime.add(services.createInstance(ArkdownEditor, parent, model, runtime, 'rich', (error: unknown) => errors.push(String(error)), () => {}));
			editor.setRemoteChanges(Array.from({ length: 6 }, (_, slot) => ({ id: slot, clientId: String(slot), start: 0, end: 6, inserted: 'Remote', removed: '' })));
		}
	},
	closeBackgroundEditor() { backgroundEditorLifetimes.pop()?.dispose(); },
	async mount(source: string, mode: DocsEditorMode = 'rich', inFrame = false) {
		comments?.dispose(); comments = undefined; imageToolbarResources.clear(); editor?.dispose(); model?.dispose(); errors.length = 0;
		const runtime = await loadArkdown();
		model = new TextModel(source);
		let parent = document.getElementById('root')!;
		if (inFrame) {
			const frame = document.createElement('iframe');
			frame.title = 'Document window';
			parent.replaceChildren(frame);
			parent = frame.contentDocument!.body;
		}
		editor = services.createInstance(ArkdownEditor, parent, model, runtime, mode, (error: unknown) => errors.push(String(error)), () => {});
		if (inFrame) {
			const outside = parent.ownerDocument.createElement('button');
			outside.textContent = 'Outside document';
			parent.append(outside);
		}
		editor.focus();
	},
	get source() { return model!.getValue(); },
	get plainText() { return editor!.getPlainText(); },
	get errors() { return [...errors]; },
	mode(value: DocsEditorMode) { editor!.setMode(value); },
	readOnly(value: boolean) { editor!.setReadOnly(value); },
	insertBlock(value: string) { editor!.insertBlock(value); },
	async insertImage(source: string, name = 'Studio.png') {
		const bytes = new Uint8Array(await (await fetch(source)).arrayBuffer());
		await editor!.insertImages(async () => [await readArkdownImage(bytes, name)]);
	},
	beginImage(source: string) {
		let resolve!: (value: readonly ArkdownImageSource[] | undefined) => void;
		const complete = editor!.insertImages(() => new Promise(done => { resolve = done; }));
		return { finish: async () => { resolve([{ source, description: 'Pending' }]); await complete; } };
	},
	imageActionAfterReplacement(source: string) {
		const action = editor!.selectedImage?.getActions(false).alignment[1];
		model!.setValue(source);
		return action?.run();
	},
	showImageToolbar() {
		imageToolbarResources.clear();
		const toolbar = imageToolbarResources.add(services.createInstance(DocsSelectionToolbar, document.getElementById('root')!, () => editor, () => editor!.selectedImage?.getActions(false).alignment ?? []));
		imageToolbarResources.add(editor!.onDidChangeSelection(() => toolbar.update()));
		toolbar.update();
	},
	setHeading(level: number) { editor!.setHeading(level); },
	setListKind(value: 'bullet' | 'ordered' | 'task') { editor!.setListKind(value); },
	get formatting() { return editor!.getSelectionFormatting(); },
	format(mark: '**' | '_' | '~~' | '`') { editor!.format(mark); },
	setTextColor(color: ArkdownTextColor | undefined) { editor!.setTextColor(color); },
	setHighlight(active: boolean) { editor!.setHighlight(active); },
	toggleUnderline() { editor!.toggleUnderline(); },
	indent(direction: 'increase' | 'decrease') { editor!.indentList(direction); },
	canIndent(direction: 'increase' | 'decrease') { return editor!.canIndentList(direction); },
	get selectionBounds() { return editor!.getSelectionBounds()?.toJSON(); },
	togglePageWidth() { editor!.togglePageWidth(); },
	get isPageWide() { return editor!.isPageWide; },
	get commentState() { const state = editor!.comments.snapshot; return { ...state, anchors: [...state.anchors] }; },
	captureComment() { return editor!.captureCommentSelection(); },
	createComment(body: string, draft?: DocsCommentDraft) { return editor!.comments.create(body, '11111111-1111-4111-8111-111111111111', draft); },
	replyComment(id: string, body: string) { editor!.comments.reply(id, body, '11111111-1111-4111-8111-111111111111'); },
	editComment(id: string, messageId: string, body: string) { editor!.comments.editMessage(id, messageId, body); },
	resolveComment(id: string, resolved: boolean) { editor!.comments.setState(id, resolved ? DocsCommentState.Resolved : DocsCommentState.Open); },
	deleteComment(id: string) { editor!.comments.deleteThread(id); },
	undo() { editor!.undo(); },
	redo() { editor!.redo(); },
	showComments() {
		if (!comments) { comments = services.createInstance(DocsCommentsWidget, document.getElementById('root')!); comments.setEditor(editor!); }
		comments.show();
	},
	requestComment() { editor!.requestComment(); },
	async switchDocument(source: string) {
		const runtime = await loadArkdown(), previous = editor, previousModel = model;
		model = new TextModel(source);
		editor = services.createInstance(ArkdownEditor, document.getElementById('root')!, model, runtime, 'rich', (error: unknown) => errors.push(String(error)), () => {});
		previous?.dispose(); previousModel?.dispose();
		comments?.setEditor(editor); editor.focus();
	},
	async concurrentCommentReplies() {
		const lifetime = new DisposableStore();
		try {
			const runtime = await loadArkdown();
			const commentsFor = (model: TextModel) => {
				const projection = lifetime.add(runtime.createProjection());
				return new ArkdownComments(model, runtime, () => true, () => ({ start: 0, end: 0 }), () => projection.parse(model.getValue()));
			};
			const initial = lifetime.add(new TextModel('Shared words'));
			const initialComments = commentsFor(initial);
			const threadId = initialComments.create('Initial comment', '11111111-1111-4111-8111-111111111111');
			const left = lifetime.add(runtime.createBuffer(41, initial.getValue())), right = lifetime.add(runtime.createBuffer(42, ''));
			right.applyUpdate(left.encodeUpdate());
			const make = (buffer: typeof left) => {
				const model = lifetime.add(new TextModel(buffer.source));
				lifetime.add(model.onDidChangeContent(event => buffer.apply(event.changes.map(edit => ({ range: { start: edit.rangeOffset, end: edit.rangeOffset + edit.rangeLength }, text: edit.text })))));
				return commentsFor(model);
			};
			make(left).reply(threadId, 'Concurrent left', '11111111-1111-4111-8111-111111111111');
			make(right).reply(threadId, 'Concurrent right', '22222222-2222-4222-8222-222222222222');
			const a = left.encodeUpdate(), b = right.encodeUpdate();
			left.applyUpdate(b); right.applyUpdate(a);
			const model = lifetime.add(new TextModel(left.source));
			const result = commentsFor(model).snapshot;
			return { converged: left.source === right.source, invalid: result.invalid, messages: result.threads[0]?.messages.map(message => message.body) };
		} finally { lifetime.dispose(); }
	},
	get exportFormats() { return getDocsExportFormats().map(format => ({ id: format.id, label: format.label, extension: format.extension })); },
	async exportFile(format: string, replacement?: string) {
		const pending = exportDocsDocument(model!.getValue(), format, document, new AbortController().signal);
		if (replacement !== undefined) model!.setValue(replacement);
		return Array.from(await pending);
	},
	async abortedExport(format: string) {
		const controller = new AbortController(); controller.abort();
		try { await exportDocsDocument(model!.getValue(), format, document, controller.signal); return false; }
		catch (error) { return error instanceof DOMException && error.name === 'AbortError'; }
	},
	external(source: string) { model!.setValue(source); },
};
declare global { interface Window { arkdownFixture: typeof fixture; } }
window.arkdownFixture = fixture;
document.getElementById('bold')!.onclick = () => editor!.format('**');
document.body.dataset.ready = 'true';
