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
    expect(content).toMatch(/analyzeDraftStream\(\s*coaching\.radiant,\s*coaching\.dire/);
    expect(content).toMatch(/fetchPlaybookStream\(\s*coaching\.allies,\s*coaching\.enemies[\s\S]*coaching\.focusHeroId/);
    expect(content).toMatch(/fetchSuggestions\(\s*coaching\.allies,\s*coaching\.enemies/);
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
