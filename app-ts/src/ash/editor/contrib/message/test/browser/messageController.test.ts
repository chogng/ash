import '../../../../test/browser/testEditorDom.js';
import { browserEnvironment as environment } from '../../../../test/browser/testEditorDom.js';
import { h } from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { URI } from '../../../../../base/common/uri.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { ICodeEditorService } from '../../../../browser/services/codeEditorService.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { StandaloneCodeEditorService } from '../../../../standalone/browser/standaloneCodeEditorService.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import '../../browser/messageController.js';
import '../../../readOnlyMessage/browser/contribution.js';

setARIAContainer(environment.window.document.body);

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { MessageController } = await import('../../browser/messageController.js');
const { ReadOnlyMessageController } = await import('../../../readOnlyMessage/browser/contribution.js');


test('read-only edit attempts use MessageController and close after cursor movement', () => {
	const container = h(environment.window.document, 'main');
	using model = new TextModel('alpha\nbeta');
	using editor = createTestCodeEditor({
		container,
		model,
		readOnly: true,
		lineHeight: 20,
	});
	editor.layout({ width: 400, height: 100 });
	assert.ok(editor.getContribution(ReadOnlyMessageController.ID));
	editor.executeCommand('test', {
		getEditOperations: (_textModel, builder) => builder.addEditOperation({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, 'x'),
		computeCursorState: () => Selection.fromPositions(new Position(1, 2)),
	});

	const messages = MessageController.get(editor);
	assert.ok(messages?.isVisible());
	const messageWidget = environment.window.document.body.querySelector<HTMLElement>('.stanza-editor-overlay-message');
	assert.ok(messageWidget);
	assert.match(messageWidget.textContent ?? '', /Cannot edit in read-only editor/);
	editor.setSelection(Selection.fromPositions(new Position(2, 1)));
	assert.equal(messages?.isVisible(), false);
	messages.showMessage('Closing message', new Position(1, 1));
	assert.equal(messages.isVisible(), true);
	messages.showMessage(new MarkdownString('a<em>b</em>c'), new Position(1, 1));
	assert.equal(environment.window.document.querySelector('.stanza-editor-overlay-message em'), null);
	assert.match(environment.window.document.querySelector('.stanza-editor-overlay-message')?.textContent ?? '', /abc/);
	messages.showMessage(new MarkdownString('a<em>b</em>c', { supportHtml: true }), new Position(1, 1));
	assert.equal(environment.window.document.querySelector('.stanza-editor-overlay-message em')?.textContent, 'b');
	messages.dispose();
	assert.equal(messages.isVisible(), false);
	assert.equal(environment.window.document.body.querySelector('.stanza-editor-overlay-message'), null);
});

test('Markdown resource links open through the code editor service', async () => {
	const container = h(environment.window.document, 'main');
	environment.window.document.body.append(container);
	using containerCleanup = toDisposable(() => container.remove());
	using model = new TextModel('alpha');
	const openedResources: URI[] = [];
	using codeEditorService = new StandaloneCodeEditorService();
	using openHandler = codeEditorService.registerCodeEditorOpenHandler(async ({ resource }) => {
		openedResources.push(resource);
		return null;
	});
	using services = new ServiceContainer();
	services.registerInstance(ICodeEditorService, codeEditorService);
	using editor = createTestCodeEditor({ container, model, instantiationService: services });
	editor.layout({ width: 400, height: 100 });
	const messages = MessageController.get(editor);
	assert.ok(messages);
	messages.showMessage(new MarkdownString('[remote](vscode-remote://ssh-remote+host/src/file.ts)'), new Position(1, 1));
	editor.layout({ width: 400, height: 100 });
	const link = environment.window.document.body.querySelector<HTMLAnchorElement>('.stanza-editor-overlay-message a');
	assert.ok(link);
	link.dispatchEvent(new environment.window.MouseEvent('click', { bubbles: true, cancelable: true }));
	await Promise.resolve();
	messages.showMessage(new MarkdownString('[Ash remote](ash-remote://ssh+host/src/ash.ts)'), new Position(1, 1));
	editor.layout({ width: 400, height: 100 });
	const ashLink = environment.window.document.body.querySelector<HTMLAnchorElement>('.stanza-editor-overlay-message a');
	assert.ok(ashLink);
	ashLink.dispatchEvent(new environment.window.MouseEvent('click', { bubbles: true, cancelable: true }));
	await Promise.resolve();
	assert.deepEqual(openedResources.map(resource => resource.toString()), [
		'vscode-remote://ssh-remote+host/src/file.ts',
		'ash-remote://ssh+host/src/ash.ts',
	]);
	messages.dispose();
});
