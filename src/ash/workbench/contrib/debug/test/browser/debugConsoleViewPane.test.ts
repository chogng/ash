import { ViewModel } from '../../common/debugViewModel.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import '../../browser/debug.contribution.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { DebugConsoleEntry } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { IDebugService, type IReplModel, type IDebugConsoleSession, type IDebugSession, type IDebugCompletionsResponse, type IDebugCompletionItem } from '../../common/debug.js';
import { registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { Repl } from '../../browser/repl.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';

suite('Debug Console view input and filtering', () => {
	test('registered accessibility providers follow filtered output and restore the originating focus', async () => {
		using fixture = new ReplFixture();
		fixture.console.append({ output: 'visible\n' });
		fixture.console.append({ output: 'hidden\n' });
		await fixture.until(() => fixture.output.textContent === 'visible\nhidden\n');
		fixture.setFilter('visible');
		await fixture.until(() => fixture.view.getVisibleContent() === 'visible\n');
		fixture.filter.focus();
		using help = fixture.accessibleProvider(AccessibleViewType.Help)!;
		using content = fixture.accessibleProvider(AccessibleViewType.View)!;
		assert.ok(help);
		assert.ok(content);
		assert.match(help.provideContent(), /Debug Console\n/);
		assert.equal(content.provideContent(), 'visible\n');
		let changes = 0;
		using subscription = content.onDidChangeContent!(() => changes++);
		fixture.console.append({ output: 'visible update\n' });
		await fixture.until(() => content.provideContent() === 'visible\nvisible update\n');
		assert.ok(changes > 0);
		const outside = document.createElement('button');
		document.body.append(outside);
		using cleanup = toDisposable(() => outside.remove());
		outside.focus();
		assert.equal(fixture.accessibleProvider(AccessibleViewType.Help), undefined);
		assert.equal(fixture.accessibleProvider(AccessibleViewType.View), undefined);
		content.dispose();
		assert.equal(document.activeElement, fixture.filter);
	});

	test('renders retained output, evaluates expressions, and exposes its clear icon action', async () => {
		using fixture = new ReplFixture();
		fixture.console.append({ output: 'ready\n' });
		await fixture.until(() => fixture.output.textContent === 'ready\n');
		assert.equal(fixture.output.textContent, 'ready\n');
		fixture.setInput('answer');
		fixture.key('Enter');
		await Promise.resolve();
		assert.deepEqual(fixture.console.evaluations, ['answer']);
		await fixture.until(() => /42/.test(fixture.output.textContent!));
		assert.match(fixture.output.textContent!, /42/);
		const clear = fixture.view.partTitleProjection.actions!.querySelector<HTMLButtonElement>("[data-action-id='workbench.debug.panel.action.clearReplAction'] button")!;
		assert.ok(clear.querySelector('svg'));
		clear.click();
		await fixture.until(() => fixture.output.textContent === '');
		assert.equal(fixture.output.textContent, '');
	});

	test('find action searches retained output independently of the filter and restores tree focus', async () => {
		using fixture = new ReplFixture();
		fixture.console.append({ output: 'first needle\n' });
		fixture.console.append({ output: 'other\n' });
		fixture.console.append({ output: 'second needle\n' });
		await fixture.until(() => fixture.output.querySelectorAll('[role=treeitem]').length === 3);
		fixture.setInput('draft');
		const action = fixture.view.partTitleProjection.actions!.querySelector<HTMLButtonElement>("[data-action-id='repl.action.find'] button")!;
		assert.equal(action.querySelector('svg')?.getAttribute('data-ash-icon-id'), 'search');
		action.click();
		const find = fixture.output.querySelector<HTMLInputElement>('.ash-tree-find-widget input')!;
		assert.equal(document.activeElement, find);
		find.value = 'needle';
		find.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
		const rows = [...fixture.output.querySelectorAll<HTMLElement>('[role=treeitem]')];
		assert.deepEqual(rows.map(row => row.classList.contains('find-match')), [true, false, true]);
		const tree = fixture.output.querySelector<HTMLElement>('[role=tree]')!;
		assert.equal(tree.getAttribute('aria-activedescendant'), rows[0]!.id);
		fixture.key('Enter', {}, find);
		assert.equal(tree.getAttribute('aria-activedescendant'), rows[2]!.id);
		fixture.key('Enter', { shiftKey: true }, find);
		assert.equal(tree.getAttribute('aria-activedescendant'), rows[0]!.id);
		assert.equal(fixture.filter.value, '');
		assert.equal(fixture.view.getReplInput().getValue(), 'draft');
		fixture.key('Escape', {}, find);
		assert.equal(fixture.output.querySelector<HTMLElement>('.ash-tree-find-widget')!.hidden, true);
		assert.equal(document.activeElement, tree);
		fixture.key('f', { ctrlKey: true, altKey: true }, tree);
		assert.equal(document.activeElement, find);
		assert.equal(find.value, '');
		fixture.key('Escape', {}, find);
		fixture.key('f', { metaKey: true, altKey: true }, tree);
		assert.equal(document.activeElement, find);
		fixture.console.append({ output: 'streamed\n' });
		await fixture.until(() => fixture.output.textContent!.includes('streamed'));
		assert.equal(document.activeElement, find, 'Streaming must retain the find input and its focus');
	});

	test('filters output while preserving groups, evaluation pairs, snapshot identity, and collapse state', async () => {
		using fixture = new ReplFixture();
		fixture.console.append({ output: 'request\n', kind: 'group', collapsed: true });
		fixture.console.append({ output: 'fatal issue\n', parentId: 1 });
		fixture.console.append({ output: 'routine\n', parentId: 1 });
		fixture.console.append({ output: '> value\n', kind: 'input' });
		fixture.console.append({ output: '42\n', kind: 'evaluation' });
		fixture.console.append({ output: 'secret fatal\n' });
		const snapshot = fixture.console.activeSession.elements;
		await fixture.until(() => fixture.output.querySelectorAll('[role=treeitem]').length === 4);
		const group = fixture.output.querySelector('[role=treeitem]')!;
		assert.equal(group.getAttribute('aria-expanded'), 'false');
		fixture.setFilter('fatal, !secret');
		await fixture.until(() => fixture.view.getVisibleContent() === 'request\nfatal issue\n> value\n42\n');
		assert.equal(fixture.view.getVisibleContent(), 'request\nfatal issue\n> value\n42\n');
		assert.deepEqual(fixture.view.getFilterStats(), { total: 6, filtered: 4 });
		assert.equal(group.getAttribute('aria-expanded'), 'true');
		assert.equal(fixture.console.activeSession.elements, snapshot, 'Filtering must leave the backend snapshot untouched');
		fixture.setFilter('');
		await fixture.until(() => group.getAttribute('aria-expanded') === 'false');
		assert.equal(group.getAttribute('aria-expanded'), 'false');
		assert.deepEqual(fixture.view.getFilterStats(), { total: 6, filtered: 6 });
	});

	test('keeps adjacent DAP chunks on one visual line while filtering their original entry identities', async () => {
		using fixture = new ReplFixture();
		fixture.console.append({ output: 'part ' });
		fixture.console.append({ output: 'line\n' });
		await fixture.until(() => fixture.view.getVisibleContent() === 'part line\n');
		assert.equal(fixture.output.querySelectorAll('[role=treeitem]').length, 1);
		assert.equal(fixture.view.getVisibleContent(), 'part line\n');
		fixture.setFilter('line');
		await fixture.until(() => fixture.view.getVisibleContent() === 'line\n');
		assert.equal(fixture.output.textContent, 'line\n');
		assert.deepEqual(fixture.console.activeSession.elements.map(entry => [entry.id, entry.output]), [[1, 'part '], [2, 'line\n']]);
		fixture.setFilter('');
		await fixture.until(() => fixture.view.getVisibleContent() === 'part line\n');
	});

	test('does not join text links across producers in a shared console', async () => {
		using fixture = new ReplFixture();
		fixture.console.append({ output: 'https://first.test/', sessionId: 'one' });
		fixture.console.append({ output: 'tail\n', sessionId: 'other' });
		await fixture.until(() => fixture.output.querySelectorAll('[role=treeitem]').length === 2);
		assert.equal(fixture.output.querySelector('[role=link]')?.textContent, 'https://first.test/');
		assert.equal(fixture.console.activeSession.elements[1]!.sessionId, 'other');
	});

	test('loads each inspected branch once and retains its inspection revision while group output streams', async () => {
		using fixture = new ReplFixture();
		const reads: [number, number | undefined][] = [];
		fixture.debug.session.variables = async (reference, revision) => {
			reads.push([reference, revision]);
			return reference === 20 ? [{ name: 'parent', value: 'Object', variablesReference: 21 }] : [{ name: 'child', value: 'value', variablesReference: 0 }];
		};
		fixture.console.append({ output: 'group\n', kind: 'group', collapsed: false });
		fixture.console.append({ output: 'object\n', parentId: 1, variablesReference: 20, inspectionRevision: 7 });
		await fixture.until(() => fixture.output.querySelectorAll('[role=treeitem]').length === 2);
		const tree = fixture.output.querySelector<HTMLElement>('[role=tree]')!;
		fixture.key('ArrowDown', {}, tree);
		fixture.key('ArrowRight', {}, tree);
		await fixture.until(() => fixture.output.textContent!.includes('parent: Object'));
		fixture.key('ArrowRight', {}, tree);
		fixture.key('ArrowRight', {}, tree);
		await fixture.until(() => fixture.output.textContent!.includes('child: value'));
		assert.deepEqual(reads, [[20, 7], [21, 7]]);
		fixture.console.append({ output: 'tail\n', parentId: 1 });
		await fixture.until(() => fixture.output.textContent!.includes('tail\n'));
		fixture.setFilter('object');
		await fixture.until(() => !fixture.view.getVisibleContent().includes('tail\n'));
		fixture.setFilter('');
		await fixture.until(() => fixture.view.getVisibleContent().includes('tail\n'));
		assert.deepEqual(reads, [[20, 7], [21, 7]], 'snapshot refresh and filtering must reuse tree-owned inspection children');
		assert.match(fixture.view.getVisibleContent(), /parent: Object\nchild: value\n/);
	});


	for (const failure of ['ended session', 'rejected inspection'] as const) {
		test(`retains JSON data and displays the dynamic error after ${failure}`, async () => {
			using fixture = new ReplFixture();
			let reads = 0;
			fixture.debug.session.variables = async () => { reads++; throw new Error('Variable inspection unavailable'); };
			if (failure === 'ended session') (fixture.debug.session as { state: string; }).state = 'terminated';
			fixture.console.append({ output: 'mixed object\n', data: { retained: 42 }, variablesReference: 20, inspectionRevision: 7 });
			await fixture.until(() => fixture.output.querySelectorAll('[role=treeitem]').length === 1);
			fixture.output.querySelector<HTMLElement>('.ash-tree-twistie')!.click();
			await fixture.until(() => fixture.output.querySelectorAll('[role=treeitem]').length === 3);
			assert.match(fixture.view.getVisibleContent(), /"retained": 42/);
			assert.match(fixture.view.getVisibleContent(), failure === 'ended session' ? /The debug session has ended\./ : /Variable inspection unavailable/);
			assert.equal(reads, failure === 'ended session' ? 0 : 1);
			const rows = fixture.output.querySelectorAll('[role=treeitem]');
			assert.equal(rows[0]!.getAttribute('aria-expanded'), 'true');
			assert.equal(rows[2]!.hasAttribute('aria-expanded'), false);
		});
	}

	test('filter focus shortcut and Escape clear the query before returning focus to output', () => {
		using fixture = new ReplFixture();
		fixture.setInput('draft');
		fixture.key('f', { ctrlKey: true });
		assert.equal(document.activeElement, fixture.filter);
		fixture.setFilter('missing');
		fixture.key('Escape', {}, fixture.filter);
		assert.equal(fixture.filter.value, '');
		assert.equal(document.activeElement, fixture.filter);
		fixture.key('Escape', {}, fixture.filter);
		assert.equal(document.activeElement, fixture.output.querySelector('[role=tree]'));
		assert.equal(fixture.view.getReplInput().getValue(), 'draft');
	});

	test('navigates expression history, preserves a draft, deduplicates, and survives view recreation', () => {
		using fixture = new ReplFixture();
		for (const value of ['first()', 'second()', 'first()']) { fixture.setInput(value); fixture.view.acceptReplInput(); }
		fixture.setInput('unfinished');
		fixture.key('ArrowUp'); assert.equal(fixture.view.getReplInput().getValue(), 'first()');
		fixture.key('ArrowUp'); assert.equal(fixture.view.getReplInput().getValue(), 'second()');
		fixture.key('ArrowDown'); assert.equal(fixture.view.getReplInput().getValue(), 'first()');
		fixture.key('ArrowDown'); assert.equal(fixture.view.getReplInput().getValue(), 'unfinished');
		fixture.recreate();
		fixture.key('ArrowUp'); assert.equal(fixture.view.getReplInput().getValue(), 'first()');
		assert.deepEqual(JSON.parse(fixture.storage.get('debug.repl.history', StorageScope.WORKSPACE, '[]')), ['second()', 'first()']);
	});

	test('keeps input and filter histories across workspace switches and clear-output actions', () => {
		using fixture = new ReplFixture();
		fixture.setInput('workspaceA()'); fixture.view.acceptReplInput();
		fixture.setFilter('important'); fixture.key('Enter', {}, fixture.filter);
		fixture.console.clear();
		fixture.storage.switchWorkspace('other');
		fixture.key('ArrowUp'); assert.equal(fixture.view.getReplInput().getValue(), '');
		fixture.setInput('workspaceB()'); fixture.view.acceptReplInput();
		fixture.storage.switchWorkspace('workspace');
		fixture.key('ArrowUp'); assert.equal(fixture.view.getReplInput().getValue(), 'workspaceA()');
		fixture.setFilter(''); fixture.key('ArrowUp', {}, fixture.filter);
		assert.equal(fixture.filter.value, 'important');
	});

	test('rejects malformed persisted histories and restores only the last 100 valid entries', () => {
		using fixture = new ReplFixture();
		for (const invalid of ['{}', '["valid", 7]', '["bad\\u0000value"]', JSON.stringify(['x'.repeat(32_769)])]) {
			fixture.storage.store('debug.repl.history', invalid, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			fixture.recreate(); fixture.key('ArrowUp');
			assert.equal(fixture.view.getReplInput().getValue(), '');
		}
		fixture.storage.store('debug.repl.history', JSON.stringify(Array.from({ length: 105 }, (_, index) => `entry-${index}`)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		fixture.recreate();
		for (let index = 0; index < 110; index++) fixture.key('ArrowUp');
		assert.equal(fixture.view.getReplInput().getValue(), 'entry-5');
	});

	test('accepts DAP replacement ranges and selection offsets without evaluating', async () => {
		using fixture = new ReplFixture();
		fixture.debug.complete = async () => completion([{ label: 'call', text: 'call(value)', start: 5, length: 2, selectionStart: 5, selectionLength: 5 }]);
		fixture.setInput('obj.ca + 1', 6);
		fixture.key(' ', { ctrlKey: true, code: 'Space' });
		await Promise.resolve();
		assert.equal(fixture.input.getAttribute('aria-expanded'), 'true');
		fixture.key('Enter');
		assert.equal(fixture.view.getReplInput().getValue(), 'obj.call(value) + 1');
		assert.deepEqual(fixture.selection, [9, 14]);
		assert.deepEqual(fixture.console.evaluations, []);
		assert.equal(fixture.input.getAttribute('aria-expanded'), 'false');
	});

	test('arbitrates suggestion arrows, Tab, Escape, history, and IME composition', async () => {
		using fixture = new ReplFixture();
		fixture.setInput('remembered'); fixture.view.acceptReplInput();
		fixture.debug.complete = async () => completion([{ label: 'alpha', start: 1, length: 1 }, { label: 'beta', start: 1, length: 1 }]);
		fixture.setInput('a'); fixture.key(' ', { ctrlKey: true, code: 'Space' }); await Promise.resolve();
		const options = [...fixture.view.element.querySelectorAll<HTMLElement>('.ash-repl-completion')];
		assert.deepEqual(options.map(option => [option.classList.contains('selected'), option.getAttribute('aria-selected')]), [[true, 'true'], [false, 'false']]);
		fixture.key('ArrowDown');
		assert.deepEqual(options.map(option => [option.classList.contains('selected'), option.getAttribute('aria-selected')]), [[false, 'false'], [true, 'true']]);
		fixture.key('Tab');
		assert.equal(fixture.view.getReplInput().getValue(), 'beta');
		fixture.setInput('a'); fixture.key(' ', { ctrlKey: true, code: 'Space' }); await Promise.resolve();
		fixture.key('Enter', { isComposing: true });
		assert.equal(fixture.view.getReplInput().getValue(), 'a');
		assert.equal(fixture.input.getAttribute('aria-expanded'), 'true');
		fixture.input.dispatchEvent(new browserEnvironment.window.CompositionEvent('compositionstart', { bubbles: true }));
		assert.equal(fixture.input.getAttribute('aria-expanded'), 'false');
		fixture.key('ArrowUp', { isComposing: true }); assert.equal(fixture.view.getReplInput().getValue(), 'a');
		fixture.input.dispatchEvent(new browserEnvironment.window.CompositionEvent('compositionend', { bubbles: true, data: '' }));
		fixture.key('ArrowUp'); assert.equal(fixture.view.getReplInput().getValue(), 'remembered');
		assert.deepEqual(fixture.console.evaluations, ['remembered']);
	});

	test('omitted DAP edit ranges insert at the caret and empty text falls back to the label', async () => {
		using fixture = new ReplFixture();
		fixture.debug.complete = async () => completion([{ label: 'value', text: '', sortText: '' }]);
		fixture.setInput('pre tail', 3);
		fixture.key(' ', { ctrlKey: true, code: 'Space' });
		await Promise.resolve();
		fixture.key('Enter');
		assert.equal(fixture.view.getReplInput().getValue(), 'prevalue tail');
		assert.deepEqual(fixture.selection, [8, 8]);
		assert.deepEqual(fixture.console.evaluations, []);
	});

	test('cancels stale completions after input, cursor, frame, session, or stop changes', async () => {
		using fixture = new ReplFixture();
		const invalidations: [string, () => void][] = [
			['input', () => fixture.setInput('changed')],
			['cursor', () => { fixture.view.getReplInput().setPosition({ lineNumber: 1, column: 1 }); }],
			['selection anchor', () => { fixture.view.getReplInput().setSelection(new Selection(1, 1, 1, 2)); }],
			['history command', () => fixture.view.showPreviousValue()],
			['thread without a frame', () => fixture.debug.focusThread()],
			['frame', () => fixture.debug.focusFrame()],
			['session', () => fixture.debug.changeSession()],
			['stop', () => fixture.console.stop()],
		];
		for (const [name, invalidate] of invalidations) {
			fixture.console.resume(); fixture.setInput('a');
			let resolve!: (value: IDebugCompletionsResponse) => void;
			let token!: CancellationToken;
			fixture.debug.complete = (_frame, _thread, _text, _position, requestToken) => { token = requestToken; return new Promise(done => { resolve = done; }); };
			fixture.key(' ', { ctrlKey: true, code: 'Space' });
			invalidate();
			assert.equal(token.isCancellationRequested, true, name);
			resolve(completion([{ label: 'stale' }])); await Promise.resolve();
			assert.equal(fixture.input.getAttribute('aria-expanded'), 'false', name);
		}
		assert.deepEqual(fixture.console.evaluations, []);
	});


	test('retires displayed completions when a thread with no stack frame changes', async () => {
		using fixture = new ReplFixture();
		fixture.debug.complete = async (frame, thread) => {
			assert.equal(frame, undefined);
			assert.equal(thread, 1);
			return completion([{ label: 'mainThreadValue', start: 1, length: 1 }]);
		};
		fixture.setInput('a');
		fixture.key(' ', { ctrlKey: true, code: 'Space' });
		await Promise.resolve();
		assert.equal(fixture.input.getAttribute('aria-expanded'), 'true');
		assert.equal(fixture.debug.getViewModel().focusedStackFrame, undefined);
		fixture.debug.focusThread();
		assert.equal(fixture.debug.getViewModel().focusedStackFrame, undefined);
		assert.equal(fixture.input.getAttribute('aria-expanded'), 'false');
		fixture.key('Enter');
		assert.deepEqual(fixture.console.evaluations, ['a']);
	});

	test('ignores an older completion response after a newer request and cancels on disposal', async () => {
		using fixture = new ReplFixture();
		const pending: { token: CancellationToken; resolve(value: IDebugCompletionsResponse): void; }[] = [];
		fixture.debug.complete = (_frame, _thread, _text, _position, token) => new Promise(resolve => pending.push({ token, resolve }));
		fixture.setInput('a'); fixture.key(' ', { ctrlKey: true, code: 'Space' });
		fixture.key(' ', { ctrlKey: true, code: 'Space' });
		assert.equal(pending[0]!.token.isCancellationRequested, true);
		pending[1]!.resolve(completion([{ label: 'new' }])); await Promise.resolve();
		pending[0]!.resolve(completion([{ label: 'old' }])); await Promise.resolve();
		assert.equal(fixture.view.element.querySelector('[role="option"]')?.textContent, 'new');
		fixture.key('Escape'); fixture.key(' ', { ctrlKey: true, code: 'Space' });
		fixture.view.dispose();
		assert.equal(pending[2]!.token.isCancellationRequested, true);
		pending[2]!.resolve(completion([{ label: 'late' }])); await Promise.resolve();
	});
	test('registers the input with the editor host and releases its editor and model with the view', () => {
		using fixture = new ReplFixture();
		const editor = fixture.view.getReplInput();
		const model = editor.getModel()!;
		assert.ok(fixture.editors.listCodeEditors().includes(editor));
		fixture.view.focus();
		assert.equal(fixture.editors.getFocusedCodeEditor(), editor);
		editor.setValue('first\nsecond');
		editor.executeEdits('test.host', [{ range: new Range(2, 1, 2, 7), text: 'value' }]);
		assert.equal(editor.getValue(), 'first\nvalue');
		fixture.view.dispose();
		assert.equal(fixture.editors.listCodeEditors().includes(editor), false);
		assert.equal(model.isDisposed(), true);
	});

	test('owns a real multiline editor, preserves history draft selection and completes on the current UTF-16 line', async () => {
		using fixture = new ReplFixture();
		const editor = fixture.view.getReplInput();
		fixture.setInput('first');
		assert.equal(fixture.key('Enter', { shiftKey: true }).defaultPrevented, false);
		assert.equal(editor.getValue(), 'first');
		fixture.key('Enter', { isComposing: true });
		assert.deepEqual(fixture.console.evaluations, []);
		fixture.setInput('first\n😀obj.ca');
		let requestPosition: unknown;
		fixture.debug.complete = async (_frame, _thread, _text, position) => {
			requestPosition = position;
			return completion([{ label: 'call', text: 'call(value)', start: 7, length: 2, selectionStart: 5, selectionLength: 5 }]);
		};
		fixture.key(' ', { ctrlKey: true, code: 'Space' }); await Promise.resolve();
		assert.deepEqual({ ...requestPosition as object }, { lineNumber: 2, column: 9 });
		fixture.key('Enter');
		assert.equal(editor.getValue(), 'first\n😀obj.call(value)');
		assert.deepEqual(fixture.selection, [17, 22]);
		fixture.key('Enter');
		assert.deepEqual(fixture.console.evaluations, ['first\n😀obj.call(value)']);
		fixture.setInput('draft\nsecond');
		editor.setSelection(new Selection(2, 2, 2, 5));
		fixture.view.showPreviousValue();
		fixture.view.showNextValue();
		assert.equal(editor.getValue(), 'draft\nsecond');
		assert.deepEqual(fixture.selection, [7, 10]);
	});

});

class ReplFixture extends Disposable {
	readonly console = this._register(new FakeDebugConsoleService());
	readonly debug = this._register(new FakeDebugService(this.console));
	readonly storage = this._register(new BrowserStorageService({ ownerWindow: browserEnvironment.window as unknown as Window, workspaceId: 'workspace', backend: new MemoryStorage(), flushInterval: 0 }));
	private readonly services = this._register(new InstantiationService());
	private readonly views = this._register(new DisposableStore());
	view!: Repl;
	constructor() {
		super();
		this.services.registerInstance(IDebugService, this.debug as unknown as IDebugService);
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(ILogService, new NullLoggerService());
		this.services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as never);
		this.services.registerInstance(IEditorService, {} as never);
		this.services.registerInstance(IUriIdentityService, {} as never);
		this.services.registerInstance(IViewsService, { getViewWithId: () => this.view } as never);
		this.services.registerInstance(IWorkspaceContextService, this._register(new TestWorkspaceService({ id: 'workspace', folders: [] })));
		this.services.registerInstance(IFileService, this._register(new FileService()));
		registerCodeEditorServices(this.services);
		this.recreate();
	}
	recreate(): void {
		this.views.clear();
		this.view?.element.remove();
		this.view = this.views.add(this.services.createInstance(Repl, document.body, { id: 'ash.debugConsole.test', title: 'Debug Console' }));
		document.body.append(this.view.element);
		this.view.getReplInput().layout({ width: 600, height: 24 });
		const element = this.view.element;
		this.views.add(toDisposable(() => element.remove()));
	}
	async until(predicate: () => boolean): Promise<void> {
		if (predicate()) return;
		await new Promise<void>(resolve => {
			const listener = this.views.add(this.view.onDidChangeContent(() => {
				if (predicate()) { listener.dispose(); resolve(); }
			}));
		});
	}
	get editors() { return this.services.get(ICodeEditorService); }
	accessibleProvider(type: AccessibleViewType) {
		const implementations = AccessibleViewRegistry.getImplementations().filter(item => item.name === `debug.repl.${type}`);
		assert.equal(implementations.length, 1);
		return this.services.invokeFunction(accessor => implementations[0]!.getProvider(accessor));
	}
	get input(): HTMLElement { return this.view.getReplInput().controller.element; }
	get selection(): number[] { const editor = this.view.getReplInput(); const selection = editor.getSelection()!; const model = editor.getModel()!; return [model.getOffsetAt(selection.getStartPosition()), model.getOffsetAt(selection.getEndPosition())]; }
	get filter(): HTMLInputElement { return this.view.element.querySelector<HTMLInputElement>('input[aria-label="Filter Debug Console"]')!; }
	get output(): HTMLElement { return this.view.element.querySelector<HTMLElement>('.ash-debug-console-output')!; }
	setInput(value: string, cursor = value.length): void {
		const editor = this.view.getReplInput();
		editor.focus(); editor.setValue(value); editor.setPosition(editor.getModel()!.getPositionAt(cursor));
	}
	setFilter(value: string): void { this.filter.value = value; this.filter.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true })); }
	key(key: string, options: KeyboardEventInit = {}, target: HTMLElement = this.input): KeyboardEvent {
		const event = new browserEnvironment.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
		target.dispatchEvent(event);
		return event;
	}
}

