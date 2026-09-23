import { execFile } from "node:child_process";
import { GOAL_STATUS_OUTPUT_TAIL } from "../shared/goal-status";

/**
 * The objective half of "is the goal met".
 *
 * A verification command is the only completion signal this plugin cannot be
 * talked out of: exit 0 is exit 0. It runs unsandboxed with the daemon user's
 * access, which is why it is opt-in per agent and why the README says so plainly.
 */

export const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_MAX_BUFFER = 1024 * 1024;

export interface VerifyResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout and stderr, tail-truncated to the status row's budget. */
  output: string;
}

/** Everything after the trailing newline noise, capped for the status row. */
export function tailOf(text: string, limit: number = GOAL_STATUS_OUTPUT_TAIL): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `…${trimmed.slice(trimmed.length - limit)}`;
}

interface Shell {
  file: string;
  flag: string;
}

function shellFor(platform: NodeJS.Platform): Shell {
  if (platform === "win32") {
    return { file: "cmd.exe", flag: "/c" };
  }
  return { file: "/bin/sh", flag: "-c" };
}

export function runVerify(
  command: string,
  cwd: string,
  options: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<VerifyResult> {
  const timeout = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const shell = shellFor(options.platform ?? process.platform);

  return new Promise<VerifyResult>((resolve) => {
    execFile(
      shell.file,
      [shell.flag, command],
      { cwd, timeout, maxBuffer: VERIFY_MAX_BUFFER, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n");
        let exitCode: number | null = 0;
        if (typeof error?.code === "number") {
          exitCode = error.code;
        } else if (error) {
          exitCode = null;
        }

        resolve({
          passed: error === null,
          exitCode,
          timedOut: error?.signal === "SIGKILL",
          output: tailOf(combined),
        });
      },
    );
  });
}
