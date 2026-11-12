import { languagePackCatalog as chineseCatalog } from '../../../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IChatService, type ChatToolCallBinding, type ThreadItem, type ThreadRead, type ThreadTranscriptEntry, type Turn } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatExportActions } from '../../../browser/actions/chatImportExport.js';

function fixture(resources: DisposableStore, options: { readonly entries?: readonly ThreadTranscriptEntry[]; readonly turns?: readonly Turn[]; } = {}) {
	resources.add(registerChatExportActions());
	const services = resources.add(new InstantiationService());
	const resource = URI.file('/workspace/chat.json');
	let content = '';
	let size = 0;
	let cancelled = false;
	let invalidConnection = false;
	const reads: { sessionId: string; threadId: string; }[] = [];
	const saveDialogs: unknown[] = [];
	const writes: unknown[] = [];
	const opens: unknown[] = [];
	services.registerInstance(IFileDialogService, {
		showSaveDialog: async (options: unknown) => { saveDialogs.push(options); return cancelled ? undefined : resource; },
		showOpenDialog: async () => cancelled ? undefined : [resource],
	} as unknown as IFileDialogService);
	services.registerInstance(IFileService, {
		stat: async () => ({ sizeBytes: size }), readFile: async () => ({ content }), writeFile: async (value: Parameters<IFileService['writeFile']>[0]) => { writes.push(value); return {} as never; },
	} as unknown as IFileService);
	services.registerInstance(IEditorService, { openEditor: async (input: Parameters<IEditorService['openEditor']>[0]) => { opens.push(input); } } as unknown as IEditorService);
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: { sessionId: 'source', threadId: 'thread' } } as unknown as IChatWidgetService);
	services.registerInstance(IChatSessionNavigationService, {
		captureConnection: () => ({ generation: 1, assertCurrent: async () => { if (invalidConnection) { throw new Error('Connection retired'); } }, dispose: () => { } }),
	} as unknown as IChatSessionNavigationService);
	services.registerInstance(IChatService, {
		readThread: async (sessionId: string, threadId: string) => {
			reads.push({ sessionId, threadId });
			return {
				thread: { title: 'Saved title', turns: options.turns ?? [] }, transcript: {
					entries: options.entries ?? [
						{ type: 'item', transient: false, item: { type: 'userMessage', text: 'Question' } },
						{ type: 'item', transient: true, item: { type: 'agentMessage', text: '**Partial reply**' } },
						{ type: 'item', item: { type: 'reasoning', text: 'Internal reasoning' } },
						{ type: 'voiceTranscript', transcript: { speaker: 'user', text: 'Spoken follow-up' } },
					]
				}
			} as unknown as ThreadRead;
		},
	} as unknown as IChatService);
	return {
		reads, saveDialogs, writes, opens, resource, setContent: (text: string) => { content = text; }, setSize: (value: number) => { size = value; },
		cancel: () => { cancelled = true; }, retire: () => { invalidConnection = true; },
		run: async (action: 'import' | 'export', context?: unknown): Promise<void> => { await services.invokeFunction(CommandsRegistry.getCommand(`workbench.action.chat.${action}`)!, context); }
	};
}

test('export freezes readable messages including voice and partial state; import is a read-only document', async () => {
	using resources = new DisposableStore(); const f = fixture(resources);
	await f.run('export');
	const saved = f.writes[0] as { resource: URI; content: string; };
	assert.equal(saved.resource.toString(), f.resource.toString());
	assert.deepEqual(JSON.parse(saved.content), {
		format: 'ash.chat.transcript', version: 1, title: 'Saved title', messages: [
			{ role: 'user', text: 'Question', partial: false }, { role: 'assistant', text: '**Partial reply**', partial: true }, { role: 'user', text: 'Spoken follow-up', partial: false },
		]
	});
	f.setContent(saved.content); await f.run('import');
	const opened = f.opens[0] as { readOnly: boolean; initialText: string; resource: URI; };
	assert.equal(opened.readOnly, true); assert.equal(opened.resource.scheme, 'ash-chat-transcript');
	assert.match(opened.initialText, /Assistant \(partial\)\n\n\*\*Partial reply\*\*/);
	assert.equal(opened.initialText.includes('Internal reasoning'), false); assert.equal(f.writes.length, 1);
});

