import { onboardingTryoutRegistry, parseOnboardingTryoutLink } from '../../onboarding/common/onboardingTryout.js';

const TRYOUT_LINK = /\]\((ash:\/\/tryout\/[A-Za-z0-9._-]+)\)/g;
const ANCHOR_PREFIX = '#ash-release-tryout-';

/** Only installed tryouts become clickable inside release notes. */
export function prepareReleaseNotesMarkdown(markdown: string): string {
	return markdown.replace(TRYOUT_LINK, (match, href: string) => {
		const id = parseOnboardingTryoutLink(href);
		return id && onboardingTryoutRegistry.get(id) ? `](${ANCHOR_PREFIX}${id})` : match;
	});
}

export function releaseNotesTryoutId(href: string): string | undefined {
	if (!href.startsWith(ANCHOR_PREFIX)) return undefined;
	const id = href.slice(ANCHOR_PREFIX.length);
	return onboardingTryoutRegistry.get(id)?.id;
}
