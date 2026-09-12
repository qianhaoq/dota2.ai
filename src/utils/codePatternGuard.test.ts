import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { globSync } from 'glob';

describe('CoachView streaming code patterns (regression guard)', () => {
  const coachViewPath = join(__dirname, '../components/CoachView.tsx');
  
  it('does NOT use stale closure pattern: messages.find(...).content + text', () => {
    const content = readFileSync(coachViewPath, 'utf-8');
    
    const staleClosurePattern = /messages\.find\([^)]*\)\.content\s*\+\s*text/;
    const hasStalePattern = staleClosurePattern.test(content);
    
    expect(hasStalePattern).toBe(false);
  });

  it('does NOT use stale closure pattern: (messages.find(...).content || "") + chunk', () => {
    const content = readFileSync(coachViewPath, 'utf-8');
    
    const staleClosurePattern = /\(messages\.find\([^)]*\)\?\.content\s*\|\|\s*['"`]['"``]\s*\)\s*\+/;
    const hasStalePattern = staleClosurePattern.test(content);
    
    expect(hasStalePattern).toBe(false);
  });

  it('uses functional setMessages pattern in onChunk callbacks', () => {
    const content = readFileSync(coachViewPath, 'utf-8');
    
    const functionalPattern = /setMessages\s*\(\s*prev\s*=>/;
    const hasFunctionalPattern = functionalPattern.test(content);
    
    expect(hasFunctionalPattern).toBe(true);
  });

  it('wires practiceHero into analyze/playbook/suggest via existing request fields', () => {
    const content = readFileSync(coachViewPath, 'utf-8');

    expect(content).toContain('resolveCoachingLineup');
    expect(content).toContain('buildPracticeUserContext');
    // lineup may be coaching or a draftOverride-resolved CoachingLineup
    expect(content).toMatch(/analyzeDraftStream\(\s*(?:coaching|lineup)\.radiant,\s*(?:coaching|lineup)\.dire/);
    expect(content).toMatch(/fetchPlaybookStream\(\s*(?:coaching|lineup)\.allies,\s*(?:coaching|lineup)\.enemies[\s\S]*(?:coaching|lineup)\.focusHeroId/);
    expect(content).toMatch(/fetchSuggestions\(\s*coaching\.allies,\s*coaching\.enemies/);
    expect(content).toContain('draftOverride');
  });

  it('guards stream terminal callbacks with inflight generation', () => {
    const content = readFileSync(coachViewPath, 'utf-8');
    expect(content).toContain('isCoachInflightCurrent(inflightTaskRef, streamGen)');
    expect(content).toContain('claimCoachInflightGeneration(inflightTaskRef)');
    expect(content).toContain('finishStream(streamGen)');
  });
});

describe('server review fallback SSE patterns', () => {
  const serverPath = join(__dirname, '../../server.js');

  it('sends non-destructive error notice after fallback reviewCards before [DONE]', () => {
    const content = readFileSync(serverPath, 'utf-8');
    expect(content).toContain('reviewAiUnavailableNotice');
    expect(content).toMatch(
      /sendReviewSse\(res,\s*\{\s*reviewCards[\s\S]*sendReviewSse\(res,\s*\{\s*reviewNotice:\s*reviewAiUnavailableNotice/,
    );
    expect(content).toMatch(/if \(usedFallback\)[\s\S]*reviewAiUnavailableNotice\(lang,\s*'invalid'\)/);
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

describe('CoachView suggest allySide binding (Codex P1)', () => {
  const coachViewPath = join(__dirname, '../components/CoachView.tsx');
  const content = readFileSync(coachViewPath, 'utf-8');

  it('stores request-time allySide on suggest coach messages', () => {
    expect(content).toMatch(/const requestSide = mySide/);
    expect(content).toMatch(/allySide:\s*requestSide/);
    expect(content).toMatch(/contextRevision:\s*requestRevision/);
  });

  it('accepts an explicit allySide on handleAcceptSuggestion', () => {
    expect(content).toMatch(/handleAcceptSuggestion = useCallback\(\s*\(hero: Hero, allySide\?:/);
    expect(content).toMatch(/const side = allySide \?\? mySide/);
  });

  it('invalidates in-flight and clears stale suggestions on My side change', () => {
    expect(content).toContain('clearStaleSuggestionMessages');
    expect(content).toMatch(/onMySideChange=\{\(side\) => \{[\s\S]*cancelStream\(\)[\s\S]*clearStaleSuggestionMessages/);
  });
});

describe('CoachView suggest practiceHeroId binding (Codex P1)', () => {
  const coachViewPath = join(__dirname, '../components/CoachView.tsx');
  const content = readFileSync(coachViewPath, 'utf-8');

  it('stores request-time practiceHeroId on suggest coach messages', () => {
    expect(content).toMatch(/const requestPracticeHeroId = practiceHero\?\.id \?\? null/);
    expect(content).toMatch(/practiceHeroId:\s*requestPracticeHeroId/);
  });

  it('accepts an explicit practiceHeroId on handleAcceptSuggestion', () => {
    expect(content).toMatch(/handleAcceptSuggestion = useCallback\(\s*\(hero: Hero, allySide\?: DraftSide, practiceHeroId\?:/);
    expect(content).toMatch(/practiceHeroId !== undefined/);
  });

  it('invalidates in-flight and clears stale suggestions on practice hero change', () => {
    expect(content).toContain('clearStaleSuggestionsForPracticeHero');
    expect(content).toMatch(/onSelectMentor=\{\(hero\) => \{[\s\S]*cancelStream\(\)[\s\S]*clearStaleSuggestionsForPracticeHero/);
    expect(content).toMatch(/onDismissMentor=\{\(\) => \{[\s\S]*clearStaleSuggestionsForPracticeHero/);
  });
});
