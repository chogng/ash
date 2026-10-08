import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserStorageService } from "../../../../services/storage/browser/storageService.js";

test("OutputService registers, updates, reveals, and removes independent channels", () => {
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using first = output.createChannel({ id: "tasks", label: "Tasks" });
	using second = output.createChannel({ id: "rust-analyzer", label: "rust-analyzer" });
	const selections: Array<string | undefined> = [];
	using selectionListener = output.onDidChangeActiveChannel(channel => selections.push(channel?.id));

	assert.equal(output.activeChannel, first);
	const reveals: Array<[string, string]> = [];
	using revealListener = output.onDidRequestShowChannel(request => reveals.push([request.channel.id, request.focus]));
	first.appendLine({ severity: "log", text: "task started" });
	second.append({ severity: "warning", text: "check failed" });
	assert.deepEqual(first.entries.map(entry => [entry.sequence, entry.severity, entry.text]), [[1, "log", "task started\n"]]);
	assert.deepEqual(second.entries.map(entry => [entry.sequence, entry.severity, entry.text]), [[1, "warning", "check failed"]]);

	output.selectChannel(second.id);
	assert.equal(output.activeChannel, second);
	assert.deepEqual(selections, [second.id]);
	first.show({ focus: "preserve" });
	assert.equal(output.activeChannel, first);
	assert.deepEqual(reveals, [[first.id, "preserve"]]);
	first.replace([{ severity: "information", category: "lifecycle", timestamp: 1, text: "ready" }]);
	assert.equal(first.getText(), "ready");
	assert.deepEqual(first.entries.map(entry => [entry.timestamp, entry.severity, entry.category, entry.text]), [[1, "information", "lifecycle", "ready"]]);
	output.selectChannel(second.id);
	second.clear();
	assert.deepEqual(second.entries, []);
	second.dispose();
	assert.equal(output.activeChannel, first);
	assert.deepEqual(output.channels.map(channel => channel.id), [first.id]);
	assert.deepEqual(selections, ["rust-analyzer", "tasks", "rust-analyzer", "tasks"]);
});

test("OutputService rejects ambiguous channel ownership and invalid entries", () => {
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using channel = output.createChannel({ id: "server", label: "Server" });
	assert.throws(() => output.createChannel({ id: "server", label: "Duplicate" }), /already registered/);
	assert.throws(() => output.createChannel({ id: "invalid id", label: "Invalid" }), /cannot contain whitespace/);
	assert.throws(() => output.selectChannel("missing"), /Unknown Output channel/);
	assert.throws(() => channel.append({ severity: "fatal" as never, text: "unsupported" }), /Unsupported Output entry severity/);
	channel.append({ severity: "log", text: "  " });
	assert.equal(channel.getText(), "  ");
});

test("OutputService restores the workspace active channel when its producer returns", () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: "workspace", backend: browser.window.localStorage, flushInterval: 0 });
	{
		using outputResources = new DisposableStore();
		const output = workbenchInstantiationService(outputResources, storage).get(IOutputService);
		using first = output.createChannel({ id: "first", label: "First" });
		using second = output.createChannel({ id: "second", label: "Second" });
		output.selectChannel(second.id);
	}
	{
		using outputResources = new DisposableStore();
		const output = workbenchInstantiationService(outputResources, storage).get(IOutputService);
		using first = output.createChannel({ id: "first", label: "First" });
		assert.equal(output.activeChannel, first);
		using second = output.createChannel({ id: "second", label: "Second" });
		assert.equal(output.activeChannel, second);
	}
	browser.window.close();
});

const entry = { sequence: 1, timestamp: 1, severity: "warning", category: "lifecycle", text: "Server restart scheduled" } as const;

