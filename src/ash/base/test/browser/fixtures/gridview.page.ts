import { GridView, Orientation } from '../../../browser/ui/grid/gridview.js';

const scroller = document.createElement('div');
scroller.className = 'scroller';
const content = document.createElement('div');
content.className = 'content';
content.textContent = 'Scrollable pane content';
scroller.append(content);
const grid = new GridView(document.querySelector<HTMLElement>('#app')!, {
	type: 'branch', orientation: Orientation.HORIZONTAL, size: 600,
	children: [{ type: 'leaf', size: 600, view: {
		element: scroller, minimumWidth: 0, maximumWidth: Infinity,
		minimumHeight: 0, maximumHeight: Infinity, layout() { },
	} }],
});
grid.layout(600, 300);
// Sashes and anchored controls can extend beyond the grid's border box.
const edge = document.createElement('button');
edge.className = 'edge-control';
edge.textContent = 'Edge control';
grid.element.append(edge);
window.addEventListener('pagehide', () => grid.dispose(), { once: true });
