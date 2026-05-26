import { execFile } from "child_process";

export type ExecFileNoThrowResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
};

/**
 * Execute a command without going through a shell.
 * Returns captured stdout/stderr and exitCode, never throws.
 */
export function execFileNoThrow(
  file: string,
  args: readonly string[] = [],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<ExecFileNoThrowResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options?.cwd,
        env: options?.env,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const anyErr = error as any;
        const exitCode: number | null =
          typeof anyErr?.code === "number" ? anyErr.code : 0;

        resolve({
          ok: !error && exitCode === 0,
          exitCode,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error ?? undefined,
        });
      }
    );
  });
}