function toolCall(turnId: string, toolCallId: string, name: string, argumentsJson = '{}', binding?: ChatToolCallBinding): ThreadTranscriptEntry {
	return { type: 'item', entryId: `${turnId}:${toolCallId}:call`, turnId, transient: false, item: { type: 'toolCall', itemId: `${toolCallId}:call`, turnId, toolCallId, name, argumentsJson, binding } };
}

function toolResult(turnId: string, toolCallId: string, text: string, options: { readonly isError?: boolean; readonly content?: Extract<ThreadItem, { readonly type: 'toolResult'; }>['content']; } = {}): ThreadTranscriptEntry {
	return { type: 'item', entryId: `${turnId}:${toolCallId}:result`, turnId, transient: false, item: { type: 'toolResult', itemId: `${toolCallId}:result`, turnId, toolCallId, text, isError: options.isError ?? false, content: options.content } };
}

const commandBinding: ChatToolCallBinding = {
	registryGeneration: 1, definitionDigest: 'fixture', sourceChain: [{ type: 'product', component: 'shell-command' }], caller: { type: 'direct' },
	activity: { type: 'command', program: '/bin/sh', arguments: ['-c', 'exit 2'], workingDirectory: '/workspace' },
};

test('export pairs tool summaries within each Turn and imports them in call order without raw output', async () => {
	using resources = new DisposableStore();
	const f = fixture(resources, {
		entries: [
			toolCall('first', 'reused', 'read', '{"path":"first.md"}'),
			{ type: 'item', entryId: 'reply', turnId: 'first', transient: false, item: { type: 'agentMessage', itemId: 'reply', turnId: 'first', text: '**Reply between calls**' } },
			toolCall('second', 'reused', 'read', '{"path":"second.md"}'),
			{ type: 'toolOutput', entryId: 'stdout', turnId: 'first', toolCallId: 'reused', stream: 'stdout', text: 'RAW_STDOUT' },
			{ type: 'toolOutput', entryId: 'stderr', turnId: 'second', toolCallId: 'reused', stream: 'stderr', text: 'RAW_STDERR' },
			toolResult('second', 'reused', 'Permission denied', { isError: true }),
			toolResult('first', 'reused', 'FULL_TOOL_RESULT', { content: [{ type: 'imageUrl', url: 'BINARY_ATTACHMENT', detail: 'auto' }] }),
			toolResult('orphan', 'unmatched', 'ORPHAN_RESULT'),
			{ type: 'item', entryId: 'reasoning', turnId: 'first', transient: false, item: { type: 'reasoning', itemId: 'reasoning', turnId: 'first', text: 'INTERNAL_REASONING', state: [] } },
			{ type: 'hookRun', entryId: 'hook', turnId: 'first', run: { runId: 'hook', hookId: 'hook', event: 'PreToolUse', status: { type: 'denied', reason: 'INTERNAL_HOOK' }, startedAtUnixMs: 0, durationMs: 0, turnId: 'first', toolCallId: null, toolName: null } },
		]
	});
	await f.run('export');
	const saved = f.writes[0] as { content: string; };
	assert.deepEqual(JSON.parse(saved.content).messages, [
		{ role: 'assistant', text: 'read · Completed\n\nInput\n{"path":"first.md"}', partial: false },
		{ role: 'assistant', text: '**Reply between calls**', partial: false },
		{ role: 'assistant', text: 'read · Failed\n\nInput\n{"path":"second.md"}\n\nError\nPermission denied', partial: false },
	]);
	assert.doesNotMatch(saved.content, /RAW_STDOUT|RAW_STDERR|FULL_TOOL_RESULT|BINARY_ATTACHMENT|ORPHAN_RESULT|INTERNAL_REASONING|INTERNAL_HOOK/);
	f.setContent(saved.content);
	await f.run('import');
	const opened = f.opens[0] as { initialText: string; readOnly: boolean; };
	assert.equal(opened.readOnly, true);
	assert.match(opened.initialText, /read · Failed[\s\S]*Permission denied/);
});

