/**
 * The deep review: an agent investigates one player's game with the replay
 * and knowledge tools and submits a structured review
 * (`dota2.ai/deep-review@1`).
 *
 * Beside the findings (one player's own play) the review has a game plan:
 * how the game was played as a whole — what the teams did with the map and
 * their fights, where the player was meanwhile, and what the course is
 * mostly down to — from tempo_report and lineup_timing.
 *
 * The prompt teaches a method, not conclusions. The review is then checked
 * by code, not by trust (verifyReview): what it states about the game must
 * be in what the tools returned during this run. The model gets one chance
 * to repair what fails; whatever still states something the tools never
 * said is dropped.
 */
import { TRACE_TOOLS, runTraceTool, deathContext, abilityAudit } from '../../packages/review-engine/src/trace/index.js';
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { deepseekLanguageLock, normalizeUiLang } from '../aiLanguage.js';
import { KNOWLEDGE_TOOLS } from './knowledgeTools.js';
import { GOAL_SCHEMA, goalFromReview } from './goal.js';
import { HABITS, HABIT_KEYS, habitGoal } from '../coach/goals.js';
import { abilityName, KNOWN_ZH_NAMES } from './evidence.js';
import { AGENT_DEFAULTS, runAgent, toolContent } from './loop.js';
import { patchForGame } from './patchData.js';
import { placeNames } from './places.js';
import { planByKey, planKey } from './plans.js';

export { placeNames };

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 31;
const MAX_REFS = 3;
const MAX_FINDINGS = 3;
const MAX_PLAN_EVIDENCE = 4;
/** What a game's course is put down to. A judgment, not a fact: it ships only with the sentence that argues it. */
export const PLAN_REASONS = ['your_play', 'team_play', 'enemy_play', 'line_ups', 'unclear'];
/** The sentences of a game plan that state things about the game, in the order they are checked and shown. */
// Checked by position: a new text goes at the end, so the others keep theirs.
const PLAN_TEXTS = ['line_ups', 'course', 'your_part', 'why', 'strengths', 'window', 'against_your_plan'];
/** A stated time may be this far from a tool's time (rounding to the second, "about 30:10"). */
const CLOCK_TOLERANCE = 3;
/** From here up a number is checked wherever it stands; below, only decimals, counts and evidence. */
const BIG = 100;
/** Integers up to this are too common to check by matching ("two fights", "level 3"). */
const TRIVIAL = 3;

const STR = { type: 'string' };
export const SUBMIT_REVIEW = {
  name: 'submit_review',
  description: 'Hand in the finished review. Call it once, after you have investigated with the other tools. Every time and number you write must come from a tool result of this conversation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'mainline', 'findings', 'blind_spots'],
    properties: {
      verdict: { ...STR, description: 'One sentence: the main reason this game went the way it did for this player.' },
      mainline: { type: 'array', items: STR, maxItems: 5, description: 'The story of the game in phases, each with its times.' },
      findings: {
        type: 'array', minItems: 1, maxItems: MAX_FINDINGS,
        description: 'The problems that mattered most, most important first.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'rule', 'fix'],
          properties: {
            title: { ...STR, description: 'REQUIRED, and written first. The finding in a few words, as a heading: what the player did, not a label — at most twelve words, or twenty Chinese characters, with no times and no numbers. The claim does not repeat it.' },
            claim: { ...STR, description: 'What went wrong and why it mattered.' },
            evidence: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false, required: ['refs', 'fact'],
                properties: {
                  refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each tool record this fact is read from, copied exactly, e.g. "cast:beastmaster:primal_roar:6", "death:beastmaster:9", "immune:phantom_assassin:3".' },
                  fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
                },
              },
            },
            rule: {
              type: 'object', additionalProperties: false, required: ['when', 'do', 'this_game'],
              description: 'The one rule the player takes into the next game from this finding.',
              properties: {
                when: { ...STR, description: 'The situation, as the player meets it in game, from what is on their own screen at that moment: their health and mana, who stands next to them, what an enemy just used, the clock, what is in the shop. Not hindsight ("before you die"), not a mood ("when it is dangerous").' },
                do: { ...STR, description: 'One action for that situation: where to go, what to buy and by when, what to hold or wait for. Not "be careful", "position better" or "react faster".' },
                this_game: { ...STR, description: 'How often that situation came up in this game and went the other way: the count a tool states and the times (for example three of the twelve deaths, then their times), written in the language of the review like everything else. Every time and number must be in a tool result.' },
                counted_by: { type: 'string', enum: HABIT_KEYS, description: 'Which count a tool keeps that this rule is about, if one is — the next game\'s replay is counted the same way to see whether the rule was followed. From death_context.deaths_where — low_health_outside_fights: health_below_half_at_window_start_outside_fights. outnumbered_outside_fights: three_or_more_enemy_heroes_dealing_damage_outside_fights. alone: no_ally_within_2200_at_death. alone_not_traded: no_ally_within_2200_at_death_and_not_traded (the lone deaths that bought nothing: use it, not alone, when the finding is that dying alone got nothing back). nothing_pressed: nothing_cast_and_no_item_used. (low_health and outnumbered count the same over every death, fights included: use them only when the finding is about the fights themselves.) From ability_audit of one of the player\'s own abilities (name it in counted_ability) — cast_into_immunity: casts_where.target_spell_immune_and_not_stunned. target_survived: casts_where.enemy_hero_target_alive_12s_later. reached_few: casts_where.no_hero_target_and_at_most_one_enemy_hero_damaged. died_holding: deaths_with_it_ready_and_not_cast_total. Omit when the rule is about something else (an item).' },
                counted_ability: { type: 'string', description: 'For the four ability counts: the ability key as ability_audit names it (e.g. "tidehunter_ravage").' },
              },
            },
            fix: { ...STR, description: 'How to carry the rule out, in one or two sentences. Advice, not game facts.' },
          },
        },
      },
      game_plan: {
        type: 'object', additionalProperties: false, required: ['course', 'your_part', 'main_reason', 'why', 'evidence'],
        description: 'How the game was played as a whole, beside the findings: when each side had its chance, what the two teams did with the map and with their fights, where the player was meanwhile, and what the course of the game is mostly down to. From window_report, tempo_report, power_spikes and lineup_timing. Not another finding: nothing a finding already says.',
        properties: {
          line_ups: { ...STR, description: 'What lineup_timing shows: which heroes of each side win more in shorter or in longer public games, and which length this game had. One or two sentences; say "public games" and name the heroes. Leave out when it shows no lean on either side.' },
          strengths: { ...STR, description: 'Always present when power_spikes answered. What the player\'s hero was up against and when, from power_spikes: which enemy heroes it usually does worse or better against (say "public games" or "professional games" and the numbers), when the enemy who killed the player most reached their levels and big items next to when the player reached theirs, and from which of that enemy\'s items the kills came. Two or three sentences. Leave out what the tool has no data for.' },
          against_your_plan: { ...STR, description: 'Only when the opening message says what the player\'s plan was: the game read against it, in three to five sentences and in this order. One: did the player\'s own play fit it — their items (build_for_plan with that plan: the first item for it and when, the gold in other items before it), where they were, the fights they were at, the buildings they damaged. Two: does the data on these heroes support it against this line-up (lineup_timing, power_spikes, the windows of window_report) — when it shows no lean, say the data does not settle it. Three: where it broke, if it did — the player\'s own play, the team\'s, or what the enemy did (their window, their items by then, who on their side got richest while your team was ahead and whether they stood by the buildings your team took: farm_report). Leave out when the player did not say what their plan was.' },
          window: { ...STR, description: 'When the player\'s team had its chance, from window_report: the window in which it was ahead (its times and peak lead), what it took in it (buildings, fights it came out ahead in), and the big items the enemy finished inside it and in its last 180 seconds; or, when the team never had a window, the enemy\'s window and what it took. Two or three sentences, times and numbers as the tool gives them. Say an item came before the end; never that it ended the window. Leave out when window_report has no windows (gaps).' },
          course: { ...STR, description: 'What the two teams did with the game, from tempo_report: when each side took its buildings, how many fights each side lost fewer heroes in, and how many of those a building followed. Counts and times as the tool gives them.' },
          your_part: { ...STR, description: 'Where the player was while that happened, from the stretches of tempo_report: which side of the map, alone or with allies near, which fights they were at, which buildings they damaged. No guess about what they meant to do.' },
          main_reason: { type: 'string', enum: PLAN_REASONS, description: 'What the course of the game is mostly down to. your_play: the player\'s own numbers show it (away from the fights, on the other side of the map from where buildings fell). team_play: the team\'s numbers show it and the player\'s do not (the player was at the fights; the team did not turn them into buildings, or had a window and took little in it). enemy_play: the tools show what the enemy did (their fights became buildings, a key item\'s time, the enemy took its window). line_ups: lineup_timing favoured the other side for the length this game had. unclear: the tools do not settle it.' },
          why: { ...STR, description: 'One or two sentences arguing main_reason from the numbers above. When it is team_play, enemy_play or line_ups, say plainly that it was not the player\'s doing.' },
          evidence: {
            type: 'array', minItems: 1, maxItems: MAX_PLAN_EVIDENCE,
            items: {
              type: 'object', additionalProperties: false, required: ['refs', 'fact'],
              properties: {
                refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each record this fact is read from, copied exactly: "spikes:beastmaster" for levels, item times, kills around an item and matchups, "build:beastmaster" for the build and what killed the player, "tempo:beastmaster" for the whole game\'s counts, "phase:beastmaster:3" for one stretch (also for which of its fights the player was at), "lineup_timing", "window:beastmaster" for the gold lead over the game and "window:beastmaster:2" for one window, "fight:8" for a fight of match_overview.' },
                fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
              },
            },
          },
        },
      },
      did_well: { type: 'array', items: STR, maxItems: 3 },
      goal: GOAL_SCHEMA,
      blind_spots: { type: 'array', items: STR, description: 'What the replay data could not show for this review (from the tools\' gaps).' },
    },
  },
};

