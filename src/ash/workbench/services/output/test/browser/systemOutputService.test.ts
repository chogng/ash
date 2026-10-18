import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../common/output.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import type { AppServerConnectionState, IAppServerApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { SystemOutputService, openLogOutput } from "../../browser/systemOutputService.js";
import { Emitter, Event } from '../../../../../base/common/event.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { windowLogId } from '../../../log/common/logConstants.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import type { ILogFileReadResult, ILogFileCursor, ILogFileService } from '../../../../../platform/log/common/log.js';

test("SystemOutputService projects App Server lifecycle", async () => {
	const listeners = new Set<(state: AppServerConnectionState) => void>();
	const appServer: IAppServerApi = {
		connectionGeneration: 1,
		getConnectionState: async () => "ready",
		getSlashCommands: async () => [],
		onConnectionState: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
	};
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using service = new SystemOutputService(output, appServer);
	await Promise.resolve();
	for (const listener of listeners) listener("crashed");

	assert.match(output.getChannel("app-server")?.getText() ?? "", /Initial App Server connection state: ready/);
	assert.match(output.getChannel("app-server")?.getText() ?? "", /connection is crashed/);
});

test('system Output preserves producer time, severity, category and error context', () => {
	using resources = new DisposableStore();
	const output = workbenchInstantiationService(resources).get(IOutputService);
	using service = new SystemOutputService(output, { connectionGeneration: 0, getConnectionState: async () => 'stopped', getSlashCommands: async () => [], onConnectionState: () => ({ dispose() { } }) });
	service.log({ timestampMillis: 42, level: 'warning', category: 'workspace/read', message: 'unavailable', error: new Error('permission denied') });
	const entry = output.getChannel(windowLogId)!.entries[0]!;
	assert.deepEqual([entry.timestamp, entry.severity, entry.category], [42, 'warning', 'workspace/read']);
	assert.match(entry.text, /^1970-01-01T00:00:00.042Z \[warning\] \[workspace\/read\] unavailable\nError: permission denied/);
});

test('file-backed Output keeps a clear during an in-flight read and releases its reader with the channel', async function () {
	this.timeout(8_000);
	using resources = new DisposableStore();
	const output = workbenchInstantiationService(resources).get(IOutputService);
	const requests: { cursor?: ILogFileCursor; complete: (result: ILogFileReadResult) => void; }[] = [];
	const requested = resources.add(new Emitter<void>());
	const files: ILogFileService = {
		list: async () => [],
		read: (_id, cursor) => new Promise(resolve => { requests.push({ cursor, complete: resolve }); requested.fire(); }),
	};
	const takeRequest = async () => {
		if (!requests.length) await nextEvent(requested.event);
		return requests.shift()!;
	};
	const source = { id: 'test/file', source: 'main', format: 'jsonl', live: true, currentWindow: false } as const;
	const record = (message: string, offset: number): ILogFileReadResult => ({ text: JSON.stringify({ timestampMillis: 42, level: 'warning', category: 'test', message }) + '\n', gap: false, cursor: { generation: 'one', offset } });
	const channel = resources.add(openLogOutput(output, files, source));
	const initial = await takeRequest();
	const loaded = nextEvent(channel.onDidChange);
	initial.complete(record('saved before reload', 1));
	await loaded;
	assert.match(channel.getText(), /saved before reload/);
	assert.equal(openLogOutput(output, files, source), channel);
	const pending = await takeRequest();
	assert.deepEqual(pending.cursor, { generation: 'one', offset: 1 });
	channel.clear();
	pending.complete(record('stale before clear', 2));
	const next = await takeRequest();
	assert.equal(channel.getText(), '');
	assert.deepEqual(next.cursor, { generation: 'one', offset: 2 });
	const appended = nextEvent(channel.onDidChange);
	next.complete(record('fresh after clear', 3));
	await appended;
	assert.match(channel.getText(), /fresh after clear/);
	assert.doesNotMatch(channel.getText(), /stale|saved before/);
	const late = await takeRequest();
	channel.dispose();
	late.complete(record('after disposal', 4));
	await Promise.resolve();
	assert.equal(output.getChannel(channel.id), undefined);
});

test('recording level is producer-owned while Output filtering preserves retained records', () => {
	using resources = new DisposableStore();
	const output = workbenchInstantiationService(resources).get(IOutputService);
	using logger = new LogService();
	using service = new SystemOutputService(output, { connectionGeneration: 0, getConnectionState: async () => 'stopped', getSlashCommands: async () => [], onConnectionState: () => ({ dispose() { } }) }, logger);
	using sink = logger.registerSink(service);
	logger.trace('hidden at source');
	logger.info('retained');
	const window = output.getChannel(windowLogId)!;
	assert.equal(window.descriptor.logger?.control, logger);
	output.filters.setMinimumSeverity('error');
	assert.equal(logger.getLevel(), 'information');
	window.descriptor.logger!.control.setLevel('trace');
	logger.trace('recorded trace');
	assert.match(window.getText(), /retained/);
	assert.match(window.getText(), /recorded trace/);
	assert.doesNotMatch(window.getText(), /hidden at source/);
});

test('clearing an empty channel prevents its pending initial file snapshot from appearing', async () => {
	using resources = new DisposableStore();
	const output = workbenchInstantiationService(resources).get(IOutputService);
	const pending = promiseWithResolvers<ILogFileReadResult>();
	const channel = resources.add(openLogOutput(output, {
		list: async () => [], read: async () => pending.promise,
	}, { id: 'saved/test', source: 'main', live: false, currentWindow: false, format: 'text' }));
	channel.clear();
	pending.resolve({ text: 'before clear\n', cursor: { generation: 'saved', offset: 13 }, gap: false });
	await pending.promise;
	await Promise.resolve();
	assert.equal(channel.getText(), '');
});

function nextEvent<T>(event: Event<T>): Promise<T> {
	return new Promise(resolve => Event.once(event)(resolve));
}
