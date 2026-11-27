// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EvidenceCard } from './EvidenceCard';
import * as api from './api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EvidenceCard auto-triggered cast & unknown proximity rendering', () => {
  it('renders unknown proximity cleanly when auto-trigger positions are missing (both null and partial null)', async () => {
    const spy = vi.spyOn(api, 'fetchEvidence');
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'cast:abaddon:borrowed_time:1',
      kind: 'cast',
      names: { abaddon_borrowed_time: '回光返照' },
      record: {
        clock: '10:00',
        trigger: 'auto',
        target: null,
        target_hp: null,
        target_spell_immune: null,
        target_stunned_seconds: null,
        me: null,
        allies_within_1300: null,
        enemies_within_1300: null,
        deaths_within_12s: [],
      },
    });
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'cast:abaddon:borrowed_time:2',
      kind: 'cast',
      names: { sven: '流浪剑客', abaddon_borrowed_time: '回光返照' },
      record: {
        clock: '15:00',
        trigger: 'auto',
        target: null,
        target_hp: null,
        target_spell_immune: null,
        target_stunned_seconds: null,
        me: { hp: 380, max_hp: 1200 },
        allies_within_1300: ['sven'],
        enemies_within_1300: null,
        deaths_within_12s: [],
      },
    });

    render(
      <ul>
        <EvidenceCard
          matchId="9106357143"
          hero="abaddon"
          lang="zh"
          item={{ clock: '10:00', fact: '回光返照自动触发', refs: ['cast:abaddon:borrowed_time:1', 'cast:abaddon:borrowed_time:2'] }}
          onAsk={() => {}}
        />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: '看原始记录' }));
    await waitFor(() => expect(screen.getAllByText(/自动触发/).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText('未知')).toBeTruthy();
    expect(screen.getByText('流浪剑客')).toBeTruthy();
    expect(screen.getByText('敌方 · 未知')).toBeTruthy();
  });

  it('renders skill_build card in en/zh/ru and handles missing ability level data gracefully', async () => {
    const spy = vi.spyOn(api, 'fetchEvidence');
    const sbRecord = {
      ref: 'skill_build:beastmaster',
      hero: 'beastmaster',
      data_patch: '7.42',
      at_level_6: { clock: '7:28', abilities: { beastmaster_wild_axes: 2, beastmaster_primal_roar: 1 } },
      at_level_10: { clock: '14:53', abilities: { beastmaster_wild_axes: 4, beastmaster_primal_roar: 1 } },
      maxed_order: [{ ability: 'beastmaster_wild_axes', name: 'Wild Axes', level: 4, clock: '12:13', hero_level: 8 }],
      ultimate_levels: [{ ability: 'beastmaster_primal_roar', name: 'Primal Roar', level: 1, clock: '7:30', hero_level: 6 }],
      talents: [{ ability: 'special_bonus_unique_beastmaster_2', name: '+30 Wild Axes Damage' }],
      upgrade_timeline: [
        { clock: '0:00', t: 0, hero_level: 1, ability: 'beastmaster_inner_beast', name: 'Inner Beast', ability_level: 1, initial: true },
        { clock: '7:30', t: 450, hero_level: 6, ability: 'beastmaster_primal_roar', name: 'Primal Roar', ability_level: 1, ultimate: true },
      ],
    };
    const names = { beastmaster: '兽王', beastmaster_wild_axes: '野性之斧', beastmaster_primal_roar: '原始咆哮', beastmaster_inner_beast: '野性之心' };
    spy.mockResolvedValueOnce({ status: 'ok', ref: 'skill_build:beastmaster', kind: 'skill_build', names, record: sbRecord });
    render(
      <ul>
        <EvidenceCard matchId="9100904020" hero="beastmaster" lang="zh" item={{ fact: '加点路线', refs: ['skill_build:beastmaster'] }} onAsk={() => {}} />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: '看原始记录' }));
    await waitFor(() => expect(screen.getByText(/6 级加点/)).toBeTruthy());
    expect(screen.getByText(/10 级加点/)).toBeTruthy();
    expect(screen.getByText(/点满顺序/)).toBeTruthy();
    expect(screen.getByText(/大招升级/)).toBeTruthy();
    expect(screen.getByText('+30 Wild Axes Damage')).toBeTruthy();
    expect(screen.getByText('初始')).toBeTruthy();

    cleanup();
    spy.mockResolvedValueOnce({
      status: 'ok', ref: 'skill_build:beastmaster', kind: 'skill_build', names: { beastmaster: 'Beastmaster' },
      record: { ref: 'skill_build:beastmaster', hero: 'beastmaster', data_patch: '7.42', upgrade_timeline: null, at_level_6: null, at_level_10: null, maxed_order: null, ultimate_levels: null, talents: null },
    });
    render(
      <ul>
        <EvidenceCard matchId="9100904020" hero="beastmaster" lang="ru" item={{ fact: 'Прокачка', refs: ['skill_build:beastmaster'] }} onAsk={() => {}} />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Показать запись' }));
    await waitFor(() => expect(screen.getByText('В этом реплее нет данных об уровнях способностей.')).toBeTruthy());
  });

  it('renders bilateral death context, hides noisy low-HP rows in deaths summary, and shows me_in_fight on fights card', async () => {
    const spy = vi.spyOn(api, 'fetchEvidence');
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'death:beastmaster:9',
      kind: 'death',
      names: {
        venomancer: 'Venomancer', axe: 'Axe', necrolyte: 'Necrophos',
        venomancer_noxious_plague: 'Noxious Plague', venomancer_venomous_gale: 'Venomous Gale',
        spirit_vessel: 'Spirit Vessel', dire_top_lane: 'Dire top lane',
      },
      record: {
        clock: '36:05',
        killer: 'necrolyte',
        snapshots: [{
          dt: -12,
          me: { hp: 2915, max_hp: 2915 },
          enemies: [{ hero: 'venomancer', dist: 1647, hp: 1800, max_hp: 1820, hp_pct: 99, mana: 1406, level: 18 }],
        }],
        enemy_context_at_window_start: [{
          hero: 'venomancer', dist: 1647, hp_pct: 99, mana: 1406, level: 18,
          ready_abilities: ['venomancer_noxious_plague'],
          no_mana_abilities: [],
          on_cooldown_abilities: [{ ability: 'venomancer_venomous_gale', cooldown_left: 6.1 }],
          key_items: [{ item: 'spirit_vessel', ready: true }],
        }],
        attackers_arrived_after_window_start: [
          { hero: 'axe', dist_at_window_start: 3566, place_at_window_start: 'dire_top_lane' },
        ],
        enemy_active_buffs_in_window: {
          smokes: [{ hero: 'axe', by: 'venomancer', from: '35:50', until: '36:00' }],
          runes: [],
        },
        ready_not_cast: [],
        controls_on_me: [],
        damage_taken: [{ from: 'necrolyte', by: 'attack', value: 500 }],
      },
    });
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'deaths:beastmaster',
      kind: 'deaths',
      names: { beastmaster: 'Beastmaster' },
      record: {
        ref: 'deaths:beastmaster',
        ref_scope: 'summary',
        hero: 'beastmaster',
        deaths_total: 4,
        deaths_where: {
          health_below_half_at_window_start: ['1:00', '2:00'],
          health_below_half_at_window_start_outside_fights: ['1:00'],
          three_or_more_enemy_heroes_dealing_damage: ['8:27', '22:06'],
        },
      },
    });
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'fights:beastmaster:9',
      kind: 'fights',
      names: { beastmaster: 'Beastmaster', phantom_assassin: 'Phantom Assassin', pipe: 'Pipe of Insight' },
      record: {
        ref: 'fights:beastmaster:9',
        clock: '25:25',
        engaged_at: '25:10',
        me: 'took_part',
        me_in_fight: {
          died: true,
          hero_damage_dealt: 946,
          hero_damage_taken: 2808,
          enemy_deaths_i_damaged: 1,
          ult_cast: true,
          key_items_used: ['pipe'],
        },
        my_team: { deaths: 3, took_part_count: 1, took_part: ['beastmaster'], ultimates_ready: [], ultimates_not_ready: [], black_king_bars_ready: [], not_in_it: [] },
        enemy: { deaths: 1, took_part_count: 1, took_part: ['phantom_assassin'], ultimates_ready: [], ultimates_not_ready: [], black_king_bars_ready: [], not_in_it: [] },
      },
    });

    render(
      <ul>
        <EvidenceCard
          matchId="9100904020"
          hero="beastmaster"
          lang="en"
          item={{ clock: '36:05', fact: 'Died to collapse', refs: ['death:beastmaster:9', 'deaths:beastmaster', 'fights:beastmaster:9'] }}
          onAsk={() => {}}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show the record' }));
    await waitFor(() => expect(screen.getByText('Enemies within 2200 at window start')).toBeTruthy());
    // Snapshot shows enemy hp_pct, mana, level.
    expect(screen.getAllByText(/1647 · 99% · 1406 MP · Lv18/).length).toBeGreaterThanOrEqual(2);
    // Bilateral enemy abilities, items, arrived attackers, and smoke rendered.
    expect(screen.getByText(/ready · Noxious Plague/)).toBeTruthy();
    expect(screen.getByText(/CD · Venomous Gale 6\.1s/)).toBeTruthy();
    expect(screen.getByText(/items · Spirit Vessel/)).toBeTruthy();
    expect(screen.getByText('Attackers arrived after window start')).toBeTruthy();
    expect(screen.getByText(/Dire top lane · 3566 away/)).toBeTruthy();
    expect(screen.getByText(/Smoke/)).toBeTruthy();
    // Noisy low-HP rows are NOT rendered in deaths summary card even if present on a legacy record.
    expect(screen.queryByText(/below half health/i)).toBeNull();
    expect(screen.getByText(/Deaths to three or more enemy heroes/)).toBeTruthy();
    // Fight card renders me_in_fight stats.
    expect(screen.getByText('Your contribution')).toBeTruthy();
    expect(screen.getByText('946')).toBeTruthy();
    expect(screen.getByText('2808')).toBeTruthy();
    expect(screen.getByText(/ultimate cast · yes/)).toBeTruthy();
    expect(screen.getByText(/items used · Pipe of Insight/)).toBeTruthy();
  });

  it('renders lane 10:00 outcomes (gold, gold diff, LH, deaths, source, passive-income note) on draft evidence cards', async () => {
    const spy = vi.spyOn(api, 'fetchEvidence');
    spy.mockResolvedValueOnce({
      status: 'ok',
      ref: 'draft:beastmaster',
      kind: 'draft',
      names: { beastmaster: 'Beastmaster', undying: 'Undying', phantom_assassin: 'Phantom Assassin', venomancer: 'Venomancer', skywrath_mage: 'Skywrath Mage', necrolyte: 'Necrophos' },
      record: {
        ref: 'draft:beastmaster',
        lanes: [
          {
            lane: 'bot',
            my_team: ['beastmaster', 'undying'],
            enemy: ['phantom_assassin', 'venomancer'],
            solo: { my_team: false, enemy: false },
            at_10_00: {
              my_team_deaths_before_10_00: 4,
              enemy_deaths_before_10_00: 2,
              my_team_gold: 5600,
              enemy_gold: 6300,
              gold_diff: -700,
              my_team_last_hits: 59,
              enemy_last_hits: 72,
              source: 'match_record',
            },
            pairings: [],
          },
          {
            lane: 'mid',
            my_team: ['skywrath_mage'],
            enemy: ['necrolyte', 'venomancer'],
            solo: { my_team: true, enemy: false },
            at_10_00: {
              my_team_deaths_before_10_00: 1,
              enemy_deaths_before_10_00: 0,
              my_team_gold: 1900,
              enemy_gold: 3100,
              gold_diff: null,
              my_team_last_hits: 40,
              enemy_last_hits: 55,
              source: 'replay',
              passive_income_omitted: true,
            },
            pairings: [],
          },
        ],
      },
    });

    render(
      <ul>
        <EvidenceCard
          matchId="9100904020"
          hero="beastmaster"
          lang="en"
          item={{ clock: '10:00', fact: 'Bot lane trailed by 700 gold at 10:00', refs: ['draft:beastmaster'] }}
          onAsk={() => {}}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show the record' }));
    await waitFor(() => expect(screen.getByText(/5600 : 6300/)).toBeTruthy());
    expect(screen.getByText(/−700/)).toBeTruthy();
    expect(screen.getByText(/59 : 72/)).toBeTruthy();
    expect(screen.getByText(/4 : 2/)).toBeTruthy();
    expect(screen.getByText('match record')).toBeTruthy();
    expect(screen.getByText(/1900 : 3100/)).toBeTruthy();
    expect(screen.getByText('replay log')).toBeTruthy();
    expect(screen.getByText('passive gold omitted')).toBeTruthy();
  });
});
