# AGENTS.md — fn-native-deepseek-harness

把 DeepSeek Harness（dsh，AI Agent 框架）打包成飞牛 fnOS 原生应用（.fpk）的工程。
上游：https://github.com/deepseek-ai/deepseek-harness （MIT，npm 包 `@deepseek-ai/dsh`）。

命名约定：**应用标识一律用 `dsh`**（appname、网关前缀 `/app/dsh`、运行用户 `dsh`、共享根
`dsh`（下分 `workspace/` 与 `home/`）、显示名 `DS·H`）；只有仓库名保留全称 fn-native-deepseek-harness。

## 架构（为什么长这样）

上游 dsh 的 Web UI **拒绝绑定 127.0.0.1 以外的地址**（CLI 直接报错，防 RCE 暴露），
且自身无任何登录认证。因此：

```
浏览器 → fnOS 统一网关 /app/dsh（NAS 登录态，转发 X-Trim-* 头）
        → Unix socket /var/apps/dsh/target/app.sock（实际在 /vol1/@appcenter/dsh/app.sock）
        → relay（src/app/bin/relay.mjs，Node）
            - 校验 X-Trim-Isadmin === 'true'，否则 403（此入口等价于主机 shell，管理员专用）
            - 剥 /app/dsh 前缀
            - Host/Origin/Referer 重写为 127.0.0.1:3080（通过 dsh 的 browser-trust fence）
            - 删 accept-encoding 后对 HTML 做运行期重写（__DSH_BOOT__ 注入的 /plugins/ URL 前缀化）
            - 注入 crypto.randomUUID polyfill（fnOS 桌面经 HTTP+局域网 IP 访问是非安全上下文，
              该 API 不存在，dsh 前端拿它生成 RPC 关联 ID——工作区选择器会因此报错）            - 代理 WebSocket 升级（/api/events.mux、/api/events.host）
        → dsh web（127.0.0.1:3080，永远只绑回环）
```

数据布局（**用户数据全在共享目录，@appdata 只放可再生文件**——卸载/升级失败/重装失败
都不会丢配置、插件和会话）：

- 共享根 `dsh`（data-share 声明，实际在 `/vol1/@appshare/dsh`，Windows ACL 权限模型：
  平台以**命名 ACL 条目**授权 dsh 用户，属主类留空）：
  - `dsh/home/` = DSH_HOME：`.credentials.yaml`、settings.yaml、profiles/（插件代码）、
    会话、market-present stamp。管理员覆盖文件 `github-accel`、`npm-registry`、
    `market-registry` 也在这里，**文件管理器可直接编辑**（cmd/main 读共享优先、
    @appdata 旧位置兜底）。
  - `dsh/workspace/`：agent 工作目录。cmd/main 启动 dsh 前 `cd` 进去，新会话 cwd 默认取
    `process.getcwd()`，产出文件天然落在共享区，文件管理器可见。
- `TRIM_PKGVAR`（/vol1/@appdata/dsh）只放可再生状态：`runtime/`（install_callback 从 fpk
  解压）、`bin/` shims（seed-market 每次启动重生成）、`lastgood-web` 快照（回滚机械，
  非用户数据）、`market-cache/`、`.npm-cache`、`.xdg`、pid/log/flag。
- **credentials chmod 守卫（必须每次启动都跑，不能省）**：共享目录新建文件的 POSIX mode
  形态不可预测（0600 原子写实测 stat 回 `060` 或 `000`——权限都在命名 ACL 里，mode 位
  不反映真实访问），而上游 `assertOwnerOnly` 见 group/other 位即拒启。cmd/main 的
  `dsh_launch_env` 每次拉 dsh 前对 `$DSH_HOME/.credentials.yaml` 跑 `chmod 600`（实测
  能拉正且 dsh 仍可读写）；面板每次保存 Key 都原子重建该文件，所以守卫不能只做一次。
- **pnpm store 路径守卫（同上，每次启动都跑）**：pnpm 把 store 的**绝对路径**写死在 profile
  的 `node_modules/.modules.yaml`（storeDir 字段，JSON 或 YAML 形态都可能出现），与当前
  store 不一致时该 profile 内一切 install/update 直接 `ERR_PNPM_UNEXPECTED_STORE` 拒绝
  （市场自更新就是这么挂的，0.1.1-rc.2.1 迁移设备实锤）。布局重构把 store 从旧 home 挪到
  `$TRIM_PKGVAR/.xdg/data/pnpm/store`，迁移过来的 profile 全部带着旧路径。cmd/main 的
  `repair_pnpm_stores()`（start 与 supervised restart 时跑）把 storeDir 重指到当前 store 根
  （保留 vNN 版本后缀）；store 是内容寻址缓存，新位置缺什么 pnpm 自己重拉。**XDG_DATA_HOME
  的根若变更，该函数里的 store_root 字面量必须同步**。
- **迁移**：老安装 `$TRIM_PKGVAR/dsh`（旧 home）由 cmd/main start 的 `migrate_home_to_share`
  一次性搬到共享 `home/`（tar 保 mode、排除缓存、覆盖文件 copy 过去、搬完删旧目录）；
  失败保留旧目录下次重试。share 型软链 `profiles/node_modules/dshmarket` 清理逻辑不变。
