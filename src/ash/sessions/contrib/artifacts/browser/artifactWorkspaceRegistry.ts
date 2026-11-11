import type { IDimension } from '../../../../base/browser/dom.js';
import type { Icon } from '../../../../base/common/icon.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { CanvasArtifactExample } from './artifactExamples.js';

export interface IArtifactWorkspace extends IDisposable {
	readonly domNode: HTMLElement;
	readonly usesCanvasPanels: boolean;
	create(container: HTMLElement, example?: CanvasArtifactExample): void;
	setVisible(visible: boolean): void;
	layout(dimension: IDimension): void;
	revealInitialContent?(): void;
	focus(): void;
	getAccessibleContent(): string;
}

export interface ArtifactWorkspaceContribution {
	readonly id: ArtifactWorkspaceId;
	readonly title: string;
	readonly description: string;
	readonly icon: Icon;
	readonly help: string;
	create(instantiation: IInstantiationService, ownerDocument: Document): IArtifactWorkspace;
}

/** Workspace content is created lazily; entries are registered before the editor opens. */
export const ArtifactWorkspaces = new Map<ArtifactWorkspaceId, ArtifactWorkspaceContribution>();

export function registerArtifactWorkspace(contribution: ArtifactWorkspaceContribution): void {
	ArtifactWorkspaces.set(contribution.id, contribution);
	// Secondary workspaces remain available from the Command Palette without a second sidebar.
	registerAction2(class OpenWorkspace extends Action2 {
		constructor() {
			super({ id: `sessions.creator.open.${contribution.id}`, title: localize2('sessions.artifacts.openMode', 'Open {0}', contribution.title), f1: true });
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand('sessions.creator.openMode', contribution.id);
		}
	});
}
