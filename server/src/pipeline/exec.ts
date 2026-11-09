import { execFile } from "node:child_process";

export interface RunOptions {
  signal?: AbortSignal;
  /** Kills the process after this long. */
  timeoutMs?: number;
}

export class CommandError extends Error {
  constructor(
    public cmd: string,
    public code: number | string | null,
    public stderr: string,
  ) {
    super(`${cmd} exited with ${code}: ${stderr.trim().slice(-800)}`);
    this.name = "CommandError";
  }
}

/** Runs a command to completion and returns its output. Rejects with CommandError on a non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, signal: opts.signal, timeout: opts.timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "ENOENT") return reject(new CommandError(cmd, "ENOENT", `${cmd} is not installed or not on PATH`));
          if (opts.signal?.aborted) return reject(opts.signal.reason ?? err);
          return reject(new CommandError(cmd, (e.code as number | string | undefined) ?? null, String(stderr)));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
