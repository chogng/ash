import '../../../../workbench/test/browser/fixtures/notifications.page.js';
import '../../../browser/media/workbench.css';
import '../../../browser/media/style.css';
import '../../../browser/media/notifications.css';

// Keep the theme-owning Workbench above the window, matching the Sessions host.
const root = document.querySelector<HTMLElement>('main')!;
const sessionsWindow = document.createElement('div');
sessionsWindow.className = 'ash-sessions-window';
sessionsWindow.append(...root.childNodes);
root.append(sessionsWindow);
