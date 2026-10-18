// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TopBar from './TopBar';
import { I18nProvider } from '../i18n/I18nProvider';

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <Routes>
          <Route path="*" element={<TopBar />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );

describe('TopBar — "Sample data" badge', () => {
  afterEach(() => cleanup());

  it('shows the badge on the sample match route', () => {
    renderAt('/m/9035042364?hero=pudge');
    expect(screen.getByText('Sample data')).toBeTruthy();
  });

  it('localizes the badge on the sample match (zh)', () => {
    renderAt('/m/9035042364?lang=zh');
    expect(screen.getByText('示例数据')).toBeTruthy();
  });

  it('hides the badge on the home page', () => {
    renderAt('/');
    expect(screen.queryByText('Sample data')).toBeNull();
  });

  it('hides the badge on the /new alias of home', () => {
    renderAt('/new');
    expect(screen.queryByText('Sample data')).toBeNull();
  });

  it('hides the badge on any other match', () => {
    renderAt('/m/8985182860');
    expect(screen.queryByText('Sample data')).toBeNull();
  });
});

describe('TopBar — feedback modal portal', () => {
  beforeEach(() => {
    // The badge tests persist ?lang=zh — reset so the aria-labels are English.
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it('portals the feedback overlay to document.body, outside the blurred header', async () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open the feedback form' }));

    const dialog = await screen.findByRole('dialog');
    // The fixed overlay must be a direct child of <body>: the header's
    // backdrop-blur would otherwise contain/blurr the whole modal.
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.closest('header')).toBeNull();
  });
});
