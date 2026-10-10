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

名单这一侧也有一个反向的空子：`GATES` 是手打的 7 个名字，新增一支 `test/*.test.mjs` 只要不进名单
就永远不会被跑，而 README 的表与名单**逐名相等**（`doctest` 的那条断言）两边照样自洽——缩的是分母，
不是某条断言。所以 7 道闸跑完之后，`verify.sh` 还要以目录为准再数一遍：文件在、名字不在，就点名
`RED 名单外的套件 …` 并把退出码抬成非 0。这一条取过两个方向：干净树 → `logic: PASS`、
`=== ALL GREEN（logic + 部署集；浏览器腿这一跑没跑）===`、rc=0；一份在 `test/` 里多出一支
未登记套件的副本 → 同一支脚本点名 `闸 …… 不在 GATES 里`、`logic: FAIL`、rc=1。
（写这一段时第一版把这支副本套件的路径直接反引号进了文档，本闸当场把它红了——
第 9 节那条「README 引用的每个代码路径都还在树上」扫的就是这种写法，改后的树要过的是这一道，
不是我的记忆。）它没有对应的台账刀
（`tools/sabotage.mjs` 的刀型是"改一处再复原那一个文件"，种一个新文件不在这个形状里），
对照是手工取的；`GATES=` 点名调试那条通道不触发这段（它和钉表的逐名相等一样只在跑全套时要求）。

### 实测台 `test/balance.mjs`：不进 7 道闸的名单，但它的退出码是结论

它量的是"这一档还量不量得出板子"：每档 SEEDS 个种子的 accept%、单张板子的证明成本、
全池复证、擦线索两遍。以前某档一张板子都接不出，它也只是把那张表打完然后退 0——
而「改 `js/core/make.js` 的 band 之前先跑这个文件」这句话指望的正是这个退出码。
现在两条结论进 `fails`：某档 accept 为 0；以及**往返之后**（`serialize` → `deserialize`）复测的深度
落出自己那一档的 k 带——后一条是第二只眼睛，出题器自报"这张在带里"不作数。
两个方向都取过：把近岸的 `k: [0, 0]` 改成 `[7, 7]` → 点名 `FAIL balance: harbour：… 一张板子都没接受`、
rc=1；把 `js/core/make.js` 里那道深度比较改成恒假 → 复测深度不在带里的档逐个点名、rc=1；
未动刀的那份 rc=0（对照台账在仓库外的 `_scratch/mshop-bal/`）。CI 里它是
`Every shipped level is still uniquely solvable` 之后单独一步，本地就是 `npm run balance`。

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
| K6 | js/main.js | 提示计费不写进 grade() 读的那一个，用过提示照样判 3 星 | 1 |

## 承诺表

| 承诺 | 依据 | 怎么复跑 |
|---|---|---|
| 每一题解数 = 1 | `js/core/count.js` 穷举，`test/puzzles.test.mjs` 逐题重跑 | `node test/puzzles.test.mjs` |
| 每一题的深度 = 它印出来的 k | `js/core/logic.js` 只用局部规则求解 | 同上（同一道闸） |
| 难度带还量得出板子、往返后深度还在带里 | `test/balance.mjs` 现量 accept% 与 serialize→deserialize 后的复测深度 | `node test/balance.mjs`（CI 里独立一步） |
| 文档里印的每个现值 = 代码里的现在值 | `test/doctest.test.mjs` | `node test/doctest.test.mjs` |
| 每条断言都被证明"会红" | `tools/sabotage.mjs` 六把刀 | `node tools/sabotage.mjs` |
| 变窄（删断言/摘闸）当场显形 | `LOGIC_EXPECTS` + `BROWSER_EXPECTS` + `GOLDEN_PER_SHAPE` | `bash tools/verify.sh` |
| 页面在两种 URL 形态下都活着 | 浏览器闸 ×2 形态 | `BROWSER=1 bash tools/verify.sh` |
| 线上站点跑的是同一套闸 | `BASE_URL` 只是把第三种形态追加进同一份腿计划，条数钉表逐份照比 | `BASE_URL=https://z-biz-game.github.io/z-biz-game-minishop-cos/ BROWSER=1 bash tools/verify.sh` |
| 提交只可能是 bot 身份 | 仓库 `user.email = bot@z-biz-game.dev` | `git log -1 --format=%ae` |

## 本地跑

```bash
node server.cjs 5275          # 打开 http://127.0.0.1:5275/
bash tools/verify.sh          # 逻辑闸
BROWSER=1 bash tools/verify.sh # 再加真浏览器闸（要 Chrome；两种 URL 形态）
node tools/sabotage.mjs        # 破坏试验台账（会打刀，工作树必须干净）
node tools/bake.mjs            # 重新测量 48 题（出题线，跑之前先读文件头）
npm run balance                # 难度实测台：某档量不出板子、或往返后深度漂出带就 rc=1
```

零运行时依赖：`dependencies` 与 `devDependencies` 都是空对象，页面是裸 ES module，
部署就是拷文件。CI 里不 `npm install`——为一个不需要打包的游戏往 CI 里拉 bundler，
下一次网络抖一下就红给你看。

## 许可

MIT，见 `LICENSE`。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高。
- **钉住两个数**：`EXPECT_CHECKS=25`（R 段实际检查的路径条数）与 `EXPECT_ROWS=43`
  （这一次跑的断言条数）。没改页面却掉了，说明解析断了；删掉一张图标会同时少一条 R10 与那张的
  P1/P2，所以两个数一起钉，rows 能漂就是闸在缩水的信号。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`25`、rows 仍然 `43`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑，所以页面改了、仓与仓不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。
