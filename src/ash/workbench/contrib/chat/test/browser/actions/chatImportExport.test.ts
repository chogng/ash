import { readFileSync } from 'node:fs';
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
import { IChatService, type ThreadRead } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatExportActions } from '../../../browser/actions/chatImportExport.js';

function fixture(resources: DisposableStore) {
	resources.add(registerChatExportActions());
	const services = resources.add(new InstantiationService());
	const resource = URI.file('/workspace/chat.json');
	let content = '';
	let size = 0;
	let cancelled = false;
	let invalidConnection = false;
	const writes: unknown[] = [];
	const opens: unknown[] = [];
	services.registerInstance(IFileDialogService, { showSaveDialog: async () => cancelled ? undefined : resource, showOpenDialog: async () => cancelled ? undefined : [resource] } as unknown as IFileDialogService);
	services.registerInstance(IFileService, {
		stat: async () => ({ sizeBytes: size }), readFile: async () => ({ content }), writeFile: async (value: Parameters<IFileService['writeFile']>[0]) => { writes.push(value); return {} as never; },
	} as unknown as IFileService);
	services.registerInstance(IEditorService, { openEditor: async (input: Parameters<IEditorService['openEditor']>[0]) => { opens.push(input); } } as unknown as IEditorService);
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: { sessionId: 'source', threadId: 'thread' } } as unknown as IChatWidgetService);
	services.registerInstance(IChatSessionNavigationService, {
		captureConnection: () => ({ generation: 1, assertCurrent: async () => { if (invalidConnection) { throw new Error('Connection retired'); } }, dispose: () => { } }),
	} as unknown as IChatSessionNavigationService);
	services.registerInstance(IChatService, {
		readThread: async () => ({
			thread: { title: 'Saved title' }, transcript: {
				entries: [
					{ type: 'item', transient: false, item: { type: 'userMessage', text: 'Question' } },
					{ type: 'item', transient: true, item: { type: 'agentMessage', text: '**Partial reply**' } },
					{ type: 'item', item: { type: 'reasoning', text: 'Internal reasoning' } },
					{ type: 'voiceTranscript', transcript: { speaker: 'user', text: 'Spoken follow-up' } },
				]
			}
		} as unknown as ThreadRead)
	} as unknown as IChatService);
	return {
		writes, opens, resource, setContent: (text: string) => { content = text; }, setSize: (value: number) => { size = value; },
		cancel: () => { cancelled = true; }, retire: () => { invalidConnection = true; },
		run: async (action: 'import' | 'export'): Promise<void> => { await services.invokeFunction(CommandsRegistry.getCommand(`workbench.action.chat.${action}`)!); }
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
	setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
	try {
		using resources = new DisposableStore(); const f = fixture(resources);
		f.setContent(JSON.stringify({ format: 'ash.chat.transcript', version: 1, title: 'Saved title', messages: [{ role: 'assistant', text: 'Unchanged source', partial: true }] }));
		await f.run('import');
		const opened = f.opens[0] as { label: string; initialText: string; };
		assert.equal(opened.label, '已保存的聊天：Saved title');
		assert.match(opened.initialText, /## 助手 \(未完成\)\n\nUnchanged source/u);
	} finally { resetNlsResolver(); }
});
