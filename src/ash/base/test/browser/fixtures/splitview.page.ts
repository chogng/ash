import { SplitView } from '../../../browser/ui/splitview/splitview.js';
import { bindSashFeedbackPresentation, Orientation } from '../../../browser/ui/sash/sash.js';

const horizontal = new URLSearchParams(location.search).get('orientation') === 'horizontal';
const handle = new URLSearchParams(location.search).get('presentation') === 'handle';
const splitView = new SplitView(document.querySelector<HTMLElement>('#app')!, {
	orientation: horizontal ? Orientation.HORIZONTAL : Orientation.VERTICAL,
	styles: { separatorBorder: 'rgb(18, 52, 86)' },
});
let presentation = handle ? bindSashFeedbackPresentation(document.querySelector<HTMLElement>('#app')!, 'handle') : undefined;
window.addEventListener('pagehide', () => presentation?.dispose(), { once: true });
window.addEventListener('pagehide', () => splitView.dispose(), { once: true });
for (let index = 0; index < 3; index++) {
	splitView.addView({
		element: document.createElement('div'), minimumSize: 0, maximumSize: Number.POSITIVE_INFINITY,
		layout() { },
	}, 100);
}
splitView.layout(horizontal ? 600 : 300, horizontal ? 300 : 600);
window.ashSplitViewFixture = {
	setVisible: (index, visible) => splitView.setViewVisible(index, visible),
	setFeedbackPresentation(enabled) {
		presentation?.dispose();
		presentation = enabled ? bindSashFeedbackPresentation(document.querySelector<HTMLElement>('#app')!, 'handle') : undefined;
	},
};

declare global {
	interface Window {
		ashSplitViewFixture: { setVisible(index: number, visible: boolean): void; setFeedbackPresentation(enabled: boolean): void; };
	}
}
