import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { optimize } from "svgo";
import { generateToRs } from "./generate-to-rs.ts";
import { generateToTs } from "./generate-to-ts.ts";

const repositoryDirectory = resolve(import.meta.dirname, "../../..");
const iconDirectory = resolve(repositoryDirectory, "resources/icons");
const defaultOutputs: IconOutputs = {
  manifestFile: resolve(iconDirectory, "manifest.json"),
  rustFile: resolve(repositoryDirectory, "app-rs/icons/src/generated.rs"),
  typescriptFile: resolve(repositoryDirectory, "app-ts/src/ash/base/common/productIcons.ts"),
};
const iconFilePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.svg$/;
const unsafeSvgPattern = /<(?:script|foreignObject)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=/i;
const paintAttributePattern = /\b(?:fill|stroke)="([^"]+)"/g;
const symbolicPaints = new Set([
  "#000",
  "#000000",
  "#fff",
  "#ffffff",
  "black",
  "currentcolor",
  "none",
  "white",
]);

export type IconRendering = "multicolor" | "symbolic";
type IconSourceHandling = "check" | "ignore" | "write";

export interface IconOutputs {
  readonly manifestFile?: string;
  readonly rustFile?: string;
  readonly typescriptFile?: string;
}

export interface GenerateIconsOptions {
  readonly outputs?: IconOutputs;
  readonly sourceDirectory?: string;
  readonly sourceHandling?: IconSourceHandling;
}

export interface GenerateIconsReport {
  readonly count: number;
  readonly outputChanged: boolean;
  readonly sourceChanged: boolean;
}

export interface GeneratedIcon {
  readonly fileName: string;
  readonly id: string;
  readonly propertyName: string;
  readonly rendering: IconRendering;
  readonly rustName: string;
  readonly sourcePath: string;
  readonly svg: string;
}

interface IconSourceUpdate {
  readonly content: string;
  readonly fileName: string;
  readonly path: string;
}

interface IconCompilation {
  readonly icons: readonly GeneratedIcon[];
  readonly sourceUpdates: readonly IconSourceUpdate[];
}

interface GeneratedOutput {
  readonly content: string;
  readonly label: string;
  readonly path: string;
}

export async function generateIcons(options: GenerateIconsOptions = {}): Promise<GenerateIconsReport> {
  const sourceDirectory = options.sourceDirectory ?? iconDirectory;
  const sourceHandling = options.sourceHandling ?? "write";
  const outputs = options.outputs ?? defaultOutputs;
  const compilation = await compileIcons(sourceDirectory);
  const generatedOutputs = compileOutputs(compilation.icons, outputs);
  const staleOutputs = await findStaleOutputs(generatedOutputs);

  if (sourceHandling === "check") {
    const failures = [
      ...compilation.sourceUpdates.map((update) => `source:${update.fileName}`),
      ...staleOutputs.map((output) => output.label),
    ];
    if (failures.length > 0) {
      throw new Error(`Product icons require generation: ${failures.join(", ")}. Run 'pnpm icons:generate'.`);
    }
    return { count: compilation.icons.length, outputChanged: false, sourceChanged: false };
  }

  if (sourceHandling === "write") {
    await Promise.all(compilation.sourceUpdates.map((update) => writeFile(update.path, update.content, "utf8")));
  }
  await Promise.all(staleOutputs.map((output) => writeTextFile(output.path, output.content)));
  return {
    count: compilation.icons.length,
    outputChanged: staleOutputs.length > 0,
    sourceChanged: sourceHandling === "write" && compilation.sourceUpdates.length > 0,
  };
}

export async function checkIcons(options: Omit<GenerateIconsOptions, "sourceHandling"> = {}): Promise<GenerateIconsReport> {
  return generateIcons({ ...options, sourceHandling: "check" });
}