- dsh 运行时整树以单文件 `src/app/runtime.tar.gz` 进 fpk（33k 文件打成 1 个，安装秒级），
  `cmd/install_callback`/`upgrade_callback` 在安装/升级时解压到 `$TRIM_PKGVAR/runtime`，
  cmd/main 从那里启动 dsh（解压失败的报错会指向重装）。
- dsh 进程的 `HOME` 指向共享 workspace（目录选择器默认列 `os.homedir()`，不设 HOME 会
  落到不存在的 `/home/dsh` 报 ENOENT）；npm/XDG 缓存重定向到 `$TRIM_PKGVAR` 下
  （缓存可再生，不占共享区）。

关键 TRIM_ 环境变量（实测值）：`TRIM_APPDEST=/vol1/@appcenter/dsh`、
`TRIM_PKGVAR=/vol1/@appdata/dsh`、`TRIM_DATA_SHARE_PATHS=/vol1/@appshare/dsh`。
`/var/apps/dsh/shares/` 下是共享目录的软链（注意是 `shares` 不是 `share`）。

## 目录

```
src/                 # fnpack 打包根（manifest、config/、cmd/、app/bin/relay.mjs、app/ui/）
cache/dsh-runtime-x86_64/  # 构建缓存：x86_64 的 dsh node_modules（勿手改，勿提交）
cache/dsh-runtime-arm64/    # 构建缓存：arm64 的 dsh node_modules（仅 CI/原生 arm 主机产生）
src/app/runtime.tar.gz  # 构建期生成：runtime 整树单文件 tar（33k 文件打包成 1 个，
                      #   安装秒级；cmd/install_callback 解压到 $TRIM_PKGVAR/runtime）
src/app/bin/seed-market.mjs  # 启动期种子：市场插件的 shim/软链/profile 种子
src/app/bin/profile-salvage.mjs  # lastgood 快照 + 看门狗的外科手术式恢复（见测试生命周期节）
src/app/bin/catalog-cache.mjs  # 市场目录的本地 stale-while-revalidate 缓存（回环，见内置插件市场节）
src/app/bin/supervise-web.sh  # 常驻监督循环：托管重启 + web/relay 崩溃自愈（见测试生命周期节）
scripts/             # fetch-dsh / rewrite-dist / build / 本地与真机测试脚本
package.json         # dshVersion / pnpmVersion 钉死两组上游版本（市场本体在线装，不钉）
assets/ICON.png      # 图标母版 600x600；make-icons.mjs 导出 @2x（64pt→128px、
                      #   256pt→512px，fnOS 桌面按 HiDPI 2x 渲染）。build.sh 带
                      #   新鲜度守卫：母版比导出图新则打包时自动重生成。
```

## 构建（必须理解远程安装的原因）

```bash
./build.sh              # 自动取 npm 上游最新版 → 钉版 → 远程安装 → 重写 → fnpack → dist/
./build.sh 0.1.0-rc.6   # 构建指定上游版本
npm run build           # 等价于 build.sh 的钉版路径（不查 npm、不拷 dist）
```

- `./build.sh` 是主入口：**fpk 版本镜像上游 dsh 版本**（manifest `version=` = dshVersion，
  如 `0.1.0-rc.6`），装到设备上看到的应用版本即所带上游版本。同一上游的纯封装修复
  （relay/脚本改动）重新发布时用 `DSH_WRAPPER_BUILD=1 ./build.sh`（版本变
  `0.1.0-rc.6.1`）。入口为浏览器新标签页打开（ui/config `type: "url"`），不是桌面 iframe。
  **`DSH_WRAPPER_BUILD` 的值就是修订号后缀**（`=11` → `0.1.0-rc.7.11`）。
  **封装修订号不能跨 9→10 进位**：fnOS 部分安装路径（桌面 UI 的手动安装/升级）按字符串比较
  版本，`0.1.0-rc.7.10/7.11` < `0.1.0-rc.7.9`（'1'<'9'）会被拒"不符合系统要求"，且拒绝
  发生在客户端、journal 无任何 APP_ 事件；CLI install-fpk 不做此检查。修订号到 9 之后再
  发版要跳到对字符串和数值比较都更大的段（如 `.90` 起），`.12`→`.13` 这类不跨 9 的递增安全。
  输出 `dist/dsh_<版本>.fpk`（附 .info.txt），并把所用上游版本写回 `package.json` 的
  `dshVersion`（钉版是唯一上游版本来源，**精确钉死**，rc 阶段破坏性变更多）。
  同版本重复构建走快速路径（跳过远程安装与重写——rewrite-dist 带幂等预检）；换新版本自动
  走全流程，**若上游打包方式变化，重写门禁会让构建大声失败**，此时按门禁报错更新规则集再重跑。
