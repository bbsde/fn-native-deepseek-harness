# fn-native-deepseek-harness

把 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 打包为飞牛 fnOS
原生应用（.fpk）。应用标识为 `dsh`，显示名 **DSH**，通过统一网关 `/app/dsh` 访问。

## 设计要点

上游 dsh 的 Web UI 刻意只监听 127.0.0.1（该 UI 可执行任意代码，且自身无认证），
因此本封装不绕过上游安全模型，而是：

- **统一网关**：fnOS 登录态在前，桌面内 iframe 打开 `/app/dsh`；入口仅管理员可见。
- **relay 适配层**（`src/app/bin/relay.mjs`）：监听网关 Unix socket，校验 `X-Trim-Isadmin`、
  剥网关前缀、把 Host/Origin 重写为回环地址（通过 dsh 的 browser-trust fence）、代理
  WebSocket、对运行时注入 HTML 的 `/plugins/` URL 做前缀化。
- **构建期 URL 重写**（`scripts/rewrite-dist.mjs`）：dsh 前端把 `/api`、`/assets`、
  `/plugins` 全部写成域名根绝对路径，网关前缀下会 404；构建时对其 dist 外壳与全部
  `dsh.client` 插件包做确定性改写并强制校验（模式消失即构建失败）。
- **数据布局**：`DSH_HOME=$TRIM_PKGVAR/dsh`（凭据/插件/会话，私有）；共享目录
  `dsh/workspace` 是 agent 工作目录（启动时 cwd），产出在文件管理器可见。
- **不改上游源码**：所有适配都在 relay 与构建期补丁里，升级上游只需改 `dshVersion` 重跑构建。

## 构建

前置：飞牛测试机一台（SSH 免密，装有 nodejs_v24 运行时与 `g++ make python3` 工具链，
本项目的构建机为 `nas31`）；本地 fnpack。

```bash
./build.sh          # 自动取上游最新版，输出 dist/dsh_<应用版本>_dsh<上游版本>.fpk
./build.sh 0.1.0-rc.6   # 或构建指定版本
```

`build.sh` 会把所用的上游版本钉回 `package.json`（`dshVersion`），并**将 fpk 版本镜像为
上游版本**（应用中心里看到的版本即所带 dsh 版本；同一上游的纯封装修复重新发布时手动在
尾号加 `.N`）。构建自动完成：远程 Linux 安装（node-pty/koffi 原生模块必须在 Linux x64
上装）→ 前端 URL 前缀重写（带校验门禁）→ fnpack 打包。同版本重复构建走快速路径。

## 安装（fnOS 设备）

```bash
scp src/dsh.fpk nas31:/tmp/
ssh nas31 'sudo /usr/local/bin/appcenter-cli install-fpk --volume 1 /tmp/dsh.fpk'
ssh nas31 'sudo /usr/local/bin/appcenter-cli start dsh'
```

管理员账号登录 NAS 桌面，打开 DSH，在 设置→模型 填入 API Key 即可使用。
Agent 产出的文件默认在共享目录 `dsh/workspace`。

## 验证

- 真机：`ssh nas31 'sudo curl -s --unix-socket /vol1/@appcenter/dsh/app.sock -H "X-Trim-Isadmin: true" -o /dev/null -w "%{http_code}\n" http://nas.local/app/dsh/'`（期望 200，去 admin 头期望 403）
- 本地：`node scripts/test-boot-sequence.mjs`、`node scripts/test-ws-upgrade.mjs`

## 已知限制

- 仅 x86（原生模块为 linux-x64）；ARM 需要单独构建一轮。
- `appcenter-cli start` 可能报 error 10500（CLI 等待超时），以 `status` 和
  `/vol1/@appdata/dsh/app.log` 为准。
- dsh 处于 rc 阶段（当前钉 0.1.0-rc.6），升级需关注重写门禁是否需要适配。
- 已知上游缺陷（rc.6）：自定义提供商卡片用打开时的 settings revision 且不刷新，卡片打开期间
  llm-pi-ai 被写过（如上次保存半途失败）后再保存必报
  `settings namespace "llm-pi-ai" changed since it was read`。**解法：关闭卡片重新打开再保存**；
  服务端路径经 RPC 实测正常（`scripts/test-custom-provider.sh`）。
- 卸载后 `/vol1/@appdata/dsh` 数据目录保留，彻底清理需手动删除。

更多开发约定与生命周期细节见 [AGENTS.md](AGENTS.md)。
