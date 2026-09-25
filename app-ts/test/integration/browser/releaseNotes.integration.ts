import '../../../src/ash/workbench/browser/parts/titlebar/commandCenterOnboarding.contribution.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import type { IOpenerService } from '../../../src/ash/platform/opener/common/openerService.js';
import type { ILocaleService } from '../../../src/ash/workbench/services/localization/common/locale.js';
import type { IOnboardingTryoutService } from '../../../src/ash/workbench/contrib/onboarding/common/onboardingTryout.js';
import { ReleaseNotesEditor, releaseNotesResource } from '../../../src/ash/workbench/contrib/update/browser/releaseNotesEditor.js';
import { MarkdownDocumentView } from '../../../src/ash/workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { prepareReleaseNotesMarkdown } from '../../../src/ash/workbench/contrib/update/browser/releaseNotesTryouts.js';

declare global {
	interface Window { ashReleaseNotesIntegration: { readonly opened: readonly string[] }; }
}

const opened: string[] = [];
window.ashReleaseNotesIntegration = { get opened() { return opened; } };
const locale = { locale: 'en', onDidChangeLocale: Event.None } as unknown as ILocaleService;
const tryouts = { async run(id: string) { opened.push(id); return 'completed' as const; } } as IOnboardingTryoutService;
const opener = { async openExternal() {} } as IOpenerService;
const editor = new ReleaseNotesEditor(locale, tryouts, opener);
editor.create(document.querySelector('main')!);
void editor.setInput({ resource: URI.parse(releaseNotesResource) }, new AbortController().signal);
const chineseLocale = { locale: 'zh-CN', onDidChangeLocale: Event.None } as unknown as ILocaleService;
const chineseEditor = new ReleaseNotesEditor(chineseLocale, tryouts, opener);
chineseEditor.create(document.querySelector('#chinese')!);
void chineseEditor.setInput({ resource: URI.parse(releaseNotesResource) }, new AbortController().signal);
new MarkdownDocumentView(document.querySelector('#invalid')!, {
	title: 'Invalid links',
	markdown: prepareReleaseNotesMarkdown('[Unknown](ash://tryout/test.releaseNotes.missing) [Malformed](ash://tryout/workbench.commandCenter.open?command=other)'),
	openLink: () => { throw new Error('Invalid Try This link was activated'); },
});
