# Surface GO GNOME Desktop Customisation

Debian Trixie (GNOME 48) 定制补丁集，针对 Surface GO 硬件优化。
推一个 v* tag，CI 一次性构建 gnome-shell + gnome-control-center 两个 deb。

## 目录结构

```
gnome-shell/                     <- 桌面外壳
  overrides/                        JS 覆盖文件
  scripts/build-deb.sh              构建脚本

gnome-control-center/            <- 系统设置
  overrides/                        C/UI 覆盖文件
  scripts/
    build.sh                        构建脚本
    mask-unused-services.sh         屏蔽后台服务
    optimize-gsettings.sh           GSettings 优化
    tune-kernel.sh                  内核/zram/i915 调优

.github/workflows/build.yml     <- 统一 CI (v* tag 触发)
```

## 快速开始

### CI 一键构建

```bash
git tag v48.7-dock21 && git push origin v48.7-dock21
# 自动构建 gnome-shell + gnome-control-center，产物在 Release 页面下载
```

### 本地构建

```bash
sudo ./gnome-shell/scripts/build-deb.sh
sudo ./gnome-control-center/scripts/build.sh
sudo dpkg -i gnome-shell/dist/*.deb gnome-control-center/dist/*.deb
sudo apt-mark hold gnome-shell gnome-control-center
```

### 装机后优化 (跑一次)

```bash
sudo ./gnome-control-center/scripts/mask-unused-services.sh
./gnome-control-center/scripts/optimize-gsettings.sh
sudo ./gnome-control-center/scripts/tune-kernel.sh
```

### 回滚

```bash
# gnome-shell
cd gnome-shell-rollback-*/ && ./restore.sh && sudo systemctl restart gdm

# gnome-control-center
sudo apt install --reinstall gnome-control-center
sudo apt-mark unhold gnome-control-center
```
