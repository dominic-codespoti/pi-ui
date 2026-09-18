import { describe, expect, it } from 'vitest';
import { ResidentStore, type ResidentEntry } from '../resident-sessions';

type TestEntry = ResidentEntry & {
  running: boolean;
  busy: boolean;
};

function entry(id: string, path: string | null = `/${id}`, historyBytes = 0): TestEntry {
  return { id, path, generation: 0, historyBytes, running: false, busy: false };
}

describe('ResidentStore', () => {
  it('indexes stable ids and paths and preserves the first duplicate', () => {
    const store = new ResidentStore<TestEntry>();
    const first = entry('one', '/same');
    const duplicatePath = entry('two', '/same');
    const duplicateId = entry('one', '/other');

    expect(store.register(first)).toBe(first);
    expect(store.register(duplicatePath)).toBe(first);
    expect(store.register(duplicateId)).toBe(first);
    expect(store.get('one')).toBe(first);
    expect(store.getByPath('/same')).toBe(first);
    expect(store.getByPath('/other')).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('tracks history bytes and invalidates captured generations', () => {
    const store = new ResidentStore<TestEntry>();
    const first = entry('one', '/one', 12);
    const second = entry('two', null, 8);
    store.register(first);
    store.register(second);

    expect(store.totalHistoryBytes()).toBe(20);
    expect(store.setHistoryBytes(first, 30)).toBe(true);
    expect(store.totalHistoryBytes()).toBe(38);

    const generation = first.generation;
    expect(store.isCurrent(first, generation)).toBe(true);
    expect(store.bumpGeneration(first)).toBe(generation + 1);
    expect(store.isCurrent(first, generation)).toBe(false);
    expect(store.isCurrent(first, generation + 1)).toBe(true);

    store.remove(first);
    expect(store.isCurrent(first, generation + 1)).toBe(false);
    expect(store.totalHistoryBytes()).toBe(8);
  });

  it('keeps activation pins refcounted across overlapping activations', async () => {
    const store = new ResidentStore<TestEntry>({ pinPredicate: (item) => item.busy });
    const first = entry('one');
    store.register(first);

    store.pinActivation(first.id);
    store.pinActivation(first.id);
    expect(store.activationPinCount(first.id)).toBe(2);
    expect(store.isPinned(first)).toBe(true);

    store.releaseActivationPin(first.id);
    expect(store.activationPinCount(first.id)).toBe(1);
    store.releaseActivationPin(first.id);
    expect(store.activationPinCount(first.id)).toBe(0);
    expect(store.isPinned(first)).toBe(false);

    first.busy = true;
    await store.withActivationPin(first.id, async () => {
      expect(store.activationPinCount(first.id)).toBe(1);
      expect(store.isPinned(first)).toBe(true);
    });
    expect(store.activationPinCount(first.id)).toBe(0);
  });

  it('recovers global and per-session promise locks after rejection', async () => {
    const store = new ResidentStore<TestEntry>();
    const order: string[] = [];

    await expect(
      store.withGlobalLock(async () => {
        order.push('global-failed');
        throw new Error('global failure');
      })
    ).rejects.toThrow('global failure');
    await store.withGlobalLock(async () => {
      order.push('global-recovered');
    });

    await expect(
      store.withSessionLock('one', async () => {
        order.push('session-failed');
        throw new Error('session failure');
      })
    ).rejects.toThrow('session failure');
    await store.withSessionLock('one', async () => {
      order.push('session-recovered');
    });

    expect(order).toEqual([
      'global-failed',
      'global-recovered',
      'session-failed',
      'session-recovered',
    ]);
  });

  it('reserves run slots before dispatch and enforces the concurrent limit', () => {
    const store = new ResidentStore<TestEntry>();
    const first = entry('one');
    const second = entry('two');
    const third = entry('three');
    first.running = true;
    store.register(first);
    store.register(second);
    store.register(third);

    const running = (item: TestEntry) => item.running;
    expect(store.concurrentRunCount(running)).toBe(1);
    expect(store.reserveRunSlot(second, 2, running)).toBe(true);
    expect(store.concurrentRunCount(running)).toBe(2);
    expect(store.reserveRunSlot(third, 2, running)).toBe(false);

    store.releaseRunSlot(second.id);
    expect(store.reserveRunSlot(third, 2, running)).toBe(true);
    expect(store.hasRunReservation(third.id)).toBe(true);
    expect(store.concurrentRunCount(running)).toBe(2);
  });
});
