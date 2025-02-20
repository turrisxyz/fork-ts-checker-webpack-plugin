type Task<T> = () => Promise<T>;

interface Pool {
  submit<T>(task: Task<T>): Promise<T>;
  size: number;
  readonly pending: number;
  readonly drained: Promise<void>;
}

function createPool(size: number): Pool {
  let pendingPromises: Promise<unknown>[] = [];

  const pool = {
    async submit<T>(task: Task<T>): Promise<T> {
      while (pendingPromises.length >= pool.size) {
        await Promise.race(pendingPromises).catch(() => undefined);
      }

      const taskPromise = task().finally(() => {
        pendingPromises = pendingPromises.filter(
          (pendingPromise) => pendingPromise !== taskPromise
        );
      });
      pendingPromises.push(taskPromise);

      return taskPromise;
    },
    size,
    get pending() {
      return pendingPromises.length;
    },
    get drained() {
      // eslint-disable-next-line no-async-promise-executor
      return new Promise<void>(async (resolve) => {
        while (pendingPromises.length > 0) {
          await Promise.race(pendingPromises).catch(() => undefined);
        }
        resolve(undefined);
      });
    },
  };

  return pool;
}

export { Pool, createPool };
