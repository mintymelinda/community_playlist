export class SerialExecutor {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => {});
    return next;
  }
}
