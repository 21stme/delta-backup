// A bounded pool drains each batch before retries begin. A failed worker stops
// new jobs; all running jobs settle before the caller handles the failure.
export async function runBatch(entries, concurrency, work, control = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('Число одновременных страниц должно быть от 1 до 10.');
  let cursor = 0;
  let failed = false;
  let firstError;
  const stopped = () => failed || Boolean(control.paused?.());
  const worker = async () => {
    while (!stopped() && cursor < entries.length) {
      const entry = entries[cursor++];
      try { await work(entry, stopped); }
      catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  if (failed) throw firstError;
}

export function createRunWriter(save, getRun) {
  let tail = Promise.resolve();
  return (capture, mutate = () => {}) => {
    const write = tail.then(async () => {
      mutate();
      const run = getRun(); run.updatedAt = new Date().toISOString();
      await save(run, capture);
    });
    tail = write;
    return write;
  };
}
