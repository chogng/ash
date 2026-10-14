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
	let start: { x: number; y: number; } | undefined;
	let host: HTMLDivElement | undefined;
	let shadow: ShadowRoot | undefined;
	let outline: HTMLDivElement | undefined;
	let help: HTMLDivElement | undefined;
	let dialog: HTMLFormElement | undefined;
	let previousFocus: Element | null = null;
	let suppressClick = false;
	let markerItems: readonly { elementId: string; body: string; }[] = [];
	const markers: HTMLButtonElement[] = [];
	const send = (type: string, data?: unknown): void => ipcRenderer.send(channel, { frameToken, type, data });

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
			const key = /^[a-z]$/i.test(event.key)
				? event.key.toLowerCase()
				: /^Key[A-Z]$/.test(event.code)
					? event.code.slice(3).toLowerCase()
					: event.key.toLowerCase();
			const editing = event.shiftKey ? ['v', 'z'] : ['a', 'c', 'v', 'x', 'z', ...(mac ? [] : ['y'])];
			if (
				editing.includes(key) ||
				['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete'].includes(key)
			) {
				return false;
			}
		}
		return (
			event.ctrlKey || event.altKey || event.metaKey || event.key === 'Escape' || /^(F\d+|Audio|Media|Browser)/.test(event.key)
		);
	}
	window.addEventListener('keydown', (event) => {
		if (event.isTrusted) { suppressClick = false; }
		if (mode || dialog || !shouldForward(event)) {
			return;
		}
		// Page window listeners run after this preload listener and may still claim the shortcut.
		setTimeout(() => {
			if (mode || dialog || !shouldForward(event)) { return; }
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
		if (!host || !configuration) {
			return;
		}
		const theme = configuration.theme;
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
	function rect(element: Element): { x: number; y: number; width: number; height: number; } {
		const bounds = element.getBoundingClientRect();
		return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
	}
	function draw(bounds: { x: number; y: number; width: number; height: number; }): void {
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
		const properties = [
			'display',
			'position',
			'color',
			'background-color',
			'font-family',
			'font-size',
			'font-weight',
			'line-height',
			'padding',
			'margin',
			'border',
			'border-radius',
		];
		const computedStyle = properties
			.map((property) => property + ': ' + style.getPropertyValue(property))
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
		dialog.addEventListener('submit', (event) => {
			event.preventDefault();
			if (input.value.trim()) {
				pick(element, input.value.trim());
			}
		});
		dialog.addEventListener('keydown', (event) => {
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
			marker.setAttribute(
				'aria-label',
				configuration.localizedStrings.elementCommentWithBody.replace('{0}', String(index + 1)).replace('{1}', item.body),
			);
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
		(event) => {
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
		(event) => {
			if (
				!mode ||
				dialog ||
				!event.isTrusted ||
				event.button !== 0 ||
				(mode === 'element' && event.composedPath().includes(host!))
			) {
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
		(event) => {
			if (
				!mode ||
				dialog ||
				!event.isTrusted ||
				event.button !== 0 ||
				(mode === 'element' && event.composedPath().includes(host!))
			) {
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
				if (!current || current === host) { return; }
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
		(event) => {
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
		(event) => {
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
						draw({ ...start, width: Math.min(240, innerWidth - 32), height: Math.min(160, innerHeight - 32) });
					}
					const bounds = outline!.getBoundingClientRect();
					if (event.key === 'Enter' || event.key === ' ') {
						stop(false);
						requestAnimationFrame(() =>
							requestAnimationFrame(() => {
								send('areaPicked', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
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
						.filter((element) => element !== host && element.getBoundingClientRect().width > 0)
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
	ipcRenderer.on(channel, (_event, message: { command: string; data?: any; }) => {
		switch (message.command) {
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
					markerItems = markerItems.filter((item) => !update.pendingCommentIdsToDiscard!.includes(item.elementId));
				}
				renderMarkers();
				break;
			}
		}
	});
	send('ready');
})();
