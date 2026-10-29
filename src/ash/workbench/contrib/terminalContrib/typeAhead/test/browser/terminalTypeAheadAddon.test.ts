import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { Terminal } from '@xterm/xterm';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import {
	PromptInputState,
	type IPromptInputModelState,
} from '../../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import type { IProcessDataEvent } from '../../../../../../platform/terminal/common/terminal.js';
import {
	TestConfigurationService,
	TestWorkspaceService,
} from '../../../../../services/configuration/test/common/testServices.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import '../../../../terminal/common/terminalConfiguration.js';
import { TerminalTypeAheadAddon } from '../../browser/terminalTypeAheadAddon.js';

ensureNoDisposablesAreLeakedInTestSuite();

function fixture(resources: DisposableStore) {
	const dom = new JSDOM('<div id="terminal"><div class="xterm-screen"></div></div>');
	resources.add(toDisposable(() => dom.window.close()));
	const element = dom.window.document.querySelector<HTMLDivElement>('#terminal')!;
	element.querySelector('.xterm-screen')!.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 800, height: 480 }) as DOMRect;
	const key = resources.add(new Emitter<{ key: string }>());
	const write = resources.add(new Emitter<IProcessDataEvent>());
	const started = resources.add(new Emitter<IPromptInputModelState>());
	const model = {
		state: PromptInputState.Input,
		value: '',
		cursorIndex: 0,
		ghostTextIndex: -1,
		onDidStartInput: started.event,
		onDidFinishInput: Event.None,
		onDidInterrupt: Event.None,
	};
	const raw = {
		onKey: key.event,
		onRender: Event.None,
		onResize: Event.None,
		onScroll: Event.None,
		buffer: {
			active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0 },
			onBufferChange: Event.None,
		},
		rows: 24,
		cols: 80,
		options: { fontSize: 12, fontFamily: 'monospace' },
	} as unknown as Terminal;
	const configuration = resources.add(
		new TestConfigurationService({
			source: JSON.stringify({
				'terminal.integrated.localEchoEnabled': 'on',
				'terminal.integrated.localEchoLatencyThreshold': 0,
				'terminal.integrated.localEchoStyle': 'dim',
				'terminal.integrated.localEchoExcludePrograms': [],
			}),
		}),
	);
	const workspace = resources.add(new TestWorkspaceService({ id: 'typeahead', folders: [] }));
	const instance = {
		capabilities: {
			get: (capability: TerminalCapability) =>
				capability === TerminalCapability.CommandDetection ? { promptInputModel: model } : undefined,
			onDidChangeCapabilities: Event.None,
		},
		onDidWriteData: write.event,
		onDidChangeState: Event.None,
		onDidExit: Event.None,
		state: 'running',
		title: 'bash',
		isReadOnly: false,
	} as unknown as ITerminalInstance;
	const screen = {
		element,
		isDisposed: false,
		attachWidget: (widget: TerminalTypeAheadAddon) => {
			widget.attach(element);
			return undefined;
		},
	} as unknown as IXtermTerminal;
	const addon = resources.add(new TerminalTypeAheadAddon(instance, screen, configuration, workspace));
	addon.activate(raw);
	const text = () => element.querySelector('.ash-terminal-typeahead')!.textContent;
	const prompt = () => started.fire({ value: '', prefix: '', suffix: '', cursorIndex: 0, ghostTextIndex: -1 });
	return { key, write, text, prompt, addon };
}

test('typeahead keeps unconfirmed and no-echo input hidden, and predicts only after a committed echo in this prompt', async () => {
	using resources = new DisposableStore();
	const { key, write, text, prompt } = fixture(resources);
	key.fire({ key: 'a' });
	assert.equal(text(), '');
	let commit!: () => void;
	write.fire({
		data: 'a',
		trackCommit: true,
		writePromise: new Promise<void>(resolve => {
			commit = resolve;
		}),
	});
	key.fire({ key: 'b' });
	assert.equal(text(), '', 'receiving bytes does not prove the parsed echo has committed');
	commit();
	await Promise.resolve();
	assert.equal(text(), 'b');
	write.fire({ data: 'b', trackCommit: true });
	await Promise.resolve();
	assert.equal(text(), '');
	prompt();
	key.fire({ key: 'SYNTHETIC_SECRET_NO_ECHO' });
	assert.equal(text(), '', 'a new prompt must not inherit echo confirmation');
});

test("typeahead discards echo confirmation on control output and ignores a previous prompt's late commit", async () => {
	using resources = new DisposableStore();
	const { key, write, text, prompt } = fixture(resources);
	key.fire({ key: 'a' });
	write.fire({ data: 'a', trackCommit: true });
	await Promise.resolve();
	key.fire({ key: 'b' });
	assert.equal(text(), 'b');
	write.fire({ data: '\r\n', trackCommit: true });
	key.fire({ key: 'c' });
	assert.equal(text(), '');
	prompt();
	key.fire({ key: 'd' });
	let commit!: () => void;
	write.fire({
		data: 'd',
		trackCommit: true,
		writePromise: new Promise<void>(resolve => {
			commit = resolve;
		}),
	});
	prompt();
	key.fire({ key: 'LATE_SECRET' });
	commit();
	await Promise.resolve();
	assert.equal(text(), '');
});
