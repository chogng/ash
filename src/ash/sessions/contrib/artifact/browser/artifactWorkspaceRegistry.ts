import type { IDimension } from '../../../../base/browser/dom.js';
import type { Icon } from '../../../../base/common/icon.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { ArtifactKind } from '../../../common/artifactKind.js';
import type { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export interface IArtifactWorkspace extends IDisposable {
	readonly domNode: HTMLElement;
	readonly title: string;
	readonly onDidChangeTitle?: Event<void>;
	readonly detailsContainerId?: string;
	readonly exportActions?: readonly IAction[];
	getCodeAttachment?(): { readonly name: string; readonly content: string; };
	rename?(title: string): Promise<void>;
	delete?(): Promise<void>;
	getAccessibilityHelp?(): string;
	setVisible(visible: boolean): void;
	layout(dimension: IDimension): void;
	revealInitialContent?(): void;
	focus(): void;
	getAccessibleContent(): string;
}

export interface ArtifactWorkspaceRequest {
	readonly key: string;
	readonly entryId: string;
	readonly title: string;
	readonly help?: string;
	readonly restoreMode?: ArtifactWorkspaceId;
	mount(instantiation: IInstantiationService, container: HTMLElement): IArtifactWorkspace;
}

export interface ArtifactWorkspaceContribution {
	readonly id: ArtifactWorkspaceId;
	readonly title: string;
	readonly description: string;
	readonly icon: Icon;
	readonly help: string;
	mount(instantiation: IInstantiationService, container: HTMLElement): IArtifactWorkspace;
}

export interface ArtifactCard {
	readonly title: string;
	readonly kind: ArtifactKind;
	readonly detail: string;
	readonly workspaceKey?: string;
	readonly generatedFileResource?: string;
	readonly command: { readonly id: string; readonly args: readonly unknown[]; };
}

export interface ArtifactCatalogSource {
	readonly cards: IObservable<readonly ArtifactCard[]>;
	readonly isRestoring?: IObservable<boolean>;
	readonly error?: IObservable<string | undefined>;
}

const artifactCatalogSources: Array<(accessor: ServicesAccessor) => ArtifactCatalogSource> = [];

export function registerArtifactCatalogSource(create: (accessor: ServicesAccessor) => ArtifactCatalogSource): void {
	artifactCatalogSources.push(create);
}

export function createArtifactCatalogSources(instantiation: IInstantiationService): readonly ArtifactCatalogSource[] {
	return artifactCatalogSources.map(create => instantiation.invokeFunction(create));
}

/** Workspace content is mounted lazily; entries are registered before the editor opens. */
const artifactWorkspaces = new Map<ArtifactWorkspaceId, ArtifactWorkspaceContribution>();

export function getArtifactWorkspace(mode: string): ArtifactWorkspaceContribution | undefined {
	return artifactWorkspaces.get(mode as ArtifactWorkspaceId);
}

export function registerArtifactWorkspace(contribution: ArtifactWorkspaceContribution): void {
	if (artifactWorkspaces.has(contribution.id)) throw new Error(`Duplicate artifact workspace: ${contribution.id}`);
	artifactWorkspaces.set(contribution.id, contribution);
	registerAction2(class OpenWorkspace extends Action2 {
		constructor() {
			super({ id: `sessions.creator.open.${contribution.id}`, title: localize2('sessions.artifacts.openMode', 'Open {0}', contribution.title), f1: true });
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand('sessions.creator.openMode', contribution.id);
		}
	});
}
