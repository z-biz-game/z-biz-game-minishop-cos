#!/usr/bin/env bash
# 一条命令跑全部闸：先六道 node 逻辑闸（快、稳），再加真浏览器闸（headless Chrome + 裸 CDP，
# Node 21+ 才有全局 WebSocket/fetch）。每道闸一个自己的退码，红必须点名是哪道闸
# （统一写成 FAIL <gate> :: <哪条断言>）。
#
#   bash tools/verify.sh                 # 默认：只跑逻辑闸
#   BROWSER=1 bash tools/verify.sh       # 再加浏览器闸：两条 URL 形态（根 / 与 Pages 的 /z-biz-game-minishop-cos/）各跑一遍
#   LEGS="core mouse" BROWSER=1 bash tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-minishop-cos/ BROWSER=1 bash tools/verify.sh  # 追加已部署站点这一形态
#   GATE_SELFTEST=1 bash tools/verify.sh # 阴性自证：种一条注定错的期望，必须点名变红并且 rc 非 0（自动打开浏览器段）
#   GATES="server puzzles" bash tools/verify.sh   # 只跑其中几道逻辑闸
#
# 这个仓的规矩，改之前先读：
#  * 5275 与 9375 才是本仓专属端口（server.cjs 与 tools/playtest.mjs 的默认值就是这一对）。
#    这份脚本历史上写的是 5271/9371：那是从 z-biz-game-battleship-cos 搬代码时带过来的，而
#    battleship 的 verify.sh 把 5271/9371 声明成它自己的（9371 还同时是 euclid 的）。别的车道
#    此刻正在跑各自仓的 verify.sh：HTTP 端口撞了会拿到"另一个仓"的 index.html，那种绿比红更糟；
#    DevTools 端口撞了更狠——playtest 会附到别人的 Chrome 上，把自己的断言打在别人的页面上。
#    所以 HTTP 形态有 slug 预检，CDP 端口有"已经有监听者就拒绝起跑"的预检。
#  * 每一腿一个自己的 --user-data-dir（mktemp -d 在 _tmp-verify 里），leg_stop 一定删掉它。
#    共用 profile 会让存档那条腿读到上一腿留下的档，看起来像绿其实什么都没测：@save 结束时
#    故意留下一份坏档，只有全新 profile 才会让它变成"下一次开机读坏档"这个真场景。
#  * 指针断言走 CDP Input.dispatch*（真事件）。鼠标腿与触屏腿各发自己那一种事件，并且触屏腿
#    要把 view 亲眼看到的 pointerType 数回来——不然鼠标腿重复一遍就冒充了两条腿。
#  * 片段导航不算重载：frag 那条 run 的证人（timeOrigin + 文档哨兵）由 node 在派发导航之前取。
#  * 不要加 --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader：软件光栅会占满
#    每一个核，而且在没有 CDP 客户端 attached 时 Chrome 根本不会自己退。
#  * macOS 没有 timeout：看门狗用后台子 shell + trap（下面的 WD）。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${CDP_PORT:-9375}
HTTP=${HTTP_PORT:-5275}
SELF=${GATE_SELFTEST:-0}
export GATE_SELFTEST=$SELF
# 种单人必须真的递给台架：playtest.mjs 读的是 GATE_SELFTEST，只留 SELF=1 在 shell 里，
# planted 行一条都不会出现，阴性自证就变成空转。种错只在浏览器段有意义，所以它顺手把那段打开。
if [ "$SELF" = 1 ]; then BROWSER=1; fi
TMPD="$HERE/_tmp-verify"
LOGD="$HERE/_tmp-verify-logic"
rm -rf "$TMPD" "$LOGD"; mkdir -p "$TMPD" "$LOGD"
cd "$HERE"

