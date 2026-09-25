import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  ProgressNotifier,
  extractProgressToken,
  getProgressTokenFromArgs,
  type ProgressNotification,
} from '../../src/core/progress-notifier.js';

describe('ProgressNotifier', () => {
  let notifier: ProgressNotifier;
  let sent: ProgressNotification[];

  beforeEach(() => {
    notifier = new ProgressNotifier();
    sent = [];
  });

  const sender = async (notification: ProgressNotification) => {
    sent.push(notification);
  };

  it('delivers notifications to the sender registered for the token', async () => {
    notifier.register('tok-1', sender);
    await notifier.notify('tok-1', { progress: 3, total: 10, message: 'working' });

    expect(sent).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 3, total: 10, message: 'working' },
      },
    ]);
  });

  it('drops notifications for unregistered tokens', async () => {
    await notifier.notify('unknown', { progress: 1 });
    expect(sent).toEqual([]);
  });

  it('stops delivering after unregister', async () => {
    notifier.register('tok-1', sender);
    notifier.unregister('tok-1');
    await notifier.notify('tok-1', { progress: 1 });
    expect(sent).toEqual([]);
  });

  it('keeps senders isolated per token', async () => {
    const other: ProgressNotification[] = [];
    notifier.register('a', sender);
    notifier.register('b', async notification => {
      other.push(notification);
    });

    await notifier.notify('b', { progress: 5 });

    expect(sent).toEqual([]);
    expect(other).toHaveLength(1);
    expect(other[0].params.progressToken).toBe('b');
  });

  it('swallows sender failures (best-effort delivery)', async () => {
    notifier.register('tok-1', async () => {
      throw new Error('transport closed');
    });
    await expect(notifier.notify('tok-1', { progress: 1 })).resolves.toBeUndefined();
  });
});

describe('token extraction helpers', () => {
  it('extracts progressToken from request params _meta', () => {
    expect(extractProgressToken({ _meta: { progressToken: 'abc' } })).toBe('abc');
    expect(extractProgressToken({ _meta: { progressToken: 7 } })).toBe(7);
    expect(extractProgressToken({ _meta: {} })).toBeUndefined();
    expect(extractProgressToken({})).toBeUndefined();
    expect(extractProgressToken(null)).toBeUndefined();
  });

  it('extracts the injected _progressToken from tool args', () => {
    expect(getProgressTokenFromArgs({ _progressToken: 'abc' })).toBe('abc');
    expect(getProgressTokenFromArgs({})).toBeUndefined();
    expect(getProgressTokenFromArgs(undefined)).toBeUndefined();
  });
});
