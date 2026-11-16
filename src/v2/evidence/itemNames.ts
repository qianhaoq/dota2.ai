/** Shared id-keyed dictionary; absent translations use official English, unknown ids a neutral label. */
import { itemName } from '../../../packages/review-engine/src/insights/moments.js';
export type ItemLang = 'en' | 'zh';
export function humanizeItemSlug(_slug: string): string { return 'Unknown item'; }
export function itemDisplayName(slug: string, lang: ItemLang = 'en'): string { return itemName(slug, lang); }
