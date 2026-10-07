import '../../../src/ash/workbench/browser/parts/titlebar/commandCenterOnboarding.contribution.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { ILocaleService } from '../../../src/ash/workbench/services/localization/common/locale.js';
import { IOnboardingTryoutService } from '../../../src/ash/workbench/contrib/onboarding/common/onboardingTryout.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { createTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { ReleaseNotesEditor, releaseNotesResource } from '../../../src/ash/workbench/contrib/update/browser/releaseNotesEditor.js';
import { MarkdownDocumentView } from '../../../src/ash/workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { prepareReleaseNotesMarkdown } from '../../../src/ash/workbench/contrib/update/browser/releaseNotesTryouts.js';

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