# ============================================================ 逻辑闸：一条命令跑完，各退各的
#
# 闸名单只有这一处：每条闸必须落到一个真文件（gate_src 列出的路径逐个 -f 检查），否则这个
# 名字就是空转——一个不存在的脚本被"跳过"和"通过"长得一模一样，而分母还会跟着缩。
# 断言条数从每条闸自己打印的 `rows: N fail: M` 现读（tools/harness.mjs 的出口），写死一定漂。
# test/balance.mjs 不在名单里：它不判对错、只打印测量值（没有 rows: 行，也没有退码语义），
# 把它当闸跑等于给它一个假的绿。要看它单独 node test/balance.mjs。
GATES_RAW=${GATES:-}
GATES=${GATES_RAW:-"syntax check count game logic puzzles server doctest"}
# 点名跑几道闸（GATES="server puzzles"）是调试通道，不是把闸摘掉：钉表的"逐名相等"只在
# 跑全套时要求。部分模式必须自己印出来，否则一次 GATES=check 的绿看起来像整套的绿。
PARTIAL_LOGIC=0
[ -n "$GATES_RAW" ] && PARTIAL_LOGIC=1

# 每道逻辑闸的断言条数钉在这里。为什么 rc=0 不够：删掉一条 test() 调用，那道闸还是绿的，
# 只是少证了一件事；把一道闸从 GATES 名单里摘掉，rc 更是从头到尾没红过。条数是唯一能
# 让"变窄"当场显形的读数——它不要求断言变强，只要求变窄必须正面改这一行。
# syntax 那道闸不打印 rows:（它数的是待检文件），所以它进 NA_OK 名单，见下面的比对。
LOGIC_EXPECTS=${LOGIC_EXPECTS:-"check=13 count=13 game=18 logic=17 puzzles=15 server=24 doctest=22"}
NA_OK=${NA_OK:-syntax}

gate_src() {
  case $1 in
    syntax) echo "server.cjs electron/main.cjs js/main.js js/view.js tools/playtest.mjs" ;;
    *)      echo "test/$1.test.mjs" ;;
  esac
}
gate_cmd() {
  case $1 in
    # 语法闸扫的是这六个位置的全部文件：名单收窄= 一条断言都没跑的"通过"。
    syntax) echo 'n=0; for f in js/*.js js/*/*.js server.cjs electron/main.cjs tools/*.mjs test/*.mjs; do node --check "$f" || exit 1; n=$((n+1)); done; [ "$n" -ge 20 ] || { echo "FAIL syntax :: 只数到 $n 个待检文件，名单缩了"; exit 1; }; echo "syntax OK（$n 个文件）"' ;;
    *)      echo "node test/$1.test.mjs" ;;
  esac
}

LRC=0
GATE_ROWS="$LOGD/gate-rows.txt"; : >"$GATE_ROWS"
TOTAL=0
for gate in $GATES; do
  printf '\n===== 逻辑闸 %s =====\n' "$gate"
  log="$LOGD/$gate.log"
  missing=""
  for f in $(gate_src "$gate"); do [ -f "$f" ] || missing="$missing $f"; done
  if [ -n "$missing" ]; then
    # 名单里的闸引用了不存在的文件：这道闸根本没有跑，必须红，并且红得能说清是哪个路径。
    echo "FAIL $gate :: 闸引用的文件不存在：$missing" >"$log"
    grc=2
  else
    bash -c "$(gate_cmd "$gate")" >"$log" 2>&1
    grc=$?
  fi
  # 退码落在闸自己的日志里，就写在结果末尾：包装脚本后面再接 tail 会把 tail 的 0 当成闸的 0。
  echo "GATE_RC=$grc" >>"$log"
  sed -e "s|^  FAIL |  FAIL ${gate} :: |" -e 's/^/  /' "$log"
  N=$(sed -n 's/^rows: \([0-9]*\) fail: [0-9]*$/\1/p' "$log" | head -1)
  echo "$gate ${N:-NA} $grc" >>"$GATE_ROWS"
  TOTAL=$((TOTAL + ${N:-0}))
  # 条数比对只在闸自己绿的时候做：闸已经红了，再叠一条"条数也不对"只会把真正的根因挤走。
  if [ "$grc" = 0 ]; then
    case " $NA_OK " in
      *" $gate "*) ;;
      *)
        kv=$(printf '%s\n' $LOGIC_EXPECTS | grep "^$gate=" | head -1)
        if [ -z "$kv" ]; then
          echo "  RED $gate :: 钉表 LOGIC_EXPECTS 里没有这道闸（新闸要正面加条数，摘闸要正面删这一行）"
          LRC=1
        elif [ "${kv#*=}" != "${N:-NA}" ]; then
          echo "  RED $gate :: 条数 ${N:-NA} ≠ 钉着的 ${kv#*=}（断言被删/被并，或这道闸换了口径）"
          LRC=1
        fi
        ;;
    esac
  fi
  if [ "$grc" = 0 ]; then
    printf 'ok   %-8s %s 条断言 (GATE_RC=0)\n' "$gate" "${N:-NA}"
  else
    printf 'RED  %-8s %s 条断言 (GATE_RC=%s，见 %s)\n' "$gate" "${N:-NA}" "$grc" "$log"
    LRC=1
  fi
