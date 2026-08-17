# AGENTS.md — fn-native-deepseek-harness

把 DeepSeek Harness（dsh，AI Agent 框架）打包成飞牛 fnOS 原生应用（.fpk）的工程。
上游：https://github.com/deepseek-ai/deepseek-harness （MIT，npm 包 `@deepseek-ai/dsh`）。

命名约定：**应用标识一律用 `dsh`**（appname、网关前缀 `/app/dsh`、运行用户 `dsh`、共享目录
`dsh/workspace`、显示名 `DS·H`）；只有仓库名保留全称 fn-native-deepseek-harness。

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

数据布局（**不要**把 DSH_HOME 放共享目录）：

- `DSH_HOME=$TRIM_PKGVAR/dsh`（即 `/vol1/@appdata/dsh/dsh`）：`.credentials.yaml`
  （上游强制 owner-only 权限位，放共享目录会拒绝启动）、profiles/（可执行插件代码）、会话与设置。
- dsh 运行时整树以单文件 `src/app/runtime.tar.gz` 进 fpk（33k 文件打成 1 个，安装秒级），
  `cmd/install_callback`/`upgrade_callback` 在安装/升级时解压到 `$TRIM_PKGVAR/runtime`，
  cmd/main 从那里启动 dsh（解压失败的报错会指向重装）。
- 共享目录 `dsh/workspace`（data-share 声明，实际在 `/vol1/@appshare/dsh/workspace`）：
  agent 工作目录。cmd/main 启动 dsh 前 `cd` 进去，新会话 cwd 默认取 `process.getcwd()`，
  产出文件天然落在共享区，文件管理器可见。
- dsh 进程的 `HOME` 也指向共享 workspace（目录选择器默认列 `os.homedir()`，不设 HOME 会
  落到不存在的 `/home/dsh` 报 ENOENT）；npm/XDG 缓存重定向到 `$DSH_HOME_DIR` 下避免
  点文件污染共享区。

关键 TRIM_ 环境变量（实测值）：`TRIM_APPDEST=/vol1/@appcenter/dsh`、
`TRIM_PKGVAR=/vol1/@appdata/dsh`、`TRIM_DATA_SHARE_PATHS=/vol1/@appshare/dsh/workspace`。
`/var/apps/dsh/shares/workspace` 是共享目录的软链（注意是 `shares` 不是 `share`）。

## 目录

```
src/                 # fnpack 打包根（manifest、config/、cmd/、app/bin/relay.mjs、app/ui/）
cache/dsh-runtime-x86_64/  # 构建缓存：x86_64 的 dsh node_modules（勿手改，勿提交）
cache/dsh-runtime-arm64/    # 构建缓存：arm64 的 dsh node_modules（仅 CI/原生 arm 主机产生）
src/app/runtime.tar.gz  # 构建期生成：runtime 整树单文件 tar（33k 文件打包成 1 个，
                      #   安装秒级；cmd/install_callback 解压到 $TRIM_PKGVAR/runtime）
scripts/             # fetch-dsh / rewrite-dist / build / 本地与真机测试脚本
package.json         # dshVersion 钉死上游版本
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
- **fnOS `platform` 字段取值**：`x86`（仅 x86 设备）/ `arm`（仅 ARM 设备）/ `all`（同时支持，但仅当包内不含架构特定二进制时）。本应用内含架构相关的原生模块（node-pty/koffi/ripgrep 都是特定架构的 .node/.so），**不能用 `all`**——必须出两个独立包（`platform=x86` 与 `platform=arm`），分别安装到对应架构设备。

### 双架构发布（GitHub Actions，tag 驱动）

**发布流程全自动，git tag 是唯一版本来源**：打 tag 即构建+发 Release，无需手动跑
build 或改版本文件：

```bash
git tag v0.1.0-rc.6.3 && git push --tags
# -> CI 双 runner 矩阵构建（ubuntu-latest x86_64 + ubuntu-24.04-arm 原生 arm64）
# -> 自动建 GitHub Release 附 dsh_<ver>_x86.fpk + dsh_<ver>_arm.fpk
```

- **tag 格式** `v<上游版本>[.<封装修订>]`：`v0.1.0-rc.7`（新上游首发）或
  `v0.1.0-rc.6.3`（同一上游的封装修订）。CI 解析规则：去掉 v 得 appver；若
  `appver` 去掉最后一段后等于 package.json 钉住的 dshVersion，则那段就是封装修订，
  上游版本取剩余部分，否则整个 appver 即上游版本。解析结果经 `DSH_APPVER`/
  `DSH_UPSTREAM` 传给 build.sh（无需手改 package.json/manifest——CI 构建树里改写）。
- **push 到 main 不构建**（省 runner 额度）；`workflow_dispatch` 保留手动触发
  （显式输入 appver/upstream，只出 artifact 不发 Release）。
- fnpack 从官方 CDN 下载（`static2.fnnas.com/fnpack/fnpack-<ver>-linux-amd64|linux-arm`，
  双架构都有），非 npm 包。
- 原生 arm64 runner 上 npm 自然解析 arm64 optional deps（ripgrep），无 QEMU/代理。
- 仓库托管在 GitHub（`bbsde/fn-native-deepseek-harness`，主分支 `main`），推送用
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
- `rewrite-dist.mjs` 是对上游产物的**构建期补丁**（非源码 fork）：把 dist 外壳和 39 个
  `dsh.client` 插件包（经 package.json exports["./client"] 发现）中的根绝对 URL
  （`"/api`、`"/assets/`、`"/plugins/`、反引号形式、webmanifest 的 start_url/scope/id）
  改写为网关前缀。带校验门禁：模式消失/计数异常 → 构建失败。
  **升级 dshVersion 后重写失败时，先检查上游打包方式变化，更新规则集，再重新验证。**
- glob/grep 工具不用系统 `rg`，而是 spawn 上游 vendor 的
  `node_modules/@vscode/ripgrep-linux-<arch>/bin/rg`——树里唯一必须带执行位的文件
  （.node/.so 走 dlopen 只要读权限）。旧 Windows/MSYS tar 往返构建曾丢过该执行位：
  装出的应用一切正常、唯独 glob/grep 报 `ripgrep launch failed`（spawn EACCES）。
  `pack-runtime.mjs` 现已强制 chmod 0o755 并校验 ELF。

## 开发测试生命周期（平台：nas31）

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
```

- `start` 命令可能报 error code 10500——是 CLI 等待超时（冷启动初始化 profile 较慢），
  **以 `status` 和日志为准**，不是失败。
- **uninstall 后要 sleep 几秒再 install**：卸载未完全落稳时紧接着 install-fpk 可能静默失败
  （症状：app list 里没有应用、@appdata 目录缺失）。排查时不要用 grep 过滤安装输出，看全文。
- 卸载后 `/vol1/@appdata/dsh` 等数据目录会保留（fnOS 行为）；要彻底清理需手动删。
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
- 上游 `.credentials.yaml` 强制 owner-only 权限位——DSH_HOME 永远放 `TRIM_PKGVAR`。
