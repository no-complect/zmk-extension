import type * as vscode from "vscode";
import type { ZmkConfigStore } from "./ZmkConfigStore";
import { log } from "./logger";

const LEGACY_WEST_KEY = "zmkWestWorkspacePath";
const LEGACY_BOARD_KEY = "zmkCachedBoard";
const LEGACY_SHIELD_KEY = "zmkCachedShield";

/**
 * One-time migration from older releases that stored paths in globalState
 * or board/shield only in ad-hoc zmk-config.json fields.
 */
export async function migrateLegacyStorage(
  context: vscode.ExtensionContext,
  configStore: ZmkConfigStore
): Promise<void> {
  const legacyBoard = context.globalState.get<string>(LEGACY_BOARD_KEY);
  const legacyShield = context.globalState.get<string>(LEGACY_SHIELD_KEY);
  if (legacyBoard && !configStore.getBoard()) {
    await configStore.setBoard(legacyBoard);
    log(`Migrated cached board from globalState: ${legacyBoard}`);
  }
  if (legacyShield && !configStore.getShield()) {
    await configStore.setShield(legacyShield);
    log(`Migrated cached shield from globalState: ${legacyShield}`);
  }

  const legacyWest = context.globalState.get<string>(LEGACY_WEST_KEY);
  if (legacyWest) {
    log(`Ignoring legacy west workspace path (now uses extension globalStorage): ${legacyWest}`);
  }

  await context.globalState.update(LEGACY_WEST_KEY, undefined);
  await context.globalState.update(LEGACY_BOARD_KEY, undefined);
  await context.globalState.update(LEGACY_SHIELD_KEY, undefined);
}