done
echo
# 反空转：钉表自己也要被数一遍。钉了 6 条、名单里只有 5 道需要条数的闸，就说明钉表里有一条
# 是死行（那道闸早就不跑了），而只看上面那段的话它会一直"通过"。
if [ "$PARTIAL_LOGIC" = 0 ]; then
  PINNED_N=0
  for kv in $LOGIC_EXPECTS; do
    g=${kv%%=*}
    case " $GATES " in
      *" $g "*) ;;
      *) echo "RED 钉表里的 $g 不在闸名单上（死行：这道闸根本不跑）" >&2; LRC=1 ;;
    esac
    case " $NA_OK " in *" $g "*) echo "RED 钉表给 $g 钉了条数，可它属于 NA_OK（这道闸不打印 rows:）" >&2; LRC=1 ;; esac
    PINNED_N=$((PINNED_N + 1))
  done
  NEED_N=0
  for g in $GATES; do case " $NA_OK " in *" $g "*) ;; *) NEED_N=$((NEED_N + 1));; esac; done
  if [ "$PINNED_N" != "$NEED_N" ]; then
    echo "RED 钉表 $PINNED_N 条 vs 名单里 $NEED_N 道要条数的闸：有一道闸没被钉住" >&2
    LRC=1
  fi
  # 名单是手打的，所以"新加一支 test/*.test.mjs"这件事本身不会让任何一道闸红：那条套件不进
  # GATES 就不会被跑，而 README 的表与 GATES 的逐名相等（doctest 那条）照样绿——两边都自洽、
  # 分母却缩了。这一段以目录为准数一遍：文件在、名字不在，必须点名红（摘闸则要正面把两处删）。
  for f in test/*.test.mjs; do
    [ -e "$f" ] || continue
    g=$(basename "$f" .test.mjs)
    case " $GATES " in
      *" $g "*) ;;
      *) echo "RED 名单外的套件 $f：闸 $g 不在 GATES 里（新闸要正面加进名单与 README 的表）" >&2; LRC=1 ;;
    esac
  done
else
  echo "NOTE 部分闸模式（GATES=${GATES}）：钉表逐名相等的检查跳过，全套请不带 GATES 跑"
fi
printf '逻辑闸合计 %d 条断言（闸：%s；钉表：%s）\n' "$TOTAL" "$GATES" "$LOGIC_EXPECTS"
printf 'gate-rows：%s\n' "$(tr '\n' ' ' <"$GATE_ROWS")"
if [ "$LRC" = 0 ]; then echo "logic: PASS"; else echo "logic: FAIL（红的那道闸上面已点名）"; fi

# 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑。缺这一步就是「本地全绿、线上 404 自己的
# manifest / sw.js / 图标」这一整类坏法。它不碰 Chrome，也不读页面，纯查产物。
# 必须排在下面那条 BROWSER 早退之前：`npm test` 那条路走 `exit $LRC`，块挂在文件尾巴时
# 默认整闸一次都碰不到它——「只有 CI 在查」这个洞只是换了个位置。红并进 LRC，
# 浏览器那一路的 `exit $((LRC + BRC …))` 与尾巴上的横幅才带得动它。
echo "=== deploy-set ==="
node tools/deploy-set.mjs || LRC=1
node tools/deploy-set-selftest.mjs || LRC=1

if [ "${BROWSER:-0}" != 1 ]; then
  echo "browser: SKIP（逻辑闸段跑完了；浏览器闸走 BROWSER=1 / npm run verify:browser）"
  [ "$LRC" = 0 ] && echo "=== ALL GREEN（logic + 部署集；浏览器腿这一跑没跑）===" \
    || echo "=== FAILURES ABOVE (rc=${LRC}) ==="
  exit $LRC
fi
echo
echo "==================== 真浏览器闸（下面这段需要 Chrome 与一个空端口）===================="

CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# 附到别人的 Chrome 上，比附不到 Chrome 更危险：后者一定红，前者会替别人通过。
if curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "端口 :$PORT 上已经有一个 DevTools 在听，而它不是本仓起的（本仓专属端口）。拒绝起跑。" >&2
  exit 2
fi

SPID=0
node server.cjs "$HTTP" >"$TMPD/server.log" 2>&1 &
SPID=$!
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
  sleep 0.25
done

SHAPES=("http://127.0.0.1:$HTTP/" "http://127.0.0.1:$HTTP/z-biz-game-minishop-cos/")
if [ -n "${BASE_URL:-}" ]; then
  SHAPES+=("$BASE_URL")
fi

# 预检：证明接下来要测的字节是这个仓的应用，而不是同一个端口上别人的 index.html。
# 两种形态都要过——Pages 的前缀形态挂了就是 404，而 404 页面上什么断言都跑不出来。
for base in "${SHAPES[@]}"; do
  SERVED=$(curl -fsS -m 5 "$base" 2>/dev/null || true)
  case "$SERVED" in *js/main.js*) ;; *) echo "端口上 $base 没有本仓的 index.html（见 $TMPD/server.log）" >&2; exit 2 ;; esac
  # 题材 slug 是 MINISHIP（孤舰），仓名才是 minishop：拿仓名去 grep 页面永远抓不到，
  # 于是这个端口上坐着谁的 index.html 都判不出来。
  echo "$SERVED" | grep -qi miniship || { echo "$base 不是孤舰/miniship：端口上坐着别的仓" >&2; exit 2; }
  echo "$SERVED" | grep -q 孤舰 || { echo "$base 的 HTML 里没有 孤舰" >&2; exit 2; }
  curl -fsS -m 5 "${base}js/core/count.js" >/dev/null || { echo "$base 下取不到 js/core/count.js" >&2; exit 2; }
  curl -fsS -m 5 "${base}js/main.js" | grep -q 'window.minishop' \
    || { echo "$base 下取到的 js/main.js 不导出 window.minishop" >&2; exit 2; }
  curl -fsS -m 5 "${base}css/game.css" >/dev/null || { echo "$base 下取不到 css/game.css" >&2; exit 2; }
done
echo "preflight: ${#SHAPES[@]} 个 URL 形态都 served 且带 miniship/孤舰 标记 — ${SHAPES[*]}"

CPID=0
UDD=""
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  [ "$CPID" != 0 ] && kill -9 $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf "$UDD"
}
trap cleanup EXIT
( sleep ${WD_TIMEOUT:-1200}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

FAILED=0
REPORTS="$TMPD/reports.txt"; : >"$REPORTS"; export REPORTS
LEGS_RAW=${LEGS:-}
LEGS=${LEGS_RAW:-core play win mouse touch keys save}
PARTIAL_BROWSER=0
[ -n "$LEGS_RAW" ] && PARTIAL_BROWSER=1

# ----------------------------------------------------------------- the leg plan, in one place
#
# 这张表同时是"跑什么"和"该有几份报告"。分开写两份的话，改了一份另一份不会响——那条腿从此
# 不跑，而分母跟着一起缩，最后打印一个干净的 pass。所以分母只能从执行计划现算。
# 现算还有一个洞：把某个 token 从计划里删掉，跑的次数与期望的次数会一起变小，自我比较照样绿。
# 于是下面还钉了一个 golden 数：它要人为改一次才生效，删 run 的人必须正面回答那一行。
#
# 每个 token 就是 tools/playtest.mjs 里的一次 report：@<token> 是页内 suite，pointer/touch/
# keys 是真事件腿，frag 是"片段导航不算重载"的对照 run。
leg_plan() {
  case $1 in
    core)  echo "boot nonav|routes nonav" ;;
    play)  echo "play nonav" ;;
    win)   echo "win nonav" ;;
    mouse) echo "pointer nonav" ;;
    touch) echo "touch" ;;
    keys)  echo "keys" ;;
    save)  echo "save nonav|reloaded nav|partial nav|frag" ;;
    *) return 1 ;;
  esac
}

# golden：每种 URL 形态应有的 report 份数（core 2 + play 1 + win 1 + mouse 1 + touch 1 + keys 1 + save 4）。
GOLDEN_PER_SHAPE=${GOLDEN_PER_SHAPE:-11}

# 每份报告的断言条数同样钉死（值取自实跑打印的 "N checks"）。GOLDEN_PER_SHAPE 只数"有几份报告"，
# 数不到"每份报告里还剩几条断言"：把 playtest.mjs 里一整个 suite 的 test() 删光，份数一条不差，
# 而那份报告从此什么都不证。条数是这份表里唯一挡得住那种退化的读数。
BROWSER_EXPECTS=${BROWSER_EXPECTS:-"boot=14 routes=14 play=25 win=14 pointer=20 touch=13 keys=16 save=14 reloaded=8 partial=6 frag=4"}
expect_checks() {   # $1 = run 名；钉不到就回空，调用方必须把它当红，不能当"没有期望"
  local kv
  kv=$(printf '%s\n' $BROWSER_EXPECTS | grep "^$1=" | head -1)
  [ -n "$kv" ] && printf '%s' "${kv#*=}"
}

leg_start() {   # $1 = leg name, $2 = base url
  UDD=$(mktemp -d "$TMPD/udd-$1.XXXXXX")
  "$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir="$UDD" \
    --window-size=900,900 --no-first-run --no-default-browser-check about:blank >"$TMPD/chrome-$1.log" 2>&1 &
  CPID=$!
  # A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
  for i in $(seq 1 120); do
    curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
    echo "  RED devtools never bound on :$PORT (leg $1)" >&2; FAILED=1; return 1; }
  export CDP_PORT=$PORT BASE_URL="$2"
  echo "--- leg $1 @ $2 (profile $UDD)"
  node tools/playtest.mjs open "$2" >"$TMPD/$1.open.log" 2>&1
  if ! grep -q '^opened ' "$TMPD/$1.open.log"; then
    echo "  RED leg $1：页面从未在 $2 起来（见 $TMPD/$1.open.log）" >&2
    FAILED=1
  fi
}
leg_stop() {   # 每条腿自己收自己的尸：profile 一定要删，写完的档不能留给下一条腿
  [ "$CPID" != 0 ] && kill -9 $CPID 2>/dev/null
  wait $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf "$UDD"
  CPID=0; UDD=""
}

parse() {   # $1 = run 名（这一份报告挂什么名字）, $2 = 腿名
  python3 -c "
import sys, json, os
run, leg, selfmode = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
raw = ''
try:
    with open(os.environ['RESULT_FILE']) as f:
        for line in f:
            if line.startswith('RESULT '): raw = line[7:].strip()
except FileNotFoundError:
    pass
if not raw:
    print('  RED %s/%s：没有 RESULT 行（这一份报告一条断言都没跑到）' % (leg, run)); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED %s/%s: %r %s' % (leg, run, str(e)[:80], raw[:300])); sys.exit(1)
rows = d.get('rows') or []
if not rows:
    print('  RED %s/%s：NO CHECKS RUN — a report that asserts nothing cannot be green' % (leg, run)); sys.exit(1)
for r in rows:
    if not r.get('pass'):
        det = r.get('detail')
        print('  FAIL %-64s %s' % (r['test'], json.dumps(det, ensure_ascii=False)[:220] if det is not None else ''))
if not isinstance(d.get('fail'), int):
    print('  RED %s/%s：RESULT 里的 fail 不是整数，无法判定' % (leg, run)); sys.exit(1)
exp = os.environ.get('EXPECT_CHECKS') or ''
if exp and not selfmode:
    # 种错模式下每条报告都被 emit() 多塞一行 1===2，那一行的条数归 SELFTEST 那段自己数，
    # 所以这里只在正常跑时比对钉值。
    if exp != str(len(rows)):
        print('  RED %s/%s：条数 %d ≠ 钉着的 %s（这份报告的断言被删/被并，或它换了口径）' % (leg, run, len(rows), exp)); sys.exit(1)
planted = sum(1 for r in rows if str(r.get('test', '')).startswith('GATE_SELFTEST') and not r.get('pass'))
if selfmode:
    # 先记账再判：没种上的报告也写进对数表，末尾那句「实到几份 / 点名几份」才是有分母的数。
    open(os.environ['REPORTS'], 'a').write('%s/%s %d\n' % (leg, run, planted))
    if planted == 0:
        print('  RED %s/%s：这份报告里没有种下的错期望（这条 run 证明不了自己能红）' % (leg, run)); sys.exit(1)
print('  %d checks, %d failed  [%s]' % (len(rows), d['fail'], leg))
sys.exit(1 if d['fail'] else 0)
" "$1" "$2" "${SELF:-0}" || FAILED=1
}

collect() {   # 打印证据行，再把 RESULT 交给 parse
  sed -n 's/^EXTRA /  EVID /p' "$RESULT_FILE"
  parse "$1" "$2"
  prc=$?
  # 每条 run 的退码写进它自己的结果文件末尾：包装脚本后面接 tail / grep 拿到的是 tail 的 0。
  printf 'GATE_RC=%s\n' "$prc" >>"$RESULT_FILE"
  [ $prc -eq 0 ] || FAILED=1
}

run_page() {   # $1 = scenario token, $2 = nav|nonav, $3 = run 名
  local token="$1" mode="$2" name="${3:-$1}"
  export RESULT_FILE="$TMPD/${LEGTAG}-${name}.out"
  export EXPECT_CHECKS="$(expect_checks "$name")"
  [ -n "$EXPECT_CHECKS" ] || { echo "  RED $LEGTAG/${name}：BROWSER_EXPECTS 里没有这一份报告的条数（新 run 要正面钉一条）" >&2; FAILED=1; }
  if [ "$mode" = nav ]; then
    node tools/playtest.mjs eval "@$token" >"$RESULT_FILE" 2>"$TMPD/${LEGTAG}-${name}.console.log"
  else
    node tools/playtest.mjs eval "@$token" nonav >"$RESULT_FILE" 2>"$TMPD/${LEGTAG}-${name}.console.log"
  fi
  collect "$name" "$LEGTAG"
  if [ -s "$TMPD/${LEGTAG}-${name}.console.log" ]; then
    echo "  --- console ($LEGTAG/$name) ---"
    sed 's/^/  /' "$TMPD/${LEGTAG}-${name}.console.log" | tail -8
  fi
}

run_leg_gesture() {   # $1 = touch|keys
  export RESULT_FILE="$TMPD/${LEGTAG}-$1.out"
  export EXPECT_CHECKS="$(expect_checks "$1")"
  [ -n "$EXPECT_CHECKS" ] || { echo "  RED $LEGTAG/$1：BROWSER_EXPECTS 里没有这条腿的条数" >&2; FAILED=1; }
  node tools/playtest.mjs leg "$1" >"$RESULT_FILE" 2>"$TMPD/${LEGTAG}-$1.console.log"
  collect "$1" "$LEGTAG"
  if [ -s "$TMPD/${LEGTAG}-$1.console.log" ]; then
    echo "  --- console ($LEGTAG/$1) ---"
    sed 's/^/  /' "$TMPD/${LEGTAG}-$1.console.log" | tail -8
  fi
}

run_frag() {   # 对照 run：片段导航不算重载
  export RESULT_FILE="$TMPD/${LEGTAG}-frag.out"
  export EXPECT_CHECKS="$(expect_checks frag)"
  [ -n "$EXPECT_CHECKS" ] || { echo "  RED save/frag：BROWSER_EXPECTS 里没有 frag 的条数" >&2; FAILED=1; }
  node tools/playtest.mjs nav "${FRAGBASE}#gate-fragment-nav" same >"$RESULT_FILE" 2>"$TMPD/${LEGTAG}-frag.console.log"
  collect frag save
}

for base in "${SHAPES[@]}"; do
  echo
  echo "########## URL 形态 $base ##########"
  for leg in $LEGS; do
    PLAN=$(leg_plan "$leg") || {
      # 未知腿名必须红，不能"匹配不到就算跑完了"：一声不响地返回 0 会让一个拼错的腿名
      # 看起来像跑完了，而且分母也跟着少一截。
      echo "  RED 未知的腿：${leg}（LEGS 只认 core play win mouse touch keys save）" >&2
      FAILED=1; continue
    }
    LEGTAG=$leg
    FRAGBASE=$base
    leg_start "$leg" "$base" || continue
    IFS='|' read -ra RUNS <<< "$PLAN"
    for spec in "${RUNS[@]}"; do
      tok=${spec%% *}
      case $tok in
        frag) run_frag ;;
        touch|keys) run_leg_gesture "$tok" ;;
        *) mode=${spec##* }; run_page "$tok" "$mode" "$tok" ;;
      esac
    done
    leg_stop
  done
done

# 条数钉表的反空转：钉表必须和腿计划现算出来的 run 名单**逐名相等**。
# 只查"每份报告条数对不对"是自我比较——把一整个 run 从 leg_plan 里删掉，那份报告连 EXPECTS
# 都不会去读，钉表里那一行从此变成死行。所以这里两头都数。
RUN_NAMES=""
for leg in $LEGS; do
  PLAN=$(leg_plan "$leg") || { FAILED=1; continue; }
  IFS='|' read -ra RS <<< "$PLAN"
  for spec in "${RS[@]}"; do RUN_NAMES="$RUN_NAMES ${spec%% *}"; done
done
if [ "$PARTIAL_BROWSER" = 0 ]; then
  for n in $RUN_NAMES; do
    [ -n "$(expect_checks "$n")" ] || { echo "  RED 条数钉表缺 $n 这一份报告（新 run 没被钉住）" >&2; FAILED=1; }
  done
  for n in $(printf '%s\n' $BROWSER_EXPECTS | sed 's/=.*//'); do
    case " $RUN_NAMES " in *" $n "*) ;; *) echo "  RED 条数钉表钉着 ${n}，可腿计划里已经没有它了（死行：这份报告根本不跑）" >&2; FAILED=1 ;; esac
  done
  N_PIN=$(printf '%s\n' $BROWSER_EXPECTS | wc -l | tr -d ' ')
  N_RUN=$(printf '%s\n' $RUN_NAMES | wc -l | tr -d ' ')
  if [ "$N_PIN" != "$N_RUN" ] || [ "$N_RUN" != "$GOLDEN_PER_SHAPE" ]; then
    echo "  RED 条数钉表 $N_PIN 条 / 腿计划 $N_RUN 份报告 / golden 每形态 $GOLDEN_PER_SHAPE 份：三者必须同为一份计划" >&2
    FAILED=1
  fi
