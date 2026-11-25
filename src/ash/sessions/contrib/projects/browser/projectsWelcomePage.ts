import { h } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';

export function renderProjectsEmptyState(container: HTMLElement): void {
	const document = container.ownerDocument;
	container.append(h(document, 'div', { className: 'ash-projects-empty' },
		h(document, 'div', { className: 'ash-projects-illustration', attributes: { 'aria-hidden': 'true' } },
			h(document, 'span'), h(document, 'span'), h(document, 'span'),
		),
		h(document, 'h2', {}, localize('projects.noSelection', 'No project selected')),
		h(document, 'p', {}, localize('projects.selectFromSidebar', 'Select a project from the sidebar.')),
	));
}
