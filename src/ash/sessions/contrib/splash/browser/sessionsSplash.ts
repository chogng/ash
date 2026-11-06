import './sessionsSplash.css';
import type { IPartsSplash } from '../../../../platform/theme/common/themeService.js';
import { showPartsSplash } from '../../../../workbench/contrib/splash/browser/splash.js';

export function showSessionsSplash(document: Document, splash: IPartsSplash): void {
	splash = identifyLegacyChrome(splash);
	const shell = showPartsSplash(document, splash);
	const parts = splash.layoutInfo?.partBounds;
	const titlebarRegion = shell.querySelector('[data-part="titlebar"]');
	if (!parts || !titlebarRegion) return;

	const titlebar = parts.find(part => part.id === 'titlebar');
	const sidebar = parts.find(part => part.id === 'sidebar');
	const border = sidebar?.borders[1];
	if (!titlebar || !sidebar || !border?.width || border.style === 'none' || titlebar.top + titlebar.height !== sidebar.top) return;

	// The live titlebar continues the sidebar border with a pseudo-element.
	const separator = document.createElement('div');
	separator.className = 'ash-sessions-splash-titlebar-separator';
	separator.style.left = `${sidebar.left + sidebar.width - titlebar.left - border.width}px`;
	separator.style.borderRight = `${border.width}px ${border.style} ${border.color}`;
	titlebarRegion.append(separator);
}

function identifyLegacyChrome(splash: IPartsSplash): IPartsSplash {
	const layout = splash.layoutInfo;
	if (!layout || layout.partBounds.some(part => part.id)) return splash;
	// Older desktop caches recorded paint and bounds without Part IDs.
	const titlebar = layout.partBounds.find(part => part.top === 0 && part.left === 0 && part.width === layout.width);
	if (!titlebar) return splash;
	const sidebar = layout.partBounds.find(part => part.left === titlebar.left
		&& part.top === titlebar.top + titlebar.height && part.width < titlebar.width && part.borders[1].width > 0);
	return {
		...splash,
		layoutInfo: {
			...layout,
			partBounds: layout.partBounds.map(part => {
				if (part === titlebar) return { ...part, id: 'titlebar' };
				if (part === sidebar) return { ...part, id: 'sidebar' };
				return part;
			}),
		},
	};
}
