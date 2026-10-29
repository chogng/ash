import type { IMatch } from '../../../../base/common/filters.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import type { DebugLinkHoverBehaviorTypeData, ILinkDetector } from './linkDetector.js';
import '../../terminal/common/terminalColorRegistry.js';

const palette = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
interface Style { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean; }

/** Styles output text only. Terminal commands and OSC links never execute in the Console. */
export function handleANSIOutput(text: string, linkDetector: ILinkDetector, workspaceFolder: IWorkspaceFolder | undefined, _highlights: IMatch[] | undefined, hoverBehavior: DebugLinkHoverBehaviorTypeData): HTMLSpanElement {
	const runs: { text: string; style: Style; }[] = [];
	let style: Style = {};
	let offset = 0;
	for (const match of text.matchAll(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g)) {
		if (match.index > offset) runs.push({ text: text.slice(offset, match.index), style: { ...style } });
		if (/^\x1b\[[\d;]*m$/.test(match[0])) style = applyCodes(style, match[0].slice(2, -1));
		offset = match.index + match[0].length;
	}
	if (offset < text.length) runs.push({ text: text.slice(offset), style });
	// Linkify the plain text once, so an escape within a URL cannot split its target.
	const root = linkDetector.linkify(runs.map(run => run.text).join(''), hoverBehavior, true, workspaceFolder) as HTMLSpanElement;
	if (!text.includes('\x1b')) return root;
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	let runIndex = 0;
	let runOffset = 0;
	for (const node of nodes) {
		const fragment = root.ownerDocument.createDocumentFragment();
		let position = 0;
		while (position < node.length && runIndex < runs.length) {
			const run = runs[runIndex]!;
			const count = Math.min(node.length - position, run.text.length - runOffset);
			const span = root.ownerDocument.createElement('span');
			span.className = 'ash-debug-ansi';
			span.textContent = node.data.slice(position, position + count);
			if (run.style.foreground) span.style.color = run.style.foreground;
			if (run.style.background) span.style.backgroundColor = run.style.background;
			span.classList.toggle('bold', !!run.style.bold);
			span.classList.toggle('italic', !!run.style.italic);
			span.classList.toggle('underline', !!run.style.underline);
			fragment.append(span);
			position += count;
			runOffset += count;
			if (runOffset === run.text.length) { runIndex++; runOffset = 0; }
		}
		node.replaceWith(fragment);
	}
	return root;
}

function applyCodes(previous: Style, parameters: string): Style {
	let style = { ...previous };
	const codes = parameters ? parameters.split(';').map(Number) : [0];
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index]!;
		if (code === 0) style = {};
		else if (code === 1 || code === 22) style.bold = code === 1;
		else if (code === 3 || code === 23) style.italic = code === 3;
		else if (code === 4 || code === 24) style.underline = code === 4;
		else if (code === 39) delete style.foreground;
		else if (code === 49) delete style.background;
		else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) style.foreground = paletteColor(code % 10, code >= 90);
		else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) style.background = paletteColor(code % 10, code >= 100);
		else if (code === 38 || code === 48) {
			const kind = codes[++index];
			let color: string | undefined;
			if (kind === 5) {
				const value = codes[++index];
				if (value !== undefined && value >= 0 && value <= 255) {
					if (value < 16) color = paletteColor(value % 8, value >= 8);
					else if (value >= 232) color = `rgb(${Array(3).fill(8 + (value - 232) * 10).join(', ')})`;
					else {
						const cell = value - 16;
						const channel = (n: number) => n === 0 ? 0 : 55 + n * 40;
						color = `rgb(${[Math.floor(cell / 36), Math.floor(cell / 6) % 6, cell % 6].map(channel).join(', ')})`;
					}
				}
			} else if (kind === 2) {
				const rgb = codes.slice(index + 1, index + 4);
				index += 3;
				if (rgb.length === 3 && rgb.every(value => value >= 0 && value <= 255)) color = `rgb(${rgb.join(', ')})`;
			}
			if (color) { if (code === 38) style.foreground = color; else style.background = color; }
		}
	}
	return style;
}

function paletteColor(index: number, bright: boolean): string {
	return `var(--ash-terminal-ansi${bright ? 'Bright' : ''}${palette[index]})`;
}
