import { localize } from '../../../../nls.js';

export enum CreatorMode {
	Design = 'design',
	Whiteboard = 'whiteboard',
	Slides = 'slides',
	Brand = 'brand',
	Sites = 'sites',
	Make = 'make',
	Prototype = 'prototype',
}

export function getCreatorModeTitle(mode: CreatorMode): string {
	switch (mode) {
		case CreatorMode.Design: return localize('sessions.creator.design.title', 'Design');
		case CreatorMode.Whiteboard: return localize('sessions.creator.whiteboard.title', 'Whiteboard');
		case CreatorMode.Slides: return localize('sessions.creator.slides.title', 'Slides');
		case CreatorMode.Brand: return localize('sessions.creator.brand.title', 'Brand');
		case CreatorMode.Sites: return localize('sessions.creator.sites.title', 'Sites');
		case CreatorMode.Make: return localize('sessions.creator.make.title', 'Make');
		case CreatorMode.Prototype: return localize('sessions.creator.prototype.title', 'Prototype');
	}
}
