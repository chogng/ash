import { AgentsWindowGraphicVariant } from '../../common/constants.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { renderAgentsWindowGraphic, type AgentsWindowGraphicDesign } from './agentsWindowGraphic.js';

export interface IAgentsBannerOptions {
	/** Creates an empty Editor window through the mounting host. */
	readonly onEditorClick?: () => void | Promise<void>;
	/** Opens Agents through the host's existing command and workspace ownership. */
	readonly onButtonClick?: () => void | Promise<void>;
}

export interface IAgentsBannerResult {
	/** Host-owned placement and presentation classes may be applied to this stable root. */
	readonly element: HTMLElement;
	readonly disposables: DisposableStore;
	setAction(action: IAgentsBannerOptions['onButtonClick']): void;
	setDesign(design: AgentsWindowGraphicDesign | undefined): void;
}

/** Owns the Agents introduction and its launch listener for the mounting page's lifetime. */
export function createAgentsBanner(document: Document, options: IAgentsBannerOptions): IAgentsBannerResult {
	const disposables = new DisposableStore();
	let action = options.onButtonClick;
	let design: AgentsWindowGraphicDesign | undefined = AgentsWindowGraphicVariant.WindowComparison;
	const element = h(document, 'section');
	element.className = 'ash-agents-banner';
	const graphic = h(document, 'div');
	const createButton = (label: string, run: () => void | Promise<void>): HTMLButtonElement => {
		const button = h(document, 'button');
		button.type = 'button';
		button.className = 'ash-agents-window-card';
		button.setAttribute('aria-label', label);
		button.title = label;
		disposables.add(addDisposableListener(button, 'click', () => {
			try {
				void Promise.resolve(run()).catch(error => console.error('Failed to open window', error));
			} catch (error) {
				console.error('Failed to open window', error);
			}
		}));
		return button;
	};
	const editorButton = createButton(localize('editorWelcome.openEditorWindow', 'Open new editor window'), () => options.onEditorClick?.());
	const agentsButton = createButton(localize('editorWelcome.openAgentsWindow', 'Open Agents window'), () => action?.());
	editorButton.disabled = !options.onEditorClick;
	agentsButton.disabled = !action;
	element.hidden = !action;
	const render = (): void => {
		const focused = [editorButton, agentsButton].find(button => document.activeElement === button);
		const illustration = renderAgentsWindowGraphic(document, design);
		// No-graphic preferences keep both window entries usable as text actions.
		if (!design) {
			for (const svg of illustration.querySelectorAll('svg')) svg.remove();
		}
		const buttons = design === AgentsWindowGraphicVariant.ManyWindowsToOne ? [agentsButton] : [editorButton, agentsButton];
		illustration.querySelectorAll('figure').forEach((figure, index) => {
			const button = buttons[index]!;
			button.setAttribute('aria-description', figure.querySelector('p')!.textContent ?? '');
			figure.append(button);
		});
		graphic.replaceChildren(illustration);
		// The native buttons and listeners survive presentation changes; restore focus after reparenting.
		if (focused) {
			(focused.isConnected ? focused : agentsButton).focus({ preventScroll: true });
		}
	};
	render();
	element.append(graphic);
	return {
		element,
		disposables,
		setAction: next => {
			action = next;
			agentsButton.disabled = !next;
			element.hidden = !next;
		},
		setDesign: next => {
			if (next !== design) {
				design = next;
				render();
			}
		},
	};
}
