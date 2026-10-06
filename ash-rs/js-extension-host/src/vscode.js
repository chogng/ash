import { commands as ashCommands, languages as ashLanguages } from '@ash/extension';

// This is the public editor contract inside the confined process. Editor models and UI
// remain with the initiating client; this module owns only extension callback lifetimes.
export function createApi(configuration) {
    const titles = new Map();
    if (!Array.isArray(configuration.commands)) throw new TypeError('Invalid command contributions');
    for (const entry of configuration.commands) {
        if (typeof entry.command !== 'string' || !entry.command || typeof entry.title !== 'string' || !entry.title || titles.has(entry.command)) {
            throw new TypeError('Invalid command contribution');
        }
        titles.set(entry.command, entry.title);
    }
    const pending = new Map();
    let subscriptions;
    let providerSequence = 0;

    function unsupported(name) { throw new Error(`Unsupported VS Code API: ${name}`); }
    function contract(name, members) {
        return new Proxy(Object.freeze(members), {
            get(object, key) {
                if (key in object || typeof key === 'symbol') return Reflect.get(object, key);
                return unsupported(`${name}.${key}`);
            },
        });
    }
    function request(operation, resultKind) {
        const id = globalThis.__ashInvocation();
        const owned = pending.get(id);
        if (!owned) throw new Error('VS Code callback is no longer active');
        const promise = (async () => {
            const result = JSON.parse(await globalThis.__ashRequest(id, JSON.stringify(operation)));
            if (result.result !== resultKind) throw new Error(`Invalid result for ${operation.operation}`);
            return result;
        })();
        // Standard extensions often ignore a notification's returned Thenable. Keep its
        // request alive until it completes, without allowing detached work after retirement.
        const settled = promise.then(() => undefined, () => undefined);
        owned.push(settled);
        return promise;
    }
    async function invoke(callback) {
        const id = globalThis.__ashInvocation();
        pending.set(id, []);
        try {
            const result = await callback();
            let drained = 0;
            const owned = pending.get(id);
            while (drained < owned.length) {
                const batch = owned.slice(drained);
                drained = owned.length;
                await Promise.all(batch);
            }
            return result;
        } finally {
            pending.delete(id);
        }
    }
    function message(severity, text, ...items) {
        if (typeof text !== 'string') throw new TypeError('Message must be a string');
        if (items.length) return unsupported('window message options/items');
        return request({ operation: 'showMessage', message: text, severity }, 'done').then(() => undefined);
    }
    class Disposable {
        #callback;
        constructor(callback) {
            if (typeof callback !== 'function') throw new TypeError('Disposable requires a callback');
            this.#callback = callback;
        }
        dispose() { const callback = this.#callback; this.#callback = undefined; callback?.(); }
        static from(...items) { return new Disposable(() => { for (const item of items) item.dispose(); }); }
    }
    class Position {
        constructor(line, character) {
            if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) throw new RangeError('Invalid position');
            this.line = line;
            this.character = character;
            Object.freeze(this);
        }
        compareTo(other) { return Math.sign(this.line - other.line || this.character - other.character); }
        isEqual(other) { return this.compareTo(other) === 0; }
        isBefore(other) { return this.compareTo(other) < 0; }
        isAfter(other) { return this.compareTo(other) > 0; }
        isBeforeOrEqual(other) { return this.compareTo(other) <= 0; }
        isAfterOrEqual(other) { return this.compareTo(other) >= 0; }
        translate(lineDelta = 0, characterDelta = 0) {
            if (typeof lineDelta === 'object') return this.translate(lineDelta.lineDelta ?? 0, lineDelta.characterDelta ?? 0);
            return new Position(this.line + lineDelta, this.character + characterDelta);
        }
        with(line = this.line, character = this.character) {
            if (typeof line === 'object') return this.with(line.line ?? this.line, line.character ?? this.character);
            return new Position(line, character);
        }
    }
    class Range {
        constructor(start, end, endLine, endCharacter) {
            if (typeof start === 'number') { start = new Position(start, end); end = new Position(endLine, endCharacter); }
            const first = new Position(start.line, start.character);
            const last = new Position(end.line, end.character);
            this.start = first.isBeforeOrEqual(last) ? first : last;
            this.end = first.isBeforeOrEqual(last) ? last : first;
            Object.freeze(this);
        }
        get isEmpty() { return this.start.isEqual(this.end); }
        get isSingleLine() { return this.start.line === this.end.line; }
        contains(value) {
            if (value.start && value.end) return this.contains(value.start) && this.contains(value.end);
            return this.start.isBeforeOrEqual(value) && this.end.isAfterOrEqual(value);
        }
        isEqual(other) { return this.start.isEqual(other.start) && this.end.isEqual(other.end); }
    }
    class Uri {
        constructor(scheme, authority, path, query = '', fragment = '') {
            Object.assign(this, { scheme, authority, path, query, fragment });
            Object.freeze(this);
        }
        static parse(value) {
            const match = /^([a-zA-Z][\w+.-]*):(?:(\/\/)([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
            if (!match) throw new TypeError('Invalid URI');
            return new Uri(match[1], decodeURIComponent(match[3] ?? ''), decodeURIComponent(match[4]), match[5] ?? '', match[6] ?? '');
        }
        static file(path) {
            if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('Absolute file path required');
            return new Uri('file', '', path);
        }
        static from(components) { return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query ?? '', components.fragment ?? ''); }
        with(change) { return Uri.from({ ...this, ...change }); }
        get fsPath() { return this.authority ? `//${this.authority}${this.path}` : this.path; }
        toString(skipEncoding = false) {
            const path = skipEncoding ? this.path : this.path.split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
            return `${this.scheme}:${this.authority || this.scheme === 'file' ? `//${this.authority}` : ''}${path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
        }
        toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment }; }
    }
    function document(snapshot) {
        const uri = snapshot.uri === undefined ? undefined : Uri.parse(snapshot.uri);
        return Object.freeze({ uri, version: snapshot.version, languageId: snapshot.languageId,
            getText(range) {
                if (!range) return snapshot.text;
                const lines = snapshot.text.split('\n');
                const offset = position => lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
                return snapshot.text.slice(offset(range.start), offset(range.end));
            },
        });
    }
    const api = contract('vscode', {
        Disposable, Position, Range, Uri,
        Hover: class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } },
        MarkdownString: class MarkdownString {
            constructor(value = '') { this.value = value; }
            appendText(value) { this.value += value.replace(/[\\`*_{}[\]()#+.!-]/g, '\\$&'); return this; }
            appendMarkdown(value) { this.value += value; return this; }
        },
        commands: contract('commands', {
            registerCommand(command, callback, thisArg) {
                if (typeof callback !== 'function' || !titles.has(command)) throw new TypeError('Command must be declared in package.json');
                return ashCommands.registerCommand(command, titles.get(command), (_call, ...args) => invoke(() => callback.apply(thisArg, args)));
            },
        }),
        window: contract('window', {
            showInformationMessage: (text, ...items) => message('information', text, ...items),
            showWarningMessage: (text, ...items) => message('warning', text, ...items),
            showErrorMessage: (text, ...items) => message('error', text, ...items),
            async showQuickPick(items, options = {}) {
                if (!Array.isArray(items) || options.canPickMany) return unsupported('window.showQuickPick input/multi-select');
                const labels = items.map(item => typeof item === 'string' ? item : item.label);
                const { index } = await request({ operation: 'showQuickPick', items: labels, placeholder: options.placeHolder ?? '' }, 'selection');
                return index === null ? undefined : items[index];
            },
        }),
        workspace: contract('workspace', {
            async openTextDocument(uri) {
                if (!(uri instanceof Uri)) return unsupported('workspace.openTextDocument overload');
                const result = await request({ operation: 'readDocument', uri: uri.toString() }, 'document');
                return document(result.document);
            },
        }),
        languages: contract('languages', {
            registerHoverProvider(selector, provider) {
                const entries = Array.isArray(selector) ? selector : [selector];
                if (entries.some(entry => typeof entry !== 'string')) return unsupported('languages.registerHoverProvider selector filters');
                const registration = ashLanguages.registerHoverProvider(`vscode.hover.${++providerSequence}`, entries, {
                    provideHover: (_call, snapshot, position) => invoke(async () => {
                        const hover = await provider.provideHover(document(snapshot), new Position(position.line, position.character),
                            contract('CancellationToken', { isCancellationRequested: false }));
                        return hover == null ? undefined : { contents: hover.contents, ...(hover.range === undefined ? {} : { range: hover.range }) };
                    }),
                });
                subscriptions.push(registration);
                return registration;
            },
        }),
    });
    return Object.freeze({ api, activate(context) { subscriptions = context.subscriptions; } });
}
