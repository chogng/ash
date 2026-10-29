import { DisposableStore, MutableDisposable, toDisposable } from '../../src/ash/base/common/lifecycle.js';
import { TestThemeService } from '../../src/ash/platform/theme/test/common/testThemeService.js';
import type { ThemedFixture } from '../../src/ash/workbench/test/browser/componentFixtures/fixtureUtils.js';
import { bindTestColorTheme } from '../fixtures/browser/themeFixture.js';
/** Owns document slots, never copies or reparses CSS into replacement stylesheets. */
class StylesheetOrder {
	private readonly documents: readonly { node: HTMLStyleElement; slot: Comment; source: string; text: string; position: number; }[];

	constructor(private readonly document: Document) {
		this.documents = [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(node => {
			const slot = document.createComment('fixture stylesheet slot');
			node.before(slot);
			return { node, slot, source: node.dataset.viteDevId!, text: node.textContent ?? '', position: [...document.styleSheets].indexOf(node.sheet!) };
		});
		if (!this.documents.length) throw new Error('Component fixtures require Vite development stylesheet metadata');
	}

	manifest() {
		return this.documents.map(({ source, text, position }, index) => ({ index, source, text, position }));
	}

	order(): number[] {
		return [...this.document.styleSheets].flatMap(sheet => {
			const index = this.documents.findIndex(entry => entry.node === sheet.ownerNode);
			return index < 0 ? [] : [index];
		});
	}

	setOrder(order: readonly number[]): void {
		// This is also the interactive explorer's input boundary.
		if (order.length !== this.documents.length || new Set(order).size !== order.length || order.some(index => !Number.isInteger(index) || index < 0 || index >= order.length)) {
			throw new Error('Stylesheet order must be a permutation of the manifest indices');
		}
		if (this.document.querySelectorAll('style[data-vite-dev-id]').length !== this.documents.length || this.documents.some(({ node, text }) => !node.isConnected || node.textContent !== text)) {
			throw new Error('Stylesheets changed during the scan; reload the fixture');
		}
		for (const [index, { slot }] of this.documents.entries()) slot.after(this.documents[order[index]].node);
	}

	reset(): void {
		for (const { node, slot } of this.documents) slot.after(node);
	}

	dispose(): void {
		this.reset();
		for (const { slot } of this.documents) slot.remove();
	}

	[Symbol.dispose](): void { this.dispose(); }
}

const modules = import.meta.glob<{ default: readonly ThemedFixture[]; }>('../../src/**/*.fixture.ts', { eager: true });
const fixtures = Object.values(modules).flatMap(module => module.default).sort((left, right) => left.id.localeCompare(right.id));
if (new Set(fixtures.map(fixture => fixture.id)).size !== fixtures.length) throw new Error('Duplicate component fixture id');
const catalog = fixtures.map(({ id, name, theme, labels }) => ({ id, name, theme: theme.id, labels: labels ?? [] }));
const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

declare global {
	interface Window {
		componentExplorer: { readonly catalog: typeof catalog; };
		componentFixture: {
			readonly id: string;
			readonly selectors: readonly string[];
			documents(): ReturnType<StylesheetOrder['manifest']>;
			order(): number[];
			setOrder(order: readonly number[]): void;
			resetStyles(): void;
			refreshStyles(): void;
		};
	}
}

const requested = new URL(location.href).searchParams.get('fixture');
const fixture = fixtures.find(fixture => fixture.id === requested) ?? (requested === null ? fixtures[0] : undefined);
if (!fixture) {
	const error = document.createElement('p');
	error.role = 'alert';
	error.textContent = `Unknown component fixture: ${requested ?? '(empty catalog)'}`;
	document.body.replaceChildren(error);
	document.body.dataset.error = 'true';
} else {
	const theme = resources.add(new TestThemeService(fixture.theme));
	resources.add(bindTestColorTheme(theme, document.documentElement));
	if (document.body.dataset.mode === 'fixture') {
		const container = document.createElement('section');
		container.className = 'ash-component-fixture';
		container.style.width = '420px';
		container.style.padding = '8px';
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		await fixture.render({ container, disposableStore: resources, theme: fixture.theme });
		await document.fonts.ready;
		const styles = resources.add(new MutableDisposable<StylesheetOrder>());
		const refresh = (): void => { styles.clear(); styles.value = new StylesheetOrder(document); };
		refresh();
		window.componentFixture = {
			id: fixture.id, selectors: ['[data-fixture-target]'],
			documents: () => styles.value!.manifest(), order: () => styles.value!.order(),
			setOrder: order => styles.value!.setOrder(order), resetStyles: () => styles.value!.reset(), refreshStyles: refresh,
		};
		document.body.dataset.ready = 'true';
		window.parent.postMessage({ type: 'ash-component-fixture-ready', id: fixture.id }, location.origin);
	} else {
		await import('./componentExplorer.css');
		window.componentExplorer = { catalog };
		const list = document.querySelector<HTMLUListElement>('#fixtures')!;
		const filter = document.querySelector<HTMLInputElement>('#fixture-filter')!;
		const preview = document.querySelector<HTMLIFrameElement>('#preview')!;
		const status = document.querySelector<HTMLElement>('#status')!;
		const reverse = document.querySelector<HTMLButtonElement>('#reverse')!;
		const reset = document.querySelector<HTMLButtonElement>('#reset')!;
		const sources = document.querySelector<HTMLOListElement>('#stylesheets')!;
		let selected = fixture.id;
		const showSources = (): void => {
			const api = preview.contentWindow!.componentFixture;
			sources.replaceChildren(...api.order().map(index => {
				const item = document.createElement('li');
				const code = document.createElement('code');
				code.textContent = api.documents()[index].source;
				item.append(code);
				return item;
			}));
		};
		const select = (id: string): void => {
			selected = id;
			status.textContent = `Loading ${id}`;
			reverse.disabled = reset.disabled = true;
			preview.title = `Component fixture: ${id}`;
			preview.src = `/componentFixture.html?fixture=${encodeURIComponent(id)}`;
			for (const link of list.querySelectorAll('a')) {
				if (link.dataset.fixture === id) link.setAttribute('aria-current', 'page');
				else link.removeAttribute('aria-current');
			}
		};
		for (const entry of catalog) {
			const item = document.createElement('li');
			const link = document.createElement('a');
			link.href = `?fixture=${encodeURIComponent(entry.id)}`;
			link.textContent = link.title = entry.id;
			link.dataset.fixture = entry.id;
			link.addEventListener('click', event => { event.preventDefault(); select(entry.id); });
			item.append(link);
			list.append(item);
		}
		filter.addEventListener('input', () => {
			for (const item of list.children) (item as HTMLElement).hidden = !item.textContent!.toLowerCase().includes(filter.value.toLowerCase());
		});
		const ready = (event: MessageEvent): void => {
			if (event.origin !== location.origin || event.source !== preview.contentWindow || event.data?.type !== 'ash-component-fixture-ready' || event.data.id !== selected) return;
			status.textContent = selected;
			reverse.disabled = reset.disabled = false;
			showSources();
		};
		window.addEventListener('message', ready);
		resources.add(toDisposable(() => window.removeEventListener('message', ready)));
		reverse.addEventListener('click', () => {
			const api = preview.contentWindow!.componentFixture;
			api.setOrder(api.order().reverse());
			showSources();
		});
		reset.addEventListener('click', () => { preview.contentWindow!.componentFixture.resetStyles(); showSources(); });
		select(fixture.id);
		document.body.dataset.ready = 'true';
	}
}