class FakeDebugConsoleService extends Disposable implements IReplModel {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly evaluations: string[] = [];
	private elements: readonly DebugConsoleEntry[] = [];
	private canEvaluate = true;
	get sessions(): readonly IDebugConsoleSession[] { return [this.activeSession]; }
	get activeSession(): IDebugConsoleSession { return { id: 'one', label: 'One', state: this.canEvaluate ? 'stopped' : 'terminated', elements: this.elements, output: this.elements.map(entry => entry.output).join(''), canEvaluate: this.canEvaluate }; }
	selectSession(): void { }
	clear(): void { this.elements = []; this.changed.fire(); }
	stop(): void { this.canEvaluate = false; this.changed.fire(); }
	resume(): void { this.canEvaluate = true; this.changed.fire(); }
	append(entry: Partial<DebugConsoleEntry>): void {
		this.elements = [...this.elements, { id: this.elements.length + 1, sessionId: 'one', kind: 'output', output: '', category: 'console', parentId: null, collapsed: false, variablesReference: null, source: null, line: null, column: null, data: null, ...entry }];
		this.changed.fire();
	}
	async evaluate(expression: string): Promise<void> { this.evaluations.push(expression); this.append({ output: `> ${expression}\n42\n` }); }
}

class FakeDebugService extends Disposable {
	private readonly sessionChanged = this._register(new Emitter<IDebugSession | undefined>());
	private readonly viewModel = this._register(new ViewModel());
	readonly onDidChangeSession = this.sessionChanged.event;
	getViewModel() { return this.viewModel; }
	complete: IDebugSession['completions'] = async () => completion([]);
	readonly session = { id: 'one', consoleSessionId: 'one', configuration: { dirId: null }, threadId: 1, state: 'stopped', capabilities: { supportsCompletionsRequest: true, completionTriggerCharacters: ['.'] }, completions: (...args: Parameters<IDebugSession['completions']>) => this.complete(...args) } as unknown as IDebugSession;
	constructor(readonly replModel: FakeDebugConsoleService) {
		super();
		this.viewModel.setFocus(undefined, { id: 1, name: 'main' }, this.session, true);
	}
	getSession(id: string): IDebugSession | undefined { return id === this.session.id ? this.session : undefined; }
	focusFrame(): void { this.viewModel.setFocus({ id: 0, name: 'main', lineNumber: 1, columnNumber: 1 }, undefined, this.session, true); }
	focusThread(): void {
		(this.session as { threadId: number; }).threadId = 2;
		this.viewModel.setFocus(undefined, { id: 2, name: 'worker' }, this.session, true);
	}
	changeSession(): void { this.sessionChanged.fire(this.session); }
}

function completion(targets: readonly IDebugCompletionItem[]): IDebugCompletionsResponse { return { body: { targets } }; }

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, value); }
}
