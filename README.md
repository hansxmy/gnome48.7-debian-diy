# dock (Standalone GNOME Shell Dock Patch Project)

这个目录是独立 GitHub 项目，不依赖当前工作区其它目录。

## 目录结构

- `.github/workflows/build-deb.yml`：GitHub Actions 自动构建 Debian `.deb`
- `scripts/build-deb.sh`：下载 Debian gnome-shell 源码、覆盖补丁文件、打包
- `scripts/snapshot-current-gnome-shell.sh`：安装前快照与回滚包准备
- `scripts/collect-gnome-shell-bugreport.sh`：采集日志与 bug 包
- `scripts/bump-local-version.sh`：本地版本号后缀管理
- `overrides/js/ui/*.js`：核心 Dock/Overview 改动文件
- `overrides/js/ui-root/*.js`：工作区策略与主入口改动文件

## 你要做的事（最短流程）

1. 把 `dock/` 单独作为仓库推到 GitHub（以 `dock/` 作为仓库根目录）。
2. 在 GitHub Actions 手动触发 `Build Dock GNOME Shell .deb`。
3. 下载 `dist/` 产物并在 Debian 上安装。

## CI 产包说明

- 当前 workflow 默认 `RUN_TESTS=0`，会跳过上游自动化测试，目标是稳定产出完整 `gnome-shell` 二进制包（`gnome-shell`/`gnome-shell-common` 等）。
- 如果你想在 CI 里同时跑测试，可把 workflow 的 `RUN_TESTS` 改为 `1`。

## Debian 安装与回滚

安装前先执行：

```bash
chmod +x scripts/snapshot-current-gnome-shell.sh
./scripts/snapshot-current-gnome-shell.sh
```

安装后异常就回滚：

```bash
cd gnome-shell-rollback-YYYYMMDD-HHMMSS
./restore.sh
sudo systemctl restart gdm
```

## 采集日志给修复

```bash
chmod +x scripts/collect-gnome-shell-bugreport.sh
./scripts/collect-gnome-shell-bugreport.sh
```

把 `gnome-shell-bugreport-*.tar.gz` 和复现步骤发来即可。