else
  echo "NOTE 部分腿模式（LEGS=${LEGS}）：逐名相等的检查跳过，全套请不带 LEGS 跑（每份报告的条数照旧比对）"
fi

if [ "$SELF" = 1 ]; then
  echo
  echo "=== GATE_SELFTEST：种下的期望必须点名变红 ==="
  echo "  planted rows: tools/playtest.mjs 的 emit() 在 GATE_SELFTEST=1 时给每一份报告加一条"
  echo "                1 === 2 ——页内 suite、真事件腿、导航对照 run 走的是同一条出口"
  EXPECTED=0
  for leg in $LEGS; do
    PLAN=$(leg_plan "$leg") || { echo "  RED 未知的腿：${leg}（计划表里没有它）" >&2; FAILED=1; continue; }
    IFS='|' read -ra RUNS <<< "$PLAN"
    EXPECTED=$((EXPECTED + ${#RUNS[@]}))
  done
  DERIVED=$EXPECTED
  EXPECTED=$((EXPECTED * ${#SHAPES[@]}))
  if [ "$DERIVED" != "$GOLDEN_PER_SHAPE" ]; then
    echo "  RED 腿计划现算出每形态 $DERIVED 份报告，钉着的 golden 是 ${GOLDEN_PER_SHAPE}：\
要么 run 被删了，要么你改计划时忘了正面改这个数" >&2
    FAILED=1
  fi
  GOT=$(wc -l <"$REPORTS" | tr -d ' ')
  HIT=$(awk '$2 > 0' "$REPORTS" | wc -l | tr -d ' ')
  echo "  应有 $EXPECTED 份报告（$DERIVED run x ${#SHAPES[@]} 形态），实到 $GOT 份，其中 $HIT 份点名吃下了种下的错"
  if [ "$GOT" != "$EXPECTED" ]; then
    echo "  RED 阴性自证的报告数对不上：$GOT ≠ ${EXPECTED}（有腿没跑，或计划表漂了）" >&2
    FAILED=1
  fi
  if [ "$FAILED" = 0 ]; then
    echo "  RED 阴性自证失败：闸没能把种下的错期望跑红（这个闸证明不了自己会红）" >&2
    FAILED=1
  elif [ "$HIT" != "$EXPECTED" ]; then
    echo "  RED 阴性自证只被 $HIT/$EXPECTED 份报告点名（差的那些从没红过＝没被证明会红）" >&2
    FAILED=1
  else
    echo "  ok 闸确实会红，且 rc 非 0"
  fi
fi

kill $WD 2>/dev/null
BRC=$FAILED
[ $BRC -eq 0 ] && echo "browser: PASS（腿计划每形态 $GOLDEN_PER_SHAPE 份报告，见各 run 日志末尾的 GATE_RC）" \
  || echo "browser: FAILURES ABOVE (rc=$BRC)"
[ "$LRC" = 0 ] && [ "$BRC" = 0 ] && echo "=== ALL GREEN：logic rc=0 + browser rc=0 ===" \
  || echo "=== 有闸是红的：logic rc=$LRC, browser rc=${BRC}（点名见上面各段的 FAIL/RED 行与 gate-rows）==="
echo "GATE_RC logic=$LRC browser=$BRC"
exit $(( LRC + BRC > 0 ? 1 : 0 ))
