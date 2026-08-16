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
cache/dsh-runtime/   # 构建缓存：Linux x64 的 dsh node_modules（勿手改，勿提交）
src/app/runtime.tar.gz  # 构建期生成：runtime 整树单文件 tar（33k 文件打包成 1 个，
                      #   安装秒级；cmd/install_callback 解压到 $TRIM_PKGVAR/runtime）
scripts/             # fetch-dsh / rewrite-dist / build / 本地与真机测试脚本
package.json         # dshVersion 钉死上游版本
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
- **npm install 必须在 Linux x64 上执行**：dsh 有原生依赖 node-pty（需编译或预编译产物）
  和 koffi（install 脚本装原生模块），Windows/`--ignore-scripts` 装出的树在 fnOS 上必崩
  （症状：plugin tree failed to load / pty.node not found / Koffi missing）。
  `fetch-dsh.mjs` 通过 SSH 在构建机（`DSH_BUILD_HOST`，默认 nas31）上用设备同款
  nodejs_v24 运行时安装，tar 回传（保符号链接），并校验 pty.node 是 Linux ELF。
- nas31 需要一次性装好工具链：`sudo apt-get install -y g++ make python3`（node-pty 编译用）。
- `platform=x86`：原生模块是 linux-x64 的；ARM 设备需要另跑一套 ARM 构建。
- `rewrite-dist.mjs` 是对上游产物的**构建期补丁**（非源码 fork）：把 dist 外壳和 39 个
  `dsh.client` 插件包（经 package.json exports["./client"] 发现）中的根绝对 URL
  （`"/api`、`"/assets/`、`"/plugins/`、反引号形式、webmanifest 的 start_url/scope/id）
  改写为网关前缀。带校验门禁：模式消失/计数异常 → 构建失败。
  **升级 dshVersion 后重写失败时，先检查上游打包方式变化，更新规则集，再重新验证。**

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
