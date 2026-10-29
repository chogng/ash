import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';
import { ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import '../../browser/terminal.chat.contribution.js';

function fixture(owner: DisposableStore) {
	const services = owner.add(new InstantiationService());
	const changed = owner.add(new Emitter<ITerminalInstance | undefined>());
	const instance = { id: 'one', title: 'Shell', cwd: '/workspace', onDidChangeState: Event.None } as unknown as ITerminalInstance;
	services.registerInstance(ITerminalService, { activeInstance: instance, instances: [instance], onDidChangeActiveInstance: changed.event, onDidDisposeInstance: Event.None } as unknown as ITerminalService);
	const attachments: ChatContextAttachment[] = [];
	const drafts: string[] = [];
	let revision = 0;
	let displayed = 'captured output';
	services.registerInstance(IViewsService, {
		getViewWithId: () => ({ getTerminalOutput: async () => displayed }),
		openView: async () => { displayed = 'later output'; revision++; return { appendToDraft: (text: string) => { drafts.push(text); }, addContext: (value: ChatContextAttachment) => attachments.push(value), acceptInput: () => assert.fail('Must not submit') }; },
	} as unknown as IViewsService);
	services.registerInstance(IChatSessionNavigationService, { get revision() { return revision; } } as IChatSessionNavigationService);
	const commands = owner.add(new CommandService(services));
	return { services, changed, commands, drafts, attachments, navigate: () => revision++ };
}

suite('Terminal Ask Chat', () => {
	test('accepts the owner’s first conversation initialization and appends a question with the original parsed output without submitting', async () => {
		using owner = new DisposableStore();
		const f = fixture(owner);
		f.services.registerInstance(IQuickInputService, { input: async () => ' explain this ' } as unknown as IQuickInputService);
		await f.commands.executeCommand('workbench.action.terminal.chat.start');
		assert.deepEqual(f.drafts, ['explain this']);
		assert.equal(f.attachments[0]?.terminalSnapshot?.text, 'captured output');
	});
	for (const retirement of ['cancel', 'terminal', 'conversation'] as const) {
		test(`does not hand off context after ${retirement}`, async () => {
			using owner = new DisposableStore();
			const f = fixture(owner);
			const question = new DeferredPromise<string | undefined>();
			const shown = new DeferredPromise<void>();
			f.services.registerInstance(IQuickInputService, { input: () => { void shown.complete(); return question.p; } } as unknown as IQuickInputService);
			const pending = f.commands.executeCommand('workbench.action.terminal.chat.start');
			await shown.p;
			if (retirement === 'terminal') f.changed.fire(undefined);
			if (retirement === 'conversation') f.navigate();
			await question.complete(retirement === 'cancel' ? undefined : 'question');
			await pending;
			assert.deepEqual(f.drafts, []);
			assert.deepEqual(f.attachments, []);
		});
	}
});
