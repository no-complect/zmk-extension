/**
 * Helpers for ZMK `west build` command construction.
 */

function quoteShellArg(value: string): string {
  // Best-effort quoting for typical shells (bash/zsh). This is primarily to
  // handle paths with spaces (macOS/Linux) and multi-value defines like SHIELD.
  if (!/[\s"]/g.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Assembles the `west build` command used by pre-flight and rebuild flows. */
export function buildWestCommand(
  board: string | undefined,
  shield: string | undefined,
  configDir: string | undefined,
  options?: {
    pristine?: boolean;
    extraModules?: string[];
  }
): string {
  const parts: string[] = ["west build"];
  if (options?.pristine) parts.push("-p always");
  if (board) parts.push(`-b ${board}`);
  parts.push("zmk/app");
  const cmakeArgs: string[] = [];
  if (shield) cmakeArgs.push(`-DSHIELD=${quoteShellArg(shield)}`);
  if (configDir) cmakeArgs.push(`-DZMK_CONFIG=${quoteShellArg(configDir)}`);
  if (options?.extraModules?.length) {
    cmakeArgs.push(`-DZMK_EXTRA_MODULES=${quoteShellArg(options.extraModules.join(";"))}`);
  }
  if (cmakeArgs.length > 0) parts.push("--", ...cmakeArgs);
  return parts.join(" ");
}
