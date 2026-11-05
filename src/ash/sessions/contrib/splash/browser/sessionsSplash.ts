import './sessionsSplash.css';
import type { IPartsSplash, IPartsSplashPartBounds, IPartsSplashSkeleton } from '../../../../platform/theme/common/themeService.js';
import { showPartsSplash } from '../../../../workbench/contrib/splash/browser/splash.js';
import { SessionsLayoutPolicy } from '../../../browser/layoutPolicy.js';
import type { ISessionsEntry } from '../../../services/layout/common/sessionsLayoutService.js';

export function showSessionsSplash(document: Document, splash: IPartsSplash): void {
	splash = identifyLegacyChrome(splash);
	const shell = showPartsSplash(document, splash);
	shell.classList.add('ash-sessions-splash');
	shell.style.color = splash.colorInfo.foreground;

	const cached = splash.layoutInfo?.partBounds ?? [];
	const regions = Array.from(shell.querySelectorAll<HTMLElement>(':scope > [data-part]'));
	if (regions.length) {
		const sidebar = cached.find(part => part.id === 'sidebar');
		const titlebar = cached.find(part => part.id === 'titlebar');
		const titlebarRegion = regions.find(region => region.dataset.part === 'titlebar');
		const border = sidebar?.borders[1];
		if (sidebar && titlebar && titlebarRegion && border?.width && border.style !== 'none'
			&& titlebar.top + titlebar.height === sidebar.top) {
			// The live titlebar continues the sidebar border with a pseudo-element.
			const separator = document.createElement('div');
			separator.className = 'ash-sessions-splash-titlebar-separator';
			separator.style.left = `${sidebar.left + sidebar.width - titlebar.left - border.width}px`;
			separator.style.borderRight = `${border.width}px ${border.style} ${border.color}`;
			titlebarRegion.append(separator);
		}
		for (const region of regions) {
			const part = cached.find(part => part.id === region.dataset.part);
			if (part?.skeleton) {
				region.setAttribute('data-splash-captured', '');
				appendSkeleton(region, part.skeleton);
			}
			else if (part?.id === 'sidebar') appendSidebar(region);
		}
		return;
	}

	const fallback = document.createElement('div');
	fallback.className = 'ash-sessions-splash-fallback';
	const layout = splash.layoutInfo;
	const hasPageSkeleton = cached.some(part => part.skeleton);
	if (layout && hasPageSkeleton) {
		// Keep the cached composition when the viewport changes, using proportional bounds.
		fallback.classList.add('ash-sessions-splash-scaled');
		for (const part of cached) {
			if (!part.skeleton && part.id !== 'sidebar') continue;
			const region = document.createElement('div');
			region.className = 'ash-sessions-splash-region';
			setFractionalBounds(region, {
				left: part.left / layout.width, top: part.top / layout.height,
				width: part.width / layout.width, height: part.height / layout.height,
			});
			if (part.skeleton) appendSkeleton(region, part.skeleton);
			else {
				region.style.background = part.background;
				appendSidebar(region);
			}
			fallback.append(region);
		}
	} else {
		const sidebarWidth = new SessionsLayoutPolicy().getPartSizes(document.defaultView?.innerWidth ?? 0, 0).sideBarSize;
		appendSidebar(fallback).style.width = `${sidebarWidth}px`;
		const main = document.createElement('div');
		main.className = 'ash-sessions-splash-uncached-main';
		fallback.append(main);
	}
	shell.append(fallback);
}

function identifyLegacyChrome(splash: IPartsSplash): IPartsSplash {
	const layout = splash.layoutInfo;
	if (!layout || layout.partBounds.some(part => part.id)) return splash;
	// Older desktop caches recorded paint and bounds without Part IDs.
	const titlebar = layout.partBounds.find(part => part.top === 0 && part.left === 0 && part.width === layout.width);
	if (!titlebar) return splash;
	const sidebar = layout.partBounds.find(part => part.left === titlebar.left
		&& part.top === titlebar.top + titlebar.height && part.width < titlebar.width && part.borders[1].width > 0);
	const main = layout.partBounds.find(part => part.top === titlebar.top + titlebar.height
		&& part.left === (sidebar ? sidebar.left + sidebar.width : titlebar.left));
	return {
		...splash,
		layoutInfo: {
			...layout,
			partBounds: layout.partBounds.map(part => {
				if (part === titlebar) return { ...part, id: 'titlebar' };
				if (part === sidebar) return { ...part, id: 'sidebar' };
				if (part === main) return { ...part, id: 'legacy-main' };
				return part;
			}),
		},
	};
}

/** Fill an uncached main region only after navigation has resolved the actual restore target. */
export function showSessionsSplashForRestore(document: Document, entry: Pick<ISessionsEntry, 'content' | 'splash'>): void {
	if (!entry.splash) return;
	const shell = document.querySelector<HTMLElement>('#ash-parts-splash.ash-sessions-splash');
	if (!shell || shell.querySelector('[data-splash-captured], .ash-sessions-splash-cards, .ash-sessions-splash-chat, .ash-sessions-splash-scaled')) return;
	const part = entry.content === 'editor' ? 'editor' : 'sessions';
	const region = shell.querySelector<HTMLElement>(`.ash-sessions-splash-uncached-main, [data-part="${part}"], [data-part="legacy-main"]`);
	if (!region) return;
	if (entry.splash === 'grid') appendCards(region);
	else appendDefaultChat(region);
}

function setFractionalBounds(element: HTMLElement, bounds: IPartsSplashPartBounds): void {
	Object.assign(element.style, {
		left: `${100 * bounds.left}%`,
		top: `${100 * bounds.top}%`,
		width: `${100 * bounds.width}%`,
		height: `${100 * bounds.height}%`,
	});
}

function appendSkeleton(region: HTMLElement, skeleton: IPartsSplashSkeleton): void {
	const document = region.ownerDocument;
	for (const bounds of skeleton.shapes) {
		const shape = document.createElement('div');
		shape.className = bounds.surface ? 'ash-sessions-splash-shape surface' : 'ash-sessions-splash-shape';
		setFractionalBounds(shape, bounds);
		region.append(shape);
	}
	if (skeleton.grid) appendCards(region);
}

function appendDefaultChat(region: HTMLElement): void {
	const document = region.ownerDocument;
	const chat = document.createElement('div');
	chat.className = 'ash-sessions-splash-chat';
	chat.append(document.createElement('div'), document.createElement('div'));
	region.append(chat);
}

function appendSidebar(region: HTMLElement): HTMLElement {
	const document = region.ownerDocument;
	const rows = document.createElement('div');
	rows.className = 'ash-sessions-splash-sidebar';
	for (let i = 0; i < 3; i++) {
		rows.append(document.createElement('div'));
	}
	region.append(rows);
	return rows;
}

function appendCards(region: HTMLElement): void {
	const document = region.ownerDocument;
	const cards = document.createElement('div');
	cards.className = 'ash-sessions-splash-cards';
	for (let i = 0; i < 8; i++) {
		const card = document.createElement('div');
		const mark = document.createElement('span');
		const lines = document.createElement('div');
		lines.append(document.createElement('span'), document.createElement('span'));
		card.append(mark, lines);
		cards.append(card);
	}
	region.append(cards);
}
