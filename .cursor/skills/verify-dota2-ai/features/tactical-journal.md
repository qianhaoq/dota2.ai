# 战术笔记

战术笔记 lists locally saved trigger / action / check notes. The journal page does not create notes itself: a user saves from 英雄修炼 (`加入计划 →`) or 装备取舍, then marks, removes, undoes, or exports on this page.

## Sub-features

- `journal-empty` shows `还没有保存的动作。` on a fresh profile.
- `journal-save-from-training` persists one note via 英雄修炼 `加入计划 →`.
- `journal-complete` toggles `标记已自我检查` / `标记待练`.
- `journal-remove-undo` removes a note and restores it with `撤销刚才的移除`.
- `journal-export` enables `导出笔记` only when a note exists (downloads `dota2-tactical-notes.txt`).

## How to get to it (user POV)

- Choose `战术笔记` in `主导航` or `移动端导航`.
- Follow `#journal`.
- After saving in 英雄修炼, the shell toast `已保存到战术笔记` appears; then open 战术笔记 to read the note.

## Driving it with verify-dota2-ai

Preconditions:

- Doctor reports `ok: true`.
- Language is 中文.
- Chrome user-data-dir is the helper's disposable profile so `localStorage` key `dota-v3-tactical-notes` starts empty.
- DeepSeek is not required. The training drill is local.

- **Empty.** Run `verify-dota2-ai drive tactical-journal`. The helper opens `{uiOrigin}/#journal`. Heading `下一局，只带走一个能执行的动作。` and empty copy `还没有保存的动作。` appear. `导出笔记` is disabled.
- **Create via training.** Choose `英雄修炼`. Heading `先做决定，再看教练怎么拆解。` appears. Choose `等队友明确发起后，再选入口`, then `确认判断 · 看拆解 →`. After the local breakdown, choose `加入计划 →`. Status `已保存到战术笔记` (toast `role=status`) appears and the button becomes `已在战术笔记中`.
- **Read back.** Choose `战术笔记`. The note title `信息不完整时，先说清一个缺口` is listed with rows `触发` / `行动` / `检查`.
- **Complete.** Choose `标记已自我检查`. The tag includes `已自我检查`.
- **Remove and undo.** Choose `移除` (`aria-label="移除"`). Choose `撤销刚才的移除`. The same title returns.
- **Proof.** `empty.png`, `after.png`, and `restored.png` plus `page.txt` show the empty state, the saved title, and the restored title. Do not write `localStorage` from the console.

## Gotchas

- There is no “new note” control on this page. Creating only through `journalStore` or a test helper is not a user proof.
- Save keys are `drill-<heroId|free>-<variant>`. Saving the same drill twice is a duplicate and will not add a second row.
- Completing a note is self-report copy (`已自我检查`), not a measured skill gain.
- Headless Chrome may not keep a user-visible download for `导出笔记`. Prefer the on-page list as mutation proof; treat the download as optional.
- Cleanup deletes the Chrome profile, so the next launch is empty again. Evidence files stay on disk.