test('Output keeps panel and editor references live, and recreates a released model from retained content', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const resolver = services.get(ITextModelService);
	using channel = output.createChannel({ id: 'live', label: 'Live' });
	channel.appendLine({ text: 'first', category: 'build', severity: 'warning' });
	const panel = await resolver.createModelReference(channel.uri);
	const editor = await resolver.createModelReference(channel.uri);
	const model = panel.object.textEditorModel;
	assert.equal(model, editor.object.textEditorModel);
	channel.appendLine({ text: 'second' });
	assert.equal(editor.object.textEditorModel.getValue(), 'first\nsecond\n');
	panel.dispose();
	assert.equal(model.isDisposed(), false);
	channel.replace({ text: 'replacement' });
	assert.equal(model.getValue(), 'replacement');
	editor.dispose();
	assert.equal(model.isDisposed(), true);
	channel.appendLine({ text: ' after close' });
	using reopened = await resolver.createModelReference(channel.uri);
	assert.notEqual(reopened.object.textEditorModel, model);
	assert.equal(reopened.object.textEditorModel.getValue(), 'replacement after close\n');
	channel.clear();
	assert.equal(reopened.object.textEditorModel.getValue(), '');
});

test('Output retention also removes expired text from an open model', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	using channel = services.get(IOutputService).createChannel({ id: 'bounded', label: 'Bounded' });
	using reference = await services.get(ITextModelService).createModelReference(channel.uri);
	channel.appendLine({ text: 'expired' });
	channel.append({ text: 'x'.repeat(2 * 1024 * 1024 - 20) });
	assert.equal(reference.object.textEditorModel.getValue(), channel.getText());
	assert.equal(channel.entries.length, 1);
	channel.append({ text: 'y'.repeat(4 * 1024 * 1024) });
	assert.equal(reference.object.textEditorModel.getValue(), '');
});

test('Output normalizes CRLF once when producers split it between writes', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	using channel = services.get(IOutputService).createChannel({ id: 'crlf', label: 'CRLF' });
	using reference = await services.get(ITextModelService).createModelReference(channel.uri);
	channel.append({ text: 'first\r' });
	channel.append({ text: '\nsecond\r' });
	channel.append({ text: '\n' });
	assert.equal(channel.getText(), 'first\r\nsecond\r\n');
	assert.equal(reference.object.textEditorModel.getValue().replaceAll('\r\n', '\n'), 'first\nsecond\n');
});

test("OutputFilterState combines include, exclude, severity, and category filters", () => {
	using filterResources = new DisposableStore();
	const filters = workbenchInstantiationService(filterResources).get(IOutputService).filters;
	filters.setText('server restart,!failed');
	assert.equal(filters.matches(entry, 'window'), true);
	filters.setText("server,!scheduled");
	assert.equal(filters.matches(entry, 'window'), false);
	filters.setText("");
	filters.setSeverityVisible("warning", false);
	assert.equal(filters.matches(entry, 'window'), false);
	filters.setSeverityVisible("warning", true);
	filters.setCategoryVisible("lifecycle", false, 'window');
	assert.equal(filters.matches(entry, 'window'), false);
	filters.reset();
	assert.equal(filters.matches(entry, 'window'), true);
	filters.setMinimumSeverity("error");
	assert.equal(filters.matches(entry, 'window'), false);
	assert.equal(filters.matches({ ...entry, severity: "error" }, 'window'), true);
});

test("OutputFilterState restores workspace-local filter choices", () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: "workspace", backend: browser.window.localStorage, flushInterval: 0 });
	{
		using filterResources = new DisposableStore();
		const filters = workbenchInstantiationService(filterResources, storage).get(IOutputService).filters;
		filters.setText("server");
		filters.setSeverityVisible("trace", false);
	}
	{
		using filterResources = new DisposableStore();
		const filters = workbenchInstantiationService(filterResources, storage).get(IOutputService).filters;
		assert.equal(filters.text, "server");
		assert.equal(filters.isSeverityVisible("trace"), false);
	}
	browser.window.close();
});


function filterStorage(resources: DisposableStore, raw?: string): BrowserStorageService {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'output-query', backend: browser.window.localStorage, flushInterval: 0 }));
	resources.add(toDisposable(() => browser.window.close()));
	if (raw !== undefined) { storage.store('output.filterState', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE); }
	return storage;
}

