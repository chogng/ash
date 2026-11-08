import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export function renderProjectsWelcomePage(container: HTMLElement, searching: boolean, onClick: () => void, content: DisposableStore): void {
	const document = container.ownerDocument;
	const empty = h(document, 'div', { className: 'ash-projects-empty' });
	const illustration = h(
		document,
		'div',
		{ className: 'ash-projects-illustration', attributes: { 'aria-hidden': 'true' } },
		h(document, 'span'),
		h(document, 'span'),
		h(document, 'span'),
	);
	empty.append(
		illustration,
		h(
			document,
			'h2',
			{},
			searching
				? localize('projects.noResults', 'No matching projects')
				: localize('projects.emptyTitle', 'Looking to start a project?'),
		),
		h(
			document,
			'p',
			{},
			searching
				? localize('projects.searchHint', 'Try another name or clear your search.')
				: localize('projects.emptyDescription', 'Bring your materials and goals together in one space.'),
		),
	);
	content.add(new Button(empty, {
		...defaultButtonStyles,
		label: searching
			? localize('projects.clearSearch', 'Clear search')
			: localize('projects.new', 'New project'),
		presentation: 'secondary',
		onClick,
	}));
	container.append(empty);
}