export function deepReviewSystem(lang) {
  return `${deepseekLanguageLock(lang)}

You are a Dota 2 coach reviewing one player's game from its replay. You teach judgment: the player should finish reading knowing what to do differently next game.

You have tools that query the parsed replay and the site's data on heroes and items. They return facts; the judgment is yours.

READING THE TOOLS
- Everything is told from the player's side: "me" is the player, "ally"/"my_team" their team, "enemy" the other. my_team_gold_lead is negative when the player's team is behind. Never translate this into Radiant/Dire yourself.
- Call heroes by the names in hero_names and places by the names in place_names (the tools use engine keys such as "dire_top_lane"). Never leave a key, or half of one, in what you write.

METHOD
1. match_overview: result, the fights and which side lost fewer heroes, the gold lead around them, when buildings fell. Find where the game turned.
1b. Read the player's lane with lane_report: last hits, gold and XP at 10:00 against the enemy in the same lane, the deaths before 10:00, and how this core matchup usually stands in professional games and in public games of this bracket. A lane behind by what the matchup usually gives (this_game_against_that_range "typical", matchup "unfavoured") is the draft's, not the player's: say so. A lane finding needs something the player controls — last hits behind the enemy core's, deaths before 10:00 — with its numbers. When lane_report has no economy (gaps), say nothing about gold or last hits.
2. Find how the enemy won: which enemy hero killed the player and dealt the damage (death_context gives killed_by). Check that hero's key items with item_timeline and their spell-immunity windows.
2b. Read the strengths with power_spikes for the player: when the player and each enemy reached level 6, 12 and 18 and their big items, how often each enemy killed the player before and after each of that enemy's items, and how the player's hero usually fares against each enemy hero. From this say from when an enemy was the problem ("from their Blink Dagger at 16:56 on: 6 of their 8 kills"), whether the player's own timing came before or after it, and which matchups were against the hero before the game began. An unfavoured matchup is the draft's, not the player's: say so, and then say what the player can still do in it.
3. Audit the player's deaths with death_context. Start from its counts over all the deaths: deaths_where (which deaths, by game time, began below half health, had no ally within 2200, were against three or more enemy heroes) and damage_share_in_death_windows (one hero's attacks, or abilities). A pattern is a count over the deaths, then the two or three moments that show it — not one story per death. Then what was ready and not used and which disables landed. An ability listed under off_cooldown_without_the_mana could not be cast: it was not left unused.
4. Audit the player's ultimate: hero_abilities first (which ability it is, whether it goes through spell immunity), then ability_audit (who it was spent on, whether the stun landed, what followed, deaths with it ready), then immunity_windows with watch_hero/watch_ability: when the enemy carry became immune, where was the ultimate? Spending it on a lesser target seconds before is a decision worth naming. enemy_heroes_damaged_within_15s says whom a cast reached: one that reached several enemies was not wasted because one of them was spell immune.
5. Judge the build with build_check for the player, then pro_item_choices. build_check says where the damage in the deaths came from (whose attacks, whose abilities), what each big item the player bought is for (built_for), the gold put into each purpose, which items answer that damage for this role and what each does, and the hero's most-built professional items with when the player had them. Read what the build answered and set it against what killed the player: "your first two big items are magic resistance, 5700 gold; 65% of the damage in your deaths was one hero's attacks". Then order the advice:
   a. If a most-built professional item of this hero (most_built_by_pros_on_this_hero) came after 24:59 or never, that comes first — above all a gap closer the enemy had earlier (gap_closers). Never advise another item ahead of it. Its played_on_releases are the releases those pro games were played on: say the release when you quote a share. When it has from_the_patch_before_this_game, it is what pros built before this game's patch, not in it: say so, and this rule does not make it the first advice. When it has few_games, say how many games the share is from.
   b. Then one answer to the damage that killed the player, chosen from items_that_answer_attack_damage or items_that_answer_spell_damage: prefer the cheaper one whose "does" stops that damage, and say what it does in Valve's words. If its text has a drawback against this enemy team (more vulnerable to magic damage, when the enemy's spells also killed the player), name the drawback or pick another.
   c. Say which of the player's items it replaces or follows, and by which minute, so the order is something to follow in the shop. A minute you set must be one the player's own gold shows was reachable: the minute they finished the item it replaces, or the professional window (by 24:59) when the player had bought a big item by then. Never a minute earlier than their first big item; for a player who finished no big item in the game, say "as your first item over 2000 gold" instead of a minute.
6. Read the turning fights: fight_report for the player first, then fight_timeline before you describe one. fight_report reads each fight from the state before it: how many heroes each side brought (took_part_count), which ultimates and Black King Bars were ready when it began, and what every hero not in it was doing (dead and respawning in how long; elsewhere, how far, with a TP ready or not). A fight a side brought fewer heroes to is about where that side was before it is about how it was fought: say that first, naming who was not in it and what the replay shows them doing. Ultimates ready explain little by themselves: in the corpus the side with more ready lost fewer heroes in 59% of fights, and a side that came to have two or more ready than the other did barely better in the fight that followed (lost fewer in 73, more in 62). Do not explain a fight by ultimates ready alone, nor call a moment with every ultimate up a window the team "should" have fought in; who used theirs on whom (ability_audit) is what matters. Its counts (fights_total, fights_with_more_of_my_team, fights_the_side_with_more_heroes_lost_fewer, fights_i_took_part_in) belong to the ref "fights:<hero>"; who was in or out of one fight, what was ready and where the others were belong to that fight's ref ("fights:<hero>:<n>"). Its hero_deaths_in_window is how many heroes each side lost in that window: quote it, citing the timeline's ref, instead of counting rows. A fight listed by match_overview has its own ref ("fight:N") for its own counts.
6b. Read how the game was played as a whole (game_plan; its "strengths" comes from step 2b). siege_report for the player says, for every push on a building, which heroes hit it, which of its owners were near, whether it fell, and where everyone else was: read it before you say why the team took buildings or lost them. A push with two or more heroes hitting than the owners had near is a numbers push; a building lost with the player and most of the team far away is about where the team was, and says nothing about how the fight near it went. Its counts belong to "sieges:<hero>", one push's facts to "sieges:<hero>:<n>". tempo_report for the player: in each ten-minute stretch, the buildings each side took, the fights and whether a building followed within 120 seconds, and where the player spent their living time (which side of the map, alone or with allies near, at the fights or not, which buildings they damaged). lineup_timing: which heroes of each side win more in shorter or in longer public games, and which length this game had. window_report for the player: the team's gold lead over the game, and each window — a run of minutes one side stayed ahead — with what each side took in it and the big items each side finished in it and just before it ended. This is where the two game plans met: when the player's team had its chance, whether it turned it into buildings, and what the enemy had finished by then. Write game_plan from these: when each side had its chance (window), what the teams did with the game (course), where the player was meanwhile, and what the course is mostly down to (main_reason). In tempo_report "team" is the team of the hero you asked about and "opponents" the other: for the player that is my team and the enemy.
6c. Always call roshan_report for the player. It says, for every Roshan (an Aegis pickup), who took it, who was there, whether the Aegis was used or expired, and the buildings each side took in the 300 s after: a Roshan the player's team took and turned into no building, or one the enemy turned into buildings, is part of how the game went. Its counts belong to "roshan:<hero>", one Roshan's facts to "roshan:<hero>:<n>". Roshan is not a blind spot when it lists a take.
6d. decision_points for the player: after every fight a side won, how many of the losers were still dead 10 s after and for how long, and what the winners did — took a building (from the fight's start to 120 s after its end, as tempo_report counts it), took Roshan, pushed and took nothing, or neither. A win with three or more enemies still dead that became neither is the clearest thing a team gave away; a won fight the enemy turned into nothing is the reverse. Say what was done and what was not, with the respawn times — not what the team should have "known". The same report lists every tier 1–3 tower that fell (kind after_a_tower_fell): what its takers did in the next 120 s, the buildings they lost meanwhile (a trade), and where the player was. A tower the player's team lost while the player was elsewhere and alive is worth one line with the region; a tower taken and followed by nothing is the same lesson as a won fight followed by nothing. After a tier 1, taking nothing more is common (most tier 1s in the corpus); after a tier 3 the next building usually falls. It also lists every fight begun within 120 s after a big item (kind fight_after_a_big_item), with every such item of either side. In the corpus the side whose items alone were fresh lost fewer heroes in about two fights of three, but mostly because it was also ahead in gold (29 of 37); behind in gold it did so in 12 of 26, about as often as any side behind in gold. So say a fresh item came with the gold lead, not that it won the fight by itself. A fight the player's team took into only the enemy's fresh item, and lost, is worth naming with the item and its minute; one where both sides had fresh items says nothing about either. Its counts belong to "decision:<hero>", one moment's facts to "decision:<hero>:<n>".
7. Choose one goal the next game can be checked on (the "goal" field): hold_item when a finding is about a missing item from pro_item_choices, fewer_deaths when a finding is about dying, win_lane when a finding is about a lane that lane_report calls lost. Leave it out if neither fits.
8. Then write. At most ${MAX_FINDINGS} findings. Each needs a title (a few words, always), a pattern with its count, the moments that show it, and a rule for the next game. Before you write a finding, be able to say in one line what the player was up against at those moments (who was strong then, who was near, what each side had bought) — a finding that ignores it is a count, not coaching.
9. Order the findings by what the player could have changed alone, and earliest: staying or walking in on low health, being where no ally was, the order of their items — before how the team's fights went. match_overview lists every hero's deaths: when the player died less than their allies, say so in the verdict, and do not charge the team's lost fights to them.

RULES
- Every time (m:ss) and every number you state about the game must be one a tool returned in this conversation. Quote; do not add, subtract or average to make new numbers. For a count ("7 of 11 deaths"), use the count a tool gives (killed_by, by_target, *_total). If you did not look it up, do not state it.
- A tool's own counts and totals (casts_total, by_target, killed_by, windows_total…) belong to the ref at the top of its answer ("audit:…", "deaths:…", "immunity:…", "overview"): cite that ref when an evidence item states them.
- target_stunned_seconds is the stun the caster applied to the target within three seconds of this cast, per the combat log. Zero means the log shows none in that time: say that, do not guess why.
- Evidence cites records: each evidence item names the "ref" of the tool record(s) it is read from (at most 3) and states only what those records show. A time or number from another record needs that record's ref too. Never join a fact from one record to a different moment.
- Never state what an ability or item does from memory — not in a claim, and not in a rule or a fix either. hero_abilities says what Valve lists; ability_audit says what happened in this game (target_stunned_seconds). If they show an ability worked through spell immunity, say so; never assume it did not.
- "It was ready and not pressed" is not a finding on its own. Advise using an ability or item only for an effect the tools show (what hero_abilities lists, a stun that landed in this game). When the tools do not show what it does, do not tell the player to press it.
- Every finding ends in a rule: "when" is something the player can see on their own screen at that moment, "do" is one action, "this_game" is how often it came up this game with the tool's count and the times. When the rule answers one of the deaths_where counts, or one of ability_audit's counts for an ability of the player (casts_where: which casts went into spell immunity without a stun, were aimed at an enemy hero who was alive 12 seconds later, or damaged at most one enemy hero; and the deaths with it ready and not cast), name that count in "counted_by" (and the ability in "counted_ability"): the player's next replay is then counted the same way. A rule the player could not check themselves after their next game is not a rule.
- game_plan is about the game as a whole, not a fourth finding. A plan is not something a replay shows: never state what the player or the team "intended", "planned" or "wanted". Say what happened, and what the public data on these heroes shows ("Sven wins more in shorter public games") — not what the line-up "must" do.
- farm_report says who got richer in each stretch and each window, and which enemies were near the player's team as each building fell. An enemy core who gained the most while your team was ahead got richest then — say that, not that your team "let" them; enemies near a falling building were near, not proven to defend it. It says whether its money is gold earned or net worth: say which.
- build_for_plan says which plan an item's own effect serves, with Valve's line for it; that the effect serves the plan is the site's reading. An item it lists with no plan is not classified — never call it useless or "wrong" for that.
- When the opening message says what the player's plan was, take it as theirs — a replay cannot show what anyone meant to do — and write against_your_plan. Judge the plan they named, not one you would have picked; say plainly when the tools show it fit the line-ups and the player carried it out, and the game was lost elsewhere. When they did not say, never write against_your_plan and never say what they "intended".
- window_report lists big items next to a window's end: that one of them ended the window is your reading, not a fact the tool states. Say "finished at 21:29, inside your window" or "in the last three minutes of it", not "closed your window"; and a window the team had and took little in is about the team's play, not an item.
- fight_report: a hero "not in it" dealt and took no damage from enemy heroes in that fight. Say they were not in the fight and what the replay shows (dead, in base, at another fight, or only where they stood) — never that they refused, ignored the call or were farming. tp_ready says their TP was off cooldown, not that they could have arrived in time. A fight the player's team brought fewer heroes to and lost is "team_play" for main_reason unless the player was the one missing.
- death_context says for each death whether it was traded (traded_within_15s: an enemy hero died within 15 s of it) and where the allies who were not within 2200 were and what the replay shows them doing (allies_elsewhere). Measured over the parsed games, a death with no ally near is traded back far less often than one with two or more allies near, while standing alone was not more likely to end in a death in the next seconds. So the cost of dying alone is that the death bought nothing: say that, with this game's count (deaths_where.no_ally_within_2200_at_death_and_not_traded), not that being alone is dangerous in itself. A rule for it is counted_by alone_not_traded.
- Wards and buybacks, when the replay has them (older games give null — unknown, never "none"): death_context gives each death's observers_within_1600 (observer wards of each side standing within 1600 of where the player died) and bought_back (the buyback's clock, or false); fight_report gives each side's observers_within_1600_of_the_fight. An observer near a spot is a ward near it, not proof it saw the player; a death with no own observer near is where a ward would have shown what came — say that, with the count (deaths_where.no_own_observer_within_1600), not that the player "had no vision".
- decision_points: "neither" means no building fell, no Aegis was picked up and no hero pushed a building: the team may have farmed, pushed a wave with creeps or set up the next fight — say it did not take anything, not that it "did nothing" (in Chinese: 没拿到东西 / 什么都没拿到, never 什么都没做). A player "elsewhere" when a tower fell was not necessarily wrong: they may have been taking a building or farming in another lane. Say where they were and what fell; whether going there was right needs the rest of the map.
- roshan_report: the trace has no Roshan event; a Roshan there is the moment a hero picked up the Aegis. Say "took Roshan at 32:21 (the Aegis was picked up then)" only from it; a Roshan whose Aegis nobody picked up is not in it, so never say a side took no Roshan — say the replay shows no Aegis for them. "Used" means its holder died with it and came back.
- siege_report: "owners_near" were within 1800 of the heroes hitting the building; it does not say they defended it, and a hero not hitting a push their team made was not thereby idle. A building that fell with few hero hits may have been taken by creeps: the trace has none.
- tempo_report has no creeps: where the player stood is not what they were doing there. Say where they were and what fell; say "pushing" only with their damage to buildings, and never "farming".
- lineup_timing measures each hero alone in public games. Quote it as that. A mean of five heroes is not the line-up's win rate, and a lean is a reason to look at the early or late game, not a verdict.
- main_reason is "your_play" only when the player's own numbers show it. When the player was at the fights and the team still took nothing after them, that is "team_play": say it is not on the player. When the tools do not settle it, "unclear".
- Item advice must come from build_check, pro_item_choices or what the replay shows; say "professional games" when you quote a share. Never call an item offensive, defensive or "damage" from memory: build_check's built_for and Valve's text say what it is for, and an item with an empty built_for is not thereby an offensive one.
- Prices, recipes, what an item does and ability cooldowns are those of this game's patch: build_check, power_spikes, pro_item_choices and hero_abilities give them for it (data_patch, patch). Quote them as the tools give them, never from what you know of another patch; an item those tools do not offer did not exist then. When their gaps say the game's patch is unknown, say the prices are the current patch's.
- Read choices, not minds. You may say what a purchase or a position answered ("these two items answer spell damage") and whether that was what killed the player. You may not say what the player thought, feared or wanted.
- No vague amounts. Never "most", "many", "often", "usually", "多数", "大多", "经常", "不少" about this game: give the count a tool states ("4 of the 12 deaths").
- A rule's "when" must have been true at the moments the finding cites. If the cited deaths were on the player's own side of the map, the rule is not about the river or the enemy's side; if they were in fights, it is not about being alone. Check the places and the allies near in the death records before you write it.
- A rule's "do" names the thing: the item and the minute to have it by, the ability and its target, the place to stand or go to. If an ability is part of it, hero_abilities or ability_audit must show what it does (which targets it hits) — do not tell the player to clear a creep wave with an ability the tools do not show hitting several units.
- A death in a fight is the team's event before it is the player's. death_context says which deaths were in a fight (deaths_where.in_a_fight) and which were not, and counts low health and three-or-more-enemies outside fights separately (…_outside_fights). A finding about staying on low health, or about being caught by several enemies, counts the deaths outside fights and names only those; a death in a fight belongs in it only when its record shows what the player could have done otherwise. This holds most of all for a hero who starts the fights (build_check's played_as: frontline_initiator).
- Judge where the player was by the job their hero has in this game (build_check's played_as). A right_click_carry away from the fights in the first twenty minutes, before its first two big items, is how that role is played: it is not a finding, and "join the fights" is not advice for it — say instead what its items were late against (most_built_by_pros_on_this_hero) or what it died to. A frontline_initiator or a support away from the fights is worth a finding; so is a carry away from them after its big items were done.
- A rule's "when" is built from what the player is certain to have on their screen: their own health and mana, their items and gold, the clock, which allies are near them or where allies are on the minimap, which enemy heroes are missing from the minimap, an ability an enemy has just used on them. Never from an enemy being seen approaching, walking toward the player or standing somewhere: the replay does not know what the player could see, and an enemy about to kill them was usually not on their screen. Write "three enemy heroes are missing from the minimap", not "enemies are coming".
- What the tools list under "gaps" is unknown, not false: never claim what the enemy could or could not see or creep positions; say when Roshan was taken only from roshan_report (the Aegis pickup). Put what you could not check under blind_spots.
- Write for a player, not a programmer: never show tool or field names (ready_not_cast, controls_on_me) or engine keys (item_magic_wand, beastmaster_summon_thunderhide). Use the game's names for heroes, abilities and items.
- Speak to the player as "you" throughout, never "he" or "the player".
- Judge decisions, not outcomes, and be direct. No filler, no praise that is not earned by a fact.
- Finish by calling submit_review exactly once. Do not write the review as plain text.`;
}