- **工作区就在 fnOS 机器上时（HOME-NAS：/vol3/1000/Projects/fn-native-deepseek-harness）**：
  `DSH_BUILD_HOST=local DSH_WRAPPER_BUILD=1 ./build.sh 0.1.0-rc.6`，fetch 直接在本机
  nodejs_v24 下装进 `cache/`，不再走 SSH。npm 缓存重定向到 `cache/npm-cache`（本机
  shell 的 `npm_config_cache` 指向 `$DSH_HOME/.npm-cache`，构建树必须绕开）。注意：
  在这台机器上装的 dsh 里开的会话，其工作区若就是本仓库，**升级安装会杀掉会话**——
  先出包、择机装，装完开新会话接续；`sudo appcenter-cli` 只能由管理员在宿主 shell 执行。
- **npm install 必须在 Linux x64 上执行**：dsh 有原生依赖 node-pty（需编译或预编译产物）
  和 koffi（install 脚本装原生模块），Windows/`--ignore-scripts` 装出的树在 fnOS 上必崩
  （症状：plugin tree failed to load / pty.node not found / Koffi missing）。
  `fetch-dsh.mjs` 通过 SSH 在构建机（`DSH_BUILD_HOST`，默认 nas31）上用设备同款
  nodejs_v24 运行时安装，tar 回传（保符号链接），并校验 pty.node 是 Linux ELF。
- nas31 需要一次性装好工具链：`sudo apt-get install -y g++ make python3`（node-pty 编译用）。
- **npm registry**：nas31 远程路径与 fnOS 本机路径默认走 npmmirror（`registry.npmmirror.com`，
  node-gyp 头文件同步走镜像）——CN 网络下 npmjs 直连一个 535 包的冷安装要 ~10 分钟，
  镜像把下载瓶颈消掉后剩 node-pty 编译本身；CI 的美国 runner 保持 npmjs。
  `DSH_NPM_REGISTRY` 可覆盖。`pack-runtime.mjs` 带新鲜度跳过：cache 里现成 tar 比整棵
  staging 树都新就不重打（33k 文件重打一次要几分钟）——同依赖的封装修订重建因此只要
  秒级（fetch/rewrite/pack 三段全跳，只剩 fnpack）。
- **npm 解析活锁与 lockfile（0.1.1-rc.2 起）**：npm 11.12 的 arborist 对 dsh 的依赖图
  有病态回溯——`placeDep` 在 NAS CPU 上 ~2 行/分钟（实测 nas31 与 Windows 开发机都
  活锁，13 分钟零产出；npmjs/npmmirror、清 cacache、--legacy-peer-deps 均无效），CI
  能出包纯靠美国 runner 的快 CPU 硬磨。`fetch-dsh.mjs` 因此全面改为 **lockfile 模式**：
  `ensureLockfile()` 用本机 npm `--package-lock-only` 生成一次预解析锁（快机也要
  ~35 分钟），存为 `locks/package-lock-<dshVersion>-<pnpmVersion>.json` 并**提交进仓库**
  （这是构建输入不是缓存——CI 双架构直接复用，装出与本地验证完全一致的确定性依赖树；
  `cache/` 红线不涉及它）。锁内 resolved URL 一律规范为 npmjs 正典（生成机默认镜像时
  生成后重写），本地与远程安装路径按各自 registry 就地重写（走 npmmirror 时改写为镜像
  URL；integrity 哈希不变，镜像字节相同），安装一律 `npm ci` 跳过解析。
  **升级 dshVersion 后必须删旧锁**（名字带版本对，正常自动失效）；丢了锁文件的下一次
  构建会重新进入漫长的解析阶段。
- **fnOS `platform` 字段取值**：`x86`（仅 x86 设备）/ `arm`（仅 ARM 设备）/ `all`（同时支持，但仅当包内不含架构特定二进制时）。本应用内含架构相关的原生模块（node-pty/koffi/ripgrep 都是特定架构的 .node/.so），**不能用 `all`**——必须出两个独立包（`platform=x86` 与 `platform=arm`），分别安装到对应架构设备。

### 双架构发布（GitHub Actions）

三条 workflow，全在 `.github/workflows/`，核心构建在可复用的 `build-fpk.yml`
（双 runner 矩阵 ubuntu-latest x86_64 + ubuntu-24.04-arm 原生 arm64，fnpack 从
官方 CDN `static2.fnnas.com/fnpack/fnpack-<ver>-linux-amd64|linux-arm` 下载）：

**1. `release.yml`（手动 tag 路）**——git tag 是唯一版本来源：

```bash
git tag v0.1.0-rc.6.4 && git push --tags
# -> 解析版本 -> build-fpk 构建 -> 自动建 Release 附 dsh_<ver>_x86.fpk + _arm.fpk
```

- **tag 格式** `v<上游版本>[.<封装修订>]`：`v0.1.0-rc.7`（新上游首发）或
  `v0.1.0-rc.6.4`（同一上游封装修订）。解析规则：去掉 v 得 appver；若 appver
  去掉最后一段后等于 package.json 钉住的 dshVersion，则那段是封装修订，否则
  整个 appver 即上游版本。经 `DSH_APPVER`/`DSH_UPSTREAM` 传给 build.sh。
