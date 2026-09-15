import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { assemblePackage } from "./layout.ts";
import { cargoTargetDirectory } from "../lib/cargo.ts";
import { developmentAshPackagePath, developmentHostTarget } from "./store.ts";
import {
  parseJavaScriptRuntime,
  parsePackageOptions,
  selectNodeArtifact,
  selectRipgrepArtifact,
  selectTgrepArtifact,
  selectV8ArtifactPair,
} from "./prepare.ts";

const protocol = { major: 5, revision: 7, schemaHash: `sha256:${"9".repeat(64)}` };

test("selects the latest published package and rejects invalid manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-package-store-"));
  try {
    const store = join(root, ".build/ash-package/dev/store-v1/x86_64-pc-windows-msvc/packaged-node/dev-small");
    const manifests = join(store, "manifests");
    await mkdir(manifests, { recursive: true });
    const select = () => developmentAshPackagePath(root, "packaged-node", "win32", "x64");
    assert.throws(select, /no published manifest/);
    await writeFile(join(manifests, "notes.json"), "{}");
    for (const sequence of [2, 1]) {
      await writeFile(join(manifests, `${String(sequence).padStart(20, "0")}.json`), JSON.stringify({
        formatVersion: 1, sequence, directory: `packages/0.1.0/${String(sequence).repeat(64)}`,
      }));
    }
    assert.equal(select(), join(store, "packages/0.1.0", "2".repeat(64)));
    for (const manifest of [
      { formatVersion: 1, sequence: 1, directory: `packages/0.1.0/${"2".repeat(64)}` },
      { formatVersion: 1, sequence: 2, directory: "../../outside" },
    ]) {
      await writeFile(join(manifests, "00000000000000000002.json"), JSON.stringify(manifest));
      assert.throws(select, /Invalid Ash development package manifest/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves one shared Cargo target directory for host development builds", () => {
  const workspace = resolve("/workspace/ash");
  assert.equal(cargoTargetDirectory(workspace, {}), join(workspace, ".build", "cargo"));
  assert.equal(cargoTargetDirectory(workspace, { CARGO_TARGET_DIR: "build/cargo" }), join(workspace, "build", "cargo"));
  assert.equal(cargoTargetDirectory(workspace, { CARGO_TARGET_DIR: "/cache/ash" }), resolve("/cache/ash"));
});

test("selects host-provided Node for Desktop and explicit packaged Node for headless hosts", () => {
  assert.equal(parseJavaScriptRuntime([]), "host-provided-node");
  assert.equal(parseJavaScriptRuntime(["--javascript-runtime", "packaged-node"]), "packaged-node");
  assert.throws(() => parseJavaScriptRuntime(["--javascript-runtime", "system-node"]), /Usage/);
});

test("parses an optional packaged Remote runtime bundle", () => {
  assert.deepEqual(parsePackageOptions(["--remote-runtime-bundle", "../runtime-bundle", "--javascript-runtime", "packaged-node"]), {
    javascriptRuntime: "packaged-node",
    remoteRuntimeBundle: resolve("../runtime-bundle"),
    remoteRuntimeRelease: undefined,
  });
  assert.throws(() => parsePackageOptions(["--remote-runtime-bundle"]), /Usage/);
  assert.throws(() => parsePackageOptions(["--remote-runtime-bundle", "one", "--remote-runtime-bundle", "two"]), /Usage/);
});

test("parses only a complete credential-free network Remote runtime release", () => {
  assert.deepEqual(parsePackageOptions([
    "--remote-runtime-catalog-url", "https://releases.example/ash/catalog.json",
    "--remote-runtime-catalog-sha256", "a".repeat(64),
  ]), {
    javascriptRuntime: "host-provided-node",
    remoteRuntimeBundle: undefined,
    remoteRuntimeRelease: { url: "https://releases.example/ash/catalog.json", sha256: "a".repeat(64) },
  });
  assert.throws(() => parsePackageOptions(["--remote-runtime-catalog-url", "https://user@releases.example/catalog.json", "--remote-runtime-catalog-sha256", "a".repeat(64)]), /credential-free HTTPS/);
  assert.throws(() => parsePackageOptions(["--remote-runtime-catalog-url", "https://releases.example/catalog.json"]), /Usage/);
});

test("maps supported development hosts to Rust targets", () => {
  assert.equal(developmentHostTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(developmentHostTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(developmentHostTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.throws(() => developmentHostTarget("freebsd", "x64"), /Unsupported/);
});

test("selects the target-specific locked ripgrep artifact", () => {
  const lock = {
    artifacts: {
      windows: {
        archive: "rg.zip",
        executable: "bundle/rg.exe",
        format: "zip",
        sha256: "a".repeat(64),
        size: 123,
      },
    },
    packageTargets: { "x86_64-pc-windows-msvc": "windows" },
    runtime: "ripgrep",
    schemaVersion: 1,
    source: { release: "1.0.0", repository: "https://example.invalid/repo" },
    version: "1.0.0",
  };
  const artifact = selectRipgrepArtifact(lock, "x86_64-pc-windows-msvc");
  assert.equal(artifact.executable, "bundle/rg.exe");
  assert.equal(artifact.url, "https://example.invalid/repo/releases/download/1.0.0/rg.zip");
});

test("selects the target-specific locked Node.js artifact", () => {
  const lock = {
    artifacts: {
      windows: {
        archive: "node.zip",
        executable: "bundle/node.exe",
        format: "zip",
        license: "bundle/LICENSE",
        sha256: "a".repeat(64),
        size: 123,
      },
    },
    packageTargets: { "x86_64-pc-windows-msvc": "windows" },
    runtime: "node",
    schemaVersion: 1,
    source: { baseUrl: "https://example.invalid/node" },
    version: "1.0.0",
  };
  const artifact = selectNodeArtifact(lock, "x86_64-pc-windows-msvc");
  assert.equal(artifact.executable, "bundle/node.exe");
  assert.equal(artifact.url, "https://example.invalid/node/node.zip");

  lock.artifacts.windows.sha256 = "invalid";
  assert.throws(
    () => selectNodeArtifact(lock, "x86_64-pc-windows-msvc"),
    /SHA-256/,
  );
});

test("selects a checksum-locked sandbox-enabled rusty_v8 pair", () => {
  const target = "aarch64-apple-darwin";
  const profile = "ptrcomp_sandbox_release";
  const pair = selectV8ArtifactPair({
    artifacts: {
      [target]: {
        archive: {
          name: `librusty_v8_${profile}_${target}.a.gz`,
          sha256: "a".repeat(64),
        },
        binding: {
          name: `src_binding_${profile}_${target}.rs`,
          sha256: "b".repeat(64),
        },
      },
    },
    profile,
    runtime: "rusty-v8",
    schemaVersion: 1,
    source: {
      release: "rusty-v8-v150.4.0",
      repository: "https://github.com/openai/codex",
    },
    version: "150.4.0",
  }, target);

  assert.equal(pair.archive.url, `https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0/${pair.archive.name}`);
  assert.equal(pair.binding.sha256, "b".repeat(64));
});

test("assembles and validates the canonical Windows development layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-package-test-"));
  const staging = join(root, "package");
  const executables = {
    appServerDaemon: join(root, "ash-app-server-daemon.exe"),
    codeModeHost: join(root, "ash-code-mode-host.exe"),
    windowsSandbox: join(root, "ash-windows-sandbox.exe"),
    appServer: join(root, "ash-app-server.exe"),
    remote: join(root, "ash-remote.exe"),
    remoteServer: join(root, "ash-remote-server.exe"),
    execServer: join(root, "ash-exec-server.exe"),
  };
  const ripgrepExecutable = join(root, "rg.exe");
  const nodeExecutable = join(root, "node.exe");
  const nodeLicense = join(root, "node-license");
  const remoteRuntimeBundle = join(root, "remote-runtime-bundle");
  try {
    await mkdir(join(remoteRuntimeBundle, "artifacts"), { recursive: true });
    await Promise.all([
      writeFile(executables.appServerDaemon, "ash-app-server-daemon"),
      writeFile(executables.codeModeHost, "ash-code-mode-host"),
      writeFile(executables.windowsSandbox, "windows-sandbox"),
      writeFile(executables.appServer, "ash-app-server"),
      writeFile(executables.remote, "ash-remote"),
      writeFile(executables.remoteServer, "ash-remote-server"),
      writeFile(executables.execServer, "ash-exec-server"),
      writeFile(ripgrepExecutable, "ripgrep"),
      writeFile(nodeExecutable, "node"),
      writeFile(nodeLicense, "node license"),
      writeFile(join(remoteRuntimeBundle, "artifacts", "ash-linux.tar.gz"), "remote runtime"),
      writeFile(join(remoteRuntimeBundle, "catalog.json"), JSON.stringify({ formatVersion: 1, artifacts: [{ target: "x86_64-unknown-linux-gnu" }] })),
    ]);
    await assemblePackage(
      staging,
      "x86_64-pc-windows-msvc",
      "win32",
      protocol,
      executables,
      {
        archive: "rg.zip",
        archiveSha256: "a".repeat(64),
        binarySha256: "b".repeat(64),
        executable: ripgrepExecutable,
        source: "upstream-release",
        version: "1.0.0",
      },
      await tgrepFixture(root),
      {
        archive: "node.zip",
        archiveSha256: "c".repeat(64),
        binarySha256: "d".repeat(64),
        executable: nodeExecutable,
        license: nodeLicense,
        source: "upstream-release",
        version: "24.18.1",
      },
      remoteRuntimeBundle,
    );
    const metadata = JSON.parse(await readFile(join(staging, "ash-package.json"), "utf8"));
    assert.equal(metadata.layoutVersion, 2);
    assert.equal(metadata.components.tgrep.version, "1.0.8");
    assert.equal(metadata.files["ash-resources/tgrep/tgrep.exe"], createHash("sha256").update("tgrep").digest("hex"));
    assert.equal(await readFile(join(staging, "ash-resources/tgrep/tgrep.exe"), "utf8"), "tgrep");
    assert.equal(metadata.buildProfile, "dev-small");
    assert.equal(metadata.files["bin/ash-app-server.exe"], createHash("sha256").update("ash-app-server").digest("hex"));
    assert.deepEqual(metadata.javascriptRuntime, { kind: "packagedNode" });
    assert.equal(metadata.entrypoint, "bin/ash-app-server.exe");
    assert.equal(metadata.target, "x86_64-pc-windows-msvc");
    assert.equal(metadata.components.appServer.binarySha256, createHash("sha256").update("ash-app-server").digest("hex"));
    assert.equal(metadata.components.appServerDaemon.binarySha256, createHash("sha256").update("ash-app-server-daemon").digest("hex"));
    assert.match(metadata.buildId, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(metadata.protocol, protocol);
    assert.deepEqual(metadata.remoteRuntimeCatalog, {
      path: "ash-remote-runtimes/catalog.json",
      sha256: createHash("sha256").update(await readFile(join(remoteRuntimeBundle, "catalog.json"))).digest("hex"),
      trustBinding: "signedProductPackage",
    });
    assert.equal(await readFile(join(staging, "ash-remote-runtimes", "artifacts", "ash-linux.tar.gz"), "utf8"), "remote runtime");
    assert.equal(await readFile(join(staging, "ash-path", "rg.exe"), "utf8"), "ripgrep");
    assert.equal(await readFile(join(staging, "bin", "ash-app-server-daemon.exe"), "utf8"), "ash-app-server-daemon");
    assert.equal(await readFile(join(staging, "ash-resources", "node", "bin", "node.exe"), "utf8"), "node");
    assert.equal((await readdir(join(staging, "ash-resources"))).includes("ash-command-runner.exe"), false);
    const productServices = JSON.parse(await readFile(join(staging, "ash-resources", "product-services", "product-services.json"), "utf8"));
    const marketplace = productServices.marketplaces.find((source: { name: string }) => source.name === "ash");
    assert.equal(marketplace.metadataBaseUrl, "https://chogng.github.io/marketplace/metadata/");
    assert.equal(marketplace.catalogRefreshIntervalSeconds, 300);
    assert.equal(
      await readFile(join(staging, "ash-resources", "product-services", "marketplace-root.json"), "utf8"),
      await readFile(new URL("../../resources/product-services/marketplace-root.json", import.meta.url), "utf8"),
    );
    const extensionPackages = (await readdir(join(staging, "ash-resources", "extensions"))).sort();
    assert.deepEqual(extensionPackages, ["css", "html", "javascript", "json", "markdown-basics", "python", "rust", "shellscript", "sql", "theme-defaults", "typescript-basics", "xml", "yaml"]);
    assert.match(await readFile(join(staging, "ash-resources", "extensions", "json", "package.json"), "utf8"), /"name": "json"/);
    assert.equal(
      await readFile(join(staging, "ash-resources", "licenses", "vscode", "LICENSE.txt"), "utf8"),
      await readFile(new URL("../../third_party/vscode/LICENSE.txt", import.meta.url), "utf8"),
    );
    const fileTemplates = [];
    for (const packageName of extensionPackages) {
      const extensionRoot = join(staging, "ash-resources", "extensions", packageName);
      const manifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8")) as {
        readonly contributes?: { readonly snippets?: ReadonlyArray<{ readonly language: string | readonly string[]; readonly path: string }> };
        readonly name: string;
        readonly publisher: string;
      };
      for (const snippetContribution of manifest.contributes?.snippets ?? []) {
        assert.match(snippetContribution.path, /^\.\//);
        const snippetDocument = JSON.parse(await readFile(join(extensionRoot, ...snippetContribution.path.slice(2).split("/")), "utf8")) as Readonly<Record<string, { readonly isFileTemplate?: boolean }>>;
        const languages: readonly string[] = Array.isArray(snippetContribution.language) ? snippetContribution.language : [snippetContribution.language];
        for (const [snippetName, snippet] of Object.entries(snippetDocument)) {
          if (snippet.isFileTemplate === true) {
            fileTemplates.push(...languages.map(language => [`${manifest.publisher}.${manifest.name}`, language, snippetName]));
          }
        }
      }
    }
    fileTemplates.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
    assert.deepEqual(fileTemplates, [
      ["vscode.html", "html", "html doc"],
      ["vscode.javascript", "javascript", "Class Definition"],
      ["vscode.javascript", "javascriptreact", "Class Definition"],
      ["vscode.typescript", "typescript", "Class Definition"],
      ["vscode.typescript", "typescriptreact", "Class Definition"],
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("host-provided runtime package omits the standalone Node payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-host-runtime-test-"));
  const staging = join(root, "package");
  const executables = {
    appServerDaemon: join(root, "ash-app-server-daemon.exe"),
    codeModeHost: join(root, "ash-code-mode-host.exe"),
    windowsSandbox: join(root, "ash-windows-sandbox.exe"),
    appServer: join(root, "ash-app-server.exe"),
    remote: join(root, "ash-remote.exe"),
    remoteServer: join(root, "ash-remote-server.exe"),
    execServer: join(root, "ash-exec-server.exe"),
  };
  const ripgrepExecutable = join(root, "rg.exe");
  try {
    await Promise.all([
      writeFile(executables.appServerDaemon, "ash-app-server-daemon"),
      writeFile(executables.codeModeHost, "ash-code-mode-host"),
      writeFile(executables.windowsSandbox, "windows-sandbox"),
      writeFile(executables.appServer, "ash-app-server"),
      writeFile(executables.remote, "ash-remote"),
      writeFile(executables.remoteServer, "ash-remote-server"),
      writeFile(executables.execServer, "ash-exec-server"),
      writeFile(ripgrepExecutable, "ripgrep"),
    ]);
    await assemblePackage(
      staging,
      "x86_64-pc-windows-msvc",
      "win32",
      protocol,
      executables,
      {
        archive: "rg.zip",
        archiveSha256: "a".repeat(64),
        binarySha256: "b".repeat(64),
        executable: ripgrepExecutable,
        source: "upstream-release",
        version: "1.0.0",
      },
      await tgrepFixture(root),
      undefined,
      undefined,
      { url: "https://releases.example/ash/catalog.json", sha256: "e".repeat(64) },
    );
    const metadata = JSON.parse(await readFile(join(staging, "ash-package.json"), "utf8"));
    assert.equal(metadata.layoutVersion, 2);
    assert.equal(metadata.buildProfile, "dev-small");
    assert.deepEqual(metadata.javascriptRuntime, { kind: "hostProvidedNode" });
    assert.equal(metadata.components.node, undefined);
    assert.deepEqual(metadata.remoteRuntimeCatalog, {
      url: "https://releases.example/ash/catalog.json",
      sha256: "e".repeat(64),
      trustBinding: "signedProductPackage",
    });
    await assert.rejects(readFile(join(staging, "ash-resources", "node", "bin", "node.exe")), /ENOENT/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Linux development packages retain Bubblewrap without a Ash namespace helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-linux-network-package-"));
  try {
    const names = ["ash-remote", "ash-remote-server", "ash-exec-server", "ash-app-server", "ash-app-server-daemon", "ash-code-mode-host", "bwrap", "COPYING", "rg"];
    await Promise.all(names.map((name) => writeFile(join(root, name), name)));
    const staging = join(root, "package");
    await assemblePackage(staging, "x86_64-unknown-linux-gnu", "linux", protocol, {
      remote: join(root, "ash-remote"), remoteServer: join(root, "ash-remote-server"),
      execServer: join(root, "ash-exec-server"),
      appServer: join(root, "ash-app-server"), appServerDaemon: join(root, "ash-app-server-daemon"),
      codeModeHost: join(root, "ash-code-mode-host"),
      bubblewrap: { binary: join(root, "bwrap"), license: join(root, "COPYING"), version: "0.11.2", archive: "bwrap.tar", archiveSha256: "a".repeat(64) },
    }, { executable: join(root, "rg"), archive: "rg.tar", archiveSha256: "b".repeat(64), binarySha256: "c".repeat(64), source: "upstream-release", version: "1" },
      await tgrepFixture(root), undefined);
    assert.equal(await readFile(join(staging, "ash-resources", "bwrap"), "utf8"), "bwrap");
    assert.equal((await readdir(join(staging, "ash-resources"))).includes("ash-linux-sandbox"), false);
    const metadata = JSON.parse(await readFile(join(staging, "ash-package.json"), "utf8"));
    assert.equal(metadata.components.linuxSandbox, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects an empty built-in extension source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /source is empty/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects an empty built-in extension package directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "demo"), { recursive: true });
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /missing package.json/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a symbolic built-in extension source directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const target = join(root, "source-target");
    const source = join(root, "source");
    await mkdir(target);
    await symlink(target, source, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /source is not a real directory/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a symbolic built-in extension package directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-dev-extension-test-"));
  try {
    const source = join(root, "source");
    const extension = join(root, "demo-target");
    await mkdir(source);
    await mkdir(extension);
    await writeFile(join(extension, "package.json"), '{"name":"demo","publisher":"ash","version":"1.0.0"}');
    await symlink(extension, join(source, "demo"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copyBuiltinExtensions(join(root, "destination"), source), /Invalid built-in extension package/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// Exercise invalid resource inputs through the production assembly boundary.
async function copyBuiltinExtensions(destination: string, source: string): Promise<void> {
  const root = join(destination, "sources");
  await mkdir(join(root, "ash-rs", "skills", "assets", "review"), { recursive: true });
  await writeFile(join(root, "ash-rs", "skills", "assets", "review", "SKILL.md"), "review");
  await rename(source, join(root, "extensions"));
  await assemblePackage(join(destination, "package"), "aarch64-apple-darwin", "darwin", protocol, {
    appServer: "unused", appServerDaemon: "unused", codeModeHost: "unused",
    remote: "unused", remoteServer: "unused", execServer: "unused",
  }, { executable: "unused", binarySha256: "", source: "local-override", version: "1" },
      { executable: "unused", binarySha256: "", source: "local-override", version: "1.0.8" },
  undefined, undefined, undefined, { sourceRoot: root });
}

test("assembly rejects linked Skill assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-skill-link-"));
  try {
    const skill = join(root, "ash-rs", "skills", "assets", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "review");
    await symlink(skill, join(skill, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(assemblePackage(join(root, "output"), "aarch64-apple-darwin", "darwin", protocol, {
      appServer: "unused", appServerDaemon: "unused", codeModeHost: "unused",
      remote: "unused", remoteServer: "unused", execServer: "unused",
    }, { executable: "unused", binarySha256: "", source: "local-override", version: "1" },
      { executable: "unused", binarySha256: "", source: "local-override", version: "1.0.8" },
    undefined, undefined, undefined, { sourceRoot: root }), /symbolic link/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function tgrepFixture(root: string) {
  const executable = join(root, "tgrep-input");
  await writeFile(executable, "tgrep");
  return { executable, binarySha256:createHash("sha256").update("tgrep").digest("hex"), source:"local-override" as const, version:"1.0.8" };
}


test("selects every locked tgrep platform and rejects invalid artifacts", async () => {
  const lock = JSON.parse(await readFile(new URL("../../third_party/tgrep/runtime-lock.json", import.meta.url), "utf8"));
  for (const target of Object.keys(lock.packageTargets)) {
    const artifact = selectTgrepArtifact(lock, target);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(artifact.url, /releases\/download\/v1\.0\.8\//);
    assert.ok(artifact.executable.endsWith(target.includes("windows") ? "tgrep.exe" : "tgrep"));
  }
  assert.equal(Object.keys(lock.packageTargets).length, 8);
  assert.throws(() => selectTgrepArtifact(lock, "unsupported"), /No locked tgrep artifact/);
  lock.artifacts[lock.packageTargets["aarch64-apple-darwin"]].sha256 = "invalid";
  assert.throws(() => selectTgrepArtifact(lock, "aarch64-apple-darwin"), /SHA-256/);
});
