# 孤舰 · MINISHIP

一支舰队要摆进一张海图，而图上的数字只告诉你**每一行、每一列各有几个格子被船占着**。
把船放对，行数和列数同时兑现，且没有两条船挨着——这就是这一关的唯一解。

每一关的解数 = 1 由逐行穷举计数器（`js/core/count.js`）证明，推理深度 k 由只用局部规则的
逻辑求解器（`js/core/logic.js`）量出。关卡文件 `js/data/puzzles.js` 是 `tools/bake.mjs` 的
**测量结果**，不是手写题目：改一个数字，`node test/puzzles.test.mjs` 会把两道证明重跑一遍并拒绝。

线上地址：<https://z-biz-game.github.io/z-biz-game-minishop-cos/>

---

## 规则

海图外围是线索：第 r 行的数字 = 这一行里被船占住的格子数，第 c 列同理。
`-` 是自由行/列（`FREE = -1`，`js/core/model.js`），它不约束占格数。
船的长度由这一档的舰队清单给出，可以横放也可以竖放。

判定由 `js/core/check.js` 做，它是**独立检查器**：不调用位掩码、不调用行计划、
不 import 计数器与求解器，只用嵌套循环和一张朴素占格表把上面那句话重新推一遍。
它按顺序检查六件事，任何一件不对就返回一句人话：

| # | 判据 | 不成立时它说的话（原文） |
|---|---|---|
| 1 | 题面自洽：Σ行线索 = Σ列线索 = Σ船长 | `Σ(row clues) = ${rowSum} but Σ(column clues) = ${colSum}` |
| 2 | 每条船都在图内 | `ship ${i} runs off the right edge` |
| 3 | 两条船不共格 | `ship ${i} shares a cell with an earlier ship` |
| 4 | 两条船不挨着——边和角都算（Akaji 规则） | `ships ${ship.i} and ${owner.i} touch` |
| 5 | 每条受约束的行/列恰好占那么多个格 | `row ${r} holds ${n} occupied cells, the clue says ${spec.rowReq[r]}` |
| 6 | 放下的长度多重集正好是舰队清单 | `the fleet wants ${n} ship(s) of length ${len}` |

第 1 条那句恒等式是整个游戏的地基：三种数同一批格子的方法必须互相同意，
否则这道题根本不描述任何一支舰队，而计数器对它的任何意见都不值得印出来。

## 玩法

拖船下水，或者先用键。`js/main.js` 认这四个键：

| 键 | 做什麼 | 计不计入 |
|---|---|---|
| `r` | 转身（横↔竖） | 免费：不加操作数、不加放置步数 |
| `h` | 提示一步 | `hints++`，本关最好成绩从此封顶 2 星 |
| `u` | 撤销上一步 | 弹 `history`，放置步数与操作数一起退回去 |
| `0` | 重来 | 清图、清档面上的这一局 |

两个计数器各管各的事（`js/core/game.js`）：

- `steps`（放置步数）只有**把一条船放下去**才会 +1，下限 `par = 舰队条数`——每条船至少要下水一次。
- `ops`（操作数）记每一次动作：放船、捞回船、点水标记都算一次，转身不算。
- 点水（在一格上按一下）是给自己记"这里不会是船"，它花一次操作，不花放置步数。

评星只看这两个计数器与提示（`grade()`）：

| 成绩 | 条件 | 标记 |
|---|---|---|
| 3 星 | `steps == par` 且 `hints == 0` | 一子不差 |
| 2 星 | `hints > 0` | 有人指路 |
| 1 星 | `steps > par` | 勉强成军 |

## 菜单：四档，难度是量出来的

`js/data/puzzles.js` 里的 `TIERS_META` 与 `PUZZLES`。这里印的每一个数都由
`node test/doctest.test.mjs` 现读比对，抄不动也漂不动。

| 档 | key | 图 | 舰队 | 题数 | 推理深度 k |
|---|---|---|---|---|---|
| 近岸 | harbour | 4×4 | 2, 1 | 12 | 0 |
| 巡航 | patrol | 6×6 | 4, 3, 2 | 12 | 1 |
| 拐角 | crossing | 7×7 | 5, 4, 3, 2 | 12 | 2 |
| 孤舰 | lone | 8×8 | 6, 5, 3, 1 | 12 | 3 |

合计 48 题，每一题的 `depth` 都恰好落在它那一档的 k 上，`guesses` 是求解器为了到位被迫
假设的层数。**深度 k 的意思是**：只用"局部规则"（某行满了就封掉剩下的格、某格邻边被占就
排除某条船…）能推到第 k 层就得停下来猜——k 越大，人需要同时 hold 的推理链越长。

## 难点：这四件事以前都撒过谎

1. **自记的答案会说谎。** 出题器补/挖线索之后，`board.black` 就不再是任何一个解了。
   出货前必须用计数器那张覆盖回去，再对整盘 verify；`test/puzzles.test.mjs` 现在做的就是这件事。
2. **精确覆盖计数器要去重候选。** 同一批格子被不同放置顺序走到的话，一个分区会被数成好几解，
   于是"多解/钉不死/liar"全是乘出来的假象。唯一性按同块关系定义，不按候选 id 定义。
3. **撞预算先换挑格启发式，别急着说"成本无界"。** 行序 DFS 的长尾是自己写坏的：同一张盘
   200M 节点换 MRV 之后是 1,637。
4. **转一条已经下水的船要把足迹一起转过去。** 2026-10-02 那次三条浏览器腿全红、
   100 条逻辑断言全绿——`rotate()` 只改 `axis`、不改 `grid`/`own`，逻辑层看不出，
   只有真 DOM 才看得见。这条现在由台账 K1 看着。

