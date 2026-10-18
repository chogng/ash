import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event, Emitter } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { MainThreadEditors } from '../../browser/mainThreadEditors.js';
import type { ExtensionHostFleetSnapshot } from '../../../../platform/agentHost/common/extensionHostApi.js';
import type { IActionPromptOptions, IActionPromptResult, IOpenDialogOptions } from '../../../../platform/dialogs/common/dialogs.js';

interface Copy {
	resource: URI;
	isDirty: boolean;
	save(signal: AbortSignal): Promise<void>;
}

function bridge(
	copies: readonly Copy[],
	confirm: () => Promise<{ confirmed: boolean; }>,
	markers: readonly unknown[] = [],
	codeEditors: unknown = {},
	models: unknown = { getModels: () => [], onModelAdded: Event.None, onModelRemoved: Event.None },
	prompt?: (options: IActionPromptOptions<number>) => Promise<IActionPromptResult<number>>,
	folderPicker?: {
		showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined>;
		fileURI(path: string): Promise<URI>;
	},
	part: unknown = { groups: [] },
): MainThreadEditors {
	// Only client-owned services used by these boundary scenarios are supplied.
	const services = [
		{}, part, {}, { confirm, prompt }, folderPicker ?? {}, {}, {},
		{ getAll: () => copies, get: (resource: URI) => copies.filter(copy => copy.resource.toString() === resource.toString()) },
		{ invokeFunction: (callback: (accessor: { get(): unknown; }) => unknown) => callback({ get: () => ({ read: () => markers }) }) },
		{}, {}, codeEditors, {}, models, folderPicker ?? {},
	] as unknown as ConstructorParameters<typeof MainThreadEditors>;
	return new MainThreadEditors(...services);
}

test('active editor requests resolve numeric group context without reading a different group', async () => {
	const first = { id: 1, inputs: [{ resource: URI.file('/first.ts') }], activeInput: { resource: URI.file('/active.ts') } };
	const second = { id: 2, inputs: [{ resource: URI.file('/second.ts') }] };
	using api = bridge(
		[], async () => ({ confirmed: true }), [], { listCodeEditors: () => [] },
		undefined, undefined, undefined, { groups: [first, second], activeGroup: first },
	);
	const signal = new AbortController().signal;
	const result = await api.handle({ method: 'activeEditor', context: { groupId: 2, editorIndex: 0 } }, signal) as { input: { resource: string; }; };
	assert.equal(result.input.resource, second.inputs[0]!.resource.toString());
	const missing = await api.handle({ method: 'activeEditor', context: { groupId: 999, editorIndex: 0 } }, signal) as { input: null; };
	assert.equal(missing.input, null);
	for (const groupId of ['2', -1, 1.5]) {
		await assert.rejects(api.handle({ method: 'activeEditor', context: { groupId } }, signal), /Invalid editor group ID/u);
	}
});

test('folder selection preserves host-resolved URIs and honors cancellation', async () => {
	for (const [path, uri] of [
		['C:\\中文 space\\100%', 'file:///C:/中文%20space/100%25'],
		['\\\\server\\share\\folder', 'file://server/share/folder'],
		['/workspace/literal\\name', 'file:///workspace/literal%5Cname'],
	]) {
		let selected: string | undefined = path;
		let conversions = 0;
		const controller = new AbortController();
		using api = bridge([], async () => ({ confirmed: true }), [], {}, undefined, undefined, {
			showOpenDialog: async options => {
				assert.equal(options.defaultUri?.toString(), URI.file('/configured').toString());
				assert.equal(options.canSelectFolders, true);
				return selected ? [URI.parse(uri)] : undefined;
			},
			fileURI: async value => { assert.equal(value, 'configured folder'); conversions++; return URI.file('/configured'); },
		});
		const request = { method: 'pickFolder', defaultPath: 'configured folder' };
		assert.equal(await api.handle(request, controller.signal), URI.parse(uri).toString());
		selected = undefined;
		assert.equal(await api.handle(request, controller.signal), null);
		assert.equal(conversions, 2);
		controller.abort();
		await assert.rejects(api.handle(request, controller.signal), /aborted/i);
		assert.equal(conversions, 2);
	}
});

