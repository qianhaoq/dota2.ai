import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createBalanceMonitor, SITE_BALANCE_EVERY_MS, SITE_BALANCE_PAUSE, SITE_BALANCE_WARN } from '../../lib/agent/modelBalance.js';
import { createAgentService } from '../../lib/agent/service.js';

const ID = 9100904020;
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

describe('createBalanceMonitor (#365)', () => {
  it('warns when known balance is below warnBelow, pauses below pauseBelow, and restores once topped up', async () => {
    expect(SITE_BALANCE_WARN).toBe(20);
    expect(SITE_BALANCE_PAUSE).toBe(1);
    expect(SITE_BALANCE_EVERY_MS).toBe(300_000);

    let now = 1_000_000;
    const logs: string[] = [];
    const answers = [
      { known: true as const, available: true, total: 14.5, currency: 'CNY' },
      { known: true as const, available: true, total: 0.4, currency: 'CNY' },
      { known: true as const, available: false, total: 0, currency: 'CNY' },
      { known: true as const, available: true, total: 80, currency: 'CNY' },
    ];
    const readBalanceFn = vi.fn(async () => answers.shift()!);
    const monitor = createBalanceMonitor({
      models: [
        { id: 'deepseek-flash', provider: 'deepseek', apiKey: 'sk-secret-ds' },
        { id: 'kimi-k3.1-pro', provider: 'kimi', apiKey: 'sk-secret-kimi' },
      ],
      readBalanceFn: readBalanceFn as any,
      now: () => now,
      log: (m) => logs.push(m),
    });

    // 1. Low (14.5 < 20, >= 1): warns, does NOT block visitors.
    await monitor.check();
    expect(readBalanceFn).toHaveBeenCalledTimes(1); // kimi skipped (no balance endpoint)
    expect(monitor.down('deepseek-flash')).toBeNull();
    expect(monitor.healthy('deepseek-flash')).toBe(true);
    expect(logs).toEqual(['model balance low models=deepseek-flash balance=14.5 CNY warn_below=20']);

    // 2. Under pause floor (0.4 < 1): logs exhausted and pauses new reviews.
    await monitor.check();
    expect(monitor.down('deepseek-flash')).toEqual({ reason: 'model_out_of_credit', retry_in_sec: 300 });
    expect(monitor.healthy('deepseek-flash')).toBe(false);
    expect(logs.at(-1)).toBe('model balance exhausted models=deepseek-flash balance=0.4 CNY available=true pause_below=1');

    now += 60_000;
    expect(monitor.down('deepseek-flash')).toEqual({ reason: 'model_out_of_credit', retry_in_sec: 240 });

    // 3. Account marked unavailable by provider: stays paused.
    await monitor.check();
    expect(monitor.down('deepseek-flash')?.reason).toBe('model_out_of_credit');

    // 4. Topped up to 80 CNY: clears pause immediately and logs restoration.
    await monitor.check();
    expect(monitor.down('deepseek-flash')).toBeNull();
    expect(monitor.healthy('deepseek-flash')).toBe(true);
    expect(logs.at(-1)).toBe('model balance restored models=deepseek-flash balance=80 CNY');
    expect(logs.join('\n')).not.toContain('sk-secret');
  });

  it('never blocks visitors when the balance is unknown (endpoint down or unsupported provider)', async () => {
    const logs: string[] = [];
    const monitor = createBalanceMonitor({
      models: [{ id: 'deepseek-flash', provider: 'deepseek', apiKey: 'sk-ds' }],
      readBalanceFn: async () => ({ known: false, reason: 'the balance endpoint answered 503' }),
      log: (m) => logs.push(m),
    });
    await monitor.check();
    expect(monitor.down('deepseek-flash')).toBeNull();
    expect(logs).toEqual([]);
  });

  it('deduplicates checks when two model ids share the same provider and key', async () => {
    const readBalanceFn = vi.fn(async () => ({ known: true as const, available: false, total: 0, currency: 'CNY' }));
    const monitor = createBalanceMonitor({
      models: [
        { id: 'deepseek-flash', provider: 'deepseek', apiKey: 'sk-shared' },
        { id: 'deepseek-alt', provider: 'deepseek', apiKey: 'sk-shared' },
      ],
      readBalanceFn: readBalanceFn as any,
    });
    await monitor.check();
    expect(readBalanceFn).toHaveBeenCalledTimes(1);
    expect(monitor.down('deepseek-flash')?.reason).toBe('model_out_of_credit');
    expect(monitor.down('deepseek-alt')?.reason).toBe('model_out_of_credit');
  });

  it('stops createAgentService from starting a doomed review when balanceMonitor reports out of credit, while still serving other models', async () => {
    let credit = { known: true as const, available: false, total: 0, currency: 'CNY' };
    const monitor = createBalanceMonitor({
      models: [{ id: 'deepseek-flash', provider: 'deepseek', apiKey: 'sk-ds' }],
      readBalanceFn: async () => credit,
    });
    await monitor.check();

    const dsComplete = vi.fn();
    const kimiComplete = vi.fn(() => new Promise(() => {}));
    const admit = vi.fn(() => null);
    const service: any = createAgentService({
      traces: { get: async () => trace },
      models: {
        'deepseek-flash': { name: 'deepseek-flash', complete: dsComplete },
        'kimi-k3.1-pro': { name: 'k3.1-pro', complete: kimiComplete },
      },
      defaultModel: 'deepseek-flash',
      balanceMonitor: monitor,
    } as any);

    // Default model (DeepSeek) is paused proactively: no slot charged, no model call made.
    expect(await service.start(ID, 'beastmaster', 'zh', { admit })).toEqual({
      status: 'unavailable',
      reason: 'model_out_of_credit',
      retry_in_sec: 300,
    });
    expect(admit).not.toHaveBeenCalled();
    expect(dsComplete).not.toHaveBeenCalled();

    // Another offered model whose account is healthy is unaffected.
    expect(await service.start(ID, 'beastmaster', 'zh', { model: 'kimi-k3.1-pro', admit })).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(1);
  });
});
