import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "process";
import builtins from "builtin-modules";

const args = process.argv.slice(2);
const prod = args.includes("production");
const watch = args.includes("--watch");
const deploy = args.includes("--deploy");
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getArgValue(name) {
  const equalsArg = args.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) {
    return equalsArg.slice(name.length + 1);
  }

  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }

  return undefined;
}

function getObsidianConfigPath() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "obsidian", "obsidian.json");
}

function findVaultPath() {
  const explicitVault = getArgValue("--vault") ?? process.env.OBSIDIAN_VAULT ?? process.env.OBSIDIAN_VAULT_PATH;
  if (explicitVault) {
    return path.resolve(explicitVault);
  }

  const configPath = getObsidianConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No vault path was provided and Obsidian config was not found. Set OBSIDIAN_VAULT or pass --vault "C:\\path\\to\\vault".`,
    );
  }

  const config = readJson(configPath);
  const vaults = Object.values(config.vaults ?? {}).filter((vault) => typeof vault.path === "string");
  if (vaults.length === 0) {
    throw new Error(`No vaults were found in ${configPath}. Set OBSIDIAN_VAULT or pass --vault.`);
  }

  const openVaults = vaults.filter((vault) => vault.open);
  const candidates = openVaults.length > 0 ? openVaults : vaults;
  return candidates
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]
    .path;
}

function deployToLocalVault() {
  const manifest = readJson(path.join(repoRoot, "manifest.json"));
  const vaultPath = findVaultPath();
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", manifest.id);
  const hotReloadPath = path.join(pluginDir, ".hotreload");
  const files = ["main.js", "manifest.json", "styles.css"];

  fs.mkdirSync(pluginDir, { recursive: true });

  for (const file of files) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(pluginDir, file));
  }

  if (!fs.existsSync(hotReloadPath)) {
    fs.writeFileSync(hotReloadPath, "Hermes Client local development marker.\n");
  }

  console.log(`Copied ${files.join(", ")} to ${pluginDir}`);
}

const plugins = deploy
  ? [
      {
        name: "obsidian-local-deploy",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length === 0) {
              deployToLocalVault();
            }
          });
        },
      },
    ]
  : [];

const context = await esbuild.context({
  entryPoints: [path.join(repoRoot, "main.ts")],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(repoRoot, "main.js"),
  minify: prod,
  plugins,
});

if (watch) {
  await context.watch();
  console.log(`Watching ${path.join(repoRoot, "main.ts")}${deploy ? " and deploying to the local Obsidian vault" : ""}.`);
} else {
  await context.rebuild();
  await context.dispose();
}
