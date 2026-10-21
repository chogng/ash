import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../../base/common/strings.js';
import { TreeVisibility } from '../../../../../base/browser/ui/tree/tree.js';
import type { DebugConsoleEntry } from '../../../../../platform/debug/common/debugAdapterProcessService.js';
import { handleANSIOutput } from '../../browser/debugANSIHandling.js';
import { DebugLinkHoverBehavior, type ILinkDetector } from '../../browser/linkDetector.js';
import { ReplFilter } from '../../browser/replFilter.js';

suite('Debug ANSI output', () => {
	const dom = browserEnvironment;
	const links: ILinkDetector = {
		linkify: text => {
			const span = dom.window.document.createElement('span');
			span.textContent = text;
			return span;
		}
	};

	test('renders palette, emphasis and reset as text without changing output', () => {
		using store = new DisposableStore();
		const text = '\x1b[31;1merror\x1b[0m <img src=x>\n';
		const result = handleANSIOutput(text, links, undefined, undefined, { type: DebugLinkHoverBehavior.None, store });
		assert.equal(result.textContent, 'error <img src=x>\n');
		assert.equal(result.querySelector('img'), null);
		assert.equal(result.querySelector('.bold')?.textContent, 'error');
		assert.equal((result.firstChild as HTMLElement).style.color, 'var(--ash-terminal-ansiRed)');
		assert.equal((result.lastChild as HTMLElement).style.color, '');
		assert.equal(removeAnsiEscapeCodes(text), result.textContent);
	});

	test('handles 256-color and truecolor without treating channel values as style codes', () => {
		using store = new DisposableStore();
		const result = handleANSIOutput('\x1b[38;5;196mred\x1b[48;2;1;2;3m background\x1b[39;49m reset', links, undefined, undefined, { type: DebugLinkHoverBehavior.None, store });
		const spans = result.querySelectorAll('span');
		assert.equal(spans[0]!.style.color, 'rgb(255, 0, 0)');
		assert.equal(spans[1]!.style.backgroundColor, 'rgb(1, 2, 3)');
		assert.equal(spans[1]!.classList.contains('bold'), false);
		assert.equal(spans[2]!.style.color, '');
		assert.equal(spans[2]!.style.backgroundColor, '');
	});

	test('does not execute cursor controls or OSC links and preserves incomplete escape text', () => {
		using store = new DisposableStore();
		const text = 'before\x1b[2Jafter \x1b]8;;command:delete\x07label\x1b]8;;\x1b\\ \x1b[';
		const result = handleANSIOutput(text, links, undefined, undefined, { type: DebugLinkHoverBehavior.None, store });
		assert.equal(result.textContent, 'beforeafter label \x1b[');
		assert.equal(result.querySelector('a,[role=link]'), null);
		assert.equal(removeAnsiEscapeCodes(text), result.textContent);
	});

	test('filters the visible ANSI-free label while retaining the immutable raw entry', () => {
		const filter = new ReplFilter();
		filter.filterQuery = 'error';
		const entry = { kind: 'output', output: 'er\x1b[31mror\x1b[0m' } as DebugConsoleEntry;
		assert.equal(filter.filter(entry, TreeVisibility.Visible), TreeVisibility.Visible);
		assert.equal(entry.output, 'er\x1b[31mror\x1b[0m');
	});
});
