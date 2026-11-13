import { localize } from '../../../../nls.js';
import type { ISessionsEntry } from '../../../services/layout/common/sessionsEntryService.js';

export const artifactDetailEntry = {
	workspaceMode: 'current',
	activityContext: 'sessions.activity.creatorSelected',
	content: 'editor',
	conversation: 'visible',
	showEditorTabs: false,
	showDetailsByDefault: false,
	focus: 'editor',
} as const satisfies Partial<ISessionsEntry>;

export enum ArtifactWorkspaceId {
	Design = 'design',
	Whiteboard = 'whiteboard',
	Slides = 'slides',
	Brand = 'brand',
	Sites = 'sites',
	Make = 'make',
	Prototype = 'prototype',
}

export const artifactDesignModes = {
	slides: ArtifactWorkspaceId.Slides,
	design: ArtifactWorkspaceId.Design,
	whiteboard: ArtifactWorkspaceId.Whiteboard,
	motion: ArtifactWorkspaceId.Design,
} as const;

export type ArtifactDesignKind = keyof typeof artifactDesignModes;

export function getArtifactWorkspaceTitle(mode: ArtifactWorkspaceId): string {
	switch (mode) {
		case ArtifactWorkspaceId.Design: return localize('sessions.creator.design.title', 'Design');
		case ArtifactWorkspaceId.Whiteboard: return localize('sessions.creator.whiteboard.title', 'Whiteboard');
		case ArtifactWorkspaceId.Slides: return localize('sessions.creator.slides.title', 'Slides');
		case ArtifactWorkspaceId.Brand: return localize('sessions.creator.brand.title', 'Brand');
		case ArtifactWorkspaceId.Sites: return localize('sessions.creator.sites.title', 'Sites');
		case ArtifactWorkspaceId.Make: return localize('sessions.creator.make.title', 'Make');
		case ArtifactWorkspaceId.Prototype: return localize('sessions.creator.prototype.title', 'Prototype');
	}
}
