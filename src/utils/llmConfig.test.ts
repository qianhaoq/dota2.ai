import { describe, it, expect } from 'vitest';
import {
  resolveDeepSeekConfig,
  publicModelName,
  loggableModelName,
  REDACTED_CUSTOM_MODEL,
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
      credentialMappedFrom: null,
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
      credentialMappedFrom: null,
    });
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: '  deepseek-flash  ' }).model).toBe('deepseek-flash');
  });

  it('accepts DEEPSEEK_THINKING=enabled only as the exact string', () => {
    expect(resolveDeepSeekConfig({ DEEPSEEK_THINKING: 'enabled' })).toEqual({
      model: 'deepseek-flash',
      thinking: 'enabled',
      extraBody: { thinking: { type: 'enabled' } },
      legacyMappedFrom: null,
      credentialMappedFrom: null,
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
    // 40 chars total (with separators, no 24+ alnum run) is still valid; 41+
    // is rejected by the credential-length heuristic and falls back too.
    const long40 = `${'a'.repeat(20)}-${'a'.repeat(19)}`;
    expect(long40).toHaveLength(40);
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: long40 }).model).toBe(long40);
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: `${long40}a` }).model).toBe(DEFAULT_DEEPSEEK_MODEL);
  });

  it('rejects DEEPSEEK_MODEL values that look like a key/credential (fall back to default, flag set)', () => {
    for (const keyLike of [
      'sk-test-mock1234567890abcdef',       // sk- prefix (mock shape, never real)
      'sk_testmock1234567890abcdef',        // sk_ prefix
      'internal-key-alias',                 // contains 'key'
      'my_gateway_apikey_v2',               // contains 'key' (substring)
      'abcdefghijklmnopqrstuvwxyz012345',   // 33 chars, 26+ contiguous alnum run
    ]) {
      const resolved = resolveDeepSeekConfig({ DEEPSEEK_MODEL: keyLike });
      expect(resolved.model).toBe(DEFAULT_DEEPSEEK_MODEL);
      expect(resolved.credentialMappedFrom).toBe(keyLike);
      expect(resolved.extraBody).toEqual({ thinking: { type: 'disabled' } });
    }
    // Credential rejection never impersonates the legacy mapping.
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'sk-test-mock1234567890abcdef' }).legacyMappedFrom).toBeNull();
    // Sane names are unaffected and keep the flag clear.
    const sane = resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'corp-finetune-alias' });
    expect(sane.model).toBe('corp-finetune-alias');
    expect(sane.credentialMappedFrom).toBeNull();
  });

  it('maps retired legacy names to the default model (never sent upstream)', () => {
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'deepseek-chat' })).toEqual({
      model: DEFAULT_DEEPSEEK_MODEL,
      thinking: 'disabled',
      extraBody: { thinking: { type: 'disabled' } },
      legacyMappedFrom: 'deepseek-chat',
      credentialMappedFrom: null,
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

describe('loggableModelName (startup log masking)', () => {
  it('passes whitelisted public and legacy names through verbatim', () => {
    expect(loggableModelName('deepseek-flash')).toBe('deepseek-flash');
    expect(loggableModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(loggableModelName('deepseek-chat')).toBe('deepseek-chat');
    expect(loggableModelName('DeepSeek-Reasoner')).toBe('DeepSeek-Reasoner');
    expect(loggableModelName(' deepseek-flash ')).toBe('deepseek-flash');
  });

  it('masks every non-allowlisted custom name (heuristics are incomplete)', () => {
    for (const custom of [
      'corp-finetune-alias',
      'gateway.prod-v2_eu',
      'secret-prod-1234567890',
      'token_abcdefghijklmnopqrst',
      'password-hunter2',
    ]) {
      expect(loggableModelName(custom)).toBe(REDACTED_CUSTOM_MODEL);
    }
  });

  it('resolver ignores token/secret/password-shaped DEEPSEEK_MODEL values', () => {
    for (const v of ['secret-prod-1234567890', 'token_abcdefghijklmnopqrst', 'my-password-1', 'bearer-abc']) {
      const cfg = resolveDeepSeekConfig({ DEEPSEEK_MODEL: v });
      expect(cfg.model).toBe('deepseek-flash');
      expect(cfg.credentialMappedFrom).toBe(v);
    }
  });

  it('masks credential-shaped values (never echoes a key into the logs)', () => {
    for (const keyLike of [
      'sk-test-mock1234567890abcdef',        // mock sk- key shape
      'sk_testmock1234567890abcdef',
      'internal-key-alias',                  // contains 'key'
      'abcdefghijklmnopqrstuvwxyz012345',    // 24+ contiguous alnum run
      'a'.repeat(41),                        // over the 40-char cap
      'corp/finetune/alias',                 // chars outside the safe pattern
      '',
    ]) {
      expect(loggableModelName(keyLike)).toBe(REDACTED_CUSTOM_MODEL);
    }
    expect(loggableModelName(undefined)).toBe(REDACTED_CUSTOM_MODEL);
    expect(loggableModelName(null)).toBe(REDACTED_CUSTOM_MODEL);
    expect(loggableModelName(123)).toBe(REDACTED_CUSTOM_MODEL);
  });

  it('masks whatever the resolver would reject: any resolved model is safe to log', () => {
    // Defense in depth: even if a credential-looking value ever slipped into
    // `model`, the startup log still prints the mask, never the value.
    expect(loggableModelName('sk-test-mock1234567890abcdef')).toBe(REDACTED_CUSTOM_MODEL);
    // The resolver itself never resolves such a value (see resolveDeepSeekConfig).
    expect(resolveDeepSeekConfig({ DEEPSEEK_MODEL: 'sk-test-mock1234567890abcdef' }).model)
      .toBe(DEFAULT_DEEPSEEK_MODEL);
  });
});

describe('server.js startup log guard (model value never logged raw)', () => {
  it('routes the DeepSeek model log lines through loggableModelName', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
    expect(src).toMatch(/console\.log\(`INFO: DeepSeek model=\$\{loggableModelName\(deepseekConfig\.model\)\}/);
    expect(src).toMatch(/loggableModelName\(deepseekConfig\.legacyMappedFrom\)/);
    // The credential warning never interpolates the rejected value.
    const warnLine = src.match(/credentialMappedFrom\)\s*\{[\s\S]*?console\.warn\((`|')[^`']*(`|')\)/);
    expect(warnLine).toBeTruthy();
    expect(warnLine![0]).not.toContain('${');
  });
});
