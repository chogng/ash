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
import { TerminalAccessibilityHelpProvider } from '../../browser/terminalAccessibilityHelp.js';
import type { ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';

suite('Terminal accessibility owners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const [locale, folderHelp] of [
		['en', 'Folders inside this terminal’s workspace root are selected in Explorer.'],
		['zh-CN', '位于此终端所属工作区根目录内的文件夹会在资源管理器中选中。'],
	] as const) {
		test(`documents workspace directory links in accessibility help (${locale})`, () => {
			initializeTestLocalization(locale);
			try {
				using provider = new TerminalAccessibilityHelpProvider({} as ITerminalInstance, true);
				const content = provider.provideContent();
				assert.ok(content.includes(folderHelp));
				assert.ok(
					content.includes(
						locale === 'zh-CN'
							? '任务终端也会在任务输出标题行显示状态标记'
							: 'Task terminals also show a status marker on the task output header',
					),
				);
				assert.ok(
					content.includes(
						locale === 'zh-CN'
							? '建议列表保持终端输入焦点'
							: 'The suggestion list keeps terminal input focused',
					),
				);
				assert.ok(content.includes('<keybinding:workbench.action.terminal.openDetectedLink>'));
				assert.ok(content.includes('<keybinding:workbench.action.terminal.selectAll>'));
				assert.ok(content.includes('<keybinding:workbench.action.terminal.clearSelection>'));
				assert.ok(content.includes(locale === 'zh-CN' ? '只读终端' : 'read-only terminals'));
				for (const action of locale === 'zh-CN'
					? [
							'切换活动终端',
							'增大字号',
							'发送信号',
							'粘贴为一行',
							'命令参考线',
							'列数和行数',
							'自动回复',
							'本地回显',
							'显示环境贡献',
							'录制终端会话',
							'询问 Chat',
							'OSC 99',
						]
					: [
							'Switch Active Terminal',
							'Increase Font Size',
							'Send Signal',
							'Paste as One Line',
							'Show Command Guide',
							'column and row counts',
							'Auto Replies',
							'Local Echo',
							'Show Environment Contributions',
							'Record Terminal Session',
							'Ask Chat',
							'OSC 99',
						]) {
					assert.ok(content.includes(action), `Missing ${locale} accessibility help for ${action}`);
				}
			} finally {
				initializeTestLocalization('en');
			}
		});
	}

	test('joins wrapped rows into one text line and replaces the snapshot after a clear', () => {
		let rows = [
			{ value: 'wide ', wrapped: false },
			{ value: 'line', wrapped: true },
			{ value: 'next', wrapped: false },
		];
		const raw = {
			buffer: {
				get active() {
					return {
						length: rows.length,
						baseY: 0,
						cursorY: rows.length - 1,
						getLine: (index: number) =>
							rows[index] && {
								isWrapped: rows[index]!.wrapped,
								translateToString: (trim: boolean) =>
									trim ? rows[index]!.value.trimEnd() : rows[index]!.value,
							},
					};
				},
			},
		} as unknown as Terminal;
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
		const detection = {
			type: TerminalCapability.CommandDetection,
			promptInputModel: model,
		} as unknown as ICommandDetectionCapability;
		const textarea = document.createElement('textarea');
		textarea.value = 'untouched';
		using addon = new TextAreaSyncAddon(capabilities, {
			isScreenReaderOptimized: () => optimized,
			onDidChangeScreenReaderOptimized: optimization.event,
		} as IAccessibilityService);
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