async function compileIcons(sourceDirectory: string): Promise<IconCompilation> {
  const iconFiles = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === ".svg")
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftId = basename(left, ".svg");
      const rightId = basename(right, ".svg");
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  if (iconFiles.length === 0) {
    throw new Error(`No product icons found in ${sourceDirectory}`);
  }

  const icons: GeneratedIcon[] = [];
  const propertyNames = new Set<string>();
  const rustNames = new Set<string>();
  const sourceUpdates: IconSourceUpdate[] = [];
  for (const fileName of iconFiles) {
    if (!iconFilePattern.test(fileName)) {
      throw new Error(`Invalid product icon filename '${fileName}'`);
    }
    const sourcePath = resolve(sourceDirectory, fileName);
    const source = await readFile(sourcePath, "utf8");
    const svg = source.trim();
    validateSvg(fileName, svg);
    const optimizedSvg = optimizeSvg(fileName, svg);
    validateSvg(fileName, optimizedSvg);

    const canonicalSource = `${optimizedSvg}\n`;
    if (source !== canonicalSource) {
      sourceUpdates.push({ content: canonicalSource, fileName, path: sourcePath });
    }

    const id = basename(fileName, ".svg");
    const propertyName = typescriptPropertyName(id);
    const rustName = id.replaceAll("-", "_").toUpperCase();
    if (propertyNames.has(propertyName)) {
      throw new Error(`Duplicate generated TypeScript icon name '${propertyName}'`);
    }
    if (rustNames.has(rustName)) {
      throw new Error(`Duplicate generated Rust icon name '${rustName}'`);
    }
    propertyNames.add(propertyName);
    rustNames.add(rustName);
    icons.push({
      fileName,
      id,
      propertyName,
      rendering: renderingMode(optimizedSvg),
      rustName,
      sourcePath,
      svg: optimizedSvg,
    });
  }
  return { icons, sourceUpdates };
}

function compileOutputs(icons: readonly GeneratedIcon[], outputs: IconOutputs): GeneratedOutput[] {
  const generated: GeneratedOutput[] = [];
  if (outputs.manifestFile) {
    generated.push({ content: generateManifest(icons), label: "manifest", path: outputs.manifestFile });
  }
  if (outputs.rustFile) {
    generated.push({ content: generateToRs(icons, outputs.rustFile), label: "rust", path: outputs.rustFile });
  }
  if (outputs.typescriptFile) {
    generated.push({ content: generateToTs(icons), label: "typescript", path: outputs.typescriptFile });
  }
  if (generated.length === 0) {
    throw new Error("Product icon generation requires at least one output");
  }
  return generated;
}

function generateManifest(icons: readonly GeneratedIcon[]): string {
  return `${JSON.stringify({
    version: 1,
    icons: icons.map(({ fileName, id, rendering }) => ({ id, file: fileName, rendering })),
  }, null, 2)}\n`;
}

function renderingMode(svg: string): IconRendering {
  for (const [, paint] of svg.matchAll(paintAttributePattern)) {
    if (!symbolicPaints.has(paint.toLowerCase())) {
      return "multicolor";
    }
  }
  return "symbolic";
}

function validateSvg(fileName: string, svg: string): void {
  if (!svg.startsWith("<svg") || !svg.endsWith("</svg>")) {
    throw new Error(`Product icon '${fileName}' must contain one SVG root`);
  }
  if ((svg.match(/<svg\b/g) ?? []).length !== 1 || (svg.match(/<\/svg>/g) ?? []).length !== 1) {
    throw new Error(`Product icon '${fileName}' must contain exactly one SVG root`);
  }
  if (unsafeSvgPattern.test(svg)) {
    throw new Error(`Product icon '${fileName}' contains unsupported active or external content`);
  }
}

function optimizeSvg(fileName: string, svg: string): string {
  const iconName = basename(fileName, ".svg");
  return optimize(svg, {
    path: fileName,
    multipass: true,
    plugins: [
      "preset-default",
      {
        name: "prefixIds",
        params: {
          delim: "-",
          prefix: `ash-${iconName}`,
        },
      },
      "removeDimensions",
    ],
  }).data.trim();
}

function typescriptPropertyName(id: string): string {
  const words = id.split("-");
  return `${words[0]}${words.slice(1).map(capitalize).join("")}`;
}

function capitalize(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

async function findStaleOutputs(outputs: readonly GeneratedOutput[]): Promise<GeneratedOutput[]> {
  const stale: GeneratedOutput[] = [];
  for (const output of outputs) {
    try {
      const current = await readFile(output.path, "utf8");
      if (normalizeNewlines(current) !== output.content) {
        stale.push(output);
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      stale.push(output);
    }
  }
  return stale;
}

function normalizeNewlines(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 1 || (argumentsList.length === 1 && argumentsList[0] !== "--check")) {
    throw new Error(`Expected --check or no arguments; received ${argumentsList.join(" ")}`);
  }
  if (argumentsList[0] === "--check") {
    const report = await checkIcons();
    console.log(`Validated ${report.count} product icons and generated outputs.`);
  } else {
    const report = await generateIcons();
    const status = report.outputChanged || report.sourceChanged ? "Generated" : "Already generated";
    console.log(`${status} ${report.count} product icons and generated outputs.`);
  }
}
