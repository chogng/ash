import './media/browserWelcome.css';

/** Blank-page content belongs to the Workbench DOM, independently of the Chromium page. */
export function createBrowserWelcome(title: string, subtitle: string, document: Document): HTMLElement {
	const root = document.createElement('section');
	root.className = 'ash-browser-welcome';
	const heading = document.createElement('h2');
	heading.textContent = title;
	const description = document.createElement('p');
	description.textContent = subtitle;
	root.append(heading, description);
	return root;
}
