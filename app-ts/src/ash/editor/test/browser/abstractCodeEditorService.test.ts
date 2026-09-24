import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { AbstractCodeEditorService } from '../../browser/services/abstractCodeEditorService.js';
import { type ICodeEditor } from '../../browser/editorBrowser.js';
import { TextModel } from '../../common/model/textModel.js';

class TestCodeEditorService extends AbstractCodeEditorService {
	getActiveCodeEditor(): ICodeEditor | null {
		return this.getFocusedCodeEditor() ?? this.listCodeEditors().at(-1) ?? null;
	}
}

test('code editor open handlers use newest-first registration and dispose independently', async () => {
	using service = new TestCodeEditorService();
	const first = { getId: () => 'first' } as unknown as ICodeEditor;
	const second = { getId: () => 'second' } as unknown as ICodeEditor;
	using registrations = new DisposableStore();
	const calls: string[] = [];
	let newerHandles = false;
	const old = registrations.add(service.registerCodeEditorOpenHandler(async (_input, _source, sideBySide) => {
		calls.push(`first:${sideBySide}`);
		return first;
	}));
	registrations.add(service.registerCodeEditorOpenHandler(async (_input, _source, sideBySide) => {
		calls.push(`second:${sideBySide}`);
		return newerHandles ? second : null;
	}));
	assert.equal(await service.openCodeEditor({ resource: URI.parse('file:///document.ts') }, null), first);
	newerHandles = true;
	assert.equal(await service.openCodeEditor({ resource: URI.parse('file:///document.ts') }, null, true), second);
	old.dispose();
	assert.equal(await service.openCodeEditor({ resource: URI.parse('file:///document.ts') }, null, false), second);
	assert.deepEqual(calls, ['second:undefined', 'first:undefined', 'second:true', 'second:false']);
});

test('code editor registry owns identity, focus selection, and removal events', () => {
	using service = new TestCodeEditorService();
	using listeners = new DisposableStore();
	const events: string[] = [];
	listeners.add(service.onWillCreateCodeEditor(() => events.push('will')));
	listeners.add(service.onCodeEditorAdd(editor => events.push(`add:${editor.getId()}`)));
	listeners.add(service.onCodeEditorRemove(editor => events.push(`remove:${editor.getId()}`)));
	const firstFocus = { text: false, widget: false };
	const secondFocus = { text: false, widget: true };
	const first = codeEditor('first', firstFocus);
	const second = codeEditor('second', secondFocus);

	service.willCreateCodeEditor();
	service.addCodeEditor(first);
	service.addCodeEditor(second);
	assert.deepEqual(service.listCodeEditors(), [first, second]);
	assert.strictEqual(service.getFocusedCodeEditor(), second);
	assert.strictEqual(service.getActiveCodeEditor(), second);

	secondFocus.widget = false;
	firstFocus.text = true;
	assert.strictEqual(service.getFocusedCodeEditor(), first);
	service.removeCodeEditor(first);
	assert.strictEqual(service.getActiveCodeEditor(), second);
	service.removeCodeEditor(second);
	assert.strictEqual(service.getActiveCodeEditor(), null);
	assert.deepEqual(events, ['will', 'add:first', 'add:second', 'remove:first', 'remove:second']);
});

test('transient model properties publish only real changes', () => {
	using service = new TestCodeEditorService();
	using model = new TextModel('text', { resource: URI.parse('file:///model.ts') });
	const changed: TextModel[] = [];
	using listener = service.onDidChangeTransientModelProperty(candidate => changed.push(candidate as TextModel));

	service.setTransientModelProperty(model, 'peek', 1);
	service.setTransientModelProperty(model, 'peek', 1);
	assert.equal(service.getTransientModelProperty(model, 'peek'), 1);
	assert.deepEqual(service.getTransientModelProperties(model), [['peek', 1]]);
	service.setTransientModelProperty(model, 'peek', undefined);
	assert.equal(service.getTransientModelProperty(model, 'peek'), undefined);
	assert.deepEqual(service.getTransientModelProperties(model), [['peek', undefined]]);
	assert.deepEqual(changed, [model, model]);
});

