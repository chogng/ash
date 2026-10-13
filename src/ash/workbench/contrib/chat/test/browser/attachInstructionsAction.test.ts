import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ChatInstructionsPickerPick } from '../../browser/promptSyntax/attachInstructionsAction.js';

const document = browserEnvironment.window.document;
const path = '/outside-workspaces/instructions/review.md';

function setup(resources: DisposableStore, initial: RemoteAgentConnection) {
	const keys = resources.add(new ContextKeyService());
	const quick = resources.add(new TestQuickInputService({ container: document.body, contextKeyService: keys }));
	let connection = initial;
	const pick = new ChatInstructionsPickerPick('instruction-session', {
		isAvailable: true, list: async sessionId => {
			assert.equal(sessionId, 'instruction-session');
			return [{ name: 'A synthetic instruction', path, scope: 'user' }];
		}
	}, quick, {
		get connection() { return connection; }, connectionState: 'connected',
		onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None,
		reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }),
	});
	return { quick, pick, changeConnection: (next: RemoteAgentConnection) => { connection = next; } };
}

async function ready(quick: TestQuickInputService): Promise<void> {
	for (let checkpoint = 0; checkpoint < 8 && (quick.currentQuickInput as IQuickPick<IQuickPickItem> | undefined)?.busy; checkpoint++) await Promise.resolve();
	assert.equal((quick.currentQuickInput as IQuickPick<IQuickPickItem> | undefined)?.busy, false, 'catalog must settle before keyboard acceptance');
}

function accept(): void {
	const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
	assert.ok(input);
	// The loaded source is the default keyboard selection; Back remains after the results.
	const active = document.getElementById(input.getAttribute('aria-activedescendant')!);
	assert.ok(active?.textContent?.includes('A synthetic instruction'));
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

for (const [connection, expected] of [
	[{ kind: 'local', generation: 1 }, URI.file(path).toString()],
	[{ kind: 'ssh', generation: 1, authority: 'ssh+fixture', host: 'fixture' }, `ash-remote://ssh+fixture${path}`],
	[{ kind: 'remote', generation: 1, authority: 'fixture-cloud' }, `ash-remote://fixture-cloud${path}`],
] as const) test(`Instruction selection uses the owning ${connection.kind} connection outside all workspace folders`, async () => {
	using resources = new DisposableStore();
	const { quick, pick } = setup(resources, connection);
	const selecting = pick.asAttachment(new AbortController().signal);
	await ready(quick);
	accept();
	const selected = await selecting;
	assert.equal(selected?.attachment.resource?.toString(), expected);
	assert.deepEqual(await selected?.attachment.resolve(), { name: 'A synthetic instruction', content: path, kind: 'instruction' });
	assert.equal(quick.currentQuickInput, undefined);
});

test('Instruction selection cannot attach a catalog from a replaced connection', async () => {
	using resources = new DisposableStore();
	const { quick, pick, changeConnection } = setup(resources, { kind: 'ssh', generation: 1, authority: 'ssh+fixture', host: 'fixture' });
	const selecting = pick.asAttachment(new AbortController().signal);
	await ready(quick);
	changeConnection({ kind: 'local', generation: 2 });
	accept();
	assert.equal(await selecting, undefined);
	assert.equal(quick.currentQuickInput, undefined);
});

test('Instruction picker cancellation releases the actual Quick Pick without accepting an attachment', async () => {
	using resources = new DisposableStore();
	const { quick, pick } = setup(resources, { kind: 'local', generation: 1 });
	const controller = new AbortController();
	const selecting = pick.asAttachment(controller.signal);
	await ready(quick);
	controller.abort();
	assert.equal(await selecting, undefined);
	assert.equal(quick.currentQuickInput, undefined);
});
