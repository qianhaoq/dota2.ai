// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { SafeImg } from './CoachApp';

afterEach(cleanup);

describe('SafeImg', () => {
  it('shows a placeholder for a failed URL and retries when the src changes', () => {
    const { container, rerender } = render(<SafeImg src="https://cdn/a.png" alt="A" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.cx-img-missing')).not.toBeNull();
    rerender(<SafeImg src="https://cdn/b.png" alt="B" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn/b.png');
  });
});
