import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { productIconsPlugin } from "../../app_ts/vite/productIconsPlugin.ts";
import { checkIcons, generateIcons, type IconOutputs } from "./generate.ts";

const addSvg = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path stroke="black" d="M2.5 8h11M8 2.5v11"/>
</svg>
`;

function outputs(root: string): IconOutputs {
  return {
    manifestFile: join(root, "icons", "manifest.json"),
    rustFile: join(root, "app", "icons", "src", "generated.rs"),
    typescriptFile: join(root, "generated", "product-icons.ts"),
  };
}

test("product icon generation tracks added, changed, and removed SVG files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-icons-"));
  const sourceDirectory = join(root, "icons");
  const generatedOutputs = outputs(root);
  const outputFile = generatedOutputs.typescriptFile!;
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "add.svg"), addSvg);
    let report = await generateIcons({ outputs: generatedOutputs, sourceDirectory });
    let generated = await readFile(outputFile, "utf8");
    assert.equal(report.count, 1);
    assert.equal(report.outputChanged, true);
    assert.match(generated, /add: register\("add", iconAdd\)/);
    assert.match(generated, /viewBox=\\"0 0 16 16\\"/);
    assert.doesNotMatch(generated, /\bwidth=\\"16\\"/);
    assert.doesNotMatch(generated, /\bheight=\\"16\\"/);
    assert.match(await readFile(generatedOutputs.manifestFile!, "utf8"), /"rendering": "symbolic"/);
    assert.match(await readFile(generatedOutputs.rustFile!, "utf8"), /pub const ADD: Icon/);
    assert.equal((await generateIcons({ outputs: generatedOutputs, sourceDirectory })).outputChanged, false);

    await writeFile(join(sourceDirectory, "close.svg"), addSvg.replace("black", "red"));
    report = await generateIcons({ outputs: generatedOutputs, sourceDirectory });
    generated = await readFile(outputFile, "utf8");
    assert.equal(report.count, 2);
    assert.match(generated, /close: register\("close", iconClose\)/);
    assert.match(generated, /stroke=\\"red\\"/);
    assert.match(await readFile(generatedOutputs.manifestFile!, "utf8"), /"rendering": "multicolor"/);

    await unlink(join(sourceDirectory, "close.svg"));
    report = await generateIcons({ outputs: generatedOutputs, sourceDirectory });
    generated = await readFile(outputFile, "utf8");
    assert.equal(report.count, 1);
    assert.doesNotMatch(generated, /close: register/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("product icon generation exposes prefix-free names including reserved words", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-icons-"));
  const sourceDirectory = join(root, "icons");
  const generatedOutputs = outputs(root);
  const outputFile = generatedOutputs.typescriptFile!;
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "export.svg"), addSvg);
    await generateIcons({ outputs: generatedOutputs, sourceDirectory });
    const generated = await readFile(outputFile, "utf8");
    assert.match(generated, /const iconExport/);
    assert.match(generated, /export: register\("export", iconExport\)/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("product icon generation can update generated output without rewriting source SVGs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-icons-"));
  const sourceDirectory = join(root, "icons");
  const generatedOutputs = outputs(root);
  const outputFile = generatedOutputs.typescriptFile!;
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "add.svg"), addSvg);
    const report = await generateIcons({ outputs: generatedOutputs, sourceDirectory, sourceHandling: "ignore" });
    assert.equal(report.outputChanged, true);
    assert.equal(report.sourceChanged, false);
    assert.equal(await readFile(join(sourceDirectory, "add.svg"), "utf8"), addSvg);
    assert.match(await readFile(outputFile, "utf8"), /viewBox=\\"0 0 16 16\\"/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("product icon generation canonicalizes sources and supports a read-only check", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-icons-"));
  const sourceDirectory = join(root, "icons");
  const generatedOutputs = outputs(root);
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "add.svg"), addSvg);
    await assert.rejects(checkIcons({ outputs: generatedOutputs, sourceDirectory }), /require generation/);
    await assert.rejects(readFile(generatedOutputs.manifestFile!, "utf8"), { code: "ENOENT" });
    const report = await generateIcons({ outputs: generatedOutputs, sourceDirectory });
    const optimized = await readFile(join(sourceDirectory, "add.svg"), "utf8");
    assert.equal(report.sourceChanged, true);
    assert.doesNotMatch(optimized, /\bwidth="16"/);
    assert.doesNotMatch(optimized, /\bheight="16"/);
    assert.match(optimized, /viewBox="0 0 16 16"/);
    const rust = await readFile(generatedOutputs.rustFile!, "utf8");
    await writeFile(generatedOutputs.rustFile!, rust.replaceAll("\n", "\r\n"));
    assert.equal((await checkIcons({ outputs: generatedOutputs, sourceDirectory })).count, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("product icon generation rejects linked or active SVG content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-icons-"));
  const sourceDirectory = join(root, "icons");
  const generatedOutputs = outputs(root);
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "linked.svg"), `<svg viewBox="0 0 16 16"><a href="https://example.test"><path d="M0 0h1v1z"/></a></svg>`);
    await assert.rejects(generateIcons({ outputs: generatedOutputs, sourceDirectory }), /unsupported active or external content/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Vite product icon integration regenerates and reloads after an SVG replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-icons-vite-"));
  const sourceDirectory = join(root, "icons");
  const outputFile = join(root, "generated", "product-icons.ts");
  try {
    await mkdir(sourceDirectory);
    const sourceFile = join(sourceDirectory, "close.svg");
    await writeFile(sourceFile, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3 3l10 10"/></svg>\n');

    const watcher = Object.assign(new EventEmitter(), { add(_path: string): void {} });
    let resolveReload!: (message: { readonly type: "full-reload" }) => void;
    let rejectReload!: (reason: Error) => void;
    const reload = new Promise<{ readonly type: "full-reload" }>((resolvePromise, reject) => {
      resolveReload = resolvePromise;
      rejectReload = reject;
    });
    const reloadMessages: Array<{ readonly type: "full-reload" }> = [];
    const plugin = productIconsPlugin({ sourceDirectory, outputFile, debounceMilliseconds: 0 });
    plugin.configureServer({
      watcher,
      ws: {
        send(message) {
          reloadMessages.push(message);
          resolveReload(message);
        },
      },
      config: {
        logger: {
          error(message) {
            rejectReload(new Error(message));
          },
        },
      },
    });

    const changedSource = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1l14 14"/></svg>\n';
    await writeFile(sourceFile, changedSource);
    watcher.emit("all", "change", sourceFile);
    assert.deepEqual(await reload, { type: "full-reload" });
    assert.match(await readFile(outputFile, "utf8"), /d=\\"m1 1 14 14\\"/);
    assert.equal(await readFile(sourceFile, "utf8"), changedSource);

    watcher.emit("all", "change", sourceFile);
    await delay(25);
    assert.equal(reloadMessages.length, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
