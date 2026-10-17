import { describe, it, expect } from 'vitest';
import {
  resolveDeepSeekConfig,
  publicModelName,
  DEFAULT_DEEPSEEK_MODEL,
  LEGACY_DEEPSEEK_MODELS,
} from '../../lib/llmConfig.js';

describe('resolveDeepSeekConfig', () => {
  it('defaults to deepseek-flash with thinking disabled', () => {
    expect(DEFAULT_DEEPSEEK_MODEL).toBe('deepseek-flash');
    expect(LEGACY_DEEPSEEK_MODELS.has('deepseek-chat')).toBe(true);
    expect(LEGACY_DEEPSEEK_MODELS.has('deepseek-reasoner')).toBe(true);
    expect(resolveDeepSeekConfig({})).toEqual({
      model: 'deepseek-flash',
      thinking: 'disabled',
      extraBody: { thinking: { type: 'disabled' } },
      legacyMappedFrom: null,
    });
    expect(resolveDeepSeekConfig(undefined)).toEqual(resolveDeepSeekConfig({}));
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: undefined, DEEPSEEK_THINKING: undefined }))
      .toEqual(resolveDeepSeekConfig({}));
  });

  it('honors valid env overrides (trims whitespace)', () => {
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'deepseek-v4-pro' })).toEqual({
      model: 'deepseek-v4-pro',
      thinking: 'disabled',
      extraBody: { thinking: { type: 'disabled' } },
      legacyMappedFrom: null,
    });
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: '  deepseek-flash  ' }).model).toBe('deepseek-flash');
  });

  it('accepts DEEPSEEK_THINKING=enabled only as the exact string', () => {
    expect(resolveDeepSeekConfig({ DEEPSEEK_THINKING: 'enabled' })).toEqual({
      model: 'deepseek-flash',
      thinking: 'enabled',
      extraBody: { thinking: { type: 'enabled' } },
      legacyMappedFrom: null,
    });
    expect(resolveDeepSeekConfig({ DEEPSEEK_THINKING: ' enabled ' }).thinking).toBe('enabled');
    // Anything else (on/true/1/typos) is not accepted and falls back.
    for (const invalid of ['on', 'true', '1', 'yes', 'ENABLED', 'disable', '']) {
      expect(resolveDeepSeekConfig({ DEEPSEEK_THINKING: invalid }).thinking).toBe('disabled');
    }
  });

  it('falls back to the default model on invalid names', () => {
    for (const invalid of [
      '',
      '   ',
      'has space',
      'slash/name',
      '-leading-dash',
      '.leading-dot',
      'tab\tname',
      'x'.repeat(65), // 65 chars: over the 64-char cap
      'name\ninjection',
    ]) {
      const resolved = resolveDeepSeekConfig({ DEEPSEEK_MODEL: invalid });
      expect(resolved.model).toBe(DEFAULT_DEEPSEEK_MODEL);
      expect(resolved.extraBody).toEqual({ thinking: { type: 'disabled' } });
    }
    // Non-string values (e.g. someone exports DEEPSEEK_MODEL=123) also fall back.
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 123 as unknown as string }).model)
      .toBe(DEFAULT_DEEPSEEK_MODEL);
    // 64 chars total is still valid.
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'a'.repeat(64) }).model).toBe('a'.repeat(64));
  });

  it('maps retired legacy names to the default model (never sent upstream)', () => {
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'deepseek-chat' })).toEqual({
      model: DEFAULT_DEEPSEEK_MODEL,
      thinking: 'disabled',
      extraBody: { thinking: { type: 'disabled' } },
      legacyMappedFrom: 'deepseek-chat',
    });
    const r = resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'DeepSeek-Reasoner', DEEPSEEK_THINKING: 'enabled' });
    expect(r.model).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(r.legacyMappedFrom).toBe('DeepSeek-Reasoner');
    expect(r.extraBody).toEqual({ thinking: { type: 'enabled' } });
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'deepseek-v4-pro' }).legacyMappedFrom).toBeNull();
  });

  it('returns a fresh extraBody object per call (safe to spread per request)', () => {
    const a = resolveDeepSeekConfig({});
    const b = resolveDeepSeekConfig({});
    expect(a.extraBody).not.toBe(b.extraBody);
    expect(a.extraBody.thinking).not.toBe(b.extraBody.thinking);
  });
});

describe('publicModelName (/api/health whitelist)', () => {
  it('passes the two documented public names through verbatim', () => {
    expect(publicModelName('deepseek-flash')).toBe('deepseek-flash');
    expect(publicModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('masks every other value as deepseek-custom (never leaks deployment details)', () => {
    for (const model of [
      'my-internal-alias',      // valid per resolveDeepSeekConfig, but private
      'gateway-prod/model-x',   // never a resolved value; defense in depth
      'deepseek-chat',          // retired legacy name
      'DeepSeek-Flash',         // case differs from the whitelist
      'deepseek-flash ',        // trailing space (resolved values are trimmed,
                                // but /api/health must not echo raw input)
      '',
    ]) {
      expect(publicModelName(model)).toBe('deepseek-custom');
    }
    expect(publicModelName(undefined)).toBe('deepseek-custom');
    expect(publicModelName(null)).toBe('deepseek-custom');
    expect(publicModelName(123)).toBe('deepseek-custom');
  });

  it('keeps the health payload consistent with the resolver: legacy names resolve to a public name', () => {
    // What /api/health reports for a legacy env value: resolveDeepSeekConfig
    // maps it to the default first, so health shows 'deepseek-flash'.
    const resolved = resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'deepseek-chat' });
    expect(publicModelName(resolved.model)).toBe('deepseek-flash');
    // A valid custom name resolves to itself but is masked publicly.
    const custom = resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'corp-finetune-alias' });
    expect(custom.model).toBe('corp-finetune-alias');
    expect(publicModelName(custom.model)).toBe('deepseek-custom');
  });
});