for (const exitCode of [0, 2]) {
	test(`export preserves shell process status without tool output (exit ${exitCode})`, async () => {
		using resources = new DisposableStore();
		const f = fixture(resources, {
			entries: [
				toolCall('turn', 'command', 'shell-command', '{"program":"/bin/sh","arguments":["-c","exit 2"]}', commandBinding),
				toolResult('turn', 'command', JSON.stringify({ tool: 'shell-command', result: { exit_code: exitCode, stdout: 'RAW_STDOUT', stderr: 'RAW_STDERR' } })),
			]
		});
		await f.run('export');
		const saved = f.writes[0] as { content: string; };
		assert.deepEqual(JSON.parse(saved.content).messages, [{
			role: 'assistant', partial: false,
			text: `shell-command · ${exitCode ? 'Failed' : 'Completed'}\n\nCommand: /bin/sh\nArguments: ["-c","exit 2"]\nDirectory: /workspace\n\nInput\n{"program":"/bin/sh","arguments":["-c","exit 2"]}`
				+ (exitCode ? '\n\nTool execution failed with exit code 2' : ''),
		}]);
		assert.doesNotMatch(saved.content, /RAW_STDOUT|RAW_STDERR/);
	});
}

test('export tolerates opaque command results and only interprets valid shell-command status', async () => {
	using resources = new DisposableStore();
	const results = ['plain result', 'null', '[]', '{"tool":"other","result":{"exit_code":2}}', '{"tool":"shell-command","result":{"exit_code":"2"}}'];
	const f = fixture(resources, {
		entries: results.flatMap((text, index) => [
			toolCall('turn', String(index), 'shell-command', '{}', commandBinding), toolResult('turn', String(index), text),
		])
	});
	await f.run('export');
	const saved = f.writes[0] as { content: string; };
	const messages = JSON.parse(saved.content).messages as { text: string; partial: boolean; }[];
	assert.equal(messages.length, results.length);
	assert.ok(messages.every(message => message.text.startsWith('shell-command · Completed') && !message.partial));
});

test('export retains process failure status in older tool history without a binding', async () => {
	using resources = new DisposableStore();
	const f = fixture(resources, {
		entries: [
			toolCall('old-turn', 'command', 'shell-command', '{"program":"false"}'),
			toolResult('old-turn', 'command', '{"tool":"shell-command","result":{"exit_code":1,"stdout":"RAW_OUTPUT"}}'),
		]
	});
	await f.run('export');
	const saved = f.writes[0] as { content: string; };
	assert.deepEqual(JSON.parse(saved.content).messages, [{ role: 'assistant', text: 'shell-command · Failed\n\nInput\n{"program":"false"}\n\nTool execution failed with exit code 1', partial: false }]);
	assert.doesNotMatch(saved.content, /RAW_OUTPUT/);
});

test('export distinguishes pending calls from stopped calls and omits streaming image generation', async () => {
	using resources = new DisposableStore();
	const f = fixture(resources, {
		entries: [
			toolCall('running', 'pending', 'read'),
			toolCall('stopped', 'unfinished', 'search'),
			toolCall('running', 'image', 'imagegen', 'IMAGE_IN_PROGRESS'),
			toolCall('finished', 'image', 'imagegen', '{"prompt":"a tree"}'),
			toolResult('finished', 'image', 'IMAGE_RESULT'),
		], turns: [{ turnId: 'stopped', status: 'interrupted' } as Turn]
	});
	await f.run('export');
	const saved = f.writes[0] as { content: string; };
	assert.deepEqual(JSON.parse(saved.content).messages, [
		{ role: 'assistant', text: 'read · Awaiting result\n\nInput\n{}', partial: true },
		{ role: 'assistant', text: 'search · No result\n\nInput\n{}', partial: false },
		{ role: 'assistant', text: 'imagegen · Completed\n\nInput\n{"prompt":"a tree"}', partial: false },
	]);
	assert.doesNotMatch(saved.content, /IMAGE_IN_PROGRESS|IMAGE_RESULT/);
});