test('extension modal choices preserve labels, selection, cancellation and boundary validation', async () => {
	let selection: number | undefined = 1;
	using api = bridge([], async () => ({ confirmed: true }), [], {}, undefined, async options => {
		assert.equal(options.message, 'Synchronize origin/main?');
		assert.equal(options.severity, 'warning');
		assert.deepEqual(options.buttons.map(button => button.label), ['OK', "OK, Don't Show Again"]);
		return { result: selection === undefined ? undefined : await options.buttons[selection].run({}) };
	});
	const request = { method: 'prompt', severity: 'warning', message: 'Synchronize origin/main?', buttons: ['OK', "OK, Don't Show Again"] };
	const controller = new AbortController();
	assert.deepEqual(await api.handle(request, controller.signal), { selection: 1 });
	selection = undefined;
	assert.deepEqual(await api.handle(request, controller.signal), { selection: null });
	await assert.rejects(api.handle({ ...request, buttons: [] }, controller.signal), /Invalid extension dialog buttons/);
	await assert.rejects(api.handle({ ...request, buttons: [123] }, controller.signal), /Invalid extension editor text/);
	await assert.rejects(api.handle({ ...request, severity: 'fatal' }, controller.signal), /Invalid extension dialog severity/);
	controller.abort();
	await assert.rejects(api.handle(request, controller.signal), /aborted/i);
});

test('repository preparation saves only selected staged copies and stops on cancellation or failed saves', async () => {
	const saved: string[] = [];
	const copy = (name: string): Copy => ({ resource: URI.file(`/workspace/${name}`), isDirty: true, async save() { saved.push(name); this.isDirty = false; } });
	const first = copy('first.ts'), other = copy('other.ts');
	let accepted = false;
	using api = bridge([first, other], async () => ({ confirmed: accepted }));
	const request = { method: 'prepareRepositoryOperation', root: 'file:///workspace', paths: [first.resource.toString()], saveMode: 'staged', diagnostics: null };
	assert.equal(await api.handle(request, new AbortController().signal), false);
	assert.deepEqual(saved, []);
	accepted = true;
	assert.equal(await api.handle(request, new AbortController().signal), true);
	assert.deepEqual(saved, ['first.ts']);
	assert.equal(other.isDirty, true);
	first.isDirty = true;
	first.save = async () => undefined;
	assert.equal(await api.handle(request, new AbortController().signal), false);
	await assert.rejects(api.handle({ ...request, paths: ['file:///outside/file.ts'] }, new AbortController().signal), /exceeds repository/);
});

test('repository diagnostic policy blocks selected sources and honors an explicit source override', async () => {
	const resource = URI.file('/workspace/file.ts');
	let prompts = 0;
	using api = bridge([], async () => { prompts++; return { confirmed: true }; }, [
		{ resource, owner: 'typescript', source: 'ts', severity: MarkerSeverity.Warning },
		{ resource: URI.file('/workspace/unselected.ts'), owner: 'other', severity: MarkerSeverity.Error },
	]);
	const request = { method: 'prepareRepositoryOperation', root: 'file:///workspace', paths: [resource.toString()], saveMode: 'never', diagnostics: { '*': 'error', ts: 'warning' } };
	assert.equal(await api.handle(request, new AbortController().signal), false);
	assert.equal(prompts, 1);
	assert.equal(await api.handle({ ...request, diagnostics: { '*': 'error', ts: 'none' } }, new AbortController().signal), true);
	assert.equal(prompts, 1);
});

