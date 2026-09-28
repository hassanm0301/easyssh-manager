import { describe, expect, it } from 'vitest';

import { DisposableStore } from '../../common/disposables';

describe('DisposableStore', () => {
  it('disposes once in reverse order and continues after a failure', async () => {
    const calls: string[] = [];
    const store = new DisposableStore();
    store.add({
      dispose: () => {
        calls.push('first');
      },
    });
    store.add({
      dispose: () => {
        calls.push('second');
        throw new Error('failure');
      },
    });
    store.add({
      dispose: () => {
        calls.push('third');
      },
    });
    await expect(store.dispose()).rejects.toThrow(AggregateError);
    await store.dispose();
    expect(calls).toEqual(['third', 'second', 'first']);
  });
});
