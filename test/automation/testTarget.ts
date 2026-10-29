export type AppServerTestMode = 'disabled' | 'required';

export type PlaywrightTarget =
	| { readonly kind: 'browser'; readonly appServerMode: AppServerTestMode }
	| { readonly kind: 'electron'; readonly appServerMode: AppServerTestMode };

export function playwrightTargetForProject(projectName: string): PlaywrightTarget {
	switch (projectName) {
		case 'browser-ui':
			return { kind: 'browser', appServerMode: 'disabled' };
		case 'browser-app-server':
			return { kind: 'browser', appServerMode: 'required' };
		case 'electron-ui':
			return { kind: 'electron', appServerMode: 'disabled' };
		case 'electron-app-server':
		case 'electron-editor-app-server':
		case 'electron-pdf-corpus-app-server':
			return { kind: 'electron', appServerMode: 'required' };
		default:
			throw new Error(`Unsupported Playwright project: ${projectName}`);
	}
}

const targetTags = ['@browser-ui', '@browser-app-server', '@electron-ui', '@electron-app-server'];
const platformTags = ['@darwin', '@linux', '@win32'];

export function supportsTestTarget(tags: readonly string[], target: PlaywrightTarget, platform: string): boolean {
	const targetTag = `@${target.kind}-${target.appServerMode === 'required' ? 'app-server' : 'ui'}`;
	return (
		!tags.includes('@unsupported') &&
		(!tags.some(tag => targetTags.includes(tag)) || tags.includes(targetTag)) &&
		(!tags.some(tag => platformTags.includes(tag)) || tags.includes(`@${platform}`))
	);
}

/** Collect only applicable scenarios; the fixture also guards custom configs. */
export function testTargetExclusions(projectName: string, platform: string): RegExp[] {
	const target = playwrightTargetForProject(projectName);
	const tag = `@${target.kind}-${target.appServerMode === 'required' ? 'app-server' : 'ui'}`;
	return [
		/@unsupported(?:\s|$)/u,
		new RegExp(`^(?!.*${tag}(?:\\s|$)).*(?:${targetTags.join('|')})(?:\\s|$)`, 'u'),
		new RegExp(`^(?!.*@${platform}(?:\\s|$)).*(?:${platformTags.join('|')})(?:\\s|$)`, 'u'),
	];
}
