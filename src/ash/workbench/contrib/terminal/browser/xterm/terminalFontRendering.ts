import type { Terminal } from '@xterm/xterm';
import { isMacintosh } from '../../../../../base/common/platform.js';
import type { ITerminalConfiguration } from '../../common/terminal.js';
import './terminalFontRendering.css';

/** The renderer owns this class; cached glyphs must follow a changed antialiasing policy. */
export function updateTerminalFontRendering(terminal: Terminal, fontRendering: ITerminalConfiguration['fontRendering']): void {
	const element = terminal.element;
	if (!element) return;
	const enabled = isMacintosh && fontRendering === 'grayscale';
	if (element.classList.contains('ash-terminal-font-grayscale') === enabled) return;
	element.classList.toggle('ash-terminal-font-grayscale', enabled);
	terminal.clearTextureAtlas();
}