- `workflow_dispatch` 保留手动触发（显式输入版本，只出 artifact 不发 Release）。

**2. `auto-follow.yml`（自动跟随上游）**——每天 05:17（UTC 21:17）定时查 npm 上
`@deepseek-ai/dsh` 最新版，与 package.json 钉住的 dshVersion 比对：
- 无新版：quiet 退出（每次约 20 秒，几乎不耗额度）
- 有新版：**先构建**（调 build-fpk）→ **全部成功后**才 bump package.json、
  推 tag 留痕、用 GITHUB_TOKEN 建 Release 附双 fpk；**构建失败则什么都不动**
  （上游 rc 破坏性变更触发重写门禁时 main 保持干净，次日重试，人工修好规则集后自然通过）
- **零 PAT**：commit/tag/Release 全用 workflow 自带 GITHUB_TOKEN——其"推 tag
  不触发其他 workflow"的限制无影响，因为构建和发布在同一 workflow 内完成。

**3. `build-fpk.yml`（可复用构建）**——被上两者 `workflow_call` 调用；产物
artifact 只含 `dist/*.fpk`（info.txt 不上传、不进 Release 附件）。

**push 到 main 不构建**（不耗 runner 额度）。仓库托管在 GitHub
（`bbsde/fn-native-deepseek-harness`，主分支 `main`），推送用
`$DSH_HOME/.ssh/id_ed25519_gitee`（GitHub Deploy key，Allow write）。

- 每个架构独立 staging：`cache/dsh-runtime-x86_64/` 与 `cache/dsh-runtime-arm64/`，
  各自产出 `src/app/runtime-x86_64.tar.gz` / `runtime-arm64.tar.gz`；fnpack 前复制成
  `src/app/runtime.tar.gz`（install_callback 仍解这个固定名，包内已是对应的架构）。
- `fetch-dsh.mjs` / `rewrite-dist.mjs` / `pack-runtime.mjs` 均读 `DSH_ARCH`
  （`x86_64` 默认 / `arm64`）选择 staging 目录、ripgrep 平台包名（`ripgrep-linux-x64`
  / `ripgrep-linux-arm64`）和 pty 校验路径（`linux-x64` / `linux-arm64`）。
- **ELF e_machine 硬校验**：fetch 校验 pty.node、pack 校验 rg 的 `e_machine`
  （arm64=0xb7，x86-64=0x3e）。曾发生过"staging 标 arm 实际装出 x64 树"的事故
  （分支优先级 bug），magic-only 校验拦不住，e_machine 校验让这类错误当场失败。
- `rewrite-dist.mjs` 是对上游产物的**构建期补丁**（非源码 fork）：把 dist 外壳和全部
  `dsh.client` 插件包（扫整个 node_modules 的 dsh.client 声明发现：@deepseek-ai 39 个 +
  市场 1 个）中的根绝对 URL（`"/api`、`"/assets/`、`"/plugins/`、`"/market/api`、反引号
  形式、webmanifest 的 start_url/scope/id）改写为网关前缀，另含市场 runner 跨平台补丁
  （见"内置插件市场"节）。带校验门禁：模式消失/计数异常 → 构建失败。
  **升级 dshVersion 后重写失败时，先检查上游打包方式变化，更新规则集，再重新验证。**
- **LOOPBACK_RULE（0.1.1-rc.x 起）**：上游把 settings/credentials 特权 RPC 平面的闸门
  挪到了**客户端**——connection 包的 client.js 用页面自身 `location.hostname` 判回环，
  网关后面必然非回环 → settings 镜像进 "memory" 模式、一个 RPC 都不发，模型页报
  "settings are unavailable in this browser"（relay 骗得了服务端 Host 头，骗不了浏览器
  内部的 location）。规则把该判定钉成 `isLoopback: true`（本 fpk 里浏览器等价回环：
  请求全部经 relay 回环终结 + 管理员闸门）。门禁是家族标记
  `isLoopbackHostname(pageLocation.hostname)`——上游改写该表达式形态会触发 fail；
  上游整个改名（pageLocation 换名）则标记消失、静默不补，升级后要人工确认模型页可用。
  服务端副本 lib/index.js 的 Host 头 fence 必须保持原样（relay 靠它放行）。
- glob/grep 工具不用系统 `rg`，而是 spawn 上游 vendor 的
  `node_modules/@vscode/ripgrep-linux-<arch>/bin/rg`——树里唯一必须带执行位的文件
  （.node/.so 走 dlopen 只要读权限）。旧 Windows/MSYS tar 往返构建曾丢过该执行位：
  装出的应用一切正常、唯独 glob/grep 报 `ripgrep launch failed`（spawn EACCES）。
  `pack-runtime.mjs` 现已强制 chmod 0o755 并校验 ELF。

## 插件市场（dshmarket，首次启动在线安装）

