import { localize } from '../../../../nls.js';
import type { ISessionsEntry } from '../../../services/layout/common/sessionsEntryService.js';

export const handoffArtifactToCodeCommand = 'sessions.artifacts.handoffToCode';
export const openLinkedArtifactCommand = 'sessions.artifacts.openLinked';
export const openArtifactCommands = { canvas: 'sessions.artifacts.openCanvasArtifact', table: 'sessions.artifacts.openTable' } as const;
export const artifactNameMaxLength = 200;

export function isArtifactName(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= artifactNameMaxLength && value === value.trim() && !/[\r\n\u0000]/u.test(value);
}

export const artifactDetailEntry = {
	workspaceMode: 'chat',
	activityContext: 'sessions.activity.artifactsSelected',
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
	Prototype = 'prototype',
}

export const artifactCanvasModes = {
	slides: ArtifactWorkspaceId.Slides,
	design: ArtifactWorkspaceId.Design,
	whiteboard: ArtifactWorkspaceId.Whiteboard,
	motion: ArtifactWorkspaceId.Design,
} as const;

export type ArtifactCanvasKind = keyof typeof artifactCanvasModes;

export function getArtifactWorkspaceTitle(mode: ArtifactWorkspaceId): string {
	switch (mode) {
		case ArtifactWorkspaceId.Design: return localize('sessions.artifacts.design.title', 'Design');
		case ArtifactWorkspaceId.Whiteboard: return localize('sessions.artifacts.whiteboard.title', 'Whiteboard');
		case ArtifactWorkspaceId.Slides: return localize('sessions.artifacts.slides.title', 'Slides');
		case ArtifactWorkspaceId.Brand: return localize('sessions.artifacts.brand.title', 'Brand');
		case ArtifactWorkspaceId.Sites: return localize('sessions.artifacts.sites.title', 'Sites');
		case ArtifactWorkspaceId.Prototype: return localize('sessions.artifacts.prototype.title', 'Prototype');
	}
}
