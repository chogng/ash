import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalService, type ITerminalInstance, type TerminalInstanceState } from '../../browser/terminal.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { registerTerminalActions } from '../../browser/terminalActions.js';
import { TerminalCommandId } from '../../common/terminal.js';

registerTerminalActions();

class InputTerminal {
	state: TerminalInstanceState = 'running';
	isReadOnly = false;
	target = TerminalLocation.Panel;
	readonly input: unknown[][] = [];
	readonly instance = this as unknown as ITerminalInstance;
	async sendText(...args: unknown[]): Promise<void> { this.input.push(args); }
}

class SelectionFixture extends Disposable {
	readonly model = this._register(new TextModel('  echo first  \r\necho second'));
	selection = new Selection(1, 3, 2, 12);
	editor: ICodeEditor | null = {
		getModel: () => this.model,
		getSelection: () => this.selection,
	} as unknown as ICodeEditor;
	readonly instances: ITerminalInstance[] = [];
	active: ITerminalInstance | undefined;
	readonly effects: unknown[] = [];
	open = async (): Promise<void> => { };
	create = async (): Promise<ITerminalInstance | undefined> => {
		this.effects.push('create');
		return this.add(new InputTerminal());
	};
	private readonly services = this._register(new InstantiationService());
	readonly commands = this._register(new CommandService(this.services));

	constructor() {
		super();
		this.services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => this.editor } as ICodeEditorService);
		const fixture = this;
		this.services.registerInstance(ITerminalService, {
			instances: this.instances,
			get activeInstance() { return fixture.active; },
			createTerminal: () => this.create(),
		} as unknown as ITerminalService);
		this.services.registerInstance(IViewsService, {
			openView: async (id: string, focus: boolean) => {
				this.effects.push(['openView', id, focus]);
				await this.open();
				return { createTerminal: () => this.create() };
			},
		} as unknown as IViewsService);
		this.services.registerInstance(ITerminalGroupService, {
			showPanel: async (focus: boolean) => { this.effects.push(['panel', focus]); },
		} as ITerminalGroupService);
		this.services.registerInstance(ITerminalEditorService, {
			openEditor: async (instance: ITerminalInstance, options: unknown) => { this.effects.push(['editor', instance, options]); },
		} as ITerminalEditorService);
	}

	add(terminal: InputTerminal): ITerminalInstance {
		this.instances.push(terminal.instance);
		this.active = terminal.instance;
		return terminal.instance;
	}

	run(): Promise<unknown> { return this.commands.executeCommand(TerminalCommandId.RunSelectedText); }
}

suite('Terminal run selected text', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends the exact multiline selection through the captured terminal without taking focus', async () => {
		using fixture = new SelectionFixture();
		const terminal = new InputTerminal();
		fixture.add(terminal);
		await fixture.run();
		assert.deepEqual(terminal.input, [['echo first  \necho second', true, true]]);
		assert.deepEqual(fixture.effects, [['panel', false]]);
	});

	test('an empty selection runs the trimmed current line', async () => {
		using fixture = new SelectionFixture();
		const terminal = new InputTerminal();
		fixture.add(terminal);
		fixture.selection = new Selection(1, 5, 1, 5);
		await fixture.run();
		assert.deepEqual(terminal.input, [['echo first', true, true]]);
	});

	test('a blank current line and no active code editor do not acquire a terminal', async () => {
		using fixture = new SelectionFixture();
		fixture.model.setValue('   ');
		fixture.selection = new Selection(1, 1, 1, 1);
		await fixture.run();
		fixture.editor = null;
		await fixture.run();
		assert.deepEqual(fixture.effects, []);
	});

	test('creates through the service before revealing the panel', async () => {
		using fixture = new SelectionFixture();
		const terminal = new InputTerminal();
		fixture.create = async () => { fixture.effects.push('create'); return fixture.add(terminal); };
		await fixture.run();
		assert.deepEqual(terminal.input, [['echo first  \necho second', true, true]]);
		assert.deepEqual(fixture.effects, ['create', ['panel', false]]);
	});

	for (const kind of ['exited', 'read-only'] as const) {
		test(`creates an input terminal rather than sending to an ${kind} instance`, async () => {
			using fixture = new SelectionFixture();
			const original = new InputTerminal();
			if (kind === 'exited') original.state = 'exited';
			else original.isReadOnly = true;
			fixture.add(original);
			const created = new InputTerminal();
			fixture.create = async () => fixture.add(created);
			await fixture.run();
			assert.deepEqual(original.input, []);
			assert.deepEqual(created.input, [['echo first  \necho second', true, true]]);
		});
	}

	test('captures selected text before asynchronous terminal creation', async () => {
		using fixture = new SelectionFixture();
		const requested = new DeferredPromise<void>();
		const result = new DeferredPromise<ITerminalInstance>();
		fixture.create = async () => { await requested.complete(); return result.p; };
		const running = fixture.run();
		await requested.p;
		fixture.model.setValue('different editor content');
		fixture.selection = new Selection(1, 1, 1, 25);
		const terminal = new InputTerminal();
		await result.complete(fixture.add(terminal));
		await running;
		assert.deepEqual(terminal.input, [['echo first  \necho second', true, true]]);
	});

	for (const change of ['closed', 'switched'] as const) {
		test(`a ${change} acquisition never redirects input to another terminal`, async () => {
			using fixture = new SelectionFixture();
			const terminal = new InputTerminal();
			const other = new InputTerminal();
			fixture.create = async () => {
				fixture.add(terminal);
				if (change === 'closed') fixture.instances.splice(0, 1);
				fixture.add(other);
				return terminal.instance;
			};
			await fixture.run();
			assert.deepEqual([terminal.input, other.input], [[], []]);
		});
	}

	test('reconnecting instances receive no input and do not launch another shell', async () => {
		using fixture = new SelectionFixture();
		const terminal = new InputTerminal();
		terminal.state = 'reconnecting';
		fixture.add(terminal);
		await fixture.run();
		assert.deepEqual([terminal.input, fixture.effects], [[], []]);
	});

	test('an editor terminal stays in its editor and is revealed with preserveFocus', async () => {
		using fixture = new SelectionFixture();
		const terminal = new InputTerminal();
		terminal.target = TerminalLocation.Editor;
		fixture.add(terminal);
		await fixture.run();
		assert.deepEqual(fixture.effects, [['editor', terminal.instance, { preserveFocus: true }]]);
		assert.equal(terminal.input.length, 1);
	});
});


