import { describe, expect, it } from 'vitest';
import { itemInfo } from '../../lib/coach/analyze.js';

describe('7.42 items in the coach names table', () => {
  it('names new items and keeps removed ones for older matches', () => {
    expect(itemInfo('caduceus')).toMatchObject({ en: 'Caduceus', zh: '双蛇杖', img: expect.stringContaining('/items/caduceus.png') });
    expect(itemInfo('skypiercer').img).toBeTruthy();
    // Gone from the current item list, still needed to render 7.41 games.
    expect(itemInfo('desolator_2').img).toBeTruthy();
  });
});