test('line annotations reject stale editor versions and retire when the source or editor changes', async () => {
	using modelChanged = new Emitter<void>();
	using disposed = new Emitter<void>();
	const uri = URI.file('/workspace/file.ts');
	let version = 2, created = 0, cleared = 0, registrations = 0;
	const editor = {
		getModel: () => ({ uri, getVersionId: () => version, getLineCount: () => 3, getLineMaxColumn: () => 8 }),
		createDecorationsCollection: () => { created++; return { clear: () => cleared++ }; },
		onDidChangeModel: modelChanged.event, onDidDispose: disposed.event,
	};
	using api = bridge([], async () => ({ confirmed: true }), [], {
		getActiveCodeEditor: () => editor,
		registerDecorationType: () => { registrations++; return toDisposable(() => { registrations--; }); },
		resolveDecorationOptions: () => ({}),
	});
	const source = { extensionId: 'example.scm', incarnation: 1, activationGeneration: 1 };
	const request = { method: 'setLineAnnotation', uri: uri.toString(), line: 1, version: 1, text: 'Author', hover: 'Details' };
	await api.handle(request, new AbortController().signal, source);
	assert.equal(created, 0);
	version = 1;
	await api.handle(request, new AbortController().signal, source);
	assert.equal(created, 1);
	modelChanged.fire();
	assert.equal(cleared, 1);
	assert.equal(registrations, 0);
	await api.handle(request, new AbortController().signal, source);
	api.updateSources({ extensions: [] } as unknown as ExtensionHostFleetSnapshot);
	assert.equal(cleared, 2);
	assert.equal(registrations, 0);
});

test('timestamp formatting uses the client locale and rejects invalid batches', async () => {
	using api = bridge([], async () => ({ confirmed: true }));
	try {
		setNlsMessages('zh-CN', {});
		const result = await api.handle({ method: 'formatTimestamps', timestamps: [Date.now() - 60_000] }, new AbortController().signal) as { date: string; relative: string; }[];
		assert.match(result[0].relative, /分钟/);
		assert.ok(result[0].date.length > 0);
		await assert.rejects(api.handle({ method: 'formatTimestamps', timestamps: [Number.NaN] }, new AbortController().signal), /Invalid timestamp/);
		await assert.rejects(api.handle({ method: 'formatTimestamps', timestamps: Array(513).fill(0) }, new AbortController().signal), /Invalid timestamp/);
	} finally { resetNlsResolver(); }
});


test('AI edit evidence distinguishes chat from completions and expires after a manual edit', async () => {
	const { TextModel } = await import('../../../../editor/common/model/textModel.js');
	const { EditSources } = await import('../../../../editor/common/textModelEditSource.js');
	const { Range } = await import('../../../../editor/common/core/range.js');
	using model = new TextModel('before', { resource: URI.file('/workspace/file.ts') });
	const models = { getModels: () => [model], onModelAdded: Event.None, onModelRemoved: Event.None };
	using api = bridge([], async () => ({ confirmed: true }), [], {}, models);
	const signal = new AbortController().signal;
	model.applyEdits([{ range: new Range(1, 1, 1, 7), text: 'AI completion' }], EditSources.inlineCompletionAccept({ nes: false, requestUuid: 'request', languageId: 'typescript', correlationId: undefined }));
	assert.deepEqual(await api.handle({ method: 'aiEditedResources', root: 'file:///workspace', mode: 'chatAndAgent' }, signal), []);
	assert.deepEqual(await api.handle({ method: 'aiEditedResources', root: 'file:///workspace', mode: 'all' }, signal), [{ uri: model.uri.toString(), text: 'AI completion' }]);
	model.applyEdits([{ range: new Range(1, 1, 1, 14), text: 'manual' }], EditSources.unknown({ name: 'user' }));
	assert.deepEqual(await api.handle({ method: 'aiEditedResources', root: 'file:///workspace', mode: 'all' }, signal), []);
	model.applyEdits([{ range: new Range(1, 1, 1, 7), text: 'chat' }], EditSources.agentHostChatApplyEdits({ modelId: undefined, sessionId: 'session', requestId: 'request', harness: 'ash' }));
	assert.deepEqual(await api.handle({ method: 'aiEditedResources', root: 'file:///workspace', mode: 'chatAndAgent' }, signal), [{ uri: model.uri.toString(), text: 'chat' }]);
	assert.deepEqual(await api.handle({ method: 'aiEditedResources', root: 'file:///other', mode: 'all' }, signal), []);
});
