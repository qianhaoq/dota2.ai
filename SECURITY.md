# Security Policy

简体中文说明见下方 / Chinese notes below.

## Reporting a vulnerability (EN)

- **Do not open a pull request with a working exploit**, and do not open a
  public issue containing secrets, tokens or match IDs you do not own.
- Report suspected vulnerabilities through **GitHub Issues on this repository**
  with a clear reproduction and affected file paths; a maintainer will reply
  and, if confirmed, convert the thread into a private advisory.
- There is no personal contact email for security reports — GitHub Issues is
  the channel.

## Scope notes

- `.env` is gitignored. Never commit `DEEPSEEK_API_KEY` or
  `STEAM_WEB_API_KEY`. If a key leaks, rotate it at the provider first, then
  clean history.
- The server is a hobby-scale Express app: it assumes a trusted frontend and
  rate-limits upstream providers only. Do not expose it unauthenticated to the
  public internet without your own gateway.
- User notes (战术笔记) are stored in the browser's localStorage only; they are
  never uploaded. Exporting notes is a manual, local action.

## Recommended repo settings

Enable in **Settings → Code security**:

1. **Secret scanning** (and **push protection** where available) — catches
   DeepSeek/Steam keys before they land on the default branch.
2. **Dependabot alerts** for the npm dependency tree.
3. Keep branch protection requiring the CI checks (`npm test`, `tsc`, `build`).

---

## 漏洞报告（中文）

- 请通过本仓库的 **GitHub Issues** 反馈疑似漏洞，附复现步骤与涉及文件。
- 不要在公开 Issue 或 PR 中粘贴密钥、token 或他人比赛 ID。
- 本仓库不提供个人邮箱作为安全联系渠道。
- `.env` 已被 gitignore；密钥一旦泄露请先在服务商处轮换，再清理历史。
- 战术笔记只保存在浏览器本机 localStorage，不会上传；导出为用户手动操作。
