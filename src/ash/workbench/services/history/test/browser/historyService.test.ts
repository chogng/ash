import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IDimension } from '../../../../../base/browser/dom.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane, EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { EditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorPart, IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import '../../../../browser/parts/editor/editorActions.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { createTestEditorServices, registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { HistoryService } from '../../browser/historyService.js';
import { IHistoryService } from '../../common/history.js';

class HistoryFixture extends Disposable {
	readonly services = this._register(registerTestComponentServices(createTestEditorServices(undefined, undefined, browserEnvironment.window.document)));
	readonly registry = this._register(new EditorPaneRegistry());
	readonly failures = new Map<string, Error>();
	readonly gates = new Map<string, DeferredPromise<void>>();
	readonly started = new Map<string, DeferredPromise<void>>();
	readonly attempts: string[] = [];
	readonly editor: EditorPart;
	readonly history: HistoryService;
	readonly commands: CommandService;

	constructor() {
		super();
		this.registerPane('ash.test.history');
		const container = browserEnvironment.window.document.createElement('div');
		browserEnvironment.window.document.body.append(container);
		this.editor = this._register(this.services.createInstance(EditorPart, container, { registry: this.registry }));
		this.services.registerInstance(IEditorPart, this.editor);
		this.history = this._register(this.services.createInstance(HistoryService));
		this.services.registerInstance(IHistoryService, this.history);
		this.commands = this._register(new CommandService(this.services));
		this._register({ dispose: () => container.remove(), [Symbol.dispose]() { this.dispose(); } });
	}

	registerPane(id: string) {
		return this._register(this.registry.registerEditorPane({
			id, name: id, canOpen: () => EditorPaneMatch.Default,
			create: () => new HistoryPane(id, this),
		}));
	}

	async close(input: IResourceEditorInput): Promise<void> {
		assert.equal(await this.editor.activeGroup.closeEditor(input), true);
	}
}

class HistoryPane extends EditorPane {
	constructor(readonly id: string, private readonly fixture: HistoryFixture) {
		super(id, fixture.services.get(IThemeService), fixture.services.get(IStorageService));
	}

	override create(parent: HTMLElement): void {
		const element = parent.ownerDocument.createElement('button');
		parent.append(element);
		super.create(element);
	}

	async setInput(input: IResourceEditorInput): Promise<void> {
		const key = input.resource.toString();
		this.fixture.attempts.push(key);
		await this.fixture.started.get(key)?.complete();
		await this.fixture.gates.get(key)?.p;
		const failure = this.fixture.failures.get(key);
		if (failure) throw failure;
	}

	clearInput(): void { }
	layout(_dimension: IDimension): void { }
	override focus(): void { this.getContainer()?.focus(); }
}

const resource = (name: string): IResourceEditorInput => ({ resource: URI.file(`/workspace/${name}.ts`) });

test('reopen command restores the last explicit close with its pane, pinned state and tab position', async () => {
	using fixture = new HistoryFixture();
	fixture.registerPane('ash.test.history.alternate');
	const first = resource('first');
	const middle = resource('middle');
	const last = resource('last');
	await fixture.editor.openEditor(first, { pinned: true });
	await fixture.editor.openEditor(middle, { pinned: true, preferredEditorId: 'ash.test.history.alternate' });
	await fixture.editor.openEditor(last, { pinned: true });
	await fixture.close(middle);
	await fixture.commands.executeCommand('workbench.action.reopenClosedEditor');
	assert.deepEqual(fixture.editor.activeGroup.inputs, [first, middle, last]);
	assert.equal(fixture.editor.activePane?.id, 'ash.test.history.alternate');
	assert.equal(fixture.editor.activeGroup.isPreview(middle), false);
	const pane = fixture.editor.activePane;
	assert.ok(pane instanceof HistoryPane);
	assert.equal(browserEnvironment.window.document.activeElement, pane.getContainer());
});

test('reopen skips an editor already open in the active group and opens the next closed resource', async () => {
	using fixture = new HistoryFixture();
	const first = resource('first');
	const last = resource('last');
	await fixture.editor.openEditor(first, { pinned: true });
	await fixture.close(first);
	await fixture.editor.openEditor(last, { pinned: true });
	await fixture.close(last);
	await fixture.editor.openEditor(last, { pinned: true });
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeInput, first);
	assert.equal(fixture.editor.activeGroup.inputs.length, 2);
});

test('explicit modal closes retain their resource while reset does not record it', async () => {
	const prototype = browserEnvironment.window.HTMLElement.prototype;
	const scrollTo = Object.getOwnPropertyDescriptor(prototype, 'scrollTo');
	Object.defineProperty(prototype, 'scrollTo', { configurable: true, value: () => undefined });
	using scrolling = toDisposable(() => {
		if (scrollTo) Object.defineProperty(prototype, 'scrollTo', scrollTo);
		else Reflect.deleteProperty(prototype, 'scrollTo');
	});
	using fixture = new HistoryFixture();
	const input = resource('modal');
	await fixture.editor.openEditor(input, {}, 'modalGroup');
	assert.equal(await fixture.editor.closeEditor(input), true);
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeInput, input);
	await fixture.editor.closeAllEditors({ reason: 'reset', skipConfirmation: true });
	await fixture.editor.openEditor(input, {}, 'modalGroup');
	await fixture.editor.closeAllEditors({ reason: 'reset', skipConfirmation: true });
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeInput, undefined);
});

