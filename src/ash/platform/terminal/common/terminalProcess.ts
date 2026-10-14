import type { TerminalShellIntegrationEvent } from './terminal.js';

/** A screen replay segment parsed at the geometry active when its data was received. */
export interface ReplayEntry {
	cols: number;
	rows: number;
	data: string;
	shellIntegration?: TerminalShellIntegrationEvent;
}