suite('Terminal dropdown commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings opens the graphical editor filtered to terminal settings', async () => {
		using services = new InstantiationService();
		const requests: unknown[] = [];
		services.registerInstance(IPreferencesService, { openSettings: async options => { requests.push(options); } } as IPreferencesService);
		using commands = new CommandService(services);
		await commands.executeCommand(TerminalCommandId.ConfigureTerminalSettings);
		assert.deepEqual(requests, [{ jsonEditor: false, query: '@id:terminal.integrated.*' }]);
	});

	for (const initialized of [true, false]) {
		test(`New Terminal creates before revealing a ${initialized ? 'populated' : 'hidden'} panel`, async () => {
			using services = new InstantiationService();
			const terminal = new InputTerminal().instance;
			const instances: ITerminalInstance[] = initialized ? [new InputTerminal().instance] : [];
			const effects: unknown[] = [];
			services.registerInstance(ITerminalService, {
				createTerminal: async () => { effects.push('create'); instances.push(terminal); return terminal; },
				setActiveInstance: (instance: ITerminalInstance) => assert.equal(instance, terminal),
			} as unknown as ITerminalService);
			services.registerInstance(ITerminalGroupService, { showPanel: async (focus: boolean) => { effects.push(['panel', focus]); } } as ITerminalGroupService);
			using commands = new CommandService(services);
			await commands.executeCommand(TerminalCommandId.New);
			assert.deepEqual(effects, ['create', ['panel', true]]);
			assert.equal(instances.length, initialized ? 2 : 1);
		});
	}

	for (const outcome of ['opened', 'canceled', 'failed', 'blocked', 'closed', 'focus-failed'] as const) {
		test(`new terminal window ${outcome} keeps process and window lifetimes together`, async () => {
			using services = new InstantiationService();
			const effects: unknown[] = [];
			const instances: ITerminalInstance[] = [];
			const terminal = new InputTerminal().instance;
			services.registerInstance(ITerminalService, {
				instances, closeTerminal: async () => { effects.push('close terminal'); instances.length = 0; },
				createTerminal: async (options: unknown) => {
					effects.push(['create terminal', options]);
					if (outcome === 'canceled' || outcome === 'closed') throw new CancellationError();
					if (outcome === 'failed') throw new Error('editor failed');
					instances.push(terminal);
					return terminal;
				},
			} as unknown as ITerminalService);
			services.registerInstance(IEditorPartsService, {
				createAuxiliaryEditorPart: async () => {
					effects.push('open window');
					if (outcome === 'blocked') throw new Error('popup blocked');
					return { domNode: { ownerDocument: { defaultView: { focus: () => { effects.push('focus window'); if (outcome === 'focus-failed') throw new Error('focus failed'); } } } }, activeGroup: { id: 12, focus: () => effects.push('focus auxiliary') } };
				},
				closeAuxiliaryEditorPart: async () => { effects.push('close window'); return true; },
			} as unknown as IEditorPartsService);

			using commands = new CommandService(services);
			const operation = commands.executeCommand(TerminalCommandId.NewInNewWindow);
			if (outcome === 'blocked' || outcome === 'failed') await assert.rejects(operation, outcome === 'blocked' ? /popup blocked/ : /editor failed/);
			else if (outcome === 'canceled' || outcome === 'closed') await assert.rejects(operation, isCancellationError);
			else if (outcome === 'focus-failed') await assert.rejects(operation, /focus failed/);
			else await operation;
			assert.deepEqual(effects, outcome === 'blocked' ? ['open window'] : [
				'open window', ['create terminal', { location: { viewColumn: 12 } }],
				...(outcome === 'opened' ? ['focus window', 'focus auxiliary'] : outcome === 'focus-failed' ? ['focus window', 'close terminal', 'close window'] : ['close window']),
			]);
			assert.equal(instances.length, outcome === 'opened' ? 1 : 0);
		});
	}
});
