The item and ability dictionary is keyed by the original replay/OpenDota key.
Names were checked on 2026-11-15 against Valve's public, localized datafeeds:

- https://www.dota2.com/datafeed/itemlist?language=schinese
- https://www.dota2.com/datafeed/abilitylist?language=schinese

`name_loc` supplies Simplified Chinese; `name_english_loc` supplies English.
For older keys absent from the feed, the known English dname comes from Valve's
tracked localization file:
https://github.com/SteamDatabase/GameTracking-Dota2/blob/master/game/dota/pak01_dir/resource/localization/abilities_english.txt
Existing bilingual entries are retained where applicable. Hero names use
static-heroes.json. Missing Chinese uses the known official English dname;
unknown item/ability ids use a neutral unknown label, never a title-cased slug.
Recipe labels are independent dictionary entries, not inferred item names.
