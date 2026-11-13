import { getNLSLanguage, localize } from '../../../../nls.js';
import { registerArtifactExample } from '../../artifact/browser/artifactExamples.js';
import { openTableArtifact, registerTableArtifactCatalog } from '../../sheets/browser/tableArtifactWorkspaces.js';

registerTableArtifactCatalog('data');

registerArtifactExample('data', title => {
	const detail = localize('sessions.artifacts.exampleData', 'A read-only overview of pilot activity');
	return {
		detail,
		open: accessor => {
			const rows = [[142, 21], [185, 28], [213, 38]] as const;
			const weekdays = new Intl.DateTimeFormat(getNLSLanguage(), { weekday: 'long', timeZone: 'UTC' });
			return openTableArtifact(accessor, {
				kind: 'data', title, detail,
				columns: [
					localize('sessions.artifacts.exampleDay', 'Day'), localize('sessions.artifacts.exampleVisits', 'Visits'),
					localize('sessions.artifacts.exampleSignups', 'Sign-ups'),
				],
				rows: rows.map(([visits, signups], index) => [weekdays.format(Date.UTC(2026, 0, 5 + index)), visits, signups]),
				summary: [
					{ label: localize('sessions.artifacts.exampleVisits', 'Visits'), value: rows.reduce((sum, row) => sum + row[0], 0) },
					{ label: localize('sessions.artifacts.exampleSignups', 'Sign-ups'), value: rows.reduce((sum, row) => sum + row[1], 0) },
				],
			});
		},
	};
});