for (const syntaxVersion of [undefined, 1, 2]) {
	test(`Output category restoration keeps legacy choices global without assigning a channel (${syntaxVersion ?? 'unversioned'})`, () => {
		using resources = new DisposableStore();
		const raw = JSON.stringify({ ...(syntaxVersion === undefined ? {} : { syntaxVersion }), text: '', hiddenSeverities: [], hiddenCategories: ['lifecycle', 'build'] });
		const storage = filterStorage(resources, raw);
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		assert.deepEqual({ first: filters.matches(entry, 'window'), second: filters.matches(entry, 'extension-host'), build: filters.matches({ ...entry, category: 'build' }, 'extension-host'), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, {
			first: false, second: false, build: false, stored: raw,
		});
	});
}

for (const visible of [false, true]) {
	test(`Output first explicit category choice migrates only that category to the current channel (${visible ? 'show' : 'hide'})`, () => {
		using storageResources = new DisposableStore();
		const raw = JSON.stringify({ syntaxVersion: 2, text: '', hiddenSeverities: [], hiddenCategories: ['lifecycle', 'build'] });
		const storage = filterStorage(storageResources, raw);
		{
			using resources = new DisposableStore();
			const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
			let changes = 0;
			using migrationListener = filters.onDidChange(() => changes++);
			filters.setCategoryVisible('lifecycle', visible, 'window');
			assert.deepEqual({ first: filters.matches(entry, 'window'), second: filters.matches(entry, 'extension-host'), firstBuild: filters.matches({ ...entry, category: 'build' }, 'window'), secondBuild: filters.matches({ ...entry, category: 'build' }, 'extension-host'), changes }, {
				first: visible, second: true, firstBuild: false, secondBuild: false, changes: 1,
			});
			const stored = JSON.parse(storage.get('output.filterState', StorageScope.WORKSPACE)!);
			assert.equal(stored.hiddenCategories.includes('lifecycle'), false);
			assert.equal(stored.hiddenCategories.includes('build'), true);
		}
		{
			using resources = new DisposableStore();
			const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
			assert.deepEqual({ first: filters.matches(entry, 'window'), second: filters.matches(entry, 'extension-host'), build: filters.matches({ ...entry, category: 'build' }, 'extension-host') }, { first: visible, second: true, build: false });
			filters.setCategoryVisible('lifecycle', !visible, 'extension-host');
			assert.deepEqual({ first: filters.matches(entry, 'window'), second: filters.matches(entry, 'extension-host'), build: filters.matches({ ...entry, category: 'build' }, 'window') }, { first: visible, second: !visible, build: false });
		}
	});
}

test('Output category identities keep channel and category separators distinct', () => {
	using resources = new DisposableStore();
	const filters = workbenchInstantiationService(resources).get(IOutputService).filters;
	filters.setCategoryVisible('c', false, 'a:b');
	filters.setCategoryVisible('b:c', false, 'a');
	assert.deepEqual({ first: filters.matches({ ...entry, category: 'c' }, 'a:b'), other: filters.matches({ ...entry, category: 'c' }, 'a'), second: filters.matches({ ...entry, category: 'b:c' }, 'a') }, { first: false, other: true, second: false });
	filters.setCategoryVisible('c', true, 'a:b');
	assert.equal(filters.matches({ ...entry, category: 'b:c' }, 'a'), false);
});

for (const category of ['["window","lifecycle"]', String.raw`\0["window","lifecycle"]`, String.raw`\u0000["window","lifecycle"]`]) {
	test(`Output restores literal legacy category text without treating serialized-looking names as channel identities (${category})`, () => {
		using storageResources = new DisposableStore();
		const raw = JSON.stringify({ syntaxVersion: 2, text: '', hiddenSeverities: [], hiddenCategories: [category] });
		const storage = filterStorage(storageResources, raw);
		{
			using resources = new DisposableStore();
			const output = workbenchInstantiationService(resources, storage).get(IOutputService);
			using first = output.createChannel({ id: 'window', label: 'Window', kind: 'log' });
			using second = output.createChannel({ id: 'extension-host', label: 'Extension Host', kind: 'log' });
			for (const channel of [first, second]) {
				channel.appendLine({ category, text: 'Literal category' });
				channel.appendLine({ category: 'lifecycle', text: 'Actual lifecycle' });
			}
			const filters = output.filters;
			assert.deepEqual({ firstLiteral: filters.matches(first.entries[0]!, first.id), secondLiteral: filters.matches(second.entries[0]!, second.id), actualLifecycle: filters.matches(first.entries[1]!, first.id), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, {
				firstLiteral: false, secondLiteral: false, actualLifecycle: true, stored: raw,
			});
			filters.setCategoryVisible(category, false, first.id);
			assert.deepEqual({ firstLiteral: filters.matches(first.entries[0]!, first.id), secondLiteral: filters.matches(second.entries[0]!, second.id), actualLifecycle: filters.matches(first.entries[1]!, first.id) }, {
				firstLiteral: false, secondLiteral: true, actualLifecycle: true,
			});
		}
		{
			using resources = new DisposableStore();
			const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
			assert.deepEqual({ firstLiteral: filters.matches({ ...entry, category }, 'window'), secondLiteral: filters.matches({ ...entry, category }, 'extension-host'), actualLifecycle: filters.matches(entry, 'window') }, {
				firstLiteral: false, secondLiteral: true, actualLifecycle: true,
			});
		}
	});
}

test('Output category identities reject null bytes and survive unrelated saved-filter updates', () => {
	using storageResources = new DisposableStore();
	const storage = filterStorage(storageResources);
	{
		using resources = new DisposableStore();
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		assert.throws(() => filters.setCategoryVisible('lifecycle\0', false, 'window'), /null bytes/);
		assert.throws(() => filters.setCategoryVisible('lifecycle', false, 'window\0'), /null bytes/);
		filters.setCategoryVisible('["window","lifecycle"]', false, 'a:b');
		filters.setText('server');
		filters.setSeverityVisible('trace', false);
	}
	{
		using resources = new DisposableStore();
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		assert.deepEqual({ selected: filters.matches({ ...entry, category: '["window","lifecycle"]' }, 'a:b'), other: filters.matches({ ...entry, category: '["window","lifecycle"]' }, 'a'), original: filters.matches(entry, 'window'), severity: filters.isSeverityVisible('trace'), text: filters.text }, {
			selected: false, other: true, original: true, severity: false, text: 'server',
		});
	}
});

test('Output channel category changes remain unsaved when a future schema owns storage', () => {
	using resources = new DisposableStore();
	const raw = JSON.stringify({ syntaxVersion: 3, text: 'future', hiddenCategories: ['lifecycle'], future: { retained: true } });
	const storage = filterStorage(resources, raw);
	const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
	filters.setCategoryVisible('lifecycle', false, 'window');
	assert.deepEqual({ first: filters.matches(entry, 'window'), second: filters.matches(entry, 'extension-host'), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, { first: false, second: true, stored: raw });
	filters.reset();
	assert.deepEqual({ first: filters.matches(entry, 'window'), second: filters.matches(entry, 'extension-host'), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, { first: true, second: true, stored: raw });
});

test('Output text queries match comma alternatives with exclusions taking precedence', () => {
	using resources = new DisposableStore();
	const filters = workbenchInstantiationService(resources).get(IOutputService).filters;
	const lines = ['KEEP one', 'other two', 'keep banned', 'drop', 'keep,other'];
	const scenarios = [
		{ query: 'keep,other,!banned', expected: ['KEEP one', 'other two', 'keep,other'] },
		{ query: ' keep, ! banned ', expected: ['KEEP one', 'keep,other'] },
		{ query: '!keep', expected: ['other two', 'drop'] },
		{ query: ', ,!, ,', expected: lines },
	];
	for (const scenario of scenarios) {
		filters.setText(scenario.query);
		assert.deepEqual(lines.filter(text => filters.matches({ ...entry, text }, 'window')), scenario.expected, scenario.query);
	}
});

test('Output text queries keep spaces, minus and protected quotes literal', () => {
	using resources = new DisposableStore();
	const filters = workbenchInstantiationService(resources).get(IOutputService).filters;
	const scenarios = [
		{ query: 'server restart', lines: ['server restart', 'restart server'], expected: ['server restart'] },
		{ query: '-failed', lines: ['passed', 'failed', '-failed'], expected: ['-failed'] },
		{ query: '"a,b",other', lines: ['a,b', '"a,b"', 'other'], expected: ['"a,b"', 'other'] },
		{ query: '! "a,b"', lines: ['a,b', '"a,b"', 'other'], expected: ['a,b', 'other'] },
		{ query: 'keep,"a,b', lines: ['keep one', '"a,b', 'a,b'], expected: ['keep one', '"a,b'] },
		{ query: '\\"a,b",other', lines: ['\\"a,b"', '"a,b"', 'other'], expected: ['\\"a,b"', 'other'] },
	];
	for (const scenario of scenarios) {
		filters.setText(scenario.query);
		assert.deepEqual(scenario.lines.filter(text => filters.matches({ ...entry, text }, 'window')), scenario.expected, scenario.query);
	}
});

test('Output text queries search content while category filtering remains independent', () => {
	using resources = new DisposableStore();
	const filters = workbenchInstantiationService(resources).get(IOutputService).filters;
	filters.setText('lifecycle');
	assert.equal(filters.matches(entry, 'window'), false);
	filters.setText('server');
	assert.equal(filters.matches(entry, 'window'), true);
	filters.setCategoryVisible('lifecycle', false, 'window');
	assert.equal(filters.matches(entry, 'window'), false);
	filters.reset();
	assert.equal(filters.matches(entry, 'window'), true);
});

test('Output restores saved queries unchanged and adopts current syntax on identical explicit input', () => {
	const lines = ['Server restart scheduled', 'restart server', 'Failed server restart'];
	const scenarios = [
		{ query: 'server restart', restored: lines, current: [lines[0], lines[2]] },
		{ query: '"server restart" !failed', restored: [lines[0]], current: [] },
		{ query: '-failed', restored: [lines[0], lines[1]], current: [] },
		{ query: 'lifecycle', restored: lines, current: [] },
		{ query: 'server,restart', restored: [], current: lines },
	];
	for (const scenario of scenarios) {
		using resources = new DisposableStore();
		const raw = JSON.stringify({ text: scenario.query, hiddenSeverities: [], hiddenCategories: [], ignored: 'not owned' });
		const storage = filterStorage(resources, raw);
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		const matches = (): string[] => lines.filter(text => filters.matches({ ...entry, text }, 'window'));
		assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: matches(), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, {
			text: scenario.query, notice: 'restored', matches: scenario.restored, stored: raw,
		});
		let changes = 0;
		resources.add(filters.onDidChange(() => changes++));
		filters.setText(scenario.query);
		assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: matches(), changes, stored: JSON.parse(storage.get('output.filterState', StorageScope.WORKSPACE)!) }, {
			text: scenario.query, notice: undefined, matches: scenario.current, changes: 1,
			stored: { syntaxVersion: 2, text: scenario.query, hiddenSeverities: [], hiddenCategories: [] },
		});
	}
});

test('Output metadata changes preserve restored syntax through reload until clear or reset', () => {
	for (const action of ['clear', 'reset']) {
		using storageResources = new DisposableStore();
		const query = '"server restart" !failed';
		const storage = filterStorage(storageResources, JSON.stringify({ text: query, hiddenSeverities: [], hiddenCategories: [] }));
		{
			using resources = new DisposableStore();
			const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
			filters.setMinimumSeverity('debug');
			filters.setCategoryVisible('hidden', false, 'window');
			assert.deepEqual({ notice: filters.textFilterNotice, matches: filters.matches(entry, 'window'), stored: JSON.parse(storage.get('output.filterState', StorageScope.WORKSPACE)!) }, {
				notice: 'restored', matches: true, stored: { syntaxVersion: 1, text: query, hiddenSeverities: ['trace'], hiddenCategories: ['\0["window","hidden"]'] },
			});
		}
		{
			using resources = new DisposableStore();
			const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
			assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: filters.matches(entry, 'window') }, { text: query, notice: 'restored', matches: true });
			if (action === 'clear') { filters.setText(''); }
			else { filters.reset(); }
			const stored = JSON.parse(storage.get('output.filterState', StorageScope.WORKSPACE)!);
			assert.deepEqual(stored, { syntaxVersion: 2, text: '', hiddenSeverities: action === 'clear' ? ['trace'] : [], hiddenCategories: action === 'clear' ? ['\0["window","hidden"]'] : [] });
		}
		{
			using resources = new DisposableStore();
			const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
			assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: filters.matches(entry, 'window') }, { text: '', notice: undefined, matches: true });
		}
	}
});

