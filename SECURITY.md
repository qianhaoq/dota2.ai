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
  rate-limits upstream providers. AI routes (`/api/chat`, `/api/analyze`,
  `/api/playbook`, `POST /api/suggestions`, `POST /api/review/:matchId`) have
  in-memory, per-instance per-IP rate limits (`LLM_RATE_*`, see README). Only
  validated, LLM-bound requests consume budget (invalid 400s, cache hits and
  deterministic fallbacks never count), and IPv6 clients are keyed by their
  `/64` prefix so address rotation inside one block cannot multiply a budget.
  A generous global cost guard per group (`LLM_GLOBAL_GUARD_*`) never answers
  429: review serves the deterministic fallback cards/template, playbook the
  data-only answer, and chat/analyze the same generic 502 `ai_unavailable` as a
  provider outage (suggestions never calls an LLM and has no global guard). These are still **not**
  authentication, and the limits are not shared
  across instances (effective cap ≈ instances × limit). Do not expose the
  service unauthenticated to the public internet (including Cloud Run with
  `--allow-unauthenticated`) without your own edge layer — prefer
  IAM-authenticated Cloud Run, or IAP / API Gateway / Cloud Armor (or an
  equivalent reverse proxy) for auth and abuse controls until app-level auth
  lands.
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
- 当前 AI 接口已有按 IP 的进程内限流（`LLM_RATE_*`，每个实例独立计数，实际上限约为实例数 × 配置值），但仍无应用层鉴权；不要用裸 `--allow-unauthenticated` 把 Cloud Run（或其它公网 URL）直接暴露出去。请用 IAM 鉴权，或 IAP / API Gateway / Cloud Armor 等网关挡在前面，直到应用内鉴权落地。
- 战术笔记只保存在浏览器本机 localStorage，不会上传；导出为用户手动操作。
