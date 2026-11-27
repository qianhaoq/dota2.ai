import React from 'react';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { configureDota2AiRuntime } from '../../../../src/runtime/dota2aiRuntime';
import { clearAgentCaches } from '../../../../src/agent/api';
import { clearCardsCache } from '../../../../src/coach/api';
import coachCss from '../../../../src/coach/coach.css';
import cardsCss from '../../../../src/coach/cards.css';
import reviewCss from '../../../../src/coach/review.css';
import agentCss from '../../../../src/agent/agent.css';
import patchCss from '../../../../src/patch/patch.css';
import dshOverridesCss from './dsh-overrides.css';
import remoteInfo from '../typert.js';
import { TOOL_NAMES } from '../toolNames.js';
import { Dota2AiPanel, type PanelNavigationState } from './Dota2AiPanel';
import { NavIcon, ToolCard } from './ToolCard';
import { en, zh, type LocaleKey } from './locales';
import { createDshApiFetch, mountProfileSync, type Dota2AiClientRemote } from './transport';

export const inject = [
  'slots',
  'locale',
  'remote',
  'layout',
  'uiWorkspace',
  'sessions',
  'conversation',
];

const PANEL_ID = 'dota2ai';
const COMBINED_CSS = [coachCss, cardsCss, reviewCss, agentCss, patchCss, dshOverridesCss].join('\n');

export async function apply(ctx: any): Promise<void> {
  const unmountRemote = await ctx.remote.$mount(remoteInfo);
  ctx.effect(() => unmountRemote);

  ctx.effect(() => ctx.locale.register('dota2ai', { zh, en }));

  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dota2ai';
    tag.textContent = COMBINED_CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  });

  ctx.inject(['remote.dota2ai'], (scope: any) => {
    const remote = scope.remote.dota2ai as Dota2AiClientRemote;
    const t = scope.locale.bind('dota2ai') as (key: LocaleKey) => string;
    const navStore = createSnapshotStore<PanelNavigationState>({ path: '', revision: 0 });

    const openPath = (path: string, sessionId?: string) => {
      const snap = navStore.getSnapshot();
      navStore.set({
        path,
        revision: snap.revision + 1,
        ...(sessionId ? { sessionId } : snap.sessionId ? { sessionId: snap.sessionId } : {}),
      });
      scope.layout.selectPanel(PANEL_ID);
    };

    const apiFetch = createDshApiFetch(remote);
    const disposeRuntime = configureDota2AiRuntime({
      surface: 'dsh',
      publicOrigin: 'https://dota2.ai',
      apiFetch,
      onDiscussInHost: async ({ text }) => {
        const sessionId = navStore.getSnapshot().sessionId;
        if (sessionId) {
          const binding = scope.sessions?.binding?.(sessionId);
          if (binding && scope.conversation?.input?.requestDraftInitialization) {
            const res = scope.conversation.input.requestDraftInitialization(binding, {
              prompt: text,
              whenDraftExists: 'append',
            });
            if (res !== 'blocked') {
              scope.uiWorkspace.openSession(sessionId);
              return;
            }
          }
        }
        scope.uiWorkspace.startSession(undefined, { prompt: text, whenDraftExists: 'append' });
      },
    });

    let disposeProfile = () => {};
    void mountProfileSync(remote).then((fn) => {
      disposeProfile = fn;
    });

    scope.effect(() => () => {
      disposeProfile();
      disposeRuntime();
      clearAgentCaches();
      clearCardsCache();
    });

    scope.slots.inject('main', () =>
      scope.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          locale: 'dota2ai',
          inject: () => ({ hooks: { nav: navStore } }),
        },
        Dota2AiPanel,
      ),
    );

    scope.slots.inject('sidebar.panellist', () =>
      scope.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: 'dota2ai',
          label: () => t('title'),
        },
        NavIcon,
      ),
    );

    for (const toolName of TOOL_NAMES) {
      scope.slots.inject('tool.call.toolview', () =>
        scope.slots.register(
          {
            name: 'tool.call.toolview',
            key: toolName,
            locale: 'dota2ai',
            inject: (sessionId: string) => ({
              openPath: (path: string) => openPath(path, sessionId),
            }),
          },
          ToolCard,
        ),
      );
    }
  });
}
