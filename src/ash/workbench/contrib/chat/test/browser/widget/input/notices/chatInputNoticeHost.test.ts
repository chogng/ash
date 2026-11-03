import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../../../../browser/widget/input/chatInputNoticeHost.js';
import { DisposableStore } from '../../../../../../../../base/common/lifecycle.js';

suite('Chat input notice arbitration', () => {
	test('the newest peer leads, releasing a non-leading claim leaves its peers intact, and focus follows the winner', () => {
		let focused = 'input';
		const visible = new Set<string>();
		using host = new ChatInputNoticeHost(() => focused = 'input');
		const options = (id: string) => ({
			focusTarget: { hasFocus: () => focused === id, focus: () => focused = id },
			onDidChangeLeading: (leading: boolean) => { if (leading) visible.add(id); else visible.delete(id); },
		});
		using tip = host.occupy(ChatInputNoticeLane.Tip, options('tip'));
		assert.deepEqual([...visible], ['tip']);
		assert.equal(host.toggleFocus(), true);
		assert.equal(focused, 'tip');
		using first = host.occupy(ChatInputNoticeLane.Onboarding, options('first'));
		assert.deepEqual([...visible], ['first']);
		assert.equal(focused, 'first');
		using second = host.occupy(ChatInputNoticeLane.Onboarding, options('second'));
		assert.deepEqual([...visible], ['second']);
		first.dispose();
		assert.deepEqual([...visible], ['second']);
		using notification = host.occupy(ChatInputNoticeLane.Notification, options('notification'));
		assert.deepEqual([...visible], ['notification']);
		notification.dispose();
		assert.deepEqual([...visible], ['second']);
		assert.equal(focused, 'second');
		second.dispose();
		assert.deepEqual([...visible], ['tip']);
		tip.dispose();
		assert.deepEqual([...visible], []);
		assert.equal(focused, 'input');
		assert.equal(host.toggleFocus(), false);
	});

	test('a stand-down callback may replace the pending winner without briefly showing stale content', () => {
		using registrations = new DisposableStore();
		using host = new ChatInputNoticeHost(() => { });
		const shown: string[] = [];
		registrations.add(host.occupy(ChatInputNoticeLane.Tip, {
			onDidChangeLeading: leading => {
				if (leading) shown.push('tip');
				else registrations.add(host.occupy(ChatInputNoticeLane.Notification, {
					onDidChangeLeading: showing => {
						if (showing) shown.push('notification');
					}
				}));
			}
		}));
		registrations.add(host.occupy(ChatInputNoticeLane.Onboarding, {
			onDidChangeLeading: leading => {
				if (leading) shown.push('onboarding');
			}
		}));
		assert.deepEqual(shown, ['tip', 'notification']);
	});

	test('teardown rejects claims acquired by stand-down callbacks and never moves focus', () => {
		let focused = 0;
		let shown = 0;
		using host = new ChatInputNoticeHost(() => focused++);
		using claim = host.occupy(ChatInputNoticeLane.Onboarding, {
			focusTarget: { hasFocus: () => true, focus: () => focused++ },
			onDidChangeLeading: leading => {
				if (leading) return;
				using replacement = host.occupy(ChatInputNoticeLane.Notification, { onDidChangeLeading: visible => { if (visible) shown++; } });
			},
		});
		host.dispose();
		assert.deepEqual({ focused, shown, focusable: host.hasFocusableNotice() }, { focused: 0, shown: 0, focusable: false });
	});
});
