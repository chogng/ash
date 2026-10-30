import './media/agentsWindowGraphic.css';
import { h } from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { AgentsWindowGraphicVariant } from '../../common/constants.js';

export type AgentsWindowGraphicDesign = AgentsWindowGraphicVariant.WindowComparison | AgentsWindowGraphicVariant.ManyWindowsToOne;

/** Auto waits for a window snapshot; explicit variants never query the host. */
export function resolveAgentsWindowGraphicDesign(variant: AgentsWindowGraphicVariant, hasMultipleEditorWindows: boolean | undefined): AgentsWindowGraphicDesign | undefined {
	if (variant === AgentsWindowGraphicVariant.Auto) {
		if (hasMultipleEditorWindows === undefined) {
			return undefined;
		}
		return hasMultipleEditorWindows ? AgentsWindowGraphicVariant.ManyWindowsToOne : AgentsWindowGraphicVariant.WindowComparison;
	}
	return variant === AgentsWindowGraphicVariant.None ? undefined : variant;
}

/** Draws the Ash window comparison in the caller's document. Captions carry the decorative SVG's meaning. */
export function renderAgentsWindowGraphic(document: Document, design: AgentsWindowGraphicDesign = AgentsWindowGraphicVariant.WindowComparison): HTMLElement {
	if (design === AgentsWindowGraphicVariant.ManyWindowsToOne) {
		return renderConsolidatedWindows(document);
	}
	const comparison = h(document, 'div');
	comparison.className = 'ash-agents-window-graphic';
	const windows = [
		{
			agents: false,
			title: localize('editorWelcome.editorWindow', 'Editor window'),
			description: localize('editorWelcome.editorDescription', 'Explore your code and work with AI by your side.'),
		},
		{
			agents: true,
			title: localize('editorWelcome.agentsWindow', 'Agents window'),
			description: localize('editorWelcome.agentsDescription', 'Bring your projects and agent conversations together.'),
		},
	];
	for (const window of windows) {
		const figure = h(document, 'figure');
		const graphic = windowSketch(document, window.agents);
		const caption = h(document, 'figcaption');
		const title = h(document, 'h2');
		title.textContent = window.title;
		const description = h(document, 'p');
		description.textContent = window.description;
		caption.append(title, description);
		figure.append(graphic, caption);
		comparison.append(figure);
	}
	return comparison;
}

function windowSketch(document: Document, agents: boolean): SVGSVGElement {
	const graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	graphic.setAttribute('viewBox', '0 0 240 150');
	graphic.setAttribute('aria-hidden', 'true');
	graphic.setAttribute('focusable', 'false');
	// Coordinates describe a static illustration, independent of application state.
	const rect = (x: number, y: number, width: number, height: number, kind: string, radius = 2) => {
		const shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		for (const [key, value] of Object.entries({ x, y, width, height, rx: radius })) {
			shape.setAttribute(key, String(value));
		}
		shape.setAttribute('class', kind);
		graphic.append(shape);
	};
	rect(1, 1, 238, 148, 'window-frame', 6);
	rect(2, 2, 236, 18, 'window-chrome', 5);
	rect(91, 8, 58, 4, 'window-line');
	rect(2, 21, agents ? 84 : 58, 127, 'window-chrome', 0);
	if (agents) {
		rect(10, 29, 56, 12, 'window-accent', 4);
		for (let row = 0; row < 6; row++) {
			rect(12, 52 + row * 13, 5, 5, row === 2 ? 'window-accent' : 'window-line');
			rect(23, 53 + row * 13, row % 2 ? 38 : 48, 3, 'window-line');
		}
		rect(98, 32, 76, 5, 'window-line');
		rect(133, 50, 92, 22, 'window-chrome', 4);
		for (let row = 0; row < 3; row++) {
			rect(100, 84 + row * 12, 5, 5, 'window-accent');
			rect(113, 85 + row * 12, 80 - row * 12, 3, 'window-line');
		}
		rect(98, 126, 128, 14, 'window-chrome', 4);
	} else {
		for (let row = 0; row < 8; row++) {
			rect(12 + (row % 3 ? 6 : 0), 32 + row * 12, 28 - row % 3 * 4, 3, 'window-line');
		}
		for (let row = 0; row < 9; row++) {
			rect(72 + row % 3 * 8, 33 + row * 11, 22 + row % 4 * 9, 3, row % 3 === 0 ? 'window-accent' : 'window-line');
			rect(126 + row % 2 * 8, 33 + row * 11, 18, 3, 'window-line');
		}
		rect(174, 21, 64, 127, 'window-chrome', 0);
		rect(183, 34, 44, 3, 'window-line');
		rect(183, 51, 44, 24, 'window-frame', 4);
		for (let row = 0; row < 4; row++) {
			rect(183, 88 + row * 8, 38 - row * 5, 3, 'window-line');
		}
		rect(182, 128, 46, 12, 'window-frame', 4);
	}
	return graphic;
}

/** Several project windows converge on the same Agents sketch used by the comparison. */
function renderConsolidatedWindows(document: Document): HTMLElement {
	const container = h(document, 'div');
	container.className = 'ash-agents-window-graphic many-windows-to-one';
	const figure = h(document, 'figure');
	const scene = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	scene.setAttribute('viewBox', '0 0 560 210');
	scene.setAttribute('aria-hidden', 'true');
	scene.setAttribute('focusable', 'false');
	for (let index = 0; index < 3; index++) {
		const editor = windowSketch(document, false);
		editor.setAttribute('x', String(8 + index * 16));
		editor.setAttribute('y', String(8 + index * 28));
		editor.setAttribute('width', '190');
		editor.setAttribute('height', '119');
		scene.append(editor);
	}
	const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	arrow.setAttribute('d', 'M250 104h42m-8-8 8 8-8 8');
	arrow.setAttribute('class', 'window-merge-arrow');
	scene.append(arrow);
	const agents = windowSketch(document, true);
	agents.setAttribute('x', '310');
	agents.setAttribute('y', '30');
	agents.setAttribute('width', '240');
	agents.setAttribute('height', '150');
	scene.append(agents);
	const caption = h(document, 'figcaption');
	const description = h(document, 'p');
	description.textContent = localize('editorWelcome.manyWindowsDescription', 'All your projects and agents, in one window.');
	caption.append(description);
	figure.append(scene, caption);
	container.append(figure);
	return container;
}
