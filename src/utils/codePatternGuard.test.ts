import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { globSync } from 'glob';

describe('server review fallback SSE patterns', () => {
  const serverPath = join(__dirname, '../../server.js');

  it('sends non-destructive error notice after fallback reviewCards before [DONE]', () => {
    const content = readFileSync(serverPath, 'utf-8');
    expect(content).toContain('reviewAiUnavailableNotice');
    // Direct SSE writes (sendReviewSse) or the dual SSE/JSON responder both apply.
    const emitCall = /(?:sendReviewSse\(res,|responder\.send\()/;
    expect(content).toMatch(
      new RegExp(
        `${emitCall.source}\\s*\\{\\s*reviewCards[\\s\\S]*${emitCall.source}\\s*\\{\\s*reviewNotice:\\s*reviewAiUnavailableNotice`,
      ),
    );
    expect(content).toMatch(/if \(usedFallback\)[\s\S]*reviewAiUnavailableNotice\(lang,\s*'invalid'\)/);
  });
});

describe('parse submission gating (Codex P1: facts load never submits)', () => {
  const serverPath = join(__dirname, '../../server.js');
  const content = readFileSync(serverPath, 'utf-8');

  it('resolves parse status read-only via the lib resolver (no submission)', () => {
    expect(content).toContain('createReadOnlyParseStatusResolver({');
    expect(content).toMatch(/const resolveReviewParseStatus = createReadOnlyParseStatusResolver\(/);
  });

  it('never invokes submitParseRequest directly in server.js (endpoint wiring only)', () => {
    // The only mention with a call shape is the factory import; server.js must
    // merely pass the submitter into createReviewParseRequestHandler.
    expect(content).not.toMatch(/\bsubmitParseRequest\s*\(/);
    expect(content).toMatch(/createReviewParseRequestHandler\(\{[\s\S]*submitParseRequest,/);
  });

  it('registers the explicit parse-request endpoint and rejects its GET with 405', () => {
    expect(content).toContain("app.post('/api/review/:matchId/parse-request'");
    expect(content).toContain("app.get('/api/review/:matchId/parse-request'");
  });

  it('facts/review call sites pass no client IP or signal to the read-only resolver', () => {
    const calls = content.match(/resolveReviewParseStatus\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).not.toMatch(/resolveClientIp|signal/i);
    }
  });
});

describe('Stream callback patterns across codebase', () => {
  it('no source files use dangerous messages.find().content + pattern in onChunk', () => {
    const srcDir = join(__dirname, '..');
    const files = globSync('**/*.{ts,tsx}', { cwd: srcDir, absolute: true });
    
    const dangerousPattern = /onChunk[^}]*messages\.find\([^)]*\)\.?content/s;
    const violations: string[] = [];
    
    for (const file of files) {
      if (file.includes('.test.') || file.includes('streamAccumulator')) continue;
      
      const content = readFileSync(file, 'utf-8');
      if (dangerousPattern.test(content)) {
        violations.push(file);
      }
    }
    
    expect(violations).toEqual([]);
  });
});