应用提供 [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)（MIT，1040★，
npm 包 `dshmarket`）的侧边栏插件市场（浏览/搜索/一键安装/更新/卸载/皮肤）。
选它而非同名的 2BingLing/dsh-market（`@dsh-market/plugin`，曾短暂内置过）：工程成熟度
完全不同——跨平台 spawn（POSIX 直启、非 Windows 无 ComSpec 依赖）、实测 pnpm 9/10/11
的兼容层、ETag 复验的目录拉取、双语、主题市场、备份恢复。

**市场本体不进 fpk（在线模型，rc.7.15 起）**。旧模型把它 vendored 进 runtime 树并软链
进 profile，导致面板内"自更新"每次重启都被 seed 软链回滚到 fpk 里的旧版（用户实锤）。
现在：首次启动（或市场缺失/损坏时）由 cmd/main 的 `install_market_online()` 跑
`dsh plugin --profile web add dshmarket`（真实 pnpm 安装进 profile），此后版本完全归
用户——面板内自更新、重启持久。链路分四段：

- **构建期**：`package.json` 只钉 `dshVersion` + `pnpmVersion`（pnpm 是工具链，供
  `dsh plugin add` 用，随树分发；dshmarket 不在依赖集里）。build.sh 快速路径比对
  **整个依赖集**（dsh+pnpm），pin 变更即重新 fetch。
- **启动期决策（src/app/bin/seed-market.mjs，幂等、失败不阻断）**：
  - `$TRIM_PKGVAR/bin/{dsh,pnpm}` sh shim 重生成（fnpack 执行位不可信）；
  - 清掉 vendored 时代的父级软链 `profiles/node_modules/dshmarket`（升级后必悬空）；
  - 决策矩阵（stdout 打 `NEEDS_MARKET_INSTALL`）：行在且 profile 本地
    `node_modules/dshmarket` 可解析 → 健康，只刷 presence stamp（`$DSH_HOME/
    market-present`，只记在场不记版本，**绝不碰用户装的版本**）；行在但本地缺失/悬空
    → 需要安装（升级后悬空的旧软链就是这种）；行没了但有 stamp → 用户卸载了市场，
    尊重；全新设备 → 需要安装。
  - `--seed-bare`：离线兜底，写只有 dsh 自带 bundle 的裸 profile（零网络可启动），
    市场等下次有网再装。cmd/main 在在线安装失败时调它。
- **cmd/main 的 `ensure_market()`**：跑 seed → 见 NEEDS 就 `install_market_online()`
  （dsh_launch_env 全环境 + `timeout 600`）→ 成功重跑 seed 盖章；失败 seed 裸骨架、
  下次启动重试。start/salvage/reseed/supervised-restart 全走它。
- **relay 运行期 JS 重写（`relay.mjs` JS_PATH_RULES/JS_CDN_RULES）**：市场客户端是
  运行期安装的，构建期看不到——凡是 `/plugins/*` 的 javascript 响应，relay 缓冲后把
  根绝对路由（`"/dsh-market/*`、`"/api/*`、`"/plugins/*`、`"/assets/*`，三种引号形式，
  全部带尾斜杠防 `/apis` 这类误伤）加网关前缀，并把 GitHub CDN 模板串改写到加速代理
  （`--gh-proxy`，由 cmd/main 传设备级 github-accel 解析值，off 即只关 CDN 规则）。
  幂等（引号锚定，已前缀的不匹配）。这同时惠及任何运行期安装的插件客户端。
  host 端路由注册保持根相对（relay 剥前缀后正好对上）。**不需要 runner 补丁**。

数据源与目录缓存：dshmarket 上游对目录（`https://awesome-dsh-plugin.com/plugins.json`，
实测 1.25MB / 1500+ 插件，每日由 CI 生成）的哲学是"每次面板打开都向源站实时校验、过期
目录宁可报错"——ETag 备忘只存进程内存，应用每重启一次就要完整重拉一遍。国内到该源站
（GitHub Pages 日本边缘）握手快但正文被限速：nas31 实测完整拉取 12.7s/137.9s/80.8s，
而 dshmarket 预算只有 15s×2——重启后第一次打开市场基本必超时报错。该域名无法走 gh-proxy
（非 GitHub 域名 403），文件又是 CI 产物（仓库里只有源数据，无 raw 镜像可代），因此
**加速必须落在本地**：`bin/catalog-cache.mjs` 起 stale-while-revalidate 缓存（只绑
127.0.0.1:3180，`DSH_MARKET_CACHE_PORT` 可改），cmd/main 通过 `DSHM_REGISTRY_URL` 把
dshmarket 的取数指过去。面板请求**立即**返回磁盘缓存（`$TRIM_PKGVAR/market-cache/`，
重启后第一次也秒回），后台按 5 分钟节流向源站刷新（180s 预算，覆盖实测最差链路）；源站
挂了继续服务最后一份好目录（NAS 场景的取舍：昨天的目录好过 30 秒转圈）；只有拉到合法
目录（含非空 plugins 数组）才覆盖缓存，坏响应不会污染好副本。冷启动且源站拉不到时按
dshmarket 的耐心上限回 503（面板显示可重试错误，与上游行为一致）。缓存服务死了自动退
回上游直连（cmd/main 探 healthz，不通就不注入）。换源/关闭：`echo <URL或off> | sudo tee
/vol1/@appshare/dsh/home/market-registry`（或文件管理器直接编辑共享里的同名文件）后重启
应用。契约测试 `scripts/test-catalog-cache.mjs`。

