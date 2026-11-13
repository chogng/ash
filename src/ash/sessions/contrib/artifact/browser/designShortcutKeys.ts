/** The design canvas dispatches these keys locally while its surface owns focus. */
export const designCanvasShortcutKeys = {
	addFrame: 'f',
	importImage: 'i',
	selectTool: 'v',
	handTool: 'h',
	addRectangle: 'r',
	addEllipse: 'e',
	textTool: 't',
	penTool: 'p',
	group: 'g',
	ungroup: 'u',
	addToSelection: 'n',
	zoomIn: '=',
	zoomInAlternate: '+',
	zoomOut: '-',
	zoomOutAlternate: '_',
	resetZoom: '0',
} as const;

export const designVectorShortcutKeys = {
	flatten: 'f',
	union: 'u',
	subtract: 's',
	intersect: 'i',
	exclude: 'e',
	outline: 'o',
	transform: 'e',
	paintRegions: 'KeyB',
} as const;
