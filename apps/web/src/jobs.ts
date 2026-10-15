/**
 * In-process background job runner (MVP). Jobs are lost if the process restarts; the
 * onboarding page shows "interrupted" runs so an operator can retry. Phase 4 replaces this
 * with pg-boss (durable, retries, cron) behind the same `enqueue` interface.
 */
export interface JobRunner {
  enqueue(name: string, fn: () => Promise<void>): void;
  idle(): Promise<void>;
}

export class InProcessJobs implements JobRunner {
  #running = 0;
  #queue: Array<{ name: string; fn: () => Promise<void> }> = [];
  #idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency = 2,
    private readonly onError: (name: string, err: unknown) => void = (name, err) => console.error(`[job ${name}]`, err),
  ) {}

  static readonly MAX_QUEUE = 100;

  /** Throws if the queue is full (callers turn this into a "try again later" message). */
  enqueue(name: string, fn: () => Promise<void>): void {
    if (this.#queue.length >= InProcessJobs.MAX_QUEUE) throw new Error("Job queue is full");
    this.#queue.push({ name, fn });
    this.#pump();
  }

  #pump(): void {
    while (this.#running < this.concurrency && this.#queue.length) {
      const job = this.#queue.shift()!;
      this.#running++;
      job
        .fn()
        .catch((err) => this.onError(job.name, err))
        .finally(() => {
          this.#running--;
          this.#pump();
          if (this.#running === 0 && this.#queue.length === 0) for (const w of this.#idleWaiters.splice(0)) w();
        });
    }
  }

  idle(): Promise<void> {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.#idleWaiters.push(r));
  }
}
