export interface AsyncDisposable {
  dispose(): void | Promise<void>;
}

/** Owns resources and always releases them once, last acquired first. */
export class DisposableStore implements AsyncDisposable {
  private readonly values: AsyncDisposable[] = [];
  private disposed = false;

  add<T extends AsyncDisposable>(value: T): T {
    if (this.disposed) {
      void Promise.resolve(value.dispose()).catch(() => undefined);
      return value;
    }
    this.values.push(value);
    return value;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const failures: unknown[] = [];
    for (const value of this.values.splice(0).reverse()) {
      try {
        await value.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more EasySSH resources failed to dispose');
    }
  }
}
