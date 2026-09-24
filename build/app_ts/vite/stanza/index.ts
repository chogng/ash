import { addDisposableListener } from "../../../../app-ts/src/ash/base/browser/dom.js";
import { DisposableStore, toDisposable } from "../../../../app-ts/src/ash/base/common/lifecycle.js";
import * as stanzaApi from "../../../../app-ts/src/ash/editor/editor.main.js";
import "./style.css";

declare global {
  var stanza: typeof stanzaApi;
}

globalThis.stanza = stanzaApi;

const initialText = `interface GeometrySample {
\treadonly label: string;
\treadonly columns: readonly number[];
}

const greeting = "你好，Stanza 👋";
const sample: GeometrySample = {
\tlabel: greeting,
\tcolumns: [0, 4, 8, 16, 32, 64, 80],
};

export function describe(sample: GeometrySample): string {
\tconst longLine = "Edit this deliberately long line to inspect wrapping, cursor placement, selections, horizontal geometry, and viewport updates without starting the Ash Workbench.";
\treturn \`\${sample.label}: \${sample.columns.join(", ")} — \${longLine}\`;
}

console.log(describe(sample));
${createScrollSamples(96)}`;

const container = requiredElement("editor-root");
const resource = stanzaApi.URI.parse("inmemory://stanza/standalone.ts");
const disposables = new DisposableStore();
const model = disposables.add(stanzaApi.editor.createModel(initialText, "typescript", resource));
const editor = disposables.add(stanzaApi.editor.create(container, {
  model,
  lineWrapping: stanzaApi.EditorLineWrapping.On,
  lineNumbers: "on",
  showSymbolIcons: false,
  guides: { indentation: true },
  bracketPairColorization: { enabled: true },
  stickyScroll: { enabled: true },
  suggestions: true,
  inlineCompletions: true,
  parameterHints: { enabled: true },
  inlayHints: { enabled: "on" },
  codeLens: true,
  placeholder: "Start typing…",
}));

const resizeObserver = new ResizeObserver(() => layoutEditor());
resizeObserver.observe(container);
disposables.add(toDisposable(() => resizeObserver.disconnect()));

function layoutEditor(): void {
  const bounds = container.getBoundingClientRect();
  editor.layout({ width: bounds.width, height: bounds.height });
}

function createScrollSamples(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return `
export function scrollSample${ordinal}(value: number): string {
\tconst adjusted = value + ${index + 1};
\treturn "sample-${ordinal}: " + String(adjusted);
}
`;
  }).join("");
}

layoutEditor();
editor.focus();

disposables.add(addDisposableListener(window, "pagehide", () => disposables.dispose(), { once: true }));

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing Stanza debug element '#${id}'`);
  return element;
}
