import { createSessionsProfile } from '../../sessions/common/sessionsProfile.js';

/** Dedicated agent-session window for the Code product. */
export const codeSessionsProfile = createSessionsProfile({
	id: 'code-sessions',
	label: 'Code Sessions',
	titlebarActionId: 'ash.code.open-sessions',
	workbenchRelativePath: '../workbench/workbench.html',
});
