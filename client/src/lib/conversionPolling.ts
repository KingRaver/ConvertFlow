export interface ConversionPollStatus {
  status: "pending" | "processing" | "completed" | "failed";
  convertedSize?: number | null;
  outputFilename?: string | null;
  resultMessage?: string | null;
  expiresAt?: string | null;
}

export class ConversionTimeoutError extends Error {
  constructor(message = "Conversion timed out.") {
    super(message);
    this.name = "ConversionTimeoutError";
  }
}

export class ConversionConnectionError extends Error {
  constructor(message = "Connection error.") {
    super(message);
    this.name = "ConversionConnectionError";
  }
}

export class ConversionAbortedError extends Error {
  constructor(message = "Conversion was cancelled.") {
    super(message);
    this.name = "ConversionAbortedError";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
    };

    const abortHandler = () => {
      cleanup();
      reject(new ConversionAbortedError());
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

interface PollOptions {
  id: number;
  checkStatus: (id: number) => Promise<ConversionPollStatus>;
  maxAttempts?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, status: ConversionPollStatus) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function pollConversionUntilSettled({
  id,
  checkStatus,
  maxAttempts = 300,
  intervalMs = 1000,
  signal,
  onProgress,
  sleep = defaultSleep,
}: PollOptions): Promise<ConversionPollStatus> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new ConversionAbortedError();
    }

    let status: ConversionPollStatus;
    try {
      status = await checkStatus(id);
    } catch {
      throw new ConversionConnectionError();
    }

    if (status.status === "completed") {
      return status;
    }

    if (status.status === "failed") {
      throw new Error(status.resultMessage || "Conversion failed.");
    }

    onProgress?.(Math.min(90, 50 + attempt * 3), status);

    if (attempt === maxAttempts) {
      throw new ConversionTimeoutError();
    }

    await sleep(intervalMs, signal);
  }

  throw new ConversionTimeoutError();
}
