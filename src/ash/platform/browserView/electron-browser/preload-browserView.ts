// A standalone sandbox script: runtime imports are limited to Electron.
(() => {
	type Configuration = import('../common/browserView.js').IBrowserViewWindowConfiguration;
	type ElementOptions = import('../common/browserView.js').IBrowserElementSelectionOptions;
	type CommentsUpdate = import('../common/browserView.js').IBrowserElementCommentsUpdate;
	const { ipcRenderer, contextBridge } = require('electron') as typeof import('electron');
	const channel = 'ash:browserView:preload';
	// getRandomValues also works on about:blank and other non-secure page contexts.
	const frameToken = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
	let elementSequence = 0;
	const elements = new Map<string, WeakRef<Element>>();
	let configuration: Configuration | undefined;
	let mode: 'element' | 'area' | undefined;
	let options: ElementOptions = {};
	let current: Element | undefined;
	let start: { x: number; y: number } | undefined;
	let host: HTMLDivElement | undefined;
	let shadow: ShadowRoot | undefined;
	let outline: HTMLDivElement | undefined;
	let help: HTMLDivElement | undefined;
	let dialog: HTMLFormElement | undefined;
	let previousFocus: Element | null = null;
	let suppressClick = false;
	let markerItems: readonly { elementId: string; body: string }[] = [];
	const markers: HTMLButtonElement[] = [];
	const send = (type: string, data?: unknown): void => ipcRenderer.send(channel, { frameToken, type, data });
	// Passwords never cross the page's main-world bridge. Only top-level, visible, same-origin forms qualify.
	const passwordForms = new Map<string, WeakRef<HTMLElement>>();
	const passwordFormIds = new WeakMap<HTMLElement, string>();
	let passwordFormSequence = 0;
	let passwordGesture: { root: HTMLElement; at: number } | undefined;
	const visiblePasswordInput = (input: HTMLInputElement): boolean =>
		input.isConnected && input.getClientRects().length > 0 && input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && input.type !== 'hidden';
	const passwordAction = (root: HTMLElement): string => (root instanceof HTMLFormElement ? root.action : location.href);
	const samePasswordOrigin = (action: string): boolean => {
		try {
			return action.length <= 8192 && new URL(action, location.href).origin === location.origin;
		} catch {
			return false;
		}
	};
	const autocomplete = (input: HTMLInputElement): string | undefined => input.autocomplete.split(/\s+/u).at(-1);
	const verificationInput = (input: HTMLInputElement): boolean =>
		autocomplete(input) === 'one-time-code' || /(?:^|[\s_-])(?:otp|totp|code|pin|verification)(?:$|[\s_-])/iu.test(input.name + ' ' + input.id);
	function passwordFields(root: HTMLElement): { username?: HTMLInputElement; password?: HTMLInputElement; hasPasswordControl: boolean } | undefined {
		if (window !== window.top || !root.isConnected || !samePasswordOrigin(passwordAction(root)) || (root instanceof HTMLFormElement && root.autocomplete === 'off')) {
			return;
		}
		const controls = root instanceof HTMLFormElement ? [...root.elements] : [...root.querySelectorAll('input')];
		// A submit button can override its form's destination, including after a controlled-input update.
		if (controls.some(element => element.hasAttribute('formaction') && !samePasswordOrigin(element.getAttribute('formaction')!))) {
			return;
		}
		const inputs = controls.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && !element.disabled && !element.readOnly && visiblePasswordInput(element));
		const passwords = inputs.filter(input => input.type === 'password');
		if (passwords.length > 1 || passwords.some(input => verificationInput(input) || ['new-password', 'off'].includes(autocomplete(input) ?? ''))) {
			return;
		}
		const candidates = inputs.filter(
			input => ['text', 'email'].includes(input.type) && autocomplete(input) !== 'off' && autocomplete(input) !== 'one-time-code' && !/otp|code|token|search/iu.test(input.name + ' ' + input.id),
		);
		const identity = candidates.find(
			input => ['username', 'email'].includes(autocomplete(input) ?? '') || input.type === 'email' || /user|email|login|account/iu.test(input.name + ' ' + input.id),
		);
		const username = identity ?? (passwords.length === 1 && candidates.length === 1 ? candidates[0] : undefined);
		if (!passwords.length && (!identity || candidates.length !== 1)) {
			return;
		}
		return {
			username,
			password: passwords[0],
			hasPasswordControl: controls.some(element => element instanceof HTMLInputElement && element.type === 'password'),
		};
	}
	function passwordRoot(element: Element): HTMLElement | undefined {
		if ((element instanceof HTMLInputElement || element instanceof HTMLButtonElement) && element.form) {
			return element.form;
		}
		const explicit = element.closest('form,[role="form"]');
		if (explicit instanceof HTMLElement) {
			return explicit;
		}
		// Custom SPA panels need a bounded common ancestor, rather than collecting inputs across the page.
		let root = element.parentElement;
		for (let depth = 0; root && root !== document.body && depth < 8; depth++, root = root.parentElement) {
			if (root.querySelector('button,input[type="submit"],[role="button"]') && passwordFields(root)) {
				return root;
			}
		}
		return undefined;
	}
	let previousPasswordPageState: boolean | undefined;
	function reportPasswordPageState(): void {
		if (window !== window.top) {
			return;
		}
		// Keep the submission pending while a site advances to a visible verification-code step.
		const hasPasswordForm = [...document.querySelectorAll<HTMLInputElement>('input')].some(input => visiblePasswordInput(input) && (input.type === 'password' || verificationInput(input)));
		if (hasPasswordForm === previousPasswordPageState) {
			return;
		}
		previousPasswordPageState = hasPasswordForm;
		send('passwordPageState', { action: location.href, hasPasswordForm });
	}
	function passwordSubmit(root: HTMLElement, afterClick = false): void {
		if (passwordGesture?.root !== root || performance.now() - passwordGesture.at > 1500) {
			return;
		}
		const fields = passwordFields(root);
		if (!fields || (fields.password && !fields.password.value) || (!fields.password && !fields.username?.value)) {
			return;
		}
		passwordGesture = undefined;
		const action = passwordAction(root);
		const username = fields.username?.value ?? '';
		const password = fields.password?.value;
		const report = (): void => {
			// SPA handlers can disable/remove their inputs before this runs. Retain
			// the submitted values, but a password-to-text switch is a visibility toggle.
			if (afterClick && fields.password && fields.password.type !== 'password') {
				return;
			}
			if (password !== undefined) {
				send('passwordSubmitted', { action, username, hasUsername: !!fields.username, password });
				// A SPA may add and remove the password step within the same animation frame.
				previousPasswordPageState = undefined;
				queueMicrotask(reportPasswordPageState);
			} else {
				send('passwordIdentitySubmitted', { action, username });
			}
		};
		if (afterClick) {
			setTimeout(report, 0);
		} else {
			report();
		}
	}
	if (window === window.top) {
		for (const eventName of ['pointerdown', 'keydown'] as const) {
			document.addEventListener(
				eventName,
				event => {
					if (!event.isTrusted || !(event.target instanceof Element)) {
						return;
					}
					const root = passwordRoot(event.target);
					if (root) {
						passwordGesture = { root, at: performance.now() };
						// Native forms report a real submit event after validation. SPA panels
						// have no such event, so retain their explicit Enter submission path.
						if (!(root instanceof HTMLFormElement) && event instanceof KeyboardEvent && event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) {
							passwordSubmit(root);
						}
					}
				},
				true,
			);
		}
		document.addEventListener('focusin', event => {
			const target = event.target;
			if (!event.isTrusted || !(target instanceof HTMLInputElement)) {
				return;
			}
			const root = passwordRoot(target);
			if (!root || passwordGesture?.root !== root || performance.now() - passwordGesture.at > 1500) {
				return;
			}
			const fields = passwordFields(root);
			// A hidden or disabled password field is not a username-only step eligible for autofill.
			if (fields && !fields.password && fields.hasPasswordControl) {
				return;
			}
			if (!fields || fields.password?.value || (!fields.password && fields.username?.value) || ![fields.username, fields.password].includes(target)) {
				return;
			}
			let formId = passwordFormIds.get(root);
			if (!formId) {
				formId = frameToken + '-' + ++passwordFormSequence;
				passwordFormIds.set(root, formId);
				passwordForms.set(formId, new WeakRef(root));
				if (passwordForms.size > 64) {
					passwordForms.delete(passwordForms.keys().next().value!);
				}
			}
			send('passwordFill', {
				formId,
				action: passwordAction(root),
				username: fields.username?.value ?? '',
				hasUsername: !!fields.username,
				field: fields.password ? 'password' : 'username',
			});
		});
		document.addEventListener(
			'click',
			event => {
				if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) {
					return;
				}
				const control = event.target.closest('button,input[type="submit"],[role="button"]');
				if (!control || control.getAttribute('type') === 'reset' || control.getAttribute('aria-disabled') === 'true') {
					return;
				}
				const root = passwordRoot(control);
				if (!root || root instanceof HTMLFormElement) {
					return;
				}
				// Toggle/disclosure controls do not submit a custom login panel. For
				// other SPA buttons, let the page handler run before classifying the action.
				if (control.hasAttribute('aria-pressed') || control.hasAttribute('aria-expanded')) {
					return;
				}
				passwordSubmit(root, true);
			},
			true,
		);
		document.addEventListener(
			'submit',
			event => {
				if (event.isTrusted && event.target instanceof HTMLFormElement) {
					passwordSubmit(event.target);
				}
			},
			true,
		);
		const startPasswordObservation = (): void => {
			reportPasswordPageState();
			let pending = false;
			const observer = new MutationObserver(() => {
				if (pending) {
					return;
				}
				pending = true;
				requestAnimationFrame(() => {
					pending = false;
					reportPasswordPageState();
				});
			});
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['type', 'hidden', 'style', 'class'],
			});
			window.addEventListener(
				'pagehide',
				() => {
					observer.disconnect();
					passwordForms.clear();
					passwordGesture = undefined;
				},
				{ once: true },
			);
		};
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', startPasswordObservation, { once: true });
		} else {
			queueMicrotask(startPasswordObservation);
		}
	}
	let clearContentVisibility = (): void => {};

	function configureContentVisibility(rule: import('../common/browserView.js').IBrowserContentVisibilityRule | undefined): void {
		clearContentVisibility();
		clearContentVisibility = () => {};
		if (!rule || window !== window.top || location.origin !== rule.origin || !CSS.supports('content-visibility', 'auto')) {
			return;
		}
		// The rule comes from the trusted host; a changed website or invalid selector must fail closed.
		try {
			document.querySelector(rule.selector);
		} catch {
			return;
		}
		const abort = new AbortController();
		const properties = ['content-visibility', 'contain-intrinsic-height'] as const;
		const originals = new Map<HTMLElement, { values: readonly { value: string; priority: string }[]; applied: boolean }>();
		const restore = (element: HTMLElement): void => {
			const saved = originals.get(element);
			if (!saved) {
				return;
			}
			properties.forEach((property, index) => {
				const previous = saved.values[index]!;
				if (previous.value) {
					element.style.setProperty(property, previous.value, previous.priority);
				} else {
					element.style.removeProperty(property);
				}
			});
			originals.delete(element);
		};
		const sizes = new ResizeObserver(entries => {
			for (const entry of entries) {
				const element = entry.target as HTMLElement;
				const saved = originals.get(element);
				if (!saved || saved.applied || entry.contentRect.height <= 0 || !element.matches(rule.selector)) {
					continue;
				}
				// Measure the natural content box before containment. Chromium then remembers subsequent rendered sizes.
				saved.applied = true;
				element.style.setProperty('contain-intrinsic-height', `auto ${entry.contentRect.height}px`);
				element.style.setProperty('content-visibility', 'auto');
			}
		});
		const consider = (element: Element): void => {
			if (!(element instanceof HTMLElement)) {
				return;
			}
			if (!element.matches(rule.selector)) {
				if (originals.has(element)) {
					sizes.unobserve(element);
					restore(element);
				}
				return;
			}
			if (originals.has(element)) {
				return;
			}
			originals.set(element, {
				values: properties.map(property => ({
					value: element.style.getPropertyValue(property),
					priority: element.style.getPropertyPriority(property),
				})),
				applied: false,
			});
			sizes.observe(element);
		};
		const scan = (root: Element): void => {
			consider(root);
			root.querySelectorAll(rule.selector).forEach(consider);
		};
		const changes = new MutationObserver(records => {
			let removed = false;
			for (const record of records) {
				if (record.type === 'attributes') {
					// Our inline style writes must not create an observer feedback loop.
					if (record.attributeName !== 'style') {
						consider(record.target as Element);
					}
				} else {
					removed ||= record.removedNodes.length > 0;
					for (const added of record.addedNodes) {
						if (added instanceof Element) {
							scan(added);
						}
					}
				}
			}
			if (removed) {
				for (const element of originals.keys()) {
					if (!element.isConnected) {
						sizes.unobserve(element);
						restore(element);
					}
				}
			}
		});
		const start = (): void => {
			if (!document.documentElement || abort.signal.aborted) {
				return;
			}
			scan(document.documentElement);
			changes.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
		};
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', start, { once: true, signal: abort.signal });
		} else {
			start();
		}
		let width = window.innerWidth;
		window.addEventListener(
			'resize',
			() => {
				if (window.innerWidth !== width) {
					width = window.innerWidth;
					// Reflow at the new width before measuring again; never retain stale line wrapping heights.
					for (const element of [...originals.keys()]) {
						sizes.unobserve(element);
						restore(element);
						consider(element);
					}
				}
			},
			{ signal: abort.signal },
		);
		window.addEventListener(
			'beforeprint',
			() => {
				sizes.disconnect();
				changes.disconnect();
				for (const element of originals.keys()) {
					restore(element);
				}
			},
			{ signal: abort.signal },
		);
		window.addEventListener('afterprint', start, { signal: abort.signal });
		clearContentVisibility = () => {
			abort.abort();
			sizes.disconnect();
			changes.disconnect();
			for (const element of originals.keys()) {
				restore(element);
			}
		};
	}

	function getSelectedText(): string {
		const active = document.activeElement;
		if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
			if (active instanceof HTMLInputElement && active.type === 'password') {
				return '';
			}
			if (active.selectionStart !== null && active.selectionEnd !== null) {
				return active.value.slice(active.selectionStart, active.selectionEnd).slice(0, 65536);
			}
		}
		return (window.getSelection()?.toString() ?? '').slice(0, 65536);
	}
	contextBridge.exposeInIsolatedWorld(999, 'browserViewAPI', { getSelectedText });

	function shouldForward(event: KeyboardEvent): boolean {
		if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) {
			return false;
		}
		if (['Control', 'Shift', 'Alt', 'Meta', 'Insert', 'Help', 'Process'].includes(event.key)) {
			return false;
		}
		const mac = navigator.platform.includes('Mac');
		if (event.altKey && !event.ctrlKey && !event.metaKey && (mac || event.code.startsWith('Numpad'))) {
			return false;
		}
		if (event.shiftKey && event.key === 'F10' && !event.ctrlKey && !event.altKey && !event.metaKey) {
			return false;
		}
		const commandModifier = mac ? event.metaKey : event.ctrlKey;
		if (commandModifier && !event.altKey) {
			const key = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
			const editing = event.shiftKey ? ['v', 'z'] : ['a', 'c', 'v', 'x', 'z', ...(mac ? [] : ['y'])];
			if (editing.includes(key) || ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete'].includes(key)) {
				return false;
			}
		}
		return event.ctrlKey || event.altKey || event.metaKey || event.key === 'Escape' || /^(F\d+|Audio|Media|Browser)/.test(event.key);
	}
	window.addEventListener('keydown', event => {
		if (event.isTrusted) {
			suppressClick = false;
		}
		if (mode || dialog || !shouldForward(event)) {
			return;
		}
		// Page window listeners run after this preload listener and may still claim the shortcut.
		setTimeout(() => {
			if (mode || dialog || !shouldForward(event)) {
				return;
			}
			send('keyDown', {
				key: event.key,
				keyCode: event.keyCode,
				code: event.code,
				ctrlKey: event.ctrlKey,
				altKey: event.altKey,
				shiftKey: event.shiftKey,
				metaKey: event.metaKey,
				repeat: event.repeat,
			});
		}, 0);
	});

	function ensureUI(): void {
		if (host?.isConnected) {
			return;
		}
		host = document.createElement('div');
		host.className = 'ash-browser-selection';
		host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
		shadow = host.attachShadow({ mode: 'closed' });
		const style = document.createElement('style');
		style.textContent = `
			:host { all:initial; color:var(--ash-browser-foreground,CanvasText); font:13px system-ui; }
			* { box-sizing:border-box; }
			.outline { position:fixed; pointer-events:none; border:2px solid var(--ash-browser-focus,Highlight); background:color-mix(in srgb,var(--ash-browser-focus,Highlight) 12%,transparent); }
			.help { position:fixed; left:12px; bottom:12px; padding:8px 12px; background:var(--ash-browser-background,Canvas); border:1px solid var(--ash-browser-border,CanvasText); max-width:calc(100vw - 24px); }
			form { position:fixed; left:12px; top:12px; width:min(360px,calc(100vw - 24px)); padding:12px; background:var(--ash-browser-background,Canvas); border:1px solid var(--ash-browser-border,CanvasText); pointer-events:auto; display:grid; gap:8px; }
			textarea { width:100%; min-height:80px; resize:vertical; color:inherit; background:inherit; border:1px solid var(--ash-browser-border,CanvasText); font:inherit; padding:6px; }
			button { font:inherit; cursor:pointer; color:var(--ash-browser-button-foreground,ButtonText); background:var(--ash-browser-button-background,ButtonFace); border:1px solid var(--ash-browser-border,ButtonText); padding:4px 8px; }
			button:focus-visible,textarea:focus-visible { outline:2px solid var(--ash-browser-focus,Highlight); outline-offset:2px; }
			.marker { position:fixed; pointer-events:auto; border-radius:50%; min-width:28px; min-height:28px; }
			@media(forced-colors:active) { .outline { border-color:Highlight; background:transparent; } }
		`;
		outline = document.createElement('div');
		outline.className = 'outline';
		outline.hidden = true;
		help = document.createElement('div');
		help.className = 'help';
		help.setAttribute('role', 'status');
		help.hidden = true;
		shadow.append(style, outline, help);
		document.documentElement.append(host);
		applyTheme();
	}
	function applyTheme(): void {
		if (!configuration) {
			return;
		}
		const theme = configuration.theme;

		if (!host) {
			return;
		}
		for (const [property, value] of Object.entries({
			focus: theme.focusBorder,
			foreground: theme.widgetForeground,
			background: theme.widgetBackground,
			border: theme.contrastBorder || theme.widgetBorder,
			'button-foreground': theme.buttonForeground,
			'button-background': theme.buttonBackground,
		})) {
			if (value) {
				host.style.setProperty('--ash-browser-' + property, value);
			} else {
				host.style.removeProperty('--ash-browser-' + property);
			}
		}
	}
	function rect(element: Element): { x: number; y: number; width: number; height: number } {
		const bounds = element.getBoundingClientRect();
		return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
	}
	function draw(bounds: { x: number; y: number; width: number; height: number }): void {
		ensureUI();
		Object.assign(outline!.style, {
			left: bounds.x + 'px',
			top: bounds.y + 'px',
			width: bounds.width + 'px',
			height: bounds.height + 'px',
		});
		outline!.hidden = false;
	}
	function idFor(element: Element): string {
		for (const [id, reference] of elements) {
			const candidate = reference.deref();
			if (!candidate?.isConnected) {
				elements.delete(id);
			}
			if (candidate === element) {
				return id;
			}
		}
		if (elements.size >= 100) {
			elements.delete(elements.keys().next().value!);
		}
		const id = frameToken + ':' + ++elementSequence;
		elements.set(id, new WeakRef(element));
		return id;
	}
	function closeDialog(): void {
		dialog?.remove();
		dialog = undefined;
		if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
			previousFocus.focus();
		}
	}
	function stop(notify = true): void {
		mode = undefined;
		current = undefined;
		start = undefined;
		closeDialog();
		if (outline) {
			outline.hidden = true;
		}
		if (help) {
			help.hidden = true;
		}
		if (host) {
			host.style.pointerEvents = 'none';
			host.removeAttribute('tabindex');
		}
		if (notify) {
			send('selectionStopped');
		}
	}
	function pick(element: Element, comment?: string): void {
		const style = getComputedStyle(element);
		const properties = ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border', 'border-radius'];
		const computedStyle = properties
			.map(property => property + ': ' + style.getPropertyValue(property))
			.join('; ')
			.slice(0, 4096);
		const data = {
			elementId: idFor(element),
			url: location.href,
			outerHTML: element.outerHTML.slice(0, 16384),
			innerText: (element.textContent ?? '').slice(0, 8192),
			computedStyle,
			bounds: rect(element),
			comment,
		};
		send('elementPicked', data);
		closeDialog();
		if (!options.continuous) {
			stop();
		}
	}
	function editComment(element: Element, body = ''): void {
		if (!configuration) {
			return;
		}
		ensureUI();
		closeDialog();
		previousFocus = document.activeElement;
		const strings = configuration.localizedStrings;
		dialog = document.createElement('form');
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-label', strings.commentOnSelectedElement);
		const input = document.createElement('textarea');
		input.maxLength = 2048;
		input.value = body;
		input.placeholder = strings.addCommentPlaceholder;
		input.setAttribute('aria-label', strings.addCommentPlaceholder);
		const save = document.createElement('button');
		save.type = 'submit';
		save.textContent = strings.addComment;
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.textContent = strings.cancel;
		cancel.addEventListener('click', () => closeDialog());
		dialog.append(input, save, cancel);
		if (body) {
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.textContent = strings.removeComment;
			remove.addEventListener('click', () => {
				send('elementCommentRemoved', idFor(element));
				closeDialog();
			});
			dialog.append(remove);
		}
		dialog.addEventListener('submit', event => {
			event.preventDefault();
			if (input.value.trim()) {
				pick(element, input.value.trim());
			}
		});
		dialog.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				closeDialog();
				return;
			}
			if (event.key === 'Tab') {
				const controls = [...dialog!.querySelectorAll<HTMLElement>('textarea,button')];
				const position = controls.indexOf(shadow!.activeElement as HTMLElement);
				event.preventDefault();
				controls[(position + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]!.focus();
			}
		});
		shadow!.append(dialog);
		input.focus();
	}
	function renderMarkers(): void {
		for (const marker of markers.splice(0)) {
			marker.remove();
		}
		if (!configuration || !markerItems.length) {
			return;
		}
		ensureUI();
		for (const [index, item] of markerItems.entries()) {
			const element = elements.get(item.elementId)?.deref();
			if (!element?.isConnected) {
				continue;
			}
			const marker = document.createElement('button');
			marker.type = 'button';
			marker.className = 'marker';
			marker.textContent = String(index + 1);
			marker.setAttribute('aria-label', configuration.localizedStrings.elementCommentWithBody.replace('{0}', String(index + 1)).replace('{1}', item.body));
			const bounds = rect(element);
			Object.assign(marker.style, {
				left: Math.max(0, Math.min(innerWidth - 32, bounds.x)) + 'px',
				top: Math.max(0, Math.min(innerHeight - 32, bounds.y)) + 'px',
			});
			marker.addEventListener('click', () => editComment(element, item.body));
			shadow!.append(marker);
			markers.push(marker);
		}
	}
	window.addEventListener(
		'pointermove',
		event => {
			if (!mode || dialog || !event.isTrusted) {
				return;
			}
			if (mode === 'area' && start) {
				draw({
					x: Math.min(start.x, event.clientX),
					y: Math.min(start.y, event.clientY),
					width: Math.abs(start.x - event.clientX),
					height: Math.abs(start.y - event.clientY),
				});
				return;
			}
			if (mode === 'element') {
				current = document.elementFromPoint(event.clientX, event.clientY) ?? undefined;
				if (current && current !== host) {
					draw(rect(current));
				}
			}
		},
		true,
	);
	window.addEventListener(
		'pointerdown',
		event => {
			if (!mode || dialog || !event.isTrusted || event.button !== 0 || (mode === 'element' && event.composedPath().includes(host!))) {
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			suppressClick = true;
			if (mode === 'area') {
				start = { x: event.clientX, y: event.clientY };
				ensureUI();
				host!.style.pointerEvents = 'auto';
			}
		},
		true,
	);
	window.addEventListener(
		'pointerup',
		event => {
			if (!mode || dialog || !event.isTrusted || event.button !== 0 || (mode === 'element' && event.composedPath().includes(host!))) {
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			if (mode === 'area' && start) {
				const area = {
					x: Math.min(start.x, event.clientX),
					y: Math.min(start.y, event.clientY),
					width: Math.abs(start.x - event.clientX),
					height: Math.abs(start.y - event.clientY),
				};
				stop(false);
				// Cross the compositor boundary before Main reads pixels, including empty/transparent pages.
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						if (area.width >= 2 && area.height >= 2) {
							send('areaPicked', area);
						}
						send('selectionStopped');
					}),
				);
			} else if (mode === 'element') {
				current = document.elementFromPoint(event.clientX, event.clientY) ?? undefined;
				if (!current || current === host) {
					return;
				}
				if (options.mode === 'comment') {
					editComment(current);
				} else {
					pick(current);
				}
			}
		},
		true,
	);
	window.addEventListener(
		'click',
		event => {
			if (event.isTrusted && suppressClick) {
				suppressClick = false;
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		},
		true,
	);
	window.addEventListener(
		'pointercancel',
		() => {
			suppressClick = false;
			if (mode === 'area') {
				stop();
			}
		},
		true,
	);
	window.addEventListener(
		'keydown',
		event => {
			if (!mode || dialog || !event.isTrusted) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopImmediatePropagation();
				stop();
				return;
			}
			if (mode === 'area') {
				if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
					event.preventDefault();
					event.stopImmediatePropagation();
					if (!start) {
						start = { x: 16, y: 16 };
						current = undefined;
						draw({
							...start,
							width: Math.min(240, innerWidth - 32),
							height: Math.min(160, innerHeight - 32),
						});
					}
					const bounds = outline!.getBoundingClientRect();
					if (event.key === 'Enter' || event.key === ' ') {
						stop(false);
						requestAnimationFrame(() =>
							requestAnimationFrame(() => {
								send('areaPicked', {
									x: bounds.x,
									y: bounds.y,
									width: bounds.width,
									height: bounds.height,
								});
								send('selectionStopped');
							}),
						);
					} else {
						const dx = event.key === 'ArrowLeft' ? -8 : event.key === 'ArrowRight' ? 8 : 0;
						const dy = event.key === 'ArrowUp' ? -8 : event.key === 'ArrowDown' ? 8 : 0;
						draw({
							x: Math.max(0, Math.min(innerWidth - bounds.width, bounds.x + dx)),
							y: Math.max(0, Math.min(innerHeight - bounds.height, bounds.y + dy)),
							width: bounds.width,
							height: bounds.height,
						});
					}
				}
				return;
			}
			if (['Tab', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (event.key === 'Enter' || event.key === ' ') {
					if (current) {
						options.mode === 'comment' ? editComment(current) : pick(current);
					}
					return;
				}
				if (event.key === 'ArrowUp' && current?.parentElement) {
					current = current.parentElement;
				} else if (event.key === 'ArrowDown' && current?.firstElementChild) {
					current = current.firstElementChild;
				} else {
					const candidates = [...document.querySelectorAll('a,button,input,textarea,select,h1,h2,h3,p,img,[tabindex]')]
						.filter(element => element !== host && element.getBoundingClientRect().width > 0)
						.slice(0, 1000);
					const position = candidates.indexOf(current!);
					current = candidates[(position + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length];
				}
				if (current) {
					current.scrollIntoView({ block: 'nearest', behavior: 'instant' });
					draw(rect(current));
				}
			}
		},
		true,
	);
	window.addEventListener(
		'scroll',
		() => {
			if (current && mode === 'element') {
				draw(rect(current));
			}
			renderMarkers();
		},
		true,
	);
	window.addEventListener('resize', () => {
		if (current && mode === 'element') {
			draw(rect(current));
		}
		renderMarkers();
	});
	ipcRenderer.on(channel, (_event, message: { command: string; data?: any }) => {
		switch (message.command) {
			case 'fillPassword': {
				const data = message.data;
				if (!data || data.token !== frameToken || data.origin !== location.origin) {
					break;
				}
				const form = passwordForms.get(data.formId)?.deref();
				const fields = form && passwordFields(form);
				if (!fields || (fields.password ? 'password' : 'username') !== data.field || fields.password?.value || (fields.username?.value && fields.username.value !== data.username)) {
					break;
				}
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
				for (const [input, value] of [
					[fields.username, data.username],
					[fields.password, data.password],
				] as const) {
					if (!input || typeof value !== 'string') {
						continue;
					}
					// Controlled inputs can replace or retarget the form in their username handler.
					if (input === fields.password && (!form || passwordFields(form)?.password !== input || input.value)) {
						break;
					}
					setter.call(input, value);
					input.dispatchEvent(new Event('input', { bubbles: true }));
					input.dispatchEvent(new Event('change', { bubbles: true }));
				}
				break;
			}
			case 'contentVisibility':
				configureContentVisibility(message.data);
				break;
			case 'hideUI':
				if (host) {
					host.style.visibility = 'hidden';
				}
				break;
			case 'showUI':
				if (host) {
					host.style.visibility = '';
				}
				break;
			case 'configure':
				configuration = message.data;
				applyTheme();
				renderMarkers();
				break;
			case 'getSelectedText':
				send('selectedText', { requestId: message.data, text: getSelectedText() });
				break;
			case 'startElementPicker':
				stop(false);
				options = message.data ?? {};
				mode = 'element';
				ensureUI();
				help!.textContent = configuration?.localizedStrings.selectionHelp ?? '';
				help!.hidden = false;
				current = options.highlightFocusedElement ? (document.activeElement ?? undefined) : undefined;
				if (current && current !== document.body) {
					draw(rect(current));
				}
				break;
			case 'startAreaPicker':
				stop(false);
				mode = 'area';
				ensureUI();
				previousFocus = document.activeElement;
				host!.tabIndex = -1;
				host!.style.pointerEvents = 'auto';
				host!.focus({ preventScroll: true });
				help!.textContent = configuration?.localizedStrings.selectionHelp ?? '';
				help!.hidden = false;
				break;
			case 'stop':
				stop(false);
				break;
			case 'setElementComments': {
				const update = message.data as CommentsUpdate;
				if (update.comments) {
					markerItems = update.comments;
				}
				if (update.pendingCommentIdsToDiscard?.length) {
					markerItems = markerItems.filter(item => !update.pendingCommentIdsToDiscard!.includes(item.elementId));
				}
				renderMarkers();
				break;
			}
		}
	});
	send('ready');
})();
