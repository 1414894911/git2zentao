# 代码平台接口差异（Gitea / GitHub / Gitee）

三者都提供「按时间范围列出仓库提交」的接口，但路径前缀、鉴权头、作者过滤能力不同。
本技能通过 `config.repos[].source` 自动选择实现，**baseUrl 只填主机根**，API 前缀由脚本拼接。

| 项目 | Gitea | GitHub | Gitee |
|---|---|---|---|
| API 前缀 | `/api/v1` | 根（`api.github.com`） | `/api/v5` |
| 提交列表 | `GET /repos/{owner}/{repo}/commits` | 同左 | 同左 |
| 时间过滤 | `since` / `until`（ISO8601） | `since` / `until` | `since` / `until` |
| 作者过滤 | `author` 参数支持 | `author` 参数支持（GitHub 账号或邮箱） | **不支持**，需客户端二次筛选 |
| 鉴权头 | `Authorization: token <TOKEN>` | `Authorization: Bearer <TOKEN>` + `Accept: application/vnd.github+json` | `Authorization: token <TOKEN>` |
| 分页 | `page` / `limit`（默认 50） | `page` / `per_page`（≤100） | `page` / `per_page`（≤100） |
| 单仓库提交数上限 | 无硬限制 | 1000（概览接口另有约束） | 无硬限制 |

## 作者匹配策略

脚本采用「客户端统一二次筛选」，避免平台差异：

1. `config.authors.accounts`：平台登录名（如 `zhangsan`）
2. `config.authors.displayNames`：中文姓名（如 `张三`）
3. `config.authors.emails`：提交邮箱

任一字段命中即计入。这样即使平台不返回登录名（Gitee 只返回 author_name），只要提交者姓名与 displayNames 一致仍可命中。

## 本地 git 兜底（推荐首选）

若本机已克隆仓库，本地 `git log` 比 API 更快、更完整，且**不需要任何凭据**：

```bash
git -C <repo> log --all --no-merges \
  --since=2026-07-01 --until=2026-08-01 \
  --author="zhangsan\|张三" \
  --date=format:%Y-%m-%d --pretty=format:'@@@%H|%ad|%an|%ae|%s' --name-only
```

**注意两点**：
1. `--author` 使用 POSIX 基本正则，多身份之间的 `|` 必须转义为 `\|`，否则匹配为空（会误判为「本人无提交」）。
2. `--since/--until` 作用于**提交日期**（committer date），与作者日期可能不同；跨时区协作时建议核对几条样本。

## 何时必须用远程 API

- 目标仓库本机未克隆
- 需要统计同事/其他账号的提交（本地副本可能未 fetch 全部分支）
- 需要覆盖 `--all` 之外的远端分支

此时在 `config.platforms` 填 token，并把对应仓库的 `source` 改为 `gitea` / `github` / `gitee`，并补 `owner` 与 `repo` 字段。

## 凭据安全

- Token 只写入本机 `config.json`，该文件不应纳入版本控制（建议在技能目录加 `.gitignore`：`config.json`、`out/`）。
- 分享技能包时只分享 `config.example.json`。
- Token 权限建议最小化：仅需仓库的读权限（Gitea: `read:repository`；GitHub: `repo` 或 fine-grained `Contents: Read`；Gitee: `projects`）。
