import { AgentsWindowGraphicVariant } from '../../common/constants.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { renderAgentsWindowGraphic, type AgentsWindowGraphicDesign } from './agentsWindowGraphic.js';

export interface IAgentsBannerOptions {
	/** Opens Agents through the host's existing command and workspace ownership. */
	readonly onButtonClick?: () => void | Promise<void>;
}

export interface IAgentsBannerResult {
	/** Host-owned placement and presentation classes may be applied to this stable root. */
	readonly element: HTMLElement;
	readonly disposables: DisposableStore;
	setAction(action: IAgentsBannerOptions['onButtonClick']): void;
	setDesign(design: AgentsWindowGraphicDesign | undefined): void;
	/** The host selects a presentation from its available space; the button always remains visible. */
	setLayout(layout: 'spacious' | 'compact' | 'dropped'): void;
}

/** Owns the Agents introduction and its launch listener for the mounting page's lifetime. */
export function createAgentsBanner(document: Document, options: IAgentsBannerOptions): IAgentsBannerResult {
	const disposables = new DisposableStore();
	let action = options.onButtonClick;
	let design: AgentsWindowGraphicDesign | undefined = AgentsWindowGraphicVariant.WindowComparison;
	let dropped = false;
	const element = h(document, 'section');
	element.className = 'ash-agents-banner';
	const graphic = h(document, 'div');
	graphic.append(renderAgentsWindowGraphic(document));
	const button = h(document, 'button');
	button.type = 'button';
	button.className = 'ash-agents-banner-open';
	button.textContent = localize('editorWelcome.openAgentsWindow', 'Open Agents window');
	button.disabled = !action;
	element.hidden = !action;
	disposables.add(addDisposableListener(button, 'click', () => {
		if (!action) {
			return;
		}
		try {
			void Promise.resolve(action()).catch(error => console.error('Failed to open Agents window', error));
		} catch (error) {
			console.error('Failed to open Agents window', error);
		}
	}));
	element.append(graphic, button);
	return {
		element,
		disposables,
		setAction: next => {
			action = next;
			button.disabled = !next;
			element.hidden = !next;
		},
		setDesign: next => {
			if (next !== design) {
				design = next;
				graphic.replaceChildren(...(next ? [renderAgentsWindowGraphic(document, next)] : []));
			}
			graphic.hidden = dropped || !next;
		},
		setLayout: layout => {
			dropped = layout === 'dropped';
			graphic.hidden = dropped || graphic.childElementCount === 0;
			element.classList.toggle('compact', layout !== 'spacious');
		},
	};
}
