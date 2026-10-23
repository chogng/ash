import '../../../../../browser/parts/titlebar/commandCenterOnboarding.contribution.js';
import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { ILocaleService } from '../../../../../services/localization/common/locale.js';
import { IOnboardingTryoutService } from '../../../../onboarding/common/onboardingTryout.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { createTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { ReleaseNotesEditor, releaseNotesResource } from '../../../browser/releaseNotesEditor.js';
import { MarkdownDocumentView } from '../../../../markdown/browser/markdownDocumentRenderer.js';
import { prepareReleaseNotesMarkdown } from '../../../browser/releaseNotesTryouts.js';

declare global {
	interface Window { ashReleaseNotesIntegration: { readonly opened: readonly string[]; }; }
}

const opened: string[] = [];
window.ashReleaseNotesIntegration = { get opened() { return opened; } };
const locale = { locale: 'en' } as unknown as ILocaleService;
const tryouts = { async run(id: string) { opened.push(id); return 'completed' as const; } } as IOnboardingTryoutService;
const opener = { async open(): Promise<boolean> { return true; } } as unknown as IOpenerService;
const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const services = resources.add(createTestComponentServices());
services.registerInstance(ILocaleService, locale);
services.registerInstance(IOnboardingTryoutService, tryouts);
services.registerInstance(IOpenerService, opener);
const editor = resources.add(services.createInstance(ReleaseNotesEditor));
editor.create(document.querySelector('main')!);
void editor.setInput({ resource: URI.parse(releaseNotesResource) }, new AbortController().signal);
const chineseLocale = { locale: 'zh-CN' } as unknown as ILocaleService;
const chineseServices = resources.add(services.createChild());
chineseServices.registerInstance(ILocaleService, chineseLocale);
const chineseEditor = resources.add(chineseServices.createInstance(ReleaseNotesEditor));
chineseEditor.create(document.querySelector('#chinese')!);
void chineseEditor.setInput({ resource: URI.parse(releaseNotesResource) }, new AbortController().signal);
resources.add(services.createInstance(MarkdownDocumentView, document.querySelector('#invalid')!, {
	title: 'Invalid links',
	markdown: prepareReleaseNotesMarkdown('[Unknown](ash://tryout/test.releaseNotes.missing) [Malformed](ash://tryout/workbench.commandCenter.open?command=other)'),
	openLink: () => { throw new Error('Invalid Try This link was activated'); },
}));