const CLOCK = /(?<![\d:])-?\d{1,3}:[0-5]\d(?![\d:])/g;
const clockToSeconds = (s) => { const m = String(s).match(/^(-)?(\d{1,3}):([0-5]\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

function addText(text, times, numbers) {
  for (const m of text.matchAll(CLOCK)) { const t = clockToSeconds(m[0]); if (t != null) times.add(t); }
  for (const m of text.replace(CLOCK, ' ').matchAll(/\d+(?:\.\d+)?/g)) numbers.add(Number(m[0]));
}

/**
 * Everything checkable in the tool results of a run:
 * - `times`: every game time (seconds), `numbers`: every number, anywhere;
 * - `summary`: the counts and totals a tool states at its top level (and one
 *   level down: by_target, killed_by, the scoreboard), plus list lengths;
 * - `moments`: for every record that has a time or a time span, the numbers
 *   inside that record — what the tools said about that moment;
 * - `refs`: for every record with a `ref`, its own time and every time and
 *   number inside it — what a sentence citing that ref may state.
 */
export function collectFacts(sources) {
  /** @type {{ times: Set<number>, numbers: Set<number>, summary: Set<number>, moments: { from: number, to: number, numbers: Set<number> }[], refs: Map<string, { at: number | null, times: Set<number>, numbers: Set<number> }> }} */
  const out = { times: new Set(), numbers: new Set(), summary: new Set(), moments: [], refs: new Map() };
  const walk = (value, bucket) => {
    if (typeof value === 'number') { if (Number.isFinite(value)) { out.numbers.add(Math.abs(value)); bucket?.add(Math.abs(value)); } return; }
    if (typeof value === 'string') { addText(value, out.times, out.numbers); if (bucket) addText(value, new Set(), bucket); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, bucket); return; }
    if (!value || typeof value !== 'object') return;
    let span = null;
    if (typeof value.t === 'number') span = [value.t, value.t];
    else if (typeof value.from === 'number') span = [value.from, typeof value.to === 'number' ? value.to : value.from];
    else if (typeof value.clock === 'string' && clockToSeconds(value.clock) != null) span = [clockToSeconds(value.clock), clockToSeconds(value.clock)];
    const own = span ? new Set() : null;
    const add = (n) => { out.numbers.add(n); bucket?.add(n); own?.add(n); };
    for (const [k, v] of Object.entries(value)) {
      // A field name can carry a number the reader will repeat ("deaths_within_12s").
      for (const m of k.matchAll(/\d+/g)) add(Number(m[0]));
      if ((k === 't' || k === 'from' || k === 'to') && typeof v === 'number') out.times.add(Math.round(v));
      if (own) { const both = { add: (n) => { own.add(n); bucket?.add(n); } }; walk(v, both); } else walk(v, bucket);
    }
    if (span && own) out.moments.push({ from: span[0], to: span[1], numbers: own });
  };
  // Records by ref: a second, self-contained pass so a record's set holds its whole subtree.
  const cite = (value) => {
    if (Array.isArray(value)) { for (const v of value) cite(v); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.ref === 'string') {
      // A summary ref covers the tool's own counts and totals, not the records nested below it.
      const inner = value.ref_scope === 'summary' ? summaryFactsOf(value) : collectFactsOf(value);
      const at = typeof value.t === 'number' ? value.t : typeof value.from === 'number' ? value.from : typeof value.first_held?.t === 'number' ? value.first_held.t : null;
      const r = out.refs.get(value.ref) ?? { at, times: new Set(), numbers: new Set() };
      for (const t of inner.times) r.times.add(t);
      for (const n of inner.numbers) r.numbers.add(n);
      if (r.at == null) r.at = at;
      out.refs.set(value.ref, r);
    }
    for (const v of Object.values(value)) cite(v);
  };
  for (const src of [].concat(sources ?? [])) {
    walk(src, null);
    cite(src);
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      const top = (v, depth) => {
        if (typeof v === 'number') out.summary.add(Math.abs(v));
        else if (Array.isArray(v)) out.summary.add(v.length);
        else if (v && typeof v === 'object' && depth < 2) for (const x of Object.values(v)) top(x, depth + 1);
      };
      top(src, 0);
    }
  }
  return out;
}

/** Times and numbers anywhere inside one value (no summary, no moments). */
function collectFactsOf(value) {
  const times = new Set(); const numbers = new Set();
  const walk = (v) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) numbers.add(Math.abs(v)); return; }
    if (typeof v === 'string') { addText(v, times, numbers); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      for (const m of k.matchAll(/\d+/g)) numbers.add(Number(m[0]));
      if ((k === 't' || k === 'from' || k === 'to') && typeof x === 'number') times.add(Math.round(x));
      walk(x);
    }
  };
  walk(value);
  return { times, numbers };
}

