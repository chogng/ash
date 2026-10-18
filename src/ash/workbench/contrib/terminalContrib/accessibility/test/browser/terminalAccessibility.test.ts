import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ICommandDetectionCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { TextAreaSyncAddon } from '../../browser/textAreaSyncAddon.js';
import { BufferContentTracker } from '../../browser/bufferContentTracker.js';

suite('Terminal accessibility owners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('joins wrapped rows into one text line and replaces the snapshot after a clear', () => {
		let rows = [{ value: 'wide ', wrapped: false }, { value: 'line', wrapped: true }, { value: 'next', wrapped: false }];
		const raw = { buffer: { get active() { return { length: rows.length, baseY: 0, cursorY: rows.length - 1, getLine: (index: number) => rows[index] && { isWrapped: rows[index]!.wrapped, translateToString: (trim: boolean) => trim ? rows[index]!.value.trimEnd() : rows[index]!.value } }; } } } as unknown as Terminal;
		using tracker = new BufferContentTracker({ raw });
		tracker.update();
		assert.deepEqual(tracker.lines, ['wide line', 'next']);
		rows = [{ value: 'replacement', wrapped: false }];
		tracker.update();
		assert.deepEqual(tracker.lines, ['replacement']);
	});

	test('only synchronizes detected shell input while optimized and unsubscribes on capability removal and disposal', () => {
		using capabilities = new TerminalCapabilityStore();
		using optimization = new Emitter<void>();
		using changed = new Emitter<void>();
		let optimized = false;
		const model = { value: 'echo 中文', cursorIndex: 5, onDidChangeInput: changed.event };
		const detection = { type: TerminalCapability.CommandDetection, promptInputModel: model } as unknown as ICommandDetectionCapability;
		const textarea = document.createElement('textarea');
		textarea.value = 'untouched';
		using addon = new TextAreaSyncAddon(capabilities, { isScreenReaderOptimized: () => optimized, onDidChangeScreenReaderOptimized: optimization.event } as IAccessibilityService);
		addon.activate({ textarea } as Terminal);
		capabilities.add(TerminalCapability.CommandDetection, detection);
		assert.equal(textarea.value, 'untouched');
		optimized = true;
		optimization.fire();
		assert.equal(textarea.value, 'echo 中文');
		assert.equal(textarea.selectionStart, 5);
		model.value = 'echo changed';
		model.cursorIndex = 8;
		changed.fire();
		assert.deepEqual([textarea.value, textarea.selectionStart, textarea.selectionEnd], ['echo changed', 8, 8]);
		capabilities.remove(TerminalCapability.CommandDetection);
		model.value = 'removed';
		changed.fire();
		assert.equal(textarea.value, 'echo changed');
		capabilities.add(TerminalCapability.CommandDetection, detection);
		assert.equal(textarea.value, 'removed');
		addon.dispose();
		model.value = 'disposed';
		changed.fire();
		optimization.fire();
		assert.equal(textarea.value, 'removed');
	});
});
