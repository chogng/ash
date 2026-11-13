export const enum ChatWindowLayoutMode {
	SideBySide = 'sideBySide',
	Stacked = 'stacked',
}

export const enum ChatWindowTerminalPosition {
	FullWidth = 'fullWidth',
	UnderChat = 'underChat',
	UnderEditor = 'underEditor',
}

export type ChatWindowEdge = 'left' | 'right' | 'top' | 'bottom';

export const chatWindowEdges: readonly ChatWindowEdge[] = ['left', 'right', 'top', 'bottom'];