## 六道闸与实测条数

一条命令跑完：`bash tools/verify.sh`（加 `BROWSER=1` 连浏览器闸一起跑）。

### 逻辑闸（7 道）

| 闸 | 命令 | 条数 |
|---|---|---|
| syntax | `node --check` 扫 js/ server.cjs electron/ tools/ test/ | NA（数文件） |
| check | `node test/check.test.mjs` | 13 |
| count | `node test/count.test.mjs` | 13 |
| game | `node test/game.test.mjs` | 18 |
| logic | `node test/logic.test.mjs` | 17 |
| puzzles | `node test/puzzles.test.mjs` | 15 |
| server | `node test/server.test.mjs` | 24 |
| doctest | `node test/doctest.test.mjs` | 22 |

六道证明闸合计 100 条断言，全部钉在 `tools/verify.sh` 的 `LOGIC_EXPECTS` 里：
条数只减不红——删掉一条 `test()` 会让那道闸继续绿，所以 `verify.sh` 比的是**条数本身**。

### 浏览器闸（每种 URL 形态 11 份报告 × 2 种形态）

形态是 `http://127.0.0.1:5275/`（根）与 `http://127.0.0.1:5275/z-biz-game-minishop-cos/`
（Pages 的前缀形态）；部署之后还可以用 `BASE_URL` 追加第三种。
端口 **5275 / 9375** 是本仓专属的一对，撞号就有预检拒绝起跑——附到别人的 Chrome 上，
比附不到 Chrome 更危险：后者一定红，前者会替别人通过。

| run | 腿 | 条数 | 在证什么 |
|---|---|---|---|
| boot | core | 14 | 首屏装配、readout 与实际盘面一致 |
| routes | core | 14 | 四档路由与解锁只放行当前档 |
| play | play | 25 | 真实拖放、冲突、点水、撤销的 DOM 反应 |
| win | win | 14 | 收尾要独立检查器签名，落子那一刻才算完 |
| pointer | mouse | 20 | 指针→格子的几何映射（含 dpr/缩放） |
| touch | touch | 13 | 触屏事件真的到达 view，且只走 touch |
| keys | keys | 16 | 四只键各干自己那件事，且撤销不冒充放置 |
| save | save | 14 | 存档写读成对、刷新后水位不退 |
| reloaded | save | 8 | 真重载 = 新文档，档从盘上回读 |
| partial | save | 6 | 半截档不许被当成空档覆盖 |
| frag | save | 4 | 片段导航不算重载（同文档跳 hash） |

### 破坏试验台账（6 把刀）

`node tools/sabotage.mjs` 把每一类谎各写回代码一遍，要求闸**点名**变红，并把点名的那一行
留在日志里。六把刀打完还要恢复干净、把逻辑闸再绿一遍，才算盖章。刀只打在内存里存好的那份字节上，恢复不走 `git checkout/restore/reset`
（这个工作区是共享的）。`rc` 一列由脚本把真实退出码读回来，不许抄。

| 刀 | 打在哪 | 改坏什么 | rc |
|---|---|---|---|
| K1 | js/core/game.js | rotate 只改 axis、不改足迹 | 1 |
| K2 | js/main.js | done 之后撤销按钮又可点 | 1 |
| K3 | js/core/game.js | 撤销一步放置不退放置步数 | 1 |
| K4 | js/core/game.js | 随便一步放子都算收尾 | 1 |
| K5 | tools/playtest.mjs | 键的派发不发 keyDown，页面收不到键 | 1 |
| K6 | js/main.js | 提示计费不写进 grade() 读的那一个，用过提示照样判 3 星 | 待跑 |

## 承诺表

| 承诺 | 依据 | 怎么复跑 |
|---|---|---|
| 每一题解数 = 1 | `js/core/count.js` 穷举，`test/puzzles.test.mjs` 逐题重跑 | `node test/puzzles.test.mjs` |
| 每一题的深度 = 它印出来的 k | `js/core/logic.js` 只用局部规则求解 | 同上（同一道闸） |
| 文档里印的每个现值 = 代码里的现在值 | `test/doctest.test.mjs` | `node test/doctest.test.mjs` |
| 每条断言都被证明"会红" | `tools/sabotage.mjs` 六把刀 | `node tools/sabotage.mjs` |
| 变窄（删断言/摘闸）当场显形 | `LOGIC_EXPECTS` + `BROWSER_EXPECTS` + `GOLDEN_PER_SHAPE` | `bash tools/verify.sh` |
| 页面在两种 URL 形态下都活着 | 浏览器闸 ×2 形态 | `BROWSER=1 bash tools/verify.sh` |
| 提交只可能是 bot 身份 | 仓库 `user.email = bot@z-biz-game.dev` | `git log -1 --format=%ae` |

## 本地跑

```bash
node server.cjs 5275          # 打开 http://127.0.0.1:5275/
bash tools/verify.sh          # 逻辑闸
BROWSER=1 bash tools/verify.sh # 再加真浏览器闸（要 Chrome；两种 URL 形态）
node tools/sabotage.mjs        # 破坏试验台账（会打刀，工作树必须干净）
node tools/bake.mjs            # 重新测量 48 题（出题线，跑之前先读文件头）
```

零运行时依赖：`dependencies` 与 `devDependencies` 都是空对象，页面是裸 ES module，
部署就是拷文件。CI 里不 `npm install`——为一个不需要打包的游戏往 CI 里拉 bundler，
下一次网络抖一下就红给你看。

## 许可

MIT，见 `LICENSE`。