test('failed resources do not block older closed editors or leave error placeholders', async () => {
	using fixture = new HistoryFixture();
	const first = resource('first');
	const missing = resource('missing');
	for (const input of [first, missing]) {
		await fixture.editor.openEditor(input, { pinned: true });
		await fixture.close(input);
	}
	fixture.failures.set(missing.resource.toString(), new Error('provider cannot read this resource'));
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeInput, first);
	assert.deepEqual(fixture.editor.activeGroup.inputs, [first]);
	assert.deepEqual(fixture.attempts.slice(-2), [missing.resource.toString(), first.resource.toString()]);
});

test('reopen falls back to the available pane when the previously used pane was removed', async () => {
	using fixture = new HistoryFixture();
	const alternate = fixture.registerPane('ash.test.history.removed');
	const input = resource('alternate');
	await fixture.editor.openEditor(input, { preferredEditorId: 'ash.test.history.removed' });
	await fixture.close(input);
	alternate.dispose();
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activePane?.id, 'ash.test.history');
});

test('preview replacement, move, reset and discarded untitled editors do not become closed history', async () => {
	using fixture = new HistoryFixture();
	await fixture.editor.openEditor(resource('preview'), { pinned: false });
	const next = resource('replacement');
	await fixture.editor.openEditor(next, { pinned: false });
	await fixture.editor.activeGroup.closeEditor(next, { reason: 'replace' });
	for (const reason of ['move', 'reset'] as const) {
		const input = resource(reason);
		await fixture.editor.openEditor(input);
		await fixture.editor.activeGroup.closeEditor(input, { reason });
	}
	const untitled = { resource: URI.parse('untitled:Untitled-1') };
	await fixture.editor.openEditor(untitled);
	await fixture.close(untitled);
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeGroup.inputs.length, 0);
});

test('repeated closes are deduplicated and the retained history is bounded', async () => {
	using fixture = new HistoryFixture();
	const input = resource('repeat');
	for (let index = 0; index < 2; index++) {
		await fixture.editor.openEditor(input);
		await fixture.close(input);
	}
	await fixture.history.reopenLastClosedEditor();
	await fixture.editor.activeGroup.closeEditor(input, { reason: 'reset' });
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeGroup.inputs.length, 0);
	for (let index = 0; index < 22; index++) {
		const entry = resource(`bounded-${index}`);
		await fixture.editor.openEditor(entry);
		await fixture.close(entry);
	}
	for (let index = 0; index < 22; index++) await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeGroup.inputs.length, 20);
	assert.equal(fixture.editor.activeGroup.inputs.some(input => input.resource.path.endsWith('bounded-0.ts')), false);
});

test('concurrent reopen commands are serialized instead of canceling an opening editor', async () => {
	using fixture = new HistoryFixture();
	const first = resource('first');
	const last = resource('last');
	for (const input of [first, last]) {
		await fixture.editor.openEditor(input);
		await fixture.close(input);
	}
	const gate = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	fixture.gates.set(last.resource.toString(), gate);
	fixture.started.set(last.resource.toString(), started);
	const reopening = fixture.history.reopenLastClosedEditor();
	await started.p;
	const queued = fixture.history.reopenLastClosedEditor();
	await gate.complete();
	await Promise.all([reopening, queued]);
	assert.deepEqual(fixture.editor.activeGroup.inputs, [first, last]);
	assert.equal(fixture.editor.activeInput, first);
});

test('canceling a reopen preserves the resource for a later attempt', async () => {
	using fixture = new HistoryFixture();
	const input = resource('cancel');
	await fixture.editor.openEditor(input);
	await fixture.close(input);
	fixture.failures.set(input.resource.toString(), new CancellationError());
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeGroup.inputs.length, 0);
	fixture.failures.clear();
	await fixture.history.reopenLastClosedEditor();
	assert.equal(fixture.editor.activeInput, input);
});

test('disposing history drops queued reopens and later commands without opening more resources', async () => {
	using fixture = new HistoryFixture();
	const first = resource('first');
	const last = resource('last');
	for (const input of [first, last]) {
		await fixture.editor.openEditor(input);
		await fixture.close(input);
	}
	const gate = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	fixture.gates.set(last.resource.toString(), gate);
	fixture.started.set(last.resource.toString(), started);
	const opening = fixture.history.reopenLastClosedEditor();
	await started.p;
	const queued = fixture.history.reopenLastClosedEditor();
	fixture.history.dispose();
	await queued;
	await gate.complete();
	await opening;
	await fixture.history.reopenLastClosedEditor();
	assert.deepEqual(fixture.editor.activeGroup.inputs, [last]);
});

test('HistoryService requires the registered editor owner at its injection boundary', () => {
	using services = createTestEditorServices(undefined, undefined, browserEnvironment.window.document);
	assert.throws(() => services.createInstance(HistoryService), /editorPart/i);
});
