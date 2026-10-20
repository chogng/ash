import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { ITerminalGroupService, ITerminalService, type ITerminalInstance } from '../../browser/terminal.js';
import { TerminalEditingService } from '../../browser/terminalEditingService.js';
import { registerTerminalActions } from '../../browser/terminalActions.js';

registerTerminalActions();

suite('Terminal editing focus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a rejected rename-style input validator releases its prompt and restores focus', async () => {
		const document = browserEnvironment.window.document;
		const container = document.createElement('div');
		const terminal = document.createElement('textarea');
		container.append(terminal);
		document.body.append(container);
		using quickInput = new TestQuickInputService({ container });
		try {
			terminal.focus();
			const operation = quickInput.input({ title: 'Rename', validateInput: async () => { throw new Error('Validation failed'); } });
			const rejected = assert.rejects(operation, /Validation failed/u);
			await quickInput.accept();
			await rejected;
			assert.equal(quickInput.currentQuickInput, undefined);
			assert.equal(document.activeElement, terminal);
		} finally {
			container.remove();
		}
	});

	for (const boundary of ['create', 'reveal', 'workspace', 'none'] as const) {
		const newerPicker = boundary === 'create' || boundary === 'reveal';
		test(boundary === 'workspace' ? 'a new terminal receives focus after its own workspace chooser completes' : boundary === 'none' ? 'a new terminal receives focus when no newer interaction supersedes it' : `a terminal created during ${boundary} keeps a newer picker focused`, async () => {
			const document = browserEnvironment.window.document;
			const container = document.createElement('div');
			const terminal = document.createElement('textarea');
			container.append(terminal);
			document.body.append(container);
			using quickInput = new TestQuickInputService({ container });
			using services = new InstantiationService();
			const creating = new DeferredPromise<void>();
			const created = new DeferredPromise<void>();
			const revealing = new DeferredPromise<void>();
			const revealed = new DeferredPromise<void>();
			const choosing = new DeferredPromise<void>();
			let active: ITerminalInstance | undefined;
			const instance = { xterm: { focus: () => terminal.focus() } } as ITerminalInstance;
			services.registerInstance(ITerminalService, {
				get activeInstance() { return active; },
				async createTerminal() {
					await creating.complete();
					if (boundary === 'workspace') {
						const choice = quickInput.input({ title: 'Choose workspace' });
						await choosing.complete();
						await choice;
					}
					await created.p;
					return instance;
				},
				setActiveInstance(value: ITerminalInstance) { active = value; },
			} as unknown as ITerminalService);
			services.registerInstance(ITerminalGroupService, {
				async showPanel(focus: boolean) {
					await revealing.complete();
					await revealed.p;
					if (focus) terminal.focus();
				},
			} as unknown as ITerminalGroupService);
			services.registerInstance(IQuickInputService, quickInput);
			using commands = new CommandService(services, CommandsRegistry);
			try {
				terminal.focus();
				const operation = commands.executeCommand('workbench.action.terminal.new');
				await creating.p;
				if (boundary === 'workspace') { await choosing.p; await quickInput.accept(); }
				if (boundary === 'reveal') { await created.complete(); await revealing.p; }
				using next = quickInput.createQuickPick();
				next.items = [{ label: 'Next command' }];
				if (newerPicker) next.show();
				const field = newerPicker ? container.querySelector<HTMLInputElement>('.ash-quick-pick input')! : terminal;
				await created.complete();
				await revealed.complete();
				await operation;
				assert.equal(document.activeElement, field);
				assert.equal(active, instance);
			} finally {
				await created.complete();
				await revealed.complete();
				container.remove();
			}
		});
	}

	test('a completed rename keeps focus in a newer picker', async () => {
		const document = browserEnvironment.window.document;
		const container = document.createElement('div');
		const terminal = document.createElement('textarea');
		container.append(terminal);
		document.body.append(container);
		using quickInput = new TestQuickInputService({ container });
		const started = new DeferredPromise<void>();
		const renamed = new DeferredPromise<void>();
		let title: string | undefined;
		const instance = {
			title: 'Original',
			xterm: { isDisposed: false, focus: () => terminal.focus() },
			async rename(value: string) { title = value; await started.complete(); await renamed.p; },
		} as unknown as ITerminalInstance;
		const terminals = { instances: [instance], activeInstance: instance, onDidDisposeInstance: Event.None } as unknown as ITerminalService;
		using editing = new TerminalEditingService(terminals, quickInput);
		try {
			terminal.focus();
			const operation = editing.rename(instance);
			const field = container.querySelector<HTMLInputElement>('.ash-quick-pick input')!;
			field.value = 'Renamed';
			field.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
			await quickInput.accept();
			await started.p;
			using next = quickInput.createQuickPick();
			next.items = [{ label: 'Next command' }];
			next.show();
			const nextField = container.querySelector<HTMLInputElement>('.ash-quick-pick input')!;
			assert.equal(document.activeElement, nextField);
			await renamed.complete();
			await operation;
			assert.equal(title, 'Renamed');
			assert.equal(document.activeElement, nextField);
			assert.equal(editing.getEditingTerminal(), undefined);
		} finally {
			await renamed.complete();
			container.remove();
		}
	});
});
