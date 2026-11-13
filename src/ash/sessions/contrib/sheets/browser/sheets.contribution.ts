import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerArtifactExample } from '../../artifact/browser/artifactExamples.js';
import { ArtifactTableDrafts, IArtifactTableDrafts } from './artifactTableDrafts.js';
import { openTableArtifact, registerTableArtifactCatalog } from './tableArtifactWorkspaces.js';

registerSingleton(IArtifactTableDrafts, ArtifactTableDrafts, InstantiationType.Delayed);
registerTableArtifactCatalog('sheet');

registerArtifactExample('sheet', title => {
	const detail = localize('sessions.artifacts.exampleSheet', 'A read-only launch budget grid');
	return {
		detail,
		open: accessor => openTableArtifact(accessor, {
			kind: 'sheet', title, detail,
			columns: [
				localize('sessions.artifacts.exampleItem', 'Item'), localize('sessions.artifacts.exampleOwner', 'Owner'),
				localize('sessions.artifacts.exampleBudget', 'Budget'), localize('sessions.artifacts.exampleSpent', 'Spent'),
			],
			rows: [
				[localize('sessions.artifacts.exampleVisuals', 'Visuals'), 'Mina', 2400, 1800],
				[localize('sessions.artifacts.exampleCopy', 'Copy'), 'Leo', 1200, 950],
				[localize('sessions.artifacts.examplePilot', 'Pilot'), 'Sam', 800, 640],
			],
		}),
	};
});
