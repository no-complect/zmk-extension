import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { connectSerial, listZMKSerialPorts } from "./transport/SerialTransport";
import { connectCoreBluetooth } from "./transport/CoreBluetoothTransport";
import { MessageBridge } from "./transport/MessageBridge";
import { ZmkConfigStore } from "./ZmkConfigStore";
import { walkUpForWest, loadLocalConfig } from "./ZmkConfigLoader";
import {
  getKeyboardConfPath,
  getKeyboardKeymapPath,
  getKeyboardStorageDir,
  getWestWorkspacePath,
  isWestWorkspaceReady,
  normalizeShieldBase,
  sanitizeKeyboardName,
} from "./extensionStorage";
import { log, logError } from "./logger";
import { buildWestCommand } from "./zmkBuild";
import { execFileNoThrow } from "./utils/execFileNoThrow";
import type { ExportedKeymap } from "../shared/messages";

export class KeyboardPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "zmk-studio.keyboardPanel";

  private view?: vscode.WebviewView;
  private bridge?: MessageBridge;
  readonly configStore: ZmkConfigStore;

  /** Resolves when resolveWebviewView has been called for the first time */
  private _viewReady: Promise<void>;
  private _resolveViewReady!: () => void;

  /** Pending keymap export — resolved when the webview responds with keymapExportData */
  private _exportResolve?: (data: ExportedKeymap | undefined) => void;
  private _exportTimeout?: ReturnType<typeof setTimeout>;

  /** True when config values have changed since the last Save to Flash */
  private _configChangedSinceLastSave = false;

  /** Output channel for firmware rebuild instructions */
  private _rebuildOutput?: vscode.OutputChannel;

  /** Last known device name — populated from keymap export data */
  private _lastDeviceName?: string;

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {
    this.configStore = new ZmkConfigStore(context.globalStorageUri);
    this._viewReady = new Promise<void>((resolve) => {
      this._resolveViewReady = resolve;
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    log("resolveWebviewView called — WebView panel is opening");
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);
    this.bridge = new MessageBridge(webviewView.webview);
    this._resolveViewReady();

    // Handle messages originating from the WebView UI
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "requestDeviceList") {
        const ports = await listZMKSerialPorts();
        webviewView.webview.postMessage({
          type: "deviceList",
          devices: ports.map((p) => ({ label: p.path, path: p.path })),
        });
      }
      if (msg.type === "connectUSB") {
        await this.connectViaUSB(msg.path);
      }
      if (msg.type === "connectBLE") {
        await this.connectViaBLE();
      }
      if (msg.type === "getConfig") {
        webviewView.webview.postMessage({
          type: "configSnapshot",
          values: this.configStore.getAll(),
          hasFile: !!this.configStore.getFilePath(),
        });
      }
      if (msg.type === "setConfigValue") {
        await this.ensureKeyboardConfig(this.getCurrentDeviceName());
        await this.configStore.set(msg.key, msg.value);
        this._configChangedSinceLastSave = true;
      }
      if (msg.type === "savedToFlash") {
        await this.exportConfigToKeyboardStorage(this.getCurrentDeviceName());
        if (this._configChangedSinceLastSave) {
          this._configChangedSinceLastSave = false;
          await this.showRebuildNotification();
        }
      }
      if (msg.type === "buildFirmware") {
        try {
          await this.triggerBuildFirmware();
        } catch (err) {
          logError("triggerBuildFirmware (webview button) threw", err);
        }
      }
      if (msg.type === "openKeymapsFolder") {
        const dir = getKeyboardStorageDir(this.context, this.getCurrentDeviceName());
        vscode.env.openExternal(vscode.Uri.file(dir));
      }
      if (msg.type === "keymapExportData") {
        if (this._exportResolve) {
          // Host-initiated export (via VS Code command) — hand data back to caller
          clearTimeout(this._exportTimeout);
          this._exportResolve(msg.data);
          this._exportResolve = undefined;
        } else {
          // Webview-initiated export (toolbar button) — show save dialog directly
          this.saveExportedKeymap(msg.data);
        }
      }
      if (msg.type === "requestExportConfig") {
        await this.exportConfigAuto();
      }
      if (msg.type === "importKeymapResult") {
        if (msg.success) {
          vscode.window.showInformationMessage("Keymap imported successfully.");
        } else {
          vscode.window.showErrorMessage(`Keymap import failed: ${msg.error ?? "unknown error"}`);
        }
      }
      if (msg.type === "requestImportKeymap") {
        await this.importKeymapFromFile();
      }
    });
  }

  /** Focus the sidebar panel and wait for the webview to initialize. Returns false if it failed. */
  private async ensureViewReady(): Promise<boolean> {
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    await vscode.commands.executeCommand("workbench.view.extension.zmk-studio");
    await vscode.commands.executeCommand(`${KeyboardPanelProvider.viewId}.focus`);
    await this._viewReady;
    if (!this.view || !this.bridge) {
      vscode.window.showErrorMessage("ZMK Studio panel failed to initialize.");
      return false;
    }
    return true;
  }

  /** Ask the webview to serialise its current keymap and return it. Times out after 8 s. */
  async requestKeymapExport(): Promise<ExportedKeymap | undefined> {
    if (!this.view) {
      vscode.window.showErrorMessage("Open the ZMK Studio panel and connect a keyboard first.");
      return undefined;
    }
    return new Promise<ExportedKeymap | undefined>((resolve) => {
      if (this._exportResolve) {
        clearTimeout(this._exportTimeout);
        this._exportResolve(undefined);
      }
      this._exportResolve = resolve;
      this._exportTimeout = setTimeout(() => {
        this._exportResolve?.(undefined);
        this._exportResolve = undefined;
      }, 8_000);
      this.view!.webview.postMessage({ type: "requestKeymapExport" });
    });
  }

  /** Send an imported keymap to the webview to be applied to the keyboard. */
  sendImportKeymap(data: ExportedKeymap): void {
    if (!this.view) {
      vscode.window.showErrorMessage("Open the ZMK Studio panel and connect a keyboard first.");
      return;
    }
    this.view.webview.postMessage({ type: "importKeymap", data });
  }

  getCurrentDeviceName(): string {
    return this._lastDeviceName ?? "keyboard";
  }

  /** Ensures `<globalStorage>/keymaps/<name>/` exists and links its `.conf` file. */
  private async ensureKeyboardConfig(deviceName: string): Promise<string> {
    this._lastDeviceName = deviceName;
    const confPath = getKeyboardConfPath(
      this.context,
      deviceName,
      this.configStore.getShield()
    );
    await this.configStore.ensureLinkedFile(confPath);
    return confPath;
  }

  /** Writes current config values to the keyboard's `.conf` in extension storage. */
  private async exportConfigToKeyboardStorage(deviceName: string): Promise<void> {
    const confPath = await this.ensureKeyboardConfig(deviceName);
    await this.configStore.exportToFile(confPath);
    log(`Config synced to ${confPath}`);
  }

  /**
   * Copies an external `.conf` into extension storage for this keyboard and links it.
   */
  async importConfigFile(sourcePath: string, deviceName?: string): Promise<void> {
    const name = deviceName ?? this.getCurrentDeviceName();
    const dest = getKeyboardConfPath(this.context, name, this.configStore.getShield());
    await this.configStore.linkFile(dest, sourcePath);
    this._lastDeviceName = name;
    this.pushConfigSnapshot();
  }

  /** Called when a transport connects so storage is scoped to that keyboard. */
  private async onDeviceConnected(deviceName: string): Promise<void> {
    this._lastDeviceName = deviceName;
    const shield = this.configStore.getShield();
    const confPath = getKeyboardConfPath(this.context, deviceName, shield);
    const keymapPath = getKeyboardKeymapPath(this.context, deviceName, shield);
    getKeyboardStorageDir(this.context, deviceName);
    if (fs.existsSync(confPath)) {
      await this.configStore.linkFile(confPath);
      log(`Loaded config from extension storage: ${confPath}`);
    } else {
      await this.configStore.ensureLinkedFile(confPath);
    }
    if (fs.existsSync(keymapPath)) {
      log(`Keymap present in extension storage: ${keymapPath}`);
    }
    this.pushConfigSnapshot();
  }

  /** ZMK_CONFIG directory for builds: the keyboard folder when it has config artifacts. */
  private configDirForDevice(deviceName: string): string | undefined {
    const shield = this.configStore.getShield();
    const dir = getKeyboardStorageDir(this.context, deviceName);
    const confPath = getKeyboardConfPath(this.context, deviceName, shield);
    const keymapPath = getKeyboardKeymapPath(this.context, deviceName, shield);
    if (fs.existsSync(confPath) || fs.existsSync(keymapPath)) {
      return dir;
    }
    return undefined;
  }

  /**
   * Ensure a `.keymap` file exists in extension storage for this keyboard.
   * If missing and the webview is available, request an export and write it.
   */
  private async ensureKeymapForBuild(deviceName: string): Promise<string | undefined> {
    const shield = this.configStore.getShield();
    const keymapPath = getKeyboardKeymapPath(this.context, deviceName, shield);
    if (fs.existsSync(keymapPath)) return keymapPath;

    if (!this.view) return undefined;

    const exported = await this.requestKeymapExport();
    if (!exported?.keymapSource) return undefined;

    fs.mkdirSync(path.dirname(keymapPath), { recursive: true });
    fs.writeFileSync(keymapPath, exported.keymapSource, "utf-8");
    log(`Keymap source saved to ${keymapPath}`);
    return keymapPath;
  }

  /** Save keymap + snapshot under `<globalStorage>/keymaps/<device>/`. */
  async saveExportedKeymap(data: ExportedKeymap): Promise<void> {
    const deviceName = data.deviceName ?? this.getCurrentDeviceName();
    await this.onDeviceConnected(deviceName);

    const keymapsDir = getKeyboardStorageDir(this.context, deviceName);
    const base = sanitizeKeyboardName(deviceName);
    const date = new Date().toISOString().slice(0, 10);

    const zmkmapPath = path.join(keymapsDir, `${base}-${date}.zmkmap`);
    fs.writeFileSync(zmkmapPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    log(`Keymap snapshot exported to ${zmkmapPath}`);

    let keymapFilePath: string | undefined;
    if (data.keymapSource) {
      keymapFilePath = getKeyboardKeymapPath(
        this.context,
        deviceName,
        this.configStore.getShield()
      );
      fs.writeFileSync(keymapFilePath, data.keymapSource, "utf-8");
      log(`Keymap source saved to ${keymapFilePath}`);
    }

    const displayFile = keymapFilePath
      ? `${path.basename(keymapFilePath)} + ${path.basename(zmkmapPath)}`
      : path.basename(zmkmapPath);

    const action = await vscode.window.showInformationMessage(
      `Saved to extension storage (keymaps/${base}/${displayFile})`,
      "Show in Finder"
    );
    if (action === "Show in Finder") {
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(keymapFilePath ?? zmkmapPath));
    }
  }

  /** Show a file picker and send the chosen keymap to the webview. */
  async importKeymapFromFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "ZMK Studio Keymap": ["zmkmap"] },
      title: "Import Keymap",
      defaultUri: await this.getDefaultDir(),
    });
    if (!uris || uris.length === 0) return;

    let data: ExportedKeymap;
    try {
      data = JSON.parse(fs.readFileSync(uris[0].fsPath, "utf-8")) as ExportedKeymap;
    } catch {
      vscode.window.showErrorMessage("Failed to read keymap file. Make sure it is a valid .zmkmap file.");
      return;
    }
    if (data.version !== 1 || !Array.isArray(data.layers)) {
      vscode.window.showErrorMessage("Unrecognised keymap format.");
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Import "${path.basename(uris[0].fsPath)}" and overwrite the current keymap? This cannot be undone.`,
      { modal: true },
      "Import"
    );
    if (confirm !== "Import") return;

    this.sendImportKeymap(data);
  }

  /**
   * After a Save to Flash that included config changes, find (or prompt for) the
   * west workspace, construct the `west build` command, and offer to run it.
   */
  private async showRebuildNotification(): Promise<void> {
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

    const westRoot = await this.resolveWestWorkspace();

    const detected = westRoot ? await loadLocalConfig(westRoot, workspacePaths) : undefined;
    const board = detected?.board ?? this.configStore.getBoard();
    const shield = detected?.shield ?? this.configStore.getShield();

    const deviceName = this.getCurrentDeviceName();
    let configDir = this.configDirForDevice(deviceName);
    if (!configDir && detected?.keymapPath) {
      configDir = path.dirname(detected.keymapPath);
    }

    const command = buildWestCommand(board, shield, configDir);

    // Write to output channel
    if (!this._rebuildOutput) {
      this._rebuildOutput = vscode.window.createOutputChannel("ZMK Studio — Rebuild");
    }
    const out = this._rebuildOutput;
    out.clear();
    out.appendLine("─────────────────────────────────────────────────────────────");
    out.appendLine("  Config changes saved. Rebuild firmware to apply them.");
    out.appendLine("─────────────────────────────────────────────────────────────");
    out.appendLine("");
    out.appendLine(westRoot ? `  cd ${westRoot}` : "  # cd to your west workspace root first");
    out.appendLine(`  ${command}`);
    out.appendLine("");
    if (board) {
      const uf2Base = normalizeShieldBase(shield) ?? board;
      out.appendLine(`  Output: build/zephyr/${uf2Base}-${board}-zmk.uf2`);
    } else {
      out.appendLine("  Output: build/zephyr/<shield>-<board>-zmk.uf2");
    }
    out.appendLine("");
    out.show(true);

    const confPath = getKeyboardConfPath(
      this.context,
      deviceName,
      this.configStore.getShield()
    );
    const toastMsg = `Config saved to extension storage (${path.basename(confPath)}). Rebuild firmware to apply.`;

    const actions = westRoot
      ? (["Build Firmware", "Copy command", "Dismiss"] as const)
      : (["Copy command", "Dismiss"] as const);

    const action = await vscode.window.showInformationMessage(toastMsg, ...actions);

    if (action === "Build Firmware" && westRoot) {
      await this.triggerBuildFirmware();
    } else if (action === "Copy command") {
      const full = westRoot ? `cd "${westRoot}" && ${command}` : command;
      await vscode.env.clipboard.writeText(full);
      vscode.window.showInformationMessage("Command copied to clipboard.");
    }
  }

  /**
   * Runs pre-flight checks, writes results to the output channel, then either
   * opens the build terminal (all clear / user confirms warnings) or aborts.
   */
  private async buildFirmware(
    westRoot: string,
    command: string,
    board: string | undefined,
    shield: string | undefined,
    configDir: string | undefined,
  ): Promise<void> {
    const out = this._rebuildOutput!;

    out.appendLine("── Pre-flight checks ────────────────────────────────────────");
    out.appendLine("");

    type CheckStatus = "ok" | "warn" | "error";
    const checks: Array<{ label: string; status: CheckStatus; detail?: string }> = [];

    const check = (label: string, status: CheckStatus, detail?: string) => {
      checks.push({ label, status, detail });
      const icon = status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
      out.appendLine(`  ${icon}  ${label}${detail ? `\n       ${detail}` : ""}`);
    };

    // 1. ZMK source present
    const zmkApp = path.join(westRoot, "zmk", "app");
    if (fs.existsSync(path.join(zmkApp, "CMakeLists.txt"))) {
      check("ZMK source", "ok", zmkApp);
    } else {
      check("ZMK source", "error",
        `${zmkApp} not found — run "west update" in the workspace first`);
    }

    // 2. Zephyr present
    const zephyrDir = path.join(westRoot, "zephyr");
    if (fs.existsSync(path.join(zephyrDir, "CMakeLists.txt"))) {
      check("Zephyr source", "ok", zephyrDir);
    } else {
      check("Zephyr source", "error",
        `${zephyrDir} not found — run "west update" in the workspace first`);
    }

    // 2b. Zephyr CMake package exported (needed when the environment is not already set up)
    const zephyrConfig1 = path.join(zephyrDir, "share", "zephyr-package", "cmake", "ZephyrConfig.cmake");
    const zephyrConfig2 = path.join(zephyrDir, "share", "zephyr-package", "cmake", "zephyr-config.cmake");
    const hasZephyrPackage = fs.existsSync(zephyrConfig1) || fs.existsSync(zephyrConfig2);
    if (hasZephyrPackage) {
      check("Zephyr CMake package", "ok", "Found ZephyrConfig.cmake");
    } else {
      check(
        "Zephyr CMake package",
        "warn",
        `Not found under ${path.join("zephyr", "share", "zephyr-package")}. ` +
          `If the build fails with "Could not find ZephyrConfig.cmake", run: cd "${westRoot}" && west zephyr-export`
      );
    }

    // 3. Board specified
    if (board) {
      check("Board", "ok", board);
    } else {
      check("Board", "warn",
        "No board specified — the build command will be missing -b <board>");
    }

    // 4. Unlinked config values — these won't make it into the build
    const storeValues = this.configStore.getAll();
    const hasStoredValues = Object.keys(storeValues).length > 0;
    if (hasStoredValues && !this.configStore.getFilePath()) {
      check("Config values",  "warn",
        "Config values are saved internally but not linked to a .conf file. " +
        "Run \"ZMK: Export Configuration File\" then \"ZMK: Select Configuration File\" " +
        "so these values are included in the firmware build.");
    }

    // 5. Config directory
    if (configDir) {
      if (fs.existsSync(configDir)) {
        check("Config directory", "ok", configDir);
      } else {
        check("Config directory", "error",
          `${configDir} does not exist — check your linked .conf file path`);
      }
    } else {
      check("Config directory", "warn",
        "No -DZMK_CONFIG path detected; ZMK will use its built-in defaults");
    }

    // 5. Keymap file
    if (configDir && fs.existsSync(configDir)) {
      const shieldBase = shield?.split(/\s+/)[0]?.replace(/_left|_right|_central|_peripheral/, "");
      const keymapCandidates = [
        shieldBase && path.join(configDir, `${shieldBase}.keymap`),
        shield && path.join(configDir, `${shield.split(/\s+/)[0]}.keymap`),
      ].filter(Boolean) as string[];

      // Also scan directory for any .keymap file
      let foundKeymap: string | undefined;
      for (const p of keymapCandidates) {
        if (fs.existsSync(p)) { foundKeymap = p; break; }
      }
      if (!foundKeymap) {
        try {
          const entry = fs.readdirSync(configDir).find((f) => f.endsWith(".keymap"));
          if (entry) foundKeymap = path.join(configDir, entry);
        } catch { /* ignore */ }
      }

      if (foundKeymap) {
        check("Keymap file", "ok", foundKeymap);
      } else {
        check(
          "Keymap file",
          "warn",
          `No .keymap file found in ${configDir}. If you edited the keymap in the UI, use Export Setup (or reconnect the keyboard) so the .keymap is written to extension storage.`
        );
      }

      // 6. Conf file (warning only — ZMK can build without it)
      const shieldConf = shieldBase && path.join(configDir, `${shieldBase}.conf`);
      const hasConf = (shieldConf && fs.existsSync(shieldConf))
        || fs.readdirSync(configDir).some((f) => f.endsWith(".conf"));
      if (hasConf) {
        const confFile = (shieldConf && fs.existsSync(shieldConf))
          ? shieldConf
          : path.join(configDir, fs.readdirSync(configDir).find((f) => f.endsWith(".conf"))!);
        check("Config (.conf) file", "ok", confFile);
      } else {
        check("Config (.conf) file", "warn",
          "No .conf file found — ZMK will use firmware defaults for all config values");
      }
    }

    out.appendLine("");

    const hasErrors = checks.some((c) => c.status === "error");
    const hasWarnings = checks.some((c) => c.status === "warn");

    if (hasErrors) {
      out.appendLine("  Build blocked: fix the errors above, then Save to Flash again.");
      out.appendLine("");
      vscode.window.showErrorMessage(
        "Pre-flight checks failed. See ZMK Studio — Rebuild for details.",
        "Show Output"
      ).then((a) => { if (a === "Show Output") out.show(true); });
      return;
    }

    if (hasWarnings) {
      const proceed = await vscode.window.showWarningMessage(
        "Some pre-flight checks have warnings. Build anyway?",
        "Build Anyway",
        "Cancel"
      );
      if (proceed !== "Build Anyway") return;
    }

    out.appendLine("── Running build ─────────────────────────────────────────────");
    out.appendLine("");
    out.appendLine(`  cd "${westRoot}"`);
    out.appendLine(`  ${command}`);
    out.appendLine("");

    const terminal = vscode.window.createTerminal("ZMK Firmware Build");
    terminal.show();
    terminal.sendText(`cd "${westRoot}"`);
    // Ensure CMake can locate Zephyr via the same convention used by many Zephyr apps
    // (ZMK's CMakeLists typically uses $ENV{ZEPHYR_BASE} as a hint).
    if (process.platform === "win32") {
      terminal.sendText(`set ZEPHYR_BASE=${path.join(westRoot, "zephyr")}`);
    } else {
      terminal.sendText(`export ZEPHYR_BASE="${path.join(westRoot, "zephyr")}"`);
    }

    // `west zephyr-export` is safe and can help environments that rely on the exported CMake package.
    terminal.sendText("west zephyr-export");
    terminal.sendText(command);

    // After the terminal build completes, copy the .uf2 to keymaps/<device>/
    const uf2Source = path.join(westRoot, "build", "zephyr", "zmk.uf2");
    const deviceName = this._lastDeviceName ?? board ?? "keyboard";
    const keymapsDir = getKeyboardStorageDir(this.context, deviceName);
    const uf2Dest = path.join(keymapsDir, "zmk.uf2");
    const POLL_MS = 5_000;
    const TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
    let elapsed = 0;

    const poll = setInterval(() => {
      elapsed += POLL_MS;
      if (fs.existsSync(uf2Source)) {
        clearInterval(poll);
        try {
          fs.copyFileSync(uf2Source, uf2Dest);
          log(`Firmware copied to ${uf2Dest}`);
          vscode.window.showInformationMessage(
            `Firmware built and saved to extension storage (keymaps/${path.basename(keymapsDir)}/zmk.uf2)`,
            "Show in Finder"
          ).then((action) => {
            if (action === "Show in Finder") {
              vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(uf2Dest));
            }
          });
        } catch (err) {
          logError("Failed to copy firmware", err);
        }
      } else if (elapsed >= TIMEOUT_MS) {
        clearInterval(poll);
        log("Firmware poll timed out — build may have failed or taken too long");
      }
    }, POLL_MS);
  }

  /**
   * Returns a usable west workspace root (directory containing `.west/config`).
   *
   * Priority:
   * - Previously selected path (persisted in extension storage)
   * - Auto-detected from open VS Code workspace folders / linked config file
   * - Extension-managed workspace under globalStorage (if already initialized)
   * - Prompt: pick an existing workspace path OR set up the extension-managed one
   */
  private async resolveWestWorkspace(): Promise<string | undefined> {
    // 1) Use previously-selected workspace when it is still valid
    const saved = this.configStore.getWestWorkspacePath();
    if (saved && isWestWorkspaceReady(saved)) {
      log(`West workspace (saved): ${saved}`);
      return saved;
    }

    // 2) Auto-detect from likely roots (workspace folders, linked config)
    const detected = await this.autoDetectWestWorkspace();
    if (detected) {
      await this.configStore.setWestWorkspacePath(detected);
      log(`West workspace (auto-detected): ${detected}`);
      return detected;
    }

    // 3) Fall back to extension-managed workspace when it is already initialized
    const extensionWestRoot = getWestWorkspacePath(this.context);
    if (isWestWorkspaceReady(extensionWestRoot)) {
      log(`West workspace (extension globalStorage): ${extensionWestRoot}`);
      return extensionWestRoot;
    }

    // 4) No usable workspace found — prompt for what to do next
    return this.promptForWestWorkspace(extensionWestRoot);
  }

  /** Best-effort detection of an existing west workspace from common roots. */
  private async autoDetectWestWorkspace(): Promise<string | undefined> {
    const roots: string[] = [];

    for (const f of vscode.workspace.workspaceFolders ?? []) {
      roots.push(f.uri.fsPath);
    }

    const linkedConf = this.configStore.getFilePath();
    if (linkedConf) roots.push(path.dirname(linkedConf));

    // If we have a keyboard storage dir already, also treat it as a weak signal root.
    roots.push(getKeyboardStorageDir(this.context, this.getCurrentDeviceName()));

    for (const root of roots) {
      try {
        const westRoot = await walkUpForWest(root);
        if (westRoot) return westRoot;
      } catch {
        // ignore
      }
    }

    return undefined;
  }

  /** Returns the path to the `west` executable, or undefined if not found. */
  private async westPath(): Promise<string | undefined> {
    const tool = process.platform === "win32" ? "where" : "which";
    const res = await execFileNoThrow(tool, ["west"]);
    const found = res.ok ? res.stdout.trim().split(/\r?\n/)[0] : "";
    return found || undefined;
  }

  /**
   * Returns a set of known Zephyr board names by invoking `west boards`.
   * Best-effort; returns undefined if west is unavailable or parsing fails.
   */
  private async listKnownBoards(westRoot: string): Promise<Set<string> | undefined> {
    const west = await this.westPath();
    if (!west) return undefined;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ZEPHYR_BASE: path.join(westRoot, "zephyr"),
    };

    const res = await execFileNoThrow(west, ["boards"], { cwd: westRoot, env });
    // `west boards` often exits non-zero when stdout is piped and the reader closes early.
    // We still treat any captured stdout as usable.
    const stdout = res.stdout.trim();
    if (!stdout) return undefined;

    const boards = new Set<string>();
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      // Typical format: "<name> <arch> <vendor> ..." (headers may exist)
      if (line.toLowerCase().startsWith("name")) continue;
      if (line.startsWith("-")) continue;
      const m = line.match(/^([A-Za-z0-9_]+)(\s+|$)/);
      if (m) boards.add(m[1]);
    }
    return boards.size > 0 ? boards : undefined;
  }

  /** Prompt until board is valid (when we can validate), or user cancels. */
  private async ensureValidBoard(
    westRoot: string,
    initialBoard: string | undefined
  ): Promise<string | undefined> {
    let board = initialBoard?.trim() || undefined;
    const known = await this.listKnownBoards(westRoot);

    // If we can't validate, just return what we have (or undefined).
    if (!known) return board;

    while (board && !known.has(board)) {
      const suggested = known.has("nice_nano_v2") ? "nice_nano_v2" : (known.has("nice_nano") ? "nice_nano" : undefined);
      const enteredBoard = await vscode.window.showInputBox({
        title: "ZMK Board Identifier",
        prompt: `Board "${board}" was not found in this west workspace. Enter a valid board id (e.g. nice_nano_v2, xiao_ble).`,
        value: suggested ?? board,
        ignoreFocusOut: true,
      });
      if (enteredBoard === undefined) return undefined;
      board = enteredBoard.trim() || undefined;
    }

    return board;
  }

  /**
   * Ensure a local Zephyr module exists under extension storage containing a custom shield.
   * This lets users build custom keyboards without needing to patch the ZMK checkout.
   *
   * ── What this scaffolding does ──────────────────────────────────────────────
   * - Writes a minimal Zephyr "module" folder into extension globalStorage.
   * - The module contains a `boards/shields/<shield>/` shield definition that
   *   ZMK can discover when we pass `-DZMK_EXTRA_MODULES=<moduleDir>` to `west build`.
   *
   * ── Where it lives ──────────────────────────────────────────────────────────
   *   <globalStorage>/keyboard-modules/<shield>/
   *     zephyr/module.yml
   *     boards/shields/<shield>/{Kconfig.shield,Kconfig.defconfig,<shield>.overlay}
   *
   * ── Important limitations ──────────────────────────────────────────────────
   * - This is NOT a replacement for vendor-published hardware definitions.
   * - The generated `.overlay` contains placeholder GPIOs and WILL NOT produce a
   *   working keyboard firmware until the real matrix wiring is filled in.
   * - We only create missing files; we never overwrite user edits.
   */
  private ensureShieldModule(shieldId: string): string | undefined {
    const safeShield = shieldId.trim().split(/\s+/)[0];
    if (!safeShield) return undefined;

    const root = this.context.globalStorageUri.fsPath;
    const moduleDir = path.join(root, "keyboard-modules", safeShield);
    const moduleYml = path.join(moduleDir, "zephyr", "module.yml");
    const shieldDir = path.join(moduleDir, "boards", "shields", safeShield);

    try {
      fs.mkdirSync(path.dirname(moduleYml), { recursive: true });
      fs.mkdirSync(shieldDir, { recursive: true });

      if (!fs.existsSync(moduleYml)) {
        fs.writeFileSync(
          moduleYml,
          [
            "name: zmk-studio-local",
            "build:",
            "  cmake: .",
            "",
          ].join("\n"),
          "utf-8"
        );
      }

      const kconfigShield = path.join(shieldDir, "Kconfig.shield");
      if (!fs.existsSync(kconfigShield)) {
        fs.writeFileSync(
          kconfigShield,
          [
            `config SHIELD_${safeShield.toUpperCase()}`,
            `  def_bool $(shields_list_contains,${safeShield})`,
            "",
          ].join("\n"),
          "utf-8"
        );
      }

      const kconfigDefconfig = path.join(shieldDir, "Kconfig.defconfig");
      if (!fs.existsSync(kconfigDefconfig)) {
        fs.writeFileSync(
          kconfigDefconfig,
          [
            `if SHIELD_${safeShield.toUpperCase()}`,
            "",
            "config ZMK_KEYBOARD_NAME",
            `  default "${safeShield}"`,
            "",
            "endif",
            "",
          ].join("\n"),
          "utf-8"
        );
      }

      const overlay = path.join(shieldDir, `${safeShield}.overlay`);
      if (!fs.existsSync(overlay)) {
        fs.writeFileSync(
          overlay,
          [
            "/ {",
            "  chosen {",
            "    zmk,kscan = &kscan0;",
            "  };",
            "",
            "  kscan0: kscan_0 {",
            '    compatible = "zmk,kscan-gpio-matrix";',
            '    diode-direction = "col2row";',
            "    // TODO: Replace these placeholder GPIOs with your keyboard's real matrix wiring.",
            "    // Example: row-gpios = <&gpio0 0 GPIO_ACTIVE_HIGH>, <&gpio0 1 GPIO_ACTIVE_HIGH>;",
            "    //          col-gpios = <&gpio0 2 GPIO_ACTIVE_HIGH>, <&gpio0 3 GPIO_ACTIVE_HIGH>;",
            "    row-gpios = <&gpio0 0 GPIO_ACTIVE_HIGH>;",
            "    col-gpios = <&gpio0 1 GPIO_ACTIVE_HIGH>;",
            "  };",
            "};",
            "",
          ].join("\n"),
          "utf-8"
        );
      }

      const cmakeLists = path.join(moduleDir, "CMakeLists.txt");
      if (!fs.existsSync(cmakeLists)) {
        fs.writeFileSync(
          cmakeLists,
          ["# Intentionally empty: shield definition lives under boards/shields/." , ""].join("\n"),
          "utf-8"
        );
      }

      return moduleDir;
    } catch (err) {
      logError("Failed to ensure shield module", err);
      return undefined;
    }
  }

  /**
   * Prompts to pick an existing west workspace, or initialize the extension-managed one.
   * @param extensionWestRoot Fixed extension globalStorage west workspace path.
   */
  private async promptForWestWorkspace(westRoot: string): Promise<string | undefined> {
    const westAvailable = !!(await this.westPath());

    if (!westAvailable) {
      vscode.window.showErrorMessage(
        "west is not in PATH. Install west (https://docs.zephyrproject.org/latest/develop/west/install.html), then run Build Firmware again."
      );
      return undefined;
    }

    const choice = await vscode.window.showInformationMessage(
      "No west workspace was found automatically. Choose a workspace to build from.",
      "Select workspace folder…",
      "Set up workspace in extension storage (~2 GB)",
      "Cancel"
    );
    if (!choice || choice === "Cancel") return undefined;

    if (choice === "Select workspace folder…") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Select your west workspace root (must contain .west/config)",
        openLabel: "Use this workspace",
      });
      if (!picked || picked.length === 0) return undefined;

      const selected = picked[0].fsPath;
      const resolved = await walkUpForWest(selected);
      if (!resolved) {
        vscode.window.showErrorMessage(
          `That folder is not inside a west workspace (missing .west/config):\n${selected}`
        );
        return undefined;
      }

      await this.configStore.setWestWorkspacePath(resolved);
      return resolved;
    }

    // Set up extension-managed workspace
    this.runWestInitInTerminal(westRoot);
    vscode.window.showInformationMessage(
      `Setting up ZMK workspace in extension storage. Build Firmware again once the terminal finishes.\n${westRoot}`
    );
    return undefined;
  }

  /** Opens a terminal and runs west init + west update for the given target directory. */
  private async runWestInitInTerminal(targetDir: string, options?: { wipeTargetDir?: boolean }): Promise<void> {
    const linkedConf = this.configStore.getFilePath();
    // If the user linked a `.conf` from a real ZMK config repo, it usually lives under
    // `<repo>/config/<shield>.conf`, and the west manifest is `<repo>/config/west.yml`.
    // If the `.conf` is the extension-owned one (under `<globalStorage>/keymaps/...`),
    // there will be no `west.yml` and we must not use `west init -l`.
    const manifestDir = linkedConf ? path.dirname(linkedConf) : undefined;
    const hasLocalManifest = !!manifestDir && fs.existsSync(path.join(manifestDir, "west.yml"));

    const terminal = vscode.window.createTerminal("ZMK Workspace Setup");
    terminal.show();

    const validWorkspace = await walkUpForWest(targetDir);
    const brokenWest = !validWorkspace && fs.existsSync(path.join(targetDir, ".west"));

    if (validWorkspace) {
      terminal.sendText(`cd "${targetDir}" && west update`);
    } else {
      if (options?.wipeTargetDir) {
        // For the extension-managed workspace, "re-initialize" should start from a clean directory.
        terminal.sendText(`rm -rf "${targetDir}" && mkdir -p "${targetDir}"`);
      }
      if (brokenWest) {
        terminal.sendText(`rm -rf "${path.join(targetDir, ".west")}"`);
      }
      if (hasLocalManifest && manifestDir) {
        // `west init -l` takes a single positional argument: the local manifest repo directory.
        // The workspace dir is implied by CWD, so cd first.
        terminal.sendText(`cd "${targetDir}" && west init -l "${manifestDir}" && west update`);
      } else {
        terminal.sendText(`west init -m https://github.com/zmkfirmware/zmk --mr main --mf app/west.yml "${targetDir}" && cd "${targetDir}" && west update`);
      }
    }
  }

  /**
   * Build firmware now — available from the command palette at any time.
   * Resolves the west workspace, loads board/shield config, runs pre-flight checks,
   * then opens a build terminal.
   */
  public async triggerBuildFirmware(): Promise<void> {
    const westRoot = await this.resolveWestWorkspace();
    if (!westRoot) return; // user cancelled or init in progress

    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const detected = await loadLocalConfig(westRoot, workspacePaths);
    const { board, shield } = await this.resolveBoardShield(detected?.board, detected?.shield);
    if (board === undefined) return; // user cancelled board prompt

    const validBoard = await this.ensureValidBoard(westRoot, board);
    if (validBoard === undefined) return; // user cancelled
    if (validBoard !== board) {
      await this.configStore.setBoard(validBoard);
    }

    const deviceName = this.getCurrentDeviceName();
    try {
      await this.ensureKeymapForBuild(deviceName);
    } catch (err) {
      logError("ensureKeymapForBuild threw", err);
    }
    let configDir = this.configDirForDevice(deviceName);
    if (!configDir && detected?.keymapPath) {
      configDir = path.dirname(detected.keymapPath);
    }

    const shieldBase = shield?.trim().split(/\s+/)[0];
    const moduleDir = shieldBase ? this.ensureShieldModule(shieldBase) : undefined;
    const command = buildWestCommand(validBoard, shield, configDir, {
      pristine: true,
      extraModules: moduleDir ? [moduleDir] : undefined,
    });

    if (!this._rebuildOutput) {
      this._rebuildOutput = vscode.window.createOutputChannel("ZMK Studio — Rebuild");
    }

    await this.buildFirmware(westRoot, command, validBoard, shield, configDir);
  }

  /** Clears stored board/shield so the next build will prompt again. */
  public async clearCachedBoard(): Promise<void> {
    await this.configStore.clearBoardShield();
    vscode.window.showInformationMessage("Stored board/shield cleared. You will be prompted on the next build.");
  }

  /** Re-sync or re-initialize the extension globalStorage west workspace. */
  public async setWestWorkspace(): Promise<void> {
    const westRoot = getWestWorkspacePath(this.context);
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(sync) Run west update",
          description: "Refresh ZMK/Zephyr in extension storage (keeps existing checkout)",
          value: "update" as const,
        },
        {
          label: "$(trash) Re-initialize workspace",
          description: "Delete .west and run west init again (~2 GB download)",
          value: "reset" as const,
        },
      ],
      { placeHolder: "Manage extension west workspace" }
    );
    if (!choice) return;

    if (choice.value === "reset") {
      const confirm = await vscode.window.showWarningMessage(
        "Re-initialize the extension west workspace? This removes the current checkout under extension storage.",
        { modal: true },
        "Re-initialize"
      );
      if (confirm !== "Re-initialize") return;
      // Ensure we start from a clean workspace directory; west init will fail if repos already exist.
      try {
        if (fs.existsSync(westRoot)) {
          fs.rmSync(westRoot, { recursive: true, force: true });
        }
        fs.mkdirSync(westRoot, { recursive: true });
      } catch (err) {
        logError("Failed to reset extension west workspace directory", err);
      }
    }

    this.runWestInitInTerminal(westRoot, { wipeTargetDir: choice.value === "reset" });
    vscode.window.showInformationMessage(
      choice.value === "update"
        ? `Running west update in extension storage:\n${westRoot}`
        : `Re-initializing west workspace in extension storage:\n${westRoot}`
    );
  }

  /**
   * Board/shield from west manifest, then zmk-config.json, then user prompt.
   * Persists choices in extension globalStorage for idempotent rebuilds.
   */
  private async resolveBoardShield(
    manifestBoard?: string,
    manifestShield?: string
  ): Promise<{ board: string | undefined; shield: string | undefined }> {
    let board = manifestBoard ?? this.configStore.getBoard();
    let shield = manifestShield ?? this.configStore.getShield();

    if (manifestBoard && manifestBoard !== this.configStore.getBoard()) {
      await this.configStore.setBoard(manifestBoard);
      board = manifestBoard;
    }
    if (manifestShield && manifestShield !== this.configStore.getShield()) {
      await this.configStore.setShield(manifestShield);
      shield = manifestShield;
    }

    if (!board) {
      const enteredBoard = await vscode.window.showInputBox({
        title: "ZMK Board Identifier",
        prompt: "Enter the Zephyr board identifier for your keyboard (e.g. nice_nano_v2, seeeduino_xiao_ble)",
        value: this.configStore.getBoard() ?? "",
        placeHolder: "nice_nano_v2",
        ignoreFocusOut: true,
      });
      if (enteredBoard === undefined) return { board: undefined, shield: undefined };
      board = enteredBoard.trim() || undefined;
      if (board) await this.configStore.setBoard(board);
    }

    if (!shield) {
      const enteredShield = await vscode.window.showInputBox({
        title: "ZMK Shield (optional)",
        prompt: "Enter the shield name if your keyboard uses one (leave blank for integrated boards)",
        value: this.configStore.getShield() ?? "",
        placeHolder: "corne_left corne_right",
        ignoreFocusOut: true,
      });
      if (enteredShield === undefined) return { board, shield: undefined };
      shield = enteredShield.trim() || undefined;
      await this.configStore.setShield(shield);
    }

    return { board, shield };
  }

  /** Default directory for file open/save dialogs (keyboard folder in extension storage). */
  public async getDefaultDir(): Promise<vscode.Uri> {
    return vscode.Uri.file(
      getKeyboardStorageDir(this.context, this.getCurrentDeviceName())
    );
  }

  /** Export config to the current keyboard's `.conf` in extension storage. */
  async exportConfigAuto(): Promise<void> {
    const deviceName = this.getCurrentDeviceName();
    const confPath = await this.ensureKeyboardConfig(deviceName);
    await this.configStore.exportToFile(confPath);
    const folder = sanitizeKeyboardName(deviceName);
    vscode.window.showInformationMessage(
      `Config saved to extension storage (keymaps/${folder}/${path.basename(confPath)})`
    );
  }

  /** Push the current config store snapshot to the webview. */
  pushConfigSnapshot(): void {
    this.view?.webview.postMessage({
      type: "configSnapshot",
      values: this.configStore.getAll(),
      hasFile: !!this.configStore.getFilePath(),
    });
  }

  async connectViaUSB(portPath?: string): Promise<void> {
    if (!await this.ensureViewReady()) return;

    // If no port given, let user pick from detected devices
    if (!portPath) {
      const ports = await listZMKSerialPorts();
      if (ports.length === 0) {
        vscode.window.showErrorMessage(
          "No ZMK keyboards detected. Make sure your keyboard is plugged in via USB."
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        ports.map((p) => ({
          label: p.path,
          description: [p.manufacturer, p.serialNumber]
            .filter(Boolean)
            .join(" · "),
        })),
        { placeHolder: "Select your ZMK keyboard" }
      );
      if (!picked) return;
      portPath = picked.label;
    }

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to ZMK keyboard…" },
      async () => {
        try {
          log(`Connecting to serial port: ${portPath}`);
          const transport = await connectSerial(portPath!);
          await this.onDeviceConnected(transport.label);
          await this.bridge!.attach(transport, transport.label);
        } catch (err: unknown) {
          logError("USB connection failed", err);
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to connect: ${message}`);
        }
      }
    );
  }

  async connectViaBLE(): Promise<void> {
    if (!await this.ensureViewReady()) return;

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to ZMK keyboard via Bluetooth…", cancellable: false },
      async () => {
        try {
          log("[CB] Starting CoreBluetooth connection");
          const transport = await connectCoreBluetooth(async (devices) => {
            const picked = await vscode.window.showQuickPick(
              devices.map((d) => ({ label: d.name, description: d.id, id: d.id })),
              { placeHolder: "Select your ZMK keyboard (BLE)" }
            );
            if (!picked) throw new Error("cancelled");
            return picked.id;
          });
          log(`[CB] Connected: ${transport.label}`);
          await this.onDeviceConnected(transport.label);
          await this.bridge!.attach(transport, transport.label);
        } catch (err: unknown) {
          logError("[CB] Connection failed", err);
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("cancelled")) {
            this.view?.webview.postMessage({ type: "error", message: `BLE: ${message}` });
          }
        }
      }
    );
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';" />
  <title>ZMK Studio</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