test('transient model properties follow resource identity and leave with the model', () => {
	using service = new TestCodeEditorService();
	const resource = URI.parse('file:///shared.ts');
	const first = new TextModel('first', { resource });
	using second = new TextModel('second', { resource });

	service.setTransientModelProperty(first, 'peek', 1);
	assert.equal(service.getTransientModelProperty(second, 'peek'), 1);
	first.dispose();
	assert.equal(service.getTransientModelProperty(second, 'peek'), undefined);
	assert.equal(service.getTransientModelProperties(second), undefined);
});

test('decoration registrations share one owner until the last reference is released', () => {
	using service = new TestCodeEditorService();
	const removed: string[] = [];
	const registered: string[] = [];
	using listener = service.onDecorationTypeRegistered(key => registered.push(key));
	const editor = codeEditor('decorations', { text: false, widget: false }, removed);
	service.addCodeEditor(editor);
	const first = service.registerDecorationType('selection', 'selection', { isWholeLine: true, color: 'red' }, undefined, editor);
	const second = service.registerDecorationType('selection', 'selection', { isWholeLine: true, color: 'red' }, undefined, editor);

	assert.deepEqual(service.listDecorationTypes(), ['selection']);
	assert.deepEqual(registered, ['selection']);
	assert.deepEqual(service.resolveDecorationOptions('selection', true), {
		description: 'selection',
		className: undefined,
		inlineClassName: 'ash-decoration-selection-inline',
		glyphMarginClassName: undefined,
		beforeContentClassName: undefined,
		afterContentClassName: undefined,
		isWholeLine: true,
		lineHeight: undefined,
		stickiness: undefined,
		fontFamily: undefined,
		fontSize: undefined,
		fontWeight: undefined,
		fontStyle: undefined,
		overviewRuler: undefined,
	});
	first.dispose();
	assert.deepEqual(service.listDecorationTypes(), ['selection']);
	second.dispose();
	assert.deepEqual(service.listDecorationTypes(), []);
	assert.deepEqual(removed, ['selection']);
});

test('decoration types expose distinct line, inline, content, and injected-text roles', () => {
	using service = new TestCodeEditorService();
	using parent = service.registerDecorationType('parent', 'parent', {
		backgroundColor: 'blue',
		color: 'red',
		before: { contentText: 'parent' },
		beforeInjectedText: { contentText: 'hint', color: 'green', affectsLetterSpacing: true },
	});
	using child = service.registerDecorationType('child', 'child', {
		before: { contentText: 'child' },
		after: { contentText: 'tail' },
	}, 'parent');

	const parentOptions = service.resolveDecorationOptions('parent', false);
	const childOptions = service.resolveDecorationOptions('child', false);
	assert.deepEqual({
		parentClass: parentOptions.className,
		parentInline: parentOptions.inlineClassName,
		parentBefore: parentOptions.beforeContentClassName,
		injected: parentOptions.before,
		childInline: childOptions.inlineClassName,
		childBefore: childOptions.beforeContentClassName,
		childAfter: childOptions.afterContentClassName,
	}, {
		parentClass: 'ash-decoration-parent',
		parentInline: 'ash-decoration-parent-inline',
		parentBefore: 'ash-decoration-parent-before',
		injected: {
			content: 'hint',
			inlineClassName: 'ash-decoration-parent-before-injected',
			inlineClassNameAffectsLetterSpacing: true,
		},
		childInline: 'ash-decoration-parent-inline',
		childBefore: 'ash-decoration-child-before',
		childAfter: 'ash-decoration-child-after',
	});
});

function codeEditor(id: string, focus: { text: boolean; widget: boolean }, removedDecorations: string[] = []): ICodeEditor {
	return {
		getId: () => id,
		hasTextFocus: () => focus.text,
		hasWidgetFocus: () => focus.widget,
		getContainerDomNode: () => document.body,
		removeDecorationsByType: (key: string) => removedDecorations.push(key),
	} as unknown as ICodeEditor;
}
