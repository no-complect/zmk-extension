import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";

/** Subdirectory of extension globalStorage holding the west workspace checkout. */
export const WEST_WORKSPACE_DIR = "west-workspace";

/** Subdirectory of extension globalStorage for exported keymaps and firmware artifacts. */
export const KEYMAPS_DIR = "keymaps";

/** Filename for extension settings store (see ZmkConfigStore), not a Kconfig `.conf`. */
export const STORE_JSON = "zmk-config.json";

/** Ensures the extension globalStorage root exists and returns its absolute path. */
export function getExtensionStorageRoot(context: vscode.ExtensionContext): string {
  const root = context.globalStorageUri.fsPath;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Fixed, idempotent west workspace path: `<globalStorage>/west-workspace`. */
export function getWestWorkspacePath(context: vscode.ExtensionContext): string {
  const westRoot = path.join(getExtensionStorageRoot(context), WEST_WORKSPACE_DIR);
  fs.mkdirSync(westRoot, { recursive: true });
  return westRoot;
}

/** Fixed keymaps root: `<globalStorage>/keymaps`. */
export function getKeymapsRoot(context: vscode.ExtensionContext): string {
  const root = path.join(getExtensionStorageRoot(context), KEYMAPS_DIR);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Filesystem-safe folder name from a keyboard display name (e.g. "Agar BLE" → "agar-ble"). */
export function sanitizeKeyboardName(deviceName: string): string {
  return deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "keyboard";
}

/**
 * Per-keyboard directory under globalStorage, created idempotently:
 * `<globalStorage>/keymaps/<keyboard-name>/`
 */
export function getKeyboardStorageDir(
  context: vscode.ExtensionContext,
  deviceName: string
): string {
  const dir = path.join(getKeymapsRoot(context), sanitizeKeyboardName(deviceName));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Basename for `.conf` / `.keymap` inside a keyboard folder.
 * Prefers the ZMK shield id when known so `west build` finds the files.
 */
export function getKeyboardArtifactBaseName(deviceName: string, shield?: string): string {
  const shieldBase = normalizeShieldBase(shield);
  if (shieldBase) return shieldBase;
  return sanitizeKeyboardName(deviceName);
}

/** First shield id without split/role suffix (e.g. `corne_left` → `corne`). */
export function normalizeShieldBase(shield: string | undefined): string | undefined {
  return shield
    ?.split(/\s+/)[0]
    ?.replace(/_left|_right|_central|_peripheral/, "");
}

/** Canonical `.conf` path for a keyboard inside its storage folder. */
export function getKeyboardConfPath(
  context: vscode.ExtensionContext,
  deviceName: string,
  shield?: string
): string {
  const base = getKeyboardArtifactBaseName(deviceName, shield);
  return path.join(getKeyboardStorageDir(context, deviceName), `${base}.conf`);
}

/** Canonical `.keymap` path for a keyboard inside its storage folder. */
export function getKeyboardKeymapPath(
  context: vscode.ExtensionContext,
  deviceName: string,
  shield?: string
): string {
  const base = getKeyboardArtifactBaseName(deviceName, shield);
  return path.join(getKeyboardStorageDir(context, deviceName), `${base}.keymap`);
}

export function isWestWorkspaceReady(westRoot: string): boolean {
  return fs.existsSync(path.join(westRoot, ".west", "config"));
}