test('Output does not show a migration notice for empty or current-version saved queries', () => {
	for (const saved of [{ text: '' }, { syntaxVersion: 2, text: 'server,restart' }]) {
		using resources = new DisposableStore();
		const raw = JSON.stringify({ ...saved, hiddenSeverities: [], hiddenCategories: [] });
		const storage = filterStorage(resources, raw);
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		assert.equal(filters.textFilterNotice, undefined);
		assert.equal(storage.get('output.filterState', StorageScope.WORKSPACE), raw);
		filters.setText('server,restart');
		assert.equal(filters.matches({ ...entry, text: 'restart server' }, 'window'), true);
	}
});

test('Output preserves unknown saved versions and applies only unsaved current-window filters', () => {
	for (const syntaxVersion of [3, 'future', null]) {
		using resources = new DisposableStore();
		const raw = JSON.stringify({ syntaxVersion, text: 'unknown', hiddenSeverities: ['warning'], hiddenCategories: ['lifecycle'], future: { query: 'untouched' } });
		const storage = filterStorage(resources, raw);
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: filters.matches(entry, 'window') }, { text: '', notice: 'unsupported', matches: true });
		filters.setText('server,restart');
		filters.setSeverityVisible('warning', false);
		assert.equal(filters.matches(entry, 'window'), false);
		filters.setCategoryVisible('lifecycle', false, 'window');
		filters.reset();
		assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: filters.matches(entry, 'window'), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, { text: '', notice: 'unsupported', matches: true, stored: raw });
	}
});

