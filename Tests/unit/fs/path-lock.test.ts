import { describe, it, expect } from '@jest/globals';
import path from 'node:path';
import { isPathLocked, pathLockKey, withPathLock } from '../../../src/core/fs/path-lock.js';

const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('withPathLock', () => {
  it('runs holders of one path one at a time, in arrival order', async () => {
    const target = path.resolve('lock-test', 'a.ahk');
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(id =>
        withPathLock(target, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          events.push(`start ${id}`);
          await tick();
          events.push(`end ${id}`);
          active -= 1;
        })
      )
    );
    expect(maxActive).toBe(1);
    expect(events).toEqual([1, 2, 3, 4, 5].flatMap(id => [`start ${id}`, `end ${id}`]));
    expect(isPathLocked(target)).toBe(false);
  });

  it('lets different paths run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      ['x.ahk', 'y.ahk'].map(name =>
        withPathLock(path.resolve(name), async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await tick();
          active -= 1;
        })
      )
    );
    expect(maxActive).toBe(2);
  });

  it('is re-entrant within one call chain', async () => {
    const target = path.resolve('reentrant.ahk');
    const result = await withPathLock(target, () => withPathLock(target, async () => 'inner'));
    expect(result).toBe('inner');
  });

  it('releases the lock when the holder throws', async () => {
    const target = path.resolve('throws.ahk');
    await expect(
      withPathLock(target, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withPathLock(target, async () => 'next')).resolves.toBe('next');
    expect(isPathLocked(target)).toBe(false);
  });

  it('gives up waiting on abort without letting the next waiter overtake the holder', async () => {
    const target = path.resolve('abort.ahk');
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holder = withPathLock(target, async () => {
      order.push('holder start');
      await new Promise<void>(resolve => (releaseHolder = resolve));
      order.push('holder end');
    });
    await tick(1);

    const controller = new AbortController();
    const aborted = withPathLock(target, async () => order.push('aborted ran'), {
      signal: controller.signal,
    });
    const third = withPathLock(target, async () => order.push('third'));
    controller.abort();
    await expect(aborted).rejects.toThrow();

    await tick();
    expect(order).toEqual(['holder start']);
    releaseHolder();
    await Promise.all([holder, third]);
    expect(order).toEqual(['holder start', 'holder end', 'third']);
    expect(isPathLocked(target)).toBe(false);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withPathLock(path.resolve('pre-aborted.ahk'), async () => 1, { signal: controller.signal })
    ).rejects.toThrow();
  });

  it('keys paths by their resolved identity', () => {
    expect(pathLockKey('a/../b.ahk')).toBe(pathLockKey('b.ahk'));
    if (process.platform === 'win32') {
      expect(pathLockKey('C:\\Scripts\\A.ahk')).toBe(pathLockKey('c:\\scripts\\a.AHK'));
    }
  });
});
