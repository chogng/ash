import './sessions.web.main.js';

if (import.meta.env.ASH_DEV_ARTIFACT_EXAMPLES) {
	await import('./test/browser/fixtures/artifactExamples.contribution.js');
}

export { create } from './browser/web.factory.js';
