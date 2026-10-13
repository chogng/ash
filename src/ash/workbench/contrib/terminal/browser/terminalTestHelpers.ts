import type { Terminal } from '@xterm/xterm';

/** Browser tests wait for parsing, so callbacks and markers observe the written screen. */
export function writeP(terminal: Terminal, data: string): Promise<void> {
	return new Promise(resolve => terminal.write(data, resolve));
}
