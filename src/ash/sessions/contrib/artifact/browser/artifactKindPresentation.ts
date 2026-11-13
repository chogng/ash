import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { ArtifactKind } from '../../../common/artifactKind.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../common/artifactWorkspace.js';
import './artifactKindPresentation.css';

const artifactIllustrations: Record<ArtifactKind, string | Icon> = {
	docs: 'M38 8H17a5 5 0 0 0-5 5v38a5 5 0 0 0 5 5h30a5 5 0 0 0 5-5V22L38 8Zm0 0v14h14',
	slides: 'M7 10h50M10 10v31a5 5 0 0 0 5 5h34a5 5 0 0 0 5-5V10M32 46v10m0-10L22 58m10-12 10 12',
	design: 'M33 9C18 9 7 19 7 33s11 23 24 23h5a6 6 0 0 0 5-9l-2-3c-2-3 0-6 4-6h4c8 0 12-5 10-12C55 15 44 9 33 9ZM20 26a2 2 0 1 0 0 .1m12-8a2 2 0 1 0 0 .1m12 6a2 2 0 1 0 0 .1M17 38a2 2 0 1 0 0 .1',
	sheet: Lxicon.table,
	whiteboard: Lxicon.pen,
	data: Lxicon.database,
	motion: Lxicon.motion,
};

export function getArtifactTitle(kind: ArtifactKind): string {
	switch (kind) {
		case 'docs': return localize('sessions.artifacts.docs', 'Docs');
		case 'slides': return getArtifactWorkspaceTitle(ArtifactWorkspaceId.Slides);
		case 'design': return getArtifactWorkspaceTitle(ArtifactWorkspaceId.Design);
		case 'sheet': return localize('sessions.artifacts.sheet', 'Sheet');
		case 'whiteboard': return getArtifactWorkspaceTitle(ArtifactWorkspaceId.Whiteboard);
		case 'data': return localize('sessions.artifacts.data', 'Data');
		case 'motion': return localize('sessions.design.motionMode', 'Motion');
	}
}

export function appendArtifactIcon(kind: ArtifactKind, container: HTMLElement): Element {
	const illustration = artifactIllustrations[kind];
	if (typeof illustration !== 'string') {
		const icon = appendIcon(illustration, container);
		icon.classList.add('ash-artifact-kind-icon');
		return icon;
	}
	const document = container.ownerDocument;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('ash-artifact-kind-icon');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('viewBox', '0 0 64 64');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '3');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	const path = document.createElementNS(svg.namespaceURI, 'path');
	path.setAttribute('d', illustration);
	svg.append(path);
	container.append(svg);
	return svg;
}