/** The counts a tool states about its whole answer: top-level numbers, one level of maps, list lengths. */
function summaryFactsOf(value) {
  const times = new Set(); const numbers = new Set();
  const top = (v, depth) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) numbers.add(Math.abs(v)); } else if (typeof v === 'string') addText(v, times, numbers);
    // A list is its length, and the game times it names (deaths_where lists deaths by their clock): not the records it may hold.
    else if (Array.isArray(v)) { numbers.add(v.length); for (const x of v) if (typeof x === 'string') addText(x, times, numbers); }
    // A field's name can state a measure (no_ally_within_2200_at_death, observers_within_1600): its number is the record's,
    // as collectFactsOf reads it for a whole record — "no ally within 2200" citing deaths:<hero> is what the summary says.
    else if (v && typeof v === 'object' && depth < 2) for (const [k, x] of Object.entries(v)) { for (const m of k.matchAll(/\d+/g)) numbers.add(Number(m[0])); if ((k === 't' || k === 'from' || k === 'to') && typeof x === 'number') times.add(Math.round(x)); top(x, depth + 1); }
  };
  top(value, 0);
  return { times, numbers };
}

/** A number of seconds is a length of time, not a count of things: tools give it with a decimal and prose rounds it. */
const SECONDS_UNIT = /^\s*(秒|seconds?\b|secs?\b|s\b)/i;
const COUNT_UNIT = /^\s*(次|个|人|波|场|秒|座|times?\b|deaths?\b|kills?\b|casts?\b|fights?\b|seconds?\b|secs?\b|s\b)/i;

/** Words that mark a number as an approximation ("约 5200", "about 5,200", "5200 左右"): only such a number may be off the tool's. */
// A bare 约 is "about" — not the end of a word that has it (节约 "save", 预约, 合约 …: "节约 11000 金币" is exact).
const APPROX_BEFORE = /((?<![节预制合签条公简隐邀违履特婚赴誓契规爽失毁解续租])约|大约|大概|将近|about|around|roughly|nearly|approximately|~|～|≈)\s*$/i;
// 左右/上下 may follow a unit: "11100 码左右", "5000 金左右".
const APPROX_AFTER = /^\s*(?:码|米|金币|金|经济|经验|点|秒|分钟|次|个|人|units?|gold)?\s*(左右|上下)/i;

/** Clock times and numbers a piece of review text states. `counted` = followed by a counting word ("7 次", "11 deaths", "9.3 seconds"). */
export function statedFacts(text) {
  const times = []; const numbers = [];
  const s = String(text ?? '');
  const rest = s.replace(CLOCK, (m) => { times.push(m); return ' '; });
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?(\s*k\b)?/gi)) {
    const raw = m[0].replace(/\s*k$/i, '').replace(/,/g, '');
    const value = Number(raw) * (m[1] ? 1000 : 1);
    if (!Number.isFinite(value)) continue;
    const after = rest.slice(m.index + m[0].length);
    const percent = /^\s*[%％]/.test(after);
    const approx = Boolean(m[1]) || APPROX_BEFORE.test(rest.slice(Math.max(0, m.index - 16), m.index)) || APPROX_AFTER.test(after);
    numbers.push({ text: percent ? `${m[0].trim()}%` : m[0].trim(), value, approx, decimal: raw.includes('.') && !m[1], counted: COUNT_UNIT.test(after), ...(SECONDS_UNIT.test(after) ? { seconds: true } : {}), ...(percent ? { percent } : {}) });
  }
  return { times, numbers };
}

/**
 * Statements about who could see whom. A replay trace holds positions and
 * distances, never vision (fog of war, wards): such a statement cannot be
 * backed by any tool, however it is worded. A sentence that says the data
 * does not show it is not a claim.
 * @returns {string[]} the offending phrases
 */
