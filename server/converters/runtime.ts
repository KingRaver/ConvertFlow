import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegStatic from "ffmpeg-static";
import { ConversionError, ConversionTimeoutError, MissingToolError } from "./index";

export const CONVERTER_TIMEOUT_MS = 60_000;

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  label?: string;
  stdin?: Buffer;
  timeoutMs?: number;
}

// Note: withTimeout rejects on deadline but cannot cancel the underlying work() promise.
// For subprocess-based converters (runCommand) the process is killed via SIGTERM/SIGKILL.
// For pure-JS operations (pdfkit, docx packing) the work continues in the background
// after timeout — file handles and memory are held until it naturally completes or errors.
export async function withTimeout<T>(
  work: () => Promise<T>,
  label: string,
  timeoutMs = CONVERTER_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new ConversionTimeoutError(`${label} timed out after ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);

    timer.unref?.();

    void work()
      .then((value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runCommand(
  command: string,
  args: string[],
  { cwd, env, label, stdin, timeoutMs = CONVERTER_TIMEOUT_MS }: CommandOptions = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: "pipe",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
      hardKillTimer.unref?.();
    }, timeoutMs);

    timeout.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      cleanup();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new MissingToolError(
            `Required tool "${command}" is not available. ${label ?? "The conversion runtime"} could not start.`,
            { cause: error },
          ),
        );
        return;
      }

      reject(
        new ConversionError(
          `${label ?? command} failed to start: ${(error as Error).message}.`,
          "conversion_failed",
          { cause: error },
        ),
      );
    });

    child.on("close", (code) => {
      cleanup();
      if (timedOut) {
        reject(
          new ConversionTimeoutError(
            `${label ?? command} timed out after ${timeoutMs / 1000} seconds.`,
          ),
        );
        return;
      }

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new ConversionError(
            stderr || `${label ?? command} exited with code ${code ?? "unknown"}.`,
            "conversion_failed",
          ),
        );
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    if (stdin && child.stdin) {
      child.stdin.end(stdin);
      return;
    }

    child.stdin?.end();
  });
}

export function resolveFfmpegBinary() {
  if (typeof ffmpegStatic === "string" && existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }

  return "ffmpeg";
}

export function resolveTextutilBinary() {
  return process.platform === "darwin" ? "/usr/bin/textutil" : "textutil";
}
