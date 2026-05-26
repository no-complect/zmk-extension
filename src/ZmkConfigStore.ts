import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { STORE_JSON } from "./extensionStorage";
import { log, logError } from "./logger";

type ConfigValues = Record<string, string | number | boolean>;

interface StoreData {
  configFilePath?: string;
  values: ConfigValues;
  /** Zephyr board id used for `west build -b` when not found in the west manifest. */
  board?: string;
  /** Shield id(s) passed as `-DSHIELD=` when not found in the west manifest. */
  shield?: string;
  /**
   * Optional user-selected west workspace root (directory containing `.west/config`).
   * When set, the extension will prefer this over the extension-managed workspace.
   */
  westWorkspacePath?: string;
}

/**
 * Persists ZMK config values to a human-readable JSON file at:
 *   <globalStorageUri>/zmk-config.json
 *
 * Structure:
 * {
 *   "configFilePath": "/path/to/agar_ble.conf",   // optional linked .conf file
 *   "values": {
 *     "CONFIG_ZMK_HID_MOUSE_MOVE_MAX": 200,
 *     "CONFIG_ZMK_HID_MOUSE_SCROLL_MAX": 10
 *   },
 *   "board": "nice_nano_v2",
 *   "shield": "corne_left corne_right"
 * }
 *
 * The values block maps directly to ZMK .conf syntax: KEY=value
 */
export class ZmkConfigStore {
  private readonly storePath: string;

  constructor(globalStorageUri: vscode.Uri) {
    fs.mkdirSync(globalStorageUri.fsPath, { recursive: true });
    this.storePath = path.join(globalStorageUri.fsPath, STORE_JSON);
  }

  private read(): StoreData {
    try {
      return JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as StoreData;
    } catch (err) {
      if (fs.existsSync(this.storePath)) {
        logError("Failed to parse extension settings store", err);
      }
      return { values: {} };
    }
  }

  private write(data: StoreData): void {
    fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  getAll(): ConfigValues {
    return this.read().values;
  }

  getFilePath(): string | undefined {
    return this.read().configFilePath;
  }

  getStorePath(): string {
    return this.storePath;
  }

  getBoard(): string | undefined {
    return this.read().board;
  }

  getShield(): string | undefined {
    return this.read().shield;
  }

  getWestWorkspacePath(): string | undefined {
    return this.read().westWorkspacePath;
  }

  async setBoard(board: string | undefined): Promise<void> {
    const data = this.read();
    data.board = board;
    this.write(data);
  }

  async setShield(shield: string | undefined): Promise<void> {
    const data = this.read();
    data.shield = shield;
    this.write(data);
  }

  async setWestWorkspacePath(westWorkspacePath: string | undefined): Promise<void> {
    const data = this.read();
    data.westWorkspacePath = westWorkspacePath;
    this.write(data);
  }

  async clearBoardShield(): Promise<void> {
    const data = this.read();
    delete data.board;
    delete data.shield;
    this.write(data);
  }

  async set(key: string, value: string | number | boolean): Promise<void> {
    const data = this.read();
    data.values[key] = value;
    this.write(data);
    await this.syncToFile(data.values, data.configFilePath);
  }

  /**
   * Point config sync at `filePath`. When `importFrom` is set, copies that file into
   * `filePath` first (used to ingest an external .conf into extension storage).
   */
  async linkFile(filePath: string, importFrom?: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (importFrom) {
      fs.copyFileSync(importFrom, filePath);
      log(`Config file copied to extension storage: ${filePath}`);
    }
    const data = this.read();
    data.configFilePath = filePath;
    try {
      const fileValues = parseConfFile(fs.readFileSync(filePath, "utf-8"));
      // Existing store values win over file values
      data.values = { ...fileValues, ...data.values };
      log(`Config file linked: ${filePath} (${Object.keys(fileValues).length} values read)`);
    } catch (err) {
      logError("Failed to read config file", err);
    }
    this.write(data);
  }

  /** Create an empty linked .conf in extension storage when none exists yet. */
  async ensureLinkedFile(filePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "# ZMK Studio configuration\n", "utf-8");
      log(`Created config file: ${filePath}`);
    }
    const data = this.read();
    if (data.configFilePath === filePath) return;
    await this.linkFile(filePath);
  }

  /** Write stored values to a `.conf` file, preserving comments and non-CONFIG lines. */
  async exportToFile(filePath: string): Promise<void> {
    const data = this.read();
    await this.syncToFile(data.values, filePath);
    log(`Config exported to ${filePath}`);
  }

  /** Update matching lines in the linked .conf file; append new ones. */
  private async syncToFile(values: ConfigValues, filePath: string | undefined): Promise<void> {
    if (!filePath) return;
    try {
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
      const written = new Set<string>();
      const updated = existing.split("\n").map((line) => {
        const m = line.match(/^(CONFIG_\w+)=(.*)$/);
        if (m && m[1] in values) {
          written.add(m[1]);
          return formatLine(m[1], values[m[1]]);
        }
        return line;
      });
      for (const [k, v] of Object.entries(values)) {
        if (!written.has(k)) updated.push(formatLine(k, v));
      }
      fs.writeFileSync(filePath, updated.join("\n"), "utf-8");
    } catch (err) {
      logError("Failed to sync config to linked file", err);
    }
  }
}

function formatLine(key: string, value: string | number | boolean): string {
  if (value === true) return `${key}=y`;
  if (value === false) return `${key}=n`;
  return `${key}=${value}`;
}

function parseConfFile(content: string): ConfigValues {
  const result: ConfigValues = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^(CONFIG_\w+)=(.+)$/);
    if (!m) continue;
    const val = m[2].trim();
    if (val === "y" || val === "yes") result[m[1]] = true;
    else if (val === "n" || val === "no") result[m[1]] = false;
    else if (/^\d+$/.test(val)) result[m[1]] = parseInt(val, 10);
    else result[m[1]] = val;
  }
  return result;
}