const SIGHT = [
  /(?:在|进入|出现在|站在|走进|暴露在|离开|脱离)[^，。；！？\n]{0,12}视野|视野[里内中]|(?:没有?|有|丢了|失去)视野|看得[见到]|看不[见到]|(?:看见|看到|发现)了?你/g,
  /\b(?:in|within|into|out of|outside|had|has|have|no|without|lost|gave|gives)\s+(?:(?:your|their|his|her|its|the|enemy|enemy's|full|any)\s+){0,3}(?:vision|sight|line of sight)\b|\b(?:could(?:n't| not)?|can(?:'t|not)?)\s+see\b|\bsaw\s+you\b|\bvisible\s+to\b/gi,
];
const NOT_A_CLAIM = /录像|数据|记录|无法|不知道|看不出|查不到|\b(?:replay|data|record(?:ed|s)?|trace|unknown|not shown|cannot (?:tell|know|say)|can't (?:tell|know|say))\b/i;
/**
 * A rule's situation told as an enemy seen coming ("enemies are walking toward you", "屏幕上已有敌人朝你这边走"):
 * the replay has no fog of war, so no tool knows what was on the player's screen.
 * @returns {string[]} the offending phrases
 */
const APPROACH = [
  /(?:屏幕上|画面里|眼前)[^，。；\n]{0,10}(?:敌|对手|对面)[^，。；\n]{0,16}|(?:敌人|敌方|对手|对面|他们?)[^，。；\n]{0,8}(?:朝|向|往)你[^，。；\n]{0,6}(?:走|来|靠|逼|冲|压)[^，。；\n]{0,4}|(?:看到|看见|发现)[^，。；\n]{0,6}(?:敌|对手|对面)[^，。；\n]{0,10}/g,
  /\b(?:enem(?:y|ies)|opponents?|they)\b[^.;,\n]{0,30}\b(?:walking|moving|coming|heading|running|rotating)\b[^.;,\n]{0,12}\b(?:toward|towards|at|to)\s+you\b|\bon your screen\b[^.;,\n]{0,30}\benem(?:y|ies)\b|\byou (?:see|spot|notice)\b[^.;,\n]{0,20}\benem(?:y|ies)\b/gi,
];
export function approachClaims(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const re of APPROACH) for (const m of text.matchAll(re)) out.push(m[0].trim().slice(0, 60));
  return [...new Set(out)];
}
export function sightClaims(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const sentence of text.split(/(?<=[。！？!?\n])|(?<=\.)\s/)) {
    if (NOT_A_CLAIM.test(sentence)) continue;
    for (const re of SIGHT) for (const m of sentence.matchAll(re)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/**
 * Record handles the model put into a sentence — "（lane:beastmaster）", "(audit:x:roar, cast:x:roar:6/9)",
 * "（overview、fight:3、fight:4）", "（4 换 3，timeline:2194-2233）". They belong in `refs`. A bracket holding
 * nothing else goes whole; a handle listed after or before other words in a bracket goes with its separator.
 * One standing inside a sentence ("fight:3 at 20:20") cannot be cut out without breaking it: wordingProblems names it.
 */
const HANDLE = '[a-z][a-z_]*:[A-Za-z0-9_/+-]+(?::[A-Za-z0-9_/+-]+)*';
const SOURCE = `(?:${HANDLE}|overview|${[...TRACE_TOOLS, ...KNOWLEDGE_TOOLS].map((t) => t.name).join('|')})`;
const SEP = '[,，、;；]';
const HANDLES = new RegExp(`\\s*[（(]\\s*${SOURCE}(?:\\s*${SEP}\\s*${SOURCE})*\\s*[)）]`, 'g');
const HANDLE_LISTED = new RegExp(`\\s*${SEP}\\s*${SOURCE}(?=\\s*(?:${SEP}|[)）]))|(?<=[（(])\\s*${SOURCE}\\s*${SEP}\\s*`, 'g');
export const stripHandles = (text) => text.replace(HANDLES, '').replace(HANDLE_LISTED, '');
/** A review as stored, with the handles taken out of its text: one written before this was done at the source is shown clean too. `refs` are untouched. */
export function withoutHandles(value) {
  if (typeof value === 'string') return stripHandles(value);
  if (Array.isArray(value)) return value.map(withoutHandles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'refs' ? v : withoutHandles(v)]));
}
const BARE_HANDLE = new RegExp(`(?<![A-Za-z0-9_:/.])${HANDLE}`, 'g');
const KEY = /(?<![A-Za-z0-9_:/.-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_:])/g;
const CJK_ONLY = /^[\u3400-\u9fff]+$/;
/** A bracket of clock times and nothing else, and a time picked out "of these" straight after it. */
 /** A majority or frequency word next to this game's events, with no count: asked about in the repair round. */
const VAGUE = /(?:(?:大多数?|多数|大部分|大半|绝大多数|经常|常常|总是|不少)[^。；;，,\n]{0,10}(?:死|阵亡|团|击杀|被杀|施放|大招|时候|次))|(?:\b(?:most|the majority|many|often|usually|frequently)\b[^.;,\n]{0,24}\b(?:deaths?|died|fights?|kills?|casts?|times)\b)/gi;
const LISTED = /[（(]((?:\s*-?\d{1,3}:[0-5]\d\s*[,，、;；和]?(?:\s*and\b)?)+)[)）]\s*[,，;；]?\s*(?:其中|当中|of which|of these|of those|among them)[^，,。；;：:（(\d]{0,12}(-?\d{1,3}:[0-5]\d)(?![\d:])/gi;

/**
 * How a piece of review text is worded, apart from whether its facts are backed:
 * - `key`: a tool's key or field name left in a sentence ("no_ally_within_1200", "audit:tidehunter:ravage").
 *   A hero or place key is not named: nameHeroes replaces those, and removes handles in brackets.
 * - `name`: four or more Chinese characters that are one character away from the name of a hero of this
 *   match and are no hero, ability or item name themselves ("天赋法师" for 天怒法师).
 * - `list`: "…（18:31、19:29、25:33），其中 37:14 那次…" — a time picked out of a list of times it is not in.
 * These are put to the model once, in the repair round. They are never a reason to drop anything: the
 * second and third are a guess about what was meant.
 * @param {{ hero_names?: Record<string, string>, place_names?: Record<string, string> }} [names]
 * @returns {{ kind: 'key' | 'name' | 'list' | 'vague', text: string }[]}
 */
export function wordingProblems(text, names = {}) {
  if (typeof text !== 'string' || !text) return [];
  const out = new Map();
  const add = (kind, t) => out.set(`${kind}|${t}`, { kind, text: t });
  const body = stripHandles(text);
  const replaced = { ...names.place_names, ...names.hero_names };
  for (const m of body.matchAll(BARE_HANDLE)) if (!m[0].includes('://')) add('key', m[0]);
  for (const m of body.replace(BARE_HANDLE, ' ').matchAll(KEY)) if (!Object.hasOwn(replaced, m[0])) add('key', m[0]);
  for (const name of new Set(Object.values(names.hero_names ?? {}))) {
    if (typeof name !== 'string' || name.length < 4 || !CJK_ONLY.test(name)) continue;
    for (let i = 0; i + name.length <= body.length; i += 1) {
      const w = body.slice(i, i + name.length);
      if (w === name || !CJK_ONLY.test(w) || KNOWN_ZH_NAMES.has(w)) continue;
      let off = 0;
      for (let k = 0; k < name.length && off < 2; k += 1) if (w[k] !== name[k]) off += 1;
      if (off === 1) add('name', `${w} (${name}?)`);
    }
  }
  // "Most of your deaths", "多数死时…": an amount nobody counted. Only where the sentence is about this game's
  // events (it names deaths, fights, casts, kills): "professionals usually build it" is not this game.
  for (const m of body.matchAll(VAGUE)) add('vague', m[0].trim().slice(0, 60));
  for (const m of body.matchAll(LISTED)) {
    const listed = (m[1].match(CLOCK) ?? []).map(clockToSeconds);
    if (listed.length >= 2 && !listed.includes(clockToSeconds(m[2]))) add('list', `${m[2]} (not among ${m[1].trim()})`);
  }
  return [...out.values()];
}

const has = (set, n, slack) => { for (const x of set) if (Math.abs(x - n) <= slack) return true; return false; };
/**
 * A percentage is checked as what it says: "71%" is backed by a tool's share
 * of 0.71 (or by a tool's own 71), and "0.71%" is not backed by 0.71.
 */
const percentOk = (set, n) => has(set, n.value / 100, 0.006) || (n.value >= 1 && has(set, n.value, 0.5));

/**
 * Check a submitted review against what the tools returned.
 *
 * Checked: every clock time; every number of 100 or more; every decimal;
 * every small count ("7 times") against the tools' own counts; a whole
 * number of seconds may instead be a tool's number rounded ("8 s" for 7.6). An evidence
 * item cites tool records by `ref`: the refs must exist, and every time and
 * every number above 3 in its fact must be inside those records (a whole
 * number may be a tool's decimal rounded: "11 s" for 10.8). So a fact cannot
 * be attached to a moment it does not belong to. A statement about who could
 * see whom is never backed (sightClaims). Wording (wordingProblems) is looked at everywhere and marked
 * `soft`: it sends the review back once and never removes anything. The game plan's sentences are checked like the
 * verdict ('plan', indexed as PLAN_TEXTS) and its evidence like a finding's ('plan_evidence'). Not checked: `fix`, a
 * rule's `when` and `do`, `next_game` (advice), a plan's `main_reason` (a judgment) and `blind_spots`.
 *
 * @param {any} review  the submit_review arguments
 * @param {any[]} sources  tool results (and the context the model was given) of this run
 * @param {string[]} [accepted]  text already checked (a verified review, clean earlier answers): the counts it states may be repeated
 * @returns {{ ok: boolean, problems: { where: 'verdict' | 'mainline' | 'did_well' | 'blind_spots' | 'finding' | 'rule' | 'title' | 'plan' | 'plan_evidence', index: number, kind: 'time' | 'number' | 'count' | 'moment' | 'ref' | 'sight' | 'missing' | 'language' | 'key' | 'name' | 'list', text: string, soft?: true }[], unsupported: { findings: Set<number>, evidence: Map<number, Set<number>> }, refs: Map<string, { at: number | null }> }}
 */
export function verifyReview(review, sources, accepted = []) {
  const known = collectFacts(sources);
  for (const text of accepted) for (const n of statedFacts(text).numbers) if (n.counted && !n.decimal) known.summary.add(n.value);
  const timeOk = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (known.times.has(t + d)) return true; return false; };
  // A number stated plainly is the tool's own, give or take rounding (1). Prose is checked against every number of
  // every tool, so a looser match lets a made-up value pass on an unrelated one (#295: 11300 on farm_report's 11297
  // for a distance of 11112). Only a number the text calls approximate gets slack.
  const bigOk = (n, set) => has(set, n.value, n.approx ? n.value * 0.06 : 1);
  const problems = [];
  // Wording (wordingProblems): asked about in the repair round, never a reason to drop — kept apart, so the
  // counting below (which finding or evidence item failed) sees only what is unsupported.
  const notes = [];
  const names = [].concat(sources ?? []).find((s) => s && typeof s === 'object' && !Array.isArray(s) && s.hero_names) ?? {};
  const wording = (where, index, ...texts) => { for (const t of texts) for (const w of wordingProblems(t, names)) if (!notes.some((n) => n.where === where && n.index === index && n.kind === w.kind && n.text === w.text)) notes.push({ where, index, ...w, soft: true }); };
  const prose = (where, index, text) => {
    wording(where, index, text);
    const { times, numbers } = statedFacts(text);
    for (const s of sightClaims(text)) problems.push({ where, index, kind: 'sight', text: s });
    for (const c of new Set(times)) if (!timeOk(c)) problems.push({ where, index, kind: 'time', text: c });
    for (const n of numbers) {
      if (n.percent) { if (!percentOk(known.numbers, n)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.value >= BIG) { if (!bigOk(n, known.numbers)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.decimal) { if (!has(known.numbers, n.value, 0.05)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.counted && n.value > TRIVIAL && !known.summary.has(n.value) && !(n.seconds && has(known.numbers, n.value, 0.95))) problems.push({ where, index, kind: 'count', text: n.text });
    }
  };
  // A line in English inside a review written in Chinese (a count copied as "6 of 12 deaths: …"). Judged against
  // the review itself, not the language asked for: only a line that differs from the rest is named.
  const CJK = /[\u3400-\u9fff]/;
  const chinese = CJK.test([review?.verdict, ...(review?.findings ?? []).map((f) => f?.claim)].filter((v) => typeof v === 'string').join(''));
  const tongue = (where, index, text) => {
    if (chinese && typeof text === 'string' && /[A-Za-z]{3}/.test(text) && !CJK.test(text)) problems.push({ where, index, kind: 'language', text: text.slice(0, 80) });
  };
  // Evidence items that failed, per finding: such an item is left out; the finding goes only when nothing else holds it up.
  const badItems = new Map();
  const claimBad = new Set();
  const evidence = (index, e, where = 'finding') => {
    const refs = Array.isArray(e?.refs) ? e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) : [];
    const cited = refs.map((r) => known.refs.get(r));
    if (!refs.length) { problems.push({ where, index, kind: 'ref', text: '(no ref)' }); return; }
    refs.forEach((r, i) => { if (!cited[i]) problems.push({ where, index, kind: 'ref', text: r }); });
    if (cited.some((c) => !c)) return;
    // Only what the cited records hold may be stated. A tool's counts have their own ref (audit:…, deaths:…) and must be cited like anything else.
    const times = new Set(); const local = new Set();
    for (const c of cited) { for (const t of c.times) times.add(t); for (const n of c.numbers) local.add(n); }
    const inRecord = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (times.has(t + d)) return true; return false; };
    const stated = statedFacts(e?.fact);
    wording(where, index, e?.fact);
    for (const s of sightClaims(e?.fact)) problems.push({ where, index, kind: 'sight', text: s });
    for (const c of new Set(stated.times)) if (!inRecord(c)) problems.push({ where, index, kind: 'moment', text: `${c} (not in ${refs.join(', ')})` });
    for (const n of stated.numbers) {
      if (n.percent) { if (!percentOk(local, n)) problems.push({ where, index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` }); } else if (n.value >= BIG) { if (!bigOk(n, local)) problems.push({ where, index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` }); } else if ((n.value > TRIVIAL || n.decimal) && !has(local, n.value, n.decimal ? 0.05 : 0.5)) problems.push({ where, index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` });
    }
  };
  prose('verdict', 0, review?.verdict);
  (review?.mainline ?? []).forEach((line, i) => { prose('mainline', i, line); tongue('mainline', i, line); });
  (review?.did_well ?? []).forEach((line, i) => { prose('did_well', i, line); tongue('did_well', i, line); });
  (review?.findings ?? []).forEach((f, i) => {
    const before = problems.length;
    prose('finding', i, [f?.title, f?.claim].filter(Boolean).join('\n'));
    if (problems.length > before) claimBad.add(i);
    // A model's arguments are not schema-checked: a finding sent without its heading is asked for one ('title'), not dropped.
    if (!(typeof f?.title === 'string' && f.title.trim())) problems.push({ where: 'title', index: i, kind: 'missing', text: 'title' });
    // What a rule says happened this game is a statement about the game, checked like the claim — on its own account
    // ('rule'): when it fails, that sentence goes, not the finding it belongs to. `when`, `do` and `fix` are advice.
    if (typeof f?.rule?.this_game === 'string') { prose('rule', i, f.rule.this_game); tongue('rule', i, f.rule.this_game); }
    wording('finding', i, f?.fix, f?.rule?.when, f?.rule?.do);
    // A rule that starts from seeing an enemy come: asked about, like wording (the rule stays; the model rewrites it).
    for (const text of [f?.rule?.when, f?.rule?.do]) for (const seen of approachClaims(text)) if (!notes.some((n) => n.where === 'finding' && n.index === i && n.kind === 'approach' && n.text === seen)) notes.push({ where: 'finding', index: i, kind: 'approach', text: seen, soft: true });
    // A finding rests on cited records. The schema asks for at least one, but a model's arguments are not
    // schema-checked by the API: one that cites nothing is unsupported, whatever it says.
    const items = Array.isArray(f?.evidence) ? f.evidence : [];
    if (!items.length) { problems.push({ where: 'finding', index: i, kind: 'ref', text: '(no evidence)' }); claimBad.add(i); }
    items.forEach((e, j) => { const n = problems.length; evidence(i, e); if (problems.length > n) badItems.set(i, (badItems.get(i) ?? new Set()).add(j)); });
    if (items.length && (badItems.get(i)?.size ?? 0) === items.length) claimBad.add(i);
  });
  (Array.isArray(review?.blind_spots) ? review.blind_spots : []).forEach((line, i) => wording('blind_spots', i, line));
  // The game plan: each of its sentences is checked like the verdict, on its own account ('plan', by its place in
  // PLAN_TEXTS), and its evidence like a finding's ('plan_evidence'). What fails is left out one by one.
  const plan = review?.game_plan && typeof review.game_plan === 'object' ? review.game_plan : null;
  if (plan) {
    PLAN_TEXTS.forEach((k, i) => { if (typeof plan[k] === 'string') { prose('plan', i, plan[k]); tongue('plan', i, plan[k]); } });
    (Array.isArray(plan.evidence) ? plan.evidence : []).forEach((e, j) => { evidence(j, e, 'plan_evidence'); tongue('plan_evidence', j, e?.fact); });
  }
  problems.push(...notes);
  return { ok: problems.length === 0, problems, refs: known.refs, unsupported: { findings: claimBad, evidence: badItems } };
}

/**
 * The game plan as it ships: every sentence and evidence item the check
 * (verifyReview) found something unsupported in is left out; wording alone
 * (`soft`) removes nothing. It needs what happened (`course` or `your_part`)
 * and at least one evidence item that holds; without them there is no plan.
 * `main_reason` is a judgment: it ships only together with the sentence that
 * argues it (`why`), and only as one of PLAN_REASONS.
 * @param {any} plan  the model's game_plan
 * @param {{ where: string, index: number, soft?: true }[]} problems
 * @param {Map<string, { at: number | null }>} refs
 */
export function planOf(plan, problems, refs, { stated = false } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const bad = (where) => new Set(problems.filter((p) => p.where === where && !p.soft).map((p) => p.index));
  const badText = bad('plan'); const badItems = bad('plan_evidence');
  const text = (k) => (badText.has(PLAN_TEXTS.indexOf(k)) ? null : str(plan[k]));
  const course = text('course'); const part = text('your_part'); const why = text('why'); const lineUps = text('line_ups'); const strengths = text('strengths'); const window = text('window');
  // A plan is read against only when the player named one: written without one, it judges a plan nobody stated.
  const against = stated ? text('against_your_plan') : null;
  const fmt = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  const evidence = (Array.isArray(plan.evidence) ? plan.evidence : []).slice(0, MAX_PLAN_EVIDENCE)
    // The refs as the check read them: strings only, at most MAX_REFS. An item left with none cites nothing.
    .map((e, j) => (badItems.has(j) || !str(e?.fact) || !Array.isArray(e?.refs) ? null : { fact: e.fact, refs: e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) })).filter((e) => e?.refs.length)
    .map((e) => { const at = refs.get(e.refs[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmt(at) }), fact: e.fact }; });
  if ((!course && !part && !window && !against) || !evidence.length) return null;
  return {
    ...(against ? { against_your_plan: against } : {}), ...(window ? { window } : {}), ...(strengths ? { strengths } : {}), ...(lineUps ? { line_ups: lineUps } : {}), ...(course ? { course } : {}), ...(part ? { your_part: part } : {}),
    ...(why && PLAN_REASONS.includes(plan.main_reason) ? { main_reason: plan.main_reason, why } : {}),
    evidence,
  };
}

/**
 * Check free text (a chat answer) the same way a review's prose is checked:
 * clock times, numbers of 100 or more, decimals, and small counts. `accepted`
 * is text that was already checked; a count it states ("7 times") may be repeated.
 * @returns {{ ok: boolean, problems: { kind: string, text: string }[] }}
 */
export function verifyText(text, sources, accepted = []) {
  const r = verifyReview({ verdict: text, findings: [] }, sources, accepted);
  // A chat answer is checked for what it states; its wording is not sent back.
  const problems = r.problems.filter((p) => !p.soft);
  return { ok: problems.length === 0, problems: problems.map(({ kind, text: t }) => ({ kind, text: t })) };
}

/**
 * The lookup tools for one player's game: their schemas, how to run them
 * (told from that player's side), and the context the model starts from.
 * Shared by the deep review and the chat. Null when the hero is not in the trace.
 */
export function reviewToolkit({ trace, hero, lang, match = null }) {
  const language = normalizeUiLang(lang);
  const seat = trace.heroes.find((h) => h.key === String(hero).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_'));
  if (!seat) return null;
  const lookups = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS];
  const ctx = { match, perspective: seat.key, lang: language };
  const knowledge = new Map(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));
  return {
    seat, language,
    tools: lookups.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    runTool: (name, args) => roshanGapPointsToTool(knowledge.has(name) ? { tool: name, ...knowledge.get(name).run(trace, args, ctx) } : runTraceTool(trace, name, args, ctx)),
    patch: (({ name, exact, how, reason }) => ({ name, exact, ...(how ? { known_from: how } : {}), ...(exact ? {} : { reason }) }))(patchForGame(trace.match_id, match)),
    context: { match_id: trace.match_id, player_hero: seat.key, hero_names: heroNames(trace, language), place_names: placeNames(language), ...(scoreboard(match, seat.key) ? { scoreboard: scoreboard(match, seat.key) } : {}) },
  };
}

/**
 * A trace says Roshan is a gap (it has no Roshan kill event), and every tool passes that on. roshan_report reads the
 * Roshans from the Aegis pickups: the gap now says so, or the model reads "no reliable Roshan event" as "unknown"
 * and puts a Roshan it could have looked up among the blind spots.
 */
const ROSHAN_GAP = 'no Roshan kill event in the trace: roshan_report reads each Roshan from the Aegis pickup (a Roshan whose Aegis nobody picked up is not seen)';
function roshanGapPointsToTool(result) {
  if (!Array.isArray(result?.gaps) || result.tool === 'roshan_report') return result;
  return { ...result, gaps: result.gaps.map((g) => (g?.topic === 'roshan' ? { ...g, reason: ROSHAN_GAP } : g)) };
}

/** The scoreboard facts the model starts from, when the match JSON is at hand. Names and account ids never go in. */
function scoreboard(match, heroKey) {
  const id = heroByKey(heroKey)?.id;
  const p = id == null ? null : (match?.players ?? []).find((x) => x && x.hero_id === id);
  return p ? { kills: p.kills, deaths: p.deaths, assists: p.assists, net_worth: p.net_worth, gold_per_min: p.gold_per_min, last_hits: p.last_hits } : null;
}

/** What to call each hero of this match in the reader's language (the tools use engine keys such as "necrolyte"). */
function heroNames(trace, lang) {
  // By the replay's own key for each hero ("queen_of_pain"), resolved to the hero it means.
  return Object.fromEntries(trace.heroes.map((h) => { const hero = heroByKey(h.key); return [h.key, (hero ? (lang === 'zh' ? hero.nameZh : hero.nameEn) : null) ?? h.key]; }));
}

/**
 * Replace engine hero keys the model let through ("skywrath_mage", "sven")
 * with the reader's names. Whole identifiers only, longest first; `refs` are
 * handles and are never touched.
 */
export function nameHeroes(review, names, places = {}) {
  names = { ...places, ...names };
  const keys = Object.keys(names).filter((k) => names[k] && names[k] !== k).sort((a, b) => b.length - a.length);
  if (!keys.length) return review;
  const re = new RegExp(`(?<![A-Za-z0-9_:])(${keys.join('|')})(?![A-Za-z0-9_:])`, 'g');
  // Only place names are closed up: hero names keep the spacing the text had.
  const cjkNames = [...new Set(Object.values(places).filter((n) => /^[\u3400-\u9fff]+$/.test(n)))].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const C = '[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]';
  const tight = cjkNames.length ? new RegExp(`(?:(${C}) +)?(${cjkNames.join('|')})(?: +(?=${C}))?`, 'g') : /$^/g;
  // A Chinese name put where a key stood between Chinese text ("在 dire 上路") takes the spaces around the key with it.
  const fix = (v) => (typeof v === 'string' ? stripHandles(v).replace(re, (k) => names[k]).replace(tight, (m, before, name) => `${before ?? ''}${name}`) : v);
  return {
    ...review,
    verdict: fix(review.verdict), mainline: (review.mainline ?? []).map(fix), did_well: (review.did_well ?? []).map(fix), next_game: (review.next_game ?? []).map(fix), blind_spots: (review.blind_spots ?? []).map(fix),
    findings: (review.findings ?? []).map((f) => ({ ...f, title: fix(f.title), claim: fix(f.claim), fix: fix(f.fix), ...(f.rule ? { rule: { ...f.rule, when: fix(f.rule.when), do: fix(f.rule.do), this_game: fix(f.rule.this_game) } } : {}), evidence: (f.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) })),
    ...(review.game_plan ? { game_plan: { ...Object.fromEntries(Object.entries(review.game_plan).map(([k, v]) => [k, PLAN_TEXTS.includes(k) ? fix(v) : v])), evidence: (review.game_plan.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) } } : {}),
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** A heading for a finding that still has none after the repair round: the opening sentence of its own (checked) claim, never new words. */
export function headingOf(f) {
  if (str(f?.title)) return f.title;
  const first = (str(f?.claim) ?? '').split(/(?<=[。；！？!?;])|(?<=\.)\s/)[0].replace(/[。；;.]$/, '');
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}
/** A finding's rule when it is whole (a situation and an action), else none: half a rule is not shown as one. */
function ruleOf(f, counts = null) {
  const when = str(f?.rule?.when); const act = str(f?.rule?.do); const seen = str(f?.rule?.this_game);
  // The model only says which count the rule is about; the numbers and the wording of the check are made from the replay.
  const check = when && act && counts ? counts(f.rule.counted_by, f.rule.counted_ability) : null;
  return { rule: when && act ? { when, do: act, ...(seen ? { this_game: seen } : {}), ...(check ? { check } : {}) } : undefined };
}
/**
 * What to change next game is the findings' rules, in their order — not a
 * second list written beside them that can drift from what was found. A
 * finding without a whole rule gives its fix.
 */
export function nextGame(findings, lang) {
  return (findings ?? []).map((f) => (f?.rule?.when && f.rule.do ? `${f.rule.when}${lang === 'zh' ? '：' : ': '}${f.rule.do}` : str(f?.fix))).filter(Boolean);
}

const REPAIR_HELP = {
  time: 'this time is not in any tool result',
  number: 'this number is not in any tool result',
  count: 'no tool gave this count; use the count a tool states (killed_by, by_target, *_total)',
  moment: 'the cited record does not hold this; cite the record that does, or remove it',
  ref: 'no tool record with this ref was returned in this conversation; copy a ref exactly',
  missing: 'this finding has no title: give it a heading of a few words',
  language: 'write this in the language of the rest of the review',
  key: 'this is a tool\'s key or field name, not words for the reader: say what it means in the language of the review (a hero or item by its name)',
  name: 'this is not a hero\'s name. If the hero in brackets is meant, write the name exactly as hero_names gives it; otherwise leave it',
  list: 'this time is picked out of a list it is not in: make the sentence agree with itself, using what the tools returned',
  approach: 'a rule cannot start from seeing an enemy come: the replay does not know what was on the player\'s screen. Rewrite the situation from what the player always has: their own health, which allies are near, which enemy heroes are missing from the minimap, the clock, their items',
  vague: 'an amount nobody counted: replace the word with the count a tool states ("4 of the 12 deaths"), or take the claim out',
  sight: 'the replay data has no vision: no tool can say who saw whom. State the distance or position a tool gave, or remove it',
};

export const REVIEW_CHECKPOINT_VERSION = 1;
/** The submitted review in an assistant message, or null: what a finished first pass ended on. */
function submittedIn(message) {
  const call = message?.tool_calls?.find((c) => c?.function?.name === SUBMIT_REVIEW.name);
  if (!call) return null;
  try { const args = JSON.parse(call.function.arguments); return args && typeof args === 'object' && !Array.isArray(args) ? args : null; } catch { return null; }
}
/**
 * A saved checkpoint, if it is well formed and for this hero, language and opening message. Whether the
 * replay still says what the saved conversation heard is checked by the caller (lookupAnswers below).
 * Anything else is no checkpoint, and the review starts from the beginning.
 */
function usableCheckpoint(cp, opening, hero, lang) {
  const state = (s) => s && Array.isArray(s.messages) && s.messages.length > 0 && Array.isArray(s.calls) && s.calls.every((c) => typeof c?.name === 'string')
    && Number.isInteger(s.steps) && Number.isFinite(s.usage?.input) && Number.isFinite(s.usage?.output) && s.messages[0]?.content === opening;
  if (!cp || cp.v !== REVIEW_CHECKPOINT_VERSION || cp.opening !== opening || cp.hero !== hero || cp.lang !== lang) return null;
  if (cp.first != null && !(state(cp.first) && submittedIn(cp.first.messages.at(-1)))) return null;
  if (cp.run != null && !(state(cp.run) && Number.isInteger(cp.run.tool_count))) return null;
  return cp.first || cp.run ? cp : null;
}

/**
 * What the lookups in a saved conversation answered, in order, as the model read it: the tool messages, without
 * the loop's own refusals (no tool ran for those), without the answers to a handed-in review, and without the
 * "not run" given to a lookup the model asked for in the same turn as it handed the review in.
 */
function lookupAnswers(messages) {
  const submitted = new Set(); const out = [];
  for (const m of messages) {
    if (m?.role === 'assistant') for (const c of m.tool_calls ?? []) if (c?.function?.name === SUBMIT_REVIEW.name) submitted.add(c.id);
    if (m?.role === 'tool' && !submitted.has(m.tool_call_id) && !/^\{"error":"(tool_budget_spent|invalid_arguments|unknown_tool|not_run|unsupported_facts)"/.test(String(m.content))) out.push(String(m.content));
  }
  return out;
}

/**
 * Run the investigation and return a verified review.
 *
 * `onCheckpoint` is handed, after every finished round of lookups, what is needed to continue this run
 * elsewhere: the conversation so far and which tools were asked (not their results: a tool's answer is a
 * pure function of the replay and is computed again). `checkpoint` is such an object from a run that was
 * cut off; the review then continues after its last finished round instead of starting over. One that does
 * not fit this hero and language is ignored, and so is one whose lookups answer differently now (the replay
 * was parsed again, or a tool changed): the saved conversation would be about another game.
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, plan?: string | null, match?: any, signal?: AbortSignal, onEvent?: (e: object) => void, maxSteps?: number, maxToolCalls?: number, checkpoint?: any, onCheckpoint?: (c: object) => void }} o
 */
export async function runDeepReview({ complete, trace, hero, lang, plan = null, match = null, signal, onEvent, maxSteps, maxToolCalls, checkpoint = null, onCheckpoint = null }) {
  const kit = reviewToolkit({ trace, hero, lang, match });
  if (!kit) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const { seat, language, context } = kit;
  // The loop's own cut of a long tool answer: a checkpoint is compared against answers cut the same way.
  const maxToolChars = AGENT_DEFAULTS.maxToolChars;
  const base = {
    complete, system: deepReviewSystem(language), tools: [...kit.tools, SUBMIT_REVIEW], signal, onEvent, maxSteps, maxToolCalls, maxToolChars,
    runTool: kit.runTool,
    isFinal: (call) => call.name === SUBMIT_REVIEW.name,
    finalTools: [SUBMIT_REVIEW.name],
  };
  const usage = { input: 0, output: 0 }; let steps = 0;
  const add = (r) => { usage.input += r.usage.input; usage.output += r.usage.output; steps += r.steps; };

  // The plan the player says they went for, when they named one: part of what the review is asked, so a
  // checkpoint made for another plan (or none) is never continued from.
  const stated = planByKey(planKey(plan));
  const opening = `Review this game for the player on ${seat.key}.${stated ? `\nThe player says their plan this game was to ${stated.for_the_model} (in their words: "${stated.said.en}"). Read the game against it in game_plan.against_your_plan.` : ''}\n${JSON.stringify(context)}`;
  let from = usableCheckpoint(checkpoint, opening, seat.key, language);
  // What a tool answered is not kept in a checkpoint: asked again, it answers the same.
  const again = async (calls) => { const out = []; for (const c of calls) { let result; try { result = await kit.runTool(c.name, c.args ?? {}); } catch { result = { error: 'tool_failed' }; } out.push({ name: c.name, args: c.args ?? {}, result }); } return out; };
  const pack = (s) => ({ messages: s.messages, calls: s.transcript.map((t) => ({ name: t.name, args: t.args })), steps: s.steps, usage: s.usage });
  const save = (first, run) => onCheckpoint?.({ v: REVIEW_CHECKPOINT_VERSION, hero: seat.key, lang: language, opening, first, run });
  // Continue only if every saved lookup answers now what the model read then.
  let firstAgain = null; let runAgain = null;
  if (from) {
    firstAgain = from.first ? await again(from.first.calls) : null;
    runAgain = from.run ? await again(from.run.calls) : null;
    const same = (t, answers) => t.length === answers.length && t.every((x, i) => toolContent(x.result, maxToolChars) === answers[i]);
    const firstAnswers = from.first ? lookupAnswers(from.first.messages) : [];
    if ((from.first && !same(firstAgain, firstAnswers)) || (from.run && !same(runAgain, lookupAnswers(from.run.messages).slice(firstAnswers.length)))) from = null;
  }
  const resumed = (s) => ({ steps: s.steps, calls: s.tool_count, usage: s.usage, transcript: runAgain });
  if (from) onEvent?.({ type: 'resumed', tools: [...(from.first?.calls ?? []), ...(from.run?.calls ?? [])] });

  let first;
  if (from?.first) {
    // The first pass was finished when the run was cut off: its submitted review stands.
    first = { status: 'final', final: submittedIn(from.first.messages.at(-1)), messages: from.first.messages, transcript: firstAgain, steps: from.first.steps, usage: from.first.usage };
  } else {
    first = await runAgent({
      ...base,
      messages: from?.run ? from.run.messages : [{ role: 'user', content: opening }],
      ...(from?.run ? { resume: resumed(from.run) } : {}),
      onCheckpoint: (s) => save(null, { ...pack(s), tool_count: s.calls }),
    });
  }
  add(first);
  if (first.status !== 'final') return { status: first.status === 'budget' ? 'budget' : 'no_review', steps, usage, transcript: first.transcript };
  let review = first.final; let transcript = first.transcript;
  const sources = () => [context, ...transcript.map((t) => t.result)];
  let check = verifyReview(review, sources());
  const firstProblems = check.problems;
  let repaired = false;
  if (!check.ok) {
    // One repair round: name exactly what is unsupported; the model may look it up or take it out.
    repaired = true;
    const lastCall = first.messages.at(-1).tool_calls.find((c) => c.function.name === SUBMIT_REVIEW.name);
    const done = pack(first);
    const midRepair = from?.first && from.run ? from.run : null;
    if (!midRepair) save(done, null);
    const second = await runAgent({
      ...base,
      ...(midRepair ? { resume: resumed(midRepair) } : {}),
      // The repair round's own counts start at zero; what it had used when cut off comes back with `resume`.
      onCheckpoint: (s) => save(done, { ...pack(s), tool_count: s.calls }),
      messages: midRepair ? midRepair.messages : [...first.messages, ...first.messages.at(-1).tool_calls.map((c) => ({
        role: 'tool', tool_call_id: c.id,
        content: c === lastCall ? JSON.stringify({ error: 'unsupported_facts', detail: 'Look each one up with a tool, or rewrite the sentence without it, then call submit_review again with the whole review.', problems: check.problems.map((p) => ({ in: p.where === 'plan' ? `game_plan.${PLAN_TEXTS[p.index]}` : p.where === 'plan_evidence' ? `game_plan.evidence ${p.index + 1}` : p.where === 'finding' ? `finding ${p.index + 1}` : p.where === 'title' ? `finding ${p.index + 1}, title` : p.where === 'rule' ? `finding ${p.index + 1}, rule.this_game` : `${p.where}${p.where === 'verdict' ? '' : ` ${p.index + 1}`}`, text: p.text, why: REPAIR_HELP[p.kind] })) }) : JSON.stringify({ error: 'not_run' }),
      }))],
    });
    add(second);
    if (second.status === 'final') { review = second.final; transcript = [...transcript, ...second.transcript]; check = verifyReview(review, sources()); }
  }
  // Whatever still states something the tools never said does not ship.
  // A finding goes when its own text is unsupported or none of its evidence holds; one bad evidence item alone
  // is left out and the finding stays on the rest.
  const bad = (where) => (where === 'finding' ? check.unsupported.findings : new Set(check.problems.filter((p) => p.where === where && !p.soft).map((p) => p.index)));
  // A model's arguments are not schema-checked: a finding may be null or carry evidence that is no list. Those are
  // dropped below (they cite nothing); here they are only passed through untouched.
  const holds = (f, i) => (Array.isArray(f?.evidence) ? { ...f, evidence: f.evidence.filter((_, j) => !check.unsupported.evidence.get(i)?.has(j)) } : f);
  const keep = (list, where) => (list ?? []).filter((_, i) => !bad(where).has(i));
  const fmtClock = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  // Each evidence item gets the game time of the first record it cites, for the reader.
  const keptIndex = (review.findings ?? []).map((_, i) => i).filter((i) => !bad('finding').has(i));
  const picked = goalFromReview(review.goal, { trace, hero: seat.key, findings: (review.findings ?? []).length, match });
  // The goal follows its finding; a goal whose finding was dropped goes with it.
  const goal = picked && keptIndex.includes(picked.finding - 1) ? { ...picked.spec, finding: keptIndex.indexOf(picked.finding - 1) + 1 } : null;
  // A rule whose "this game" states something the tools never said keeps its situation and action and loses that sentence.
  const unbacked = bad('rule');
  // The check for a count the model named: over the deaths, or over one of the hero's own abilities (by its
  // name in the ability data). Anything else — another hero's ability, an unknown key, a count of one — is no check.
  const counts = (habit, ability) => {
    if (HABITS[habit]?.from === 'deaths') { const d = deathContext(trace, { hero: seat.key }); return d.error ? null : habitGoal(habit, d); }
    if (HABITS[habit]?.from !== 'audit' || typeof ability !== 'string') return null;
    const a = abilityAudit(trace, { hero: seat.key, ability });
    const name = a.error ? null : abilityName(a.ability);
    const heroId = heroByKey(seat.key)?.id;
    // One of the hero's own abilities: they are named after the internal slug, which the replay's key may differ from.
    if (!name || heroId == null || !(a.ability.startsWith(`${seat.key}_`) || a.ability.startsWith(`${heroByKey(seat.key)?.internalSlug}_`))) return null;
    return habitGoal(habit, a, { hero: seat.key, hero_id: heroId, ability: a.ref.split(':')[2], name });
  };
  // One check per count: two rules about the same count would be judged as one thing twice.
  const counted = new Set();
  const once = (f) => { const h = f.rule?.check ? `${f.rule.check.habit}:${f.rule.check.ability ?? ''}` : null; if (!h) return f; if (counted.has(h)) { const { check, ...rule } = f.rule; return { ...f, rule }; } counted.add(h); return f; };
  const findings = (review.findings ?? []).map(holds).map((f, i) => (unbacked.has(i) && f?.rule ? { ...f, rule: { ...f.rule, this_game: undefined } } : f)).filter((_, i) => !bad('finding').has(i)).map((f) => once({ ...f, title: headingOf(f), ...ruleOf(f, counts) })).map((f) => ({ ...f, evidence: (f.evidence ?? []).map((e) => { const at = check.refs.get(e.refs?.[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmtClock(at) }), fact: e.fact }; }) }));
  const verdict = bad('verdict').size ? findings[0]?.title ?? '' : review.verdict ?? '';
  const gamePlan = planOf(review.game_plan, check.problems, check.refs, { stated: Boolean(stated) });
  return {
    status: findings.length ? 'ok' : 'unverified',
    review: nameHeroes({
      schema: DEEP_REVIEW_SCHEMA, prompt_version: DEEP_REVIEW_PROMPT_VERSION, match_id: trace.match_id, hero: seat.key, lang: language, ...(stated ? { plan: stated.key } : {}),
      // Which patch's prices, item effects and cooldowns the review's numbers are from, and how that patch is known.
      data_patch: kit.patch,
      verdict, mainline: keep(review.mainline, 'mainline'), findings, did_well: keep(review.did_well, 'did_well'), next_game: nextGame(findings, language), blind_spots: review.blind_spots ?? [],
      ...(gamePlan ? { game_plan: gamePlan } : {}),
      ...(goal ? { goal } : {}),
    }, context.hero_names, context.place_names),
    verification: { repaired, first_pass_problems: firstProblems.length, dropped: (review.findings ?? []).length - findings.length, problems: check.problems },
    // What did not ship, as it was written: for whoever has to find out why (never shown to the reader).
    dropped_findings: (review.findings ?? []).filter((_, i) => bad('finding').has(i)),
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    steps, usage,
  };
}