- **插件安装走国内源**：cmd/main 给 dsh 进程（及其 pnpm 子进程）export
  `npm_config_registry=https://registry.npmmirror.com`（`NODEJS_ORG_MIRROR` 同步指向
  npmmirror 的 node 头文件，带原生依赖的插件编译不再等 nodejs.org）。镜像出问题时
  （如刚发布的包还没同步）：`echo https://registry.npmjs.org | sudo tee
  /vol1/@appshare/dsh/home/npm-registry` 后重启应用即回官方源。
- **市场详情页的 GitHub 资源也走代理（relay 运行期重写）**：dshmarket 的 client 直接在
  浏览器里拉 `raw.githubusercontent.com` 的 README/截图和 `github.com/<owner>.png` 头像，
  CN 网络下 DNS 全挂（控制台一片 ERR_NAME_NOT_RESOLVED / ERR_CONNECTION_RESET）→
  relay 的 JS_CDN_RULES 把这些模板串改写到 `https://gh-proxy.com/…`（头像改写为
  `avatars.githubusercontent.com/<owner>` 直达形式——github.com 的 .png 是 302 跳转页，
  代理不重写跳转目标）。代理根由 cmd/main 从设备级 github-accel 解析后经 `--gh-proxy`
  传入，与进程内默认值同源；改 github-accel 重启应用即对市场详情页生效。
- **GitHub 源插件加速**：分两层，cmd/main 同时注入——
  1. git 层（`git ls-remote`/clone）：`git+https://github.com/…` 规格经 insteadOf 改写为
     `https://gh-proxy.com/https://github.com/…`（默认；skill 型 git clone 同样生效）；
  2. HTTP 层（**关键**）：pnpm 拉 GitHub 依赖不走 git，而是直接
     `https://codeload.github.com/<o>/<r>/tar.gz/<sha>` 的普通 HTTPS 请求，insteadOf 看不见
     ——`app/bin/gh-accel-preload.cjs` 经 `NODE_OPTIONS=--require` 挂进 dsh 进程树的每个
     Node 进程，在 https.request/fetch 层把 codeload 地址改写到代理（实测 pnpm 10 走
     node:https）。两层都只影响本应用进程树，不碰 NAS 全局配置；dsh agent 自己的
     clone/下载也会被加速。第三方代理有信任成本，换地址/禁用：
     `echo https://ghproxy.net/ | sudo tee /vol1/@appshare/dsh/home/github-accel`（写代理根地址，
     带 https 和尾斜杠；也接受已含 github.com 的完整前缀；置空或写 off 即关）后重启应用。
  gh-proxy.org 是 gh-proxy.com 的 301 别名（同一服务），填哪个效果一样、.com 少一跳。
  `api.github.com` 的元数据请求（star 数等）不在改写范围。

- **市场升级**：面板内自更新即生效并持久（在线安装的副本不会被任何 seed 触碰）。
  relay 的 JS 规则若因新版 client.js 字符串形态变化而失配，症状是面板 RPC 打到网关
  404——按新版实际字符串更新 relay.mjs 的 JS_PATH_RULES/JS_CDN_RULES 并重新验证。

已知限制（上游行为或网关固有，排障时先想到这些）：

- 运行期安装的插件客户端，其根绝对路由只有 relay JS_PATH_RULES 覆盖到的形态
  （`/api/`、`/plugins/`、`/assets/`、`/dsh-market/` 前缀 + 双/单/反引号字符串）会被
  前缀化；更花哨的拼接形态不吃网关前缀（既有网关限制，与上游直连行为一致）。
- 市场内安装只接受 awesome-dsh-plugin 目录里收录的包（上游的安全设计）。
- skill 型/git 源安装依赖主机 `git`；`github:` 源走 pnpm 整仓下载，慢网下有超时重试。

## 开发测试生命周期（平台：nas31）

**出包后不主动 scp 到测试机**：fpk 留在 `dist/` 即可，用户自己通过 fnOS 桌面页面上传安装
（页面路径有客户端版本检查，版本号必须对已装版本字符串递增——见构建节的"跨 9 陷阱"；
设备处于异常状态时页面会拒装，那时才需要在宿主 shell 走 CLI 卸载重装）。

测试机已配好 SSH 免密别名：`~/.ssh/config` → `Host nas31`（192.168.0.31，用户 李承龙，
x86_64，fnOS 1.1.3105）。`appcenter-cli` 在 `/usr/local/bin/appcenter-cli`，**需要 sudo**。

一轮完整生命周期：

