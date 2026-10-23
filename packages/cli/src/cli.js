import { createReviewClient, invalid, normalizeInput } from './client.js';

export function parseArgs(args) {
  if (args[0] !== 'review' || !args[1]) throw invalid('Usage: dota2ai review <matchId> [--hero slug|id] [--lang en|zh] [--json] [--offline]');
  const options = { match_id: args[1], lang: 'en', json: false, offline: false };
  const seen = new Set();
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw invalid(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--json' || flag === '--offline') options[flag.slice(2)] = true;
    else if (flag === '--hero' || flag === '--lang') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw invalid(`Missing value: ${flag}`);
      options[flag.slice(2)] = value;
    } else throw invalid(`Unknown option: ${flag}`);
  }
  normalizeInput(options);
  return options;
}
export async function run(args, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  try {
    const options = parseArgs(args);
    const review = await createReviewClient({ ...dependencies, offline: options.offline })(options);
    stdout.write(options.json ? `${JSON.stringify(review)}\n` : `${review.player?.hero ?? 'Select a hero'}: ${review.player?.result ?? review.state}\n${review.insights.slice(0, 3).map(i => i.claim.text).join('\n')}\n`);
    return review.state === 'insufficient' ? 3 : 0;
  } catch (error) {
    stderr.write(`${error.code === 'INVALID_INPUT' ? error.message : 'Review request failed'}\n`);
    return error.code === 'INVALID_INPUT' ? 2 : 4;
  }
}
