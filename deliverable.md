# 孤舰 · MINISHIP · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

一支舰队要摆进一张海图，而图上的数字只告诉你每一行、每一列各有几个格子被船占着。

- 仓名：`z-biz-game-minishop-cos`　组别：E · 生成艺术与交互视觉
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm start    # node server.cjs
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |
| npm verify | `npm run verify` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 52 |
| 应用代码 | 3,827 行（JS 3,529 / CSS 199 / HTML 99） |
| 测试/工具文件 | 17 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 0 |
| 位图资产（不含 shots） | 6 个 / 267 KB |

## 目录

```
.github .gitignore LICENSE README.md css electron icons index.html js manifest.webmanifest package.json server.cjs sw.js test tools
```

## 已知边界

README 没有单列“未实现/限制”小节；以 README 正文与仓内闸为准。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-minishop-cos --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