```bash
npm run build                                        # 1. 本地出 fpk（fetch 在 nas31 上远程执行）
scp src/dsh.fpk nas31:/tmp/                          # 2. 上传
ssh nas31 'sudo /usr/local/bin/appcenter-cli install-fpk --volume 1 /tmp/dsh.fpk'   # 3. 安装
ssh nas31 'sudo /usr/local/bin/appcenter-cli start dsh'        # 4. 启动
ssh nas31 'sudo /usr/local/bin/appcenter-cli status dsh'       # 5. 状态
ssh nas31 'sudo /usr/local/bin/appcenter-cli stop dsh'         # 6. 停止
ssh nas31 'sudo /usr/local/bin/appcenter-cli uninstall dsh'    # 7. 卸载
```

真机验证点（等价于网关转发，无需浏览器登录态）：

```bash
ssh nas31 'sudo curl -s --unix-socket /vol1/@appcenter/dsh/app.sock \
  -H "X-Trim-Isadmin: true" -o /dev/null -w "%{http_code}\n" http://nas.local/app/dsh/'
# 期望 200；去掉 admin 头期望 403；日志 /vol1/@appdata/dsh/app.log 出现
# "dsh web: http://127.0.0.1:3080" 即插件树加载成功。
# 市场插件三连（client bundle 已前缀化 / host RPC 通 / boot 图含市场条目）：
#   /app/dsh/plugins/dshmarket/client.js → 200 且 body 含 "/app/dsh/dsh-market/"
#   POST /app/dsh/dsh-market/status → 插件 RPC JSON（不是网关 404）
#   /app/dsh/ 首页 __DSH_BOOT__ entries 有 url 含 "/plugins/dshmarket/" 的条目
```

- `start` 命令可能报 error code 10500——是 CLI 等待超时（冷启动初始化 profile 较慢），
  **以 `status` 和日志为准**，不是失败。
- **uninstall 后要 sleep 几秒再 install**：卸载未完全落稳时紧接着 install-fpk 可能静默失败
  （症状：app list 里没有应用、@appdata 目录缺失）。排查时不要用 grep 过滤安装输出，看全文。
- **升级会对 @appdata 全量递归 chown，遇到悬空软链当场失败**（trim_app_center/error.log 实锤：
  `chown …/node_modules/.bin/cordis: no such file or directory`，报
  APP_UPDATE_FAILED_INSTALL_INIT_FILE_EXCEPTION，应用树被清空、APP_CRASH 30s 循环、
  registry 卡旧版本，此后任何更新都拒装——只能卸载重装）。悬空链来自 pnpm 的 `.bin`
  shim：插件包被非 pnpm 手段移除（salvage 剔坏插件、手工 rm）后 shim 残留。三处守卫：
  cmd/main 每次启动 `find $TRIM_PKGVAR -xtype l -delete`；install/upgrade_callback 末尾
  同样清扫（upgrade 的 chown 在回调之后跑，运行期新产生的悬空链靠它兜住）；
  profile-salvage 剔除插件后只清 node_modules/.bin 的悬空 shim。设备已中招时的恢复：
  `sudo find /vol1/@appdata/dsh -xtype l -delete` → 卸载 → 全新安装（全新安装不做该
  chown 遍历，实测悬空链在场也能装成功）。
- **install-fpk 命令返回 ≠ 安装结束**：appcenter 守护进程还在后台异步收尾（journal 可见
  `app.updating` → 注册/自启/清旧树/提交版本号，可达几十秒）。**装完立刻 stop/start 会打断
  收尾**，实测后果（rc.7.11 在 nas31）：`APP_UPDATE_FAILED_INSTALL_INIT_FILE_EXCEPTION`
  → 应用树 `/vol1/@appcenter/dsh` 被清空、registry 版本卡在旧值、应用进入 APP_CRASH
  30s 循环；此时任何升级安装都被拒（桌面报"不符合系统要求"），**只能卸载重装**
  （@appdata 不受影响、会保留）。装完后等 ~30s 再做任何操作；要改 profile 之类，
  在 stop 之后、start 之前做，绝不要插在安装后。
- 卸载后 `/vol1/@appdata/dsh` 等数据目录会保留（fnOS 行为）；要彻底清理需手动删。
- **启动看门狗（cmd/main，两级恢复）**：坏插件（如 TUI 型插件装进 web profile）或手改坏的
  `cordis.patch.yml` 会让 dsh web 在监听前**无声挂死/退出**。start 时轮询 3080（默认
  180s，`DSH_BOOT_TIMEOUT` 可调），失败且存在 web profile 时按序两级恢复：
  1. **外科手术（salvage，`bin/profile-salvage.mjs`）**：每次成功启动后把 profile 的
     输入文件（package.json / pnpm-workspace.yaml / cordis.patch.yml / pnpm-lock.yaml）
     快照到 `$TRIM_PKGVAR/lastgood-web`；启动失败时先 park 整个 profile，把输入文件换回
     快照、删掉快照之后新装的插件的 node_modules、删合成的 cordis.yml，再启动。
     dsh boot 纯按 manifest 的 `dsh.profile.bundles` 加载（reconcilePlugins 只在
     `dsh plugin` 命令时跑，boot 不扫 node_modules），所以恢复 manifest 即可让坏插件
     不加载——**成功启动过的插件全部存活，坏插件只损失它自己**。原始坏 manifest 留在
     `package.json.broken` 供排查。
  2. **整体重置（reseed，兜底）**：手术版也起不来（如 runtime 升级改了内置 bundle 名）
     才 park 到 `profiles/web.recovery.<时间戳>[.salvaged]`（保留检查）→ 重新种子 →
     再失败才报错。绝不删 DSH_HOME 其他数据。seed-market 每次启动**只保留最近 2 份**
     recovery 备份。
  日志关键字：`attempting salvage` / `salvage boot OK; removed plugin(s)…` /
  `parking web profile` / `recovery boot OK`。
  已知取舍：**从未成功启动过**的插件不受快照保护（一次装多个、其中混了坏插件时，
  salvage 会回滚到上一次成功启动的形状，未启动过的一并移除）——装一个重启一次最稳。