test('Output does not overwrite a newer saved schema published after the window opened', () => {
	using resources = new DisposableStore();
	const storage = filterStorage(resources);
	const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
	filters.setText('server');
	const raw = JSON.stringify({ syntaxVersion: 3, text: 'future', future: [1, 2] });
	storage.store('output.filterState', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	filters.setSeverityVisible('trace', false);
	filters.setText('restart');
	assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: filters.matches(entry, 'window'), stored: storage.get('output.filterState', StorageScope.WORKSPACE) }, { text: 'restart', notice: 'unsupported', matches: true, stored: raw });
});


for (const action of ['empty-input', 'same-input', 'empty-reset']) {
	test(`Output discovers a later future schema on unchanged text and an already-empty reset (${action})`, () => {
		using resources = new DisposableStore();
		const storage = filterStorage(resources);
		const filters = workbenchInstantiationService(resources, storage).get(IOutputService).filters;
		const query = action === 'same-input' ? 'server' : '';
		filters.setText(query);
		const raw = JSON.stringify({ syntaxVersion: 3, text: 'future', future: { untouched: true } });
		storage.store('output.filterState', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		let changes = 0;
		using listener = filters.onDidChange(() => changes++);
		const apply = (): void => action === 'empty-reset' ? filters.reset() : filters.setText(query);
		apply();
		assert.deepEqual({ text: filters.text, notice: filters.textFilterNotice, matches: filters.matches(entry, 'window'), stored: storage.get('output.filterState', StorageScope.WORKSPACE), changes }, {
			text: query, notice: 'unsupported', matches: true, stored: raw, changes: 1,
		});
		apply();
		assert.equal(changes, 1);
		assert.equal(storage.get('output.filterState', StorageScope.WORKSPACE), raw);
	});
}
