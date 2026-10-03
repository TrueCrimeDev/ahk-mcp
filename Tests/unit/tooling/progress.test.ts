import { describe, expect, it, jest } from '@jest/globals';
import {
  createProgressSender,
  progressTokenOf,
  type ProgressNotification,
} from '../../../src/tooling/progress.js';

function recorder() {
  const sent: ProgressNotification['params'][] = [];
  const notify = jest.fn(async (notification: ProgressNotification) => {
    sent.push(notification.params);
  });
  return { sent, notify };
}

describe('progressTokenOf', () => {
  it('accepts 0 and the empty string, which are valid tokens', () => {
    expect(progressTokenOf({ progressToken: 0 })).toBe(0);
    expect(progressTokenOf({ progressToken: '' })).toBe('');
    expect(progressTokenOf({ progressToken: 'abc' })).toBe('abc');
  });

  it('rejects anything else', () => {
    expect(progressTokenOf(undefined)).toBeUndefined();
    expect(progressTokenOf({})).toBeUndefined();
    expect(progressTokenOf({ progressToken: Number.NaN })).toBeUndefined();
    expect(progressTokenOf({ progressToken: { id: 1 } })).toBeUndefined();
  });
});

describe('ProgressSender', () => {
  it('forwards only strictly increasing values, for token 0', async () => {
    const { sent, notify } = recorder();
    const sender = createProgressSender(0, notify);
    const accepted = [1, 1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY, 5, 4].map(value =>
      sender.report(value)
    );
    await sender.flush();
    expect(accepted).toEqual([true, false, false, true, false, false, true, false]);
    expect(sent).toEqual([
      { progressToken: 0, progress: 1 },
      { progressToken: 0, progress: 2 },
      { progressToken: 0, progress: 5 },
    ]);
    expect(sender.last).toBe(5);
  });

  it('carries the latest total forward and ignores a total below the progress', async () => {
    const { sent, notify } = recorder();
    const sender = createProgressSender('t', notify);
    sender.report({ progress: 1, total: 10 });
    sender.report({ progress: 2 });
    sender.report({ progress: 3, total: 2 });
    await sender.flush();
    expect(sent).toEqual([
      { progressToken: 't', progress: 1, total: 10 },
      { progressToken: 't', progress: 2, total: 10 },
      { progressToken: 't', progress: 3, total: 10 },
    ]);
  });

  it('cleans messages to one bounded line', async () => {
    const { sent, notify } = recorder();
    const sender = createProgressSender('t', notify);
    sender.report({ progress: 1, message: ' line one\nline two ' });
    sender.report({ progress: 2, message: 'x'.repeat(500) });
    sender.report({ progress: 3, message: '   ' });
    await sender.flush();
    expect(sent[0].message).toBe('line one line two');
    expect(sent[1].message?.length).toBe(200);
    expect(sent[2]).not.toHaveProperty('message');
  });

  it('completes at the total only when it is above the last value', async () => {
    const { sent, notify } = recorder();
    const sender = createProgressSender('t', notify);
    expect(sender.complete()).toBe(false);
    sender.report({ progress: 4, total: 8 });
    expect(sender.complete('done')).toBe(true);
    expect(sender.complete()).toBe(false);
    await sender.flush();
    expect(sent.map(params => params.progress)).toEqual([4, 8]);
    expect(sent[1]).toEqual({ progressToken: 't', progress: 8, total: 8, message: 'done' });
  });

  it('sends nothing after close, or without a token or notifier', async () => {
    const { sent, notify } = recorder();
    const sender = createProgressSender('t', notify);
    sender.report(1);
    sender.close();
    expect(sender.active).toBe(false);
    expect(sender.report(2)).toBe(false);
    await sender.flush();
    expect(sent).toHaveLength(1);

    expect(createProgressSender(undefined, notify).report(1)).toBe(false);
    expect(createProgressSender('t', undefined).report(1)).toBe(false);
  });

  it('keeps notifications in report order even when sends complete out of order', async () => {
    const order: number[] = [];
    const delays = [30, 0, 10];
    let call = 0;
    const notify = (notification: ProgressNotification) => {
      const delay = delays[call++] ?? 0;
      return new Promise<void>(resolve =>
        setTimeout(() => {
          order.push(notification.params.progress);
          resolve();
        }, delay)
      );
    };
    const sender = createProgressSender('t', notify);
    sender.report(1);
    sender.report(2);
    sender.report(3);
    await sender.flush();
    expect(order).toEqual([1, 2, 3]);
  });

  it('survives a failing send', async () => {
    const notify = jest.fn(async () => {
      throw new Error('closed');
    });
    const sender = createProgressSender('t', notify);
    sender.report(1);
    sender.report(2);
    await expect(sender.flush()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