- **市场"立即重启"被改道为托管重启（relay 拦截 + supervisor）**：dshmarket 的自重启
  （restart.js `scheduleRestart`）会起一个**脱管 helper** 等端口空了再自己 spawn 替补
  dsh web（detached、cwd 落在 runtime 的 lib 目录、日志进 /tmp），然后 SIGTERM 旧进程——
  替补不在任何 pid 文件里，`dsh.pid` 从此指向死 PID，**应用中心永远显示"停止"**（页面
  反而还能用，因为 relay 没人动）；且替补绕过启动看门狗与快照，坏插件重启即挂死无自愈。
  三件套修复：
  1. **relay 拦截**（`--restart-flag`）：`POST /app/dsh/dsh-market/restart` 不转发，直接回
     客户端唯一认的 `202 {"ok":true}` 并落 flag 文件 `$TRIM_PKGVAR/restart-web`；客户端
     随后轮询 `/dsh-market/status` 等 boot id 变化（60s 耐心），变了整页 reload——体验
     与原版一致。非 admin 照旧 403；没配 flag 的 relay（本地测试）保持透传。
  2. **supervisor**（`bin/supervise-web.sh`，start 成功后 setsid 拉起，stop 先杀它的
     整个进程组）：见 flag、web 进程消失、或 web 活着但超时（`DSH_BOOT_TIMEOUT`）不服务
     → 调 `cmd/main supervised-restart`（杀旧→悬空链清扫→种子→按完整环境拉新→看门狗
     级联→快照，成功后清 flag）；顺带 relay 掉了补拉（`relaunch-relay`）。失败退避
     30s 起最多 300s。手工触发托管重启：`touch /vol1/@appdata/dsh/restart-web`。
  3. **stop/清扫**：`stop_web_only` 杀 tracked pid 后按 /proc 扫描清一切占用 3080 的
     `bin.js web` 野进程和遗留的 `dsh-market-restart` helper（老版本重启留下的替补
     也能被接管清掉），再等端口安静。
  日志关键字：`supervised web restart` / `supervisor: restart requested` /
  `sweeping untracked dsh web process`。契约测试 `scripts/test-relay-restart-intercept.mjs`。
- **应用中心 status 只看 `dsh.pid` + `relay.pid`**：supervisor/cache 挂了不影响 status
  （supervisor 死了只是失去自愈，下次 start 重生）。托管重启期间（几十秒）status 会短暂
  报停止——真实状态，等新进程起来即恢复。
- 浏览器端最终验证：管理员账号登录 NAS 桌面 → 打开 DS·H → 设置→模型 填 API Key。

## 本地验证（Windows 开发机，Git Bash）

```bash
# relay TCP 模式（注意 Windows 本地跑 dsh web 可行但不含 Linux 原生模块路径场景）
node src/app/bin/relay.mjs --tcp-port 13080 --target 127.0.0.1:3080 --prefix /app/dsh
node scripts/test-boot-sequence.mjs     # 模拟浏览器启动：首页→插件图→bundle→langs chunk
node scripts/test-ws-upgrade.mjs        # WebSocket 101 升级
```

curl 检查要点：无 `X-Trim-Isadmin` → 403；带 admin + 任意 Host → 200（Host 重写过 fence）；
直连 3080 + 伪造 Host → 403（fence 控制组）。

## 红线

- relay 的 `--test-allow-anonymous` **只允许本地验证**，cmd/main 与任何生产调用不得出现。
- 不改上游源码；所有适配都在 relay 与构建期重写里。
- 不要把 `cache/`（构建缓存）和 `src/app/runtime.tar.gz`（构建产物）提交进仓库。
- Git Bash 下传 `/app/...` 之类参数给 node 时加 `MSYS_NO_PATHCONV=1`，否则参数被路径转换污染；
  node 脚本里远程命令一律走 `spawnSync('ssh', [host,'bash -s'], {input})`，别过 Windows shell。
- 上游 `.credentials.yaml` 强制 owner-only POSIX 权限位，而共享目录的 mode 位形态不可控
  （命名 ACL 授权）——**守卫不可删**：dsh_launch_env 每次启动前 `chmod 600` 该文件；
  移动/新增任何"启动 dsh"的代码路径都必须先过守卫。缓存类文件一律放 `TRIM_PKGVAR`，
  共享区只放用户数据。
