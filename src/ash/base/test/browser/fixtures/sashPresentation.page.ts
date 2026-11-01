import { SplitView } from '../../../browser/ui/splitview/splitview.js';
import { bindSashFeedbackPresentation, Orientation } from '../../../browser/ui/sash/sash.js';

const root = document.querySelector<HTMLElement>('#app')!;
const horizontal = new URLSearchParams(location.search).get('orientation') === 'horizontal';
const bordered = new URLSearchParams(location.search).has('border');
// One split already exists when the scope is bound; another is created afterward.
function createSplit(): SplitView {
	const split = new SplitView(root, {
		orientation: horizontal ? Orientation.HORIZONTAL : Orientation.VERTICAL,
		styles: bordered ? { separatorBorder: 'rgb(20, 40, 60)' } : undefined,
	});
	for (let index = 0; index < 3; index++) {
		split.addView({
			element: document.createElement('div'),
			minimumSize: 0,
			maximumSize: Number.POSITIVE_INFINITY,
			layout() { },
		}, 100);
	}
	split.layout(horizontal ? 600 : 300, horizontal ? 300 : 600);
	return split;
}
const first = createSplit();
const presentation = bindSashFeedbackPresentation(root, 'handle');
const second = createSplit();
window.ashSashPresentation = {
	disable: () => presentation.dispose(),
	offset: (value: number) => { first.getSash(0)!.setFeedbackOffset(value); second.getSash(0)!.setFeedbackOffset(value); },
};
window.addEventListener('pagehide', () => {
	presentation.dispose();
	first.dispose();
	second.dispose();
}, { once: true });

declare global {
	interface Window {
		ashSashPresentation: { disable(): void; offset(value: number): void; };
	}
}
