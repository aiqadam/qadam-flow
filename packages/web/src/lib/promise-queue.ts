import { Mutex } from 'async-mutex';

export class PromiseQueue {
  private queue: (() => Promise<unknown>)[] = [];
  private lock: Mutex = new Mutex();

  add(promise: () => Promise<unknown>) {
    this.queue.push(promise);
    this.run();
  }

  size() {
    return this.queue.length;
  }

  private run() {
    this.lock.runExclusive(async () => {
      const promise = this.queue.shift()!;
      await promise();
    });
  }
}
