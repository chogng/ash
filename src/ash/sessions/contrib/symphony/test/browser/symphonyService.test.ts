import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { ISymphonyBackend, SymphonySnapshot } from '../../../../../platform/symphony/common/symphonyService.js';
import { SymphonyService } from '../../browser/symphonyService.js';

const conversation = (id: string) => ({ id, workflowId: 'workflow', identifier: id, title: id, status: 'running' as const, tokens: 15, tokensComplete: true, durationMs: 1000, error: undefined });
function backend(read: () => Promise<SymphonySnapshot>, messages: ISymphonyBackend['messages']): ISymphonyBackend {
	return { onDidChange: new Emitter<void>().event, read, messages, configure: async () => ({ workflows: [], conversations: [] }), submit: async () => conversation('new'), control: async () => { }, enable: async () => { } };
}

suite('Built-in Symphony presentation', () => {
	test('a late message read cannot replace the newly selected conversation', async () => {
		const stored = new Map<string, string>();
		const storage = { get: (key: string) => stored.get(key), store: (key: string, value: string) => stored.set(key, value) } as unknown as IStorageService;
		const previous = new DeferredPromise<{ conversation: ReturnType<typeof conversation>; messages: []; }>();
		const second = new DeferredPromise<void>();
		const api = backend(async () => ({ workflows: [], conversations: [conversation('one'), conversation('two')] }), async id => {
			if (id === 'one') { return previous.p; }
			await second.complete(); return { conversation: conversation(id), messages: [{ id: 'two-message', role: 'assistant', text: 'Second' }] };
		});
		using service = new SymphonyService({ symphony: api } as IRendererHost, storage);
		const refresh = service.refresh();
		await Promise.resolve();
		service.select('two');
		await previous.complete({ conversation: conversation('one'), messages: [] });
		await refresh;
		await second.p;
		await service.refresh();
		assert.equal(service.state.get().selected, 'two');
		assert.equal(service.state.get().messages[0].text, 'Second');
	});

	test('unavailable hosts show a useful state without starting another transport', async () => {
		const stored = new Map<string, string>();
		const storage = { get: (key: string) => stored.get(key), store: (key: string, value: string) => stored.set(key, value) } as unknown as IStorageService;
		using service = new SymphonyService({} as IRendererHost, storage);
		await service.refresh();
		assert.equal(service.available, false);
		assert.match(service.state.get().error!, /App Server/u);
	});

	test('a failed command remains visible and does not erase existing totals', async () => {
		const stored = new Map<string, string>();
		const storage = { get: (key: string) => stored.get(key), store: (key: string, value: string) => stored.set(key, value) } as unknown as IStorageService;
		const api = backend(async () => ({ workflows: [], conversations: [conversation('one')] }), async () => ({ conversation: conversation('one'), messages: [] }));
		api.control = async () => { throw new Error('Could not stop'); };
		using service = new SymphonyService({ symphony: api } as IRendererHost, storage);
		await service.refresh();
		await service.control('one', 'pause');
		await service.refresh();
		assert.match(service.state.get().error!, /Could not stop/u);
		assert.equal(service.state.get().conversations[0].tokens, 15);
		assert.equal(service.state.get().loading, false);
	});
});
