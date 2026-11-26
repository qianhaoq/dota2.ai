import { readFileSync } from 'node:fs';

/** The skill the plugin registers on a host with a skill registry (`ctx.skills`). */
export const SKILL = {
  name: 'dota2ai',
  description: 'Review a player\'s own Dota 2 game with dota2.ai: the replay review with checked evidence, why the game went that way, pro games on the same problem, follow-ups, and a next-game goal.',
  whenToUse: 'Someone asks to review a Dota 2 match, why they lost, what to practise, how their last game went, or how one hero plays against another.',
  source: 'runtime',
};

/** SKILL.md without its frontmatter: name and description are registered as fields. */
export function skillBody(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

/** The registration, read from skills/dota2ai/SKILL.md (a sibling of src/ and of the bundled lib/). */
export function skillRegistration() {
  return { ...SKILL, content: skillBody(readFileSync(new URL('../skills/dota2ai/SKILL.md', import.meta.url), 'utf8')) };
}

/** Requests from our own checks are marked so the site's funnel does not count them. */
export function headersFor(env) {
  return env.DOTA2AI_INTERNAL === '1' ? { 'X-Dota2ai-Internal': '1' } : {};
}