test('export applies document limits to tool summaries before showing a save dialog', async () => {
	using resources = new DisposableStore();
	const f = fixture(resources, { entries: [toolCall('turn', 'large', 'read', 'x'.repeat(10 * 1024 * 1024))] });
	await assert.rejects(f.run('export'), /10 MB/);
	assert.deepEqual(f.saveDialogs, []);
	assert.deepEqual(f.writes, []);
});

test('export uses the conversation captured by the title menu instead of the last focused Chat', async () => {
	using resources = new DisposableStore(); const f = fixture(resources);
	await f.run('export', { sessionId: 'menu-session', threadId: 'menu-thread' });
	assert.deepEqual(f.reads, [{ sessionId: 'menu-session', threadId: 'menu-thread' }]);
	assert.equal(f.saveDialogs.length, 1);
	assert.equal(f.writes.length, 1);
});

test('an explicit draft or invalid export target never falls back to another conversation', async () => {
	using resources = new DisposableStore(); const f = fixture(resources);
	for (const context of [{}, null, { sessionId: 'source', threadId: '' }, { sessionId: 123, threadId: 'thread' }]) {
		await f.run('export', context);
	}
	assert.deepEqual(f.reads, []);
	assert.deepEqual(f.saveDialogs, []);
	assert.deepEqual(f.writes, []);
});

for (const data of ['bad JSON', '{}', '{"format":"ash.chat.transcript","version":2}', JSON.stringify({ format: 'ash.chat.transcript', version: 1, title: 'Invalid role', messages: [{ role: 'tool', text: 'Execute me', partial: false }] })]) {
	test(`import rejects unsupported document ${data.slice(0, 30)}`, async () => {
		using resources = new DisposableStore(); const f = fixture(resources); f.setContent(data);
		await assert.rejects(f.run('import'), /not a supported Ash chat transcript/); assert.deepEqual(f.opens, []);
	});
}

test('cancelled dialogs, oversized files and retired connections have no publication side effects', async () => {
	using resources = new DisposableStore(); const f = fixture(resources);
	f.setSize(11 * 1024 * 1024); await assert.rejects(f.run('import'), /10 MB/);
	f.cancel(); await f.run('import'); await f.run('export'); assert.deepEqual(f.writes, []); assert.deepEqual(f.opens, []);
	f.retire(); await assert.rejects(f.run('export'), /Connection retired/); assert.deepEqual(f.writes, []);
});


test('Chinese imported transcript uses localized role, partial marker and editor label', async () => {
	setNlsMessages('zh-CN', chineseCatalog.bundles);
	try {
		using resources = new DisposableStore(); const f = fixture(resources);
		f.setContent(JSON.stringify({ format: 'ash.chat.transcript', version: 1, title: 'Saved title', messages: [{ role: 'assistant', text: 'Unchanged source', partial: true }] }));
		await f.run('import');
		const opened = f.opens[0] as { label: string; initialText: string; };
		assert.equal(opened.label, '已保存的聊天：Saved title');
		assert.match(opened.initialText, /## 助手 \(未完成\)\n\nUnchanged source/u);
	} finally { resetNlsResolver(); }
});

test('Chinese export and read-only import preserve localized tool input, status and exit errors', async () => {
	setNlsMessages('zh-CN', chineseCatalog.bundles);
	try {
		using resources = new DisposableStore();
		const f = fixture(resources, {
			entries: [
				toolCall('turn', 'command', 'shell-command', '{"program":"/bin/sh"}', commandBinding),
				toolResult('turn', 'command', '{"tool":"shell-command","result":{"exit_code":2}}'),
			]
		});
		await f.run('export');
		const saved = f.writes[0] as { content: string; };
		assert.deepEqual(JSON.parse(saved.content).messages, [{
			role: 'assistant', partial: false,
			text: 'shell-command · 失败\n\n命令：/bin/sh\n参数：["-c","exit 2"]\n目录：/workspace\n\n输入\n{"program":"/bin/sh"}\n\n工具执行失败，退出码为 2',
		}]);
		f.setContent(saved.content);
		await f.run('import');
		const opened = f.opens[0] as { initialText: string; readOnly: boolean; };
		assert.equal(opened.readOnly, true);
		assert.match(opened.initialText, /## 助手[\s\S]*工具执行失败，退出码为 2/u);
	} finally { resetNlsResolver(); }
});
