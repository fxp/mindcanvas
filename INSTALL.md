# 安装步骤（从 GitHub Release 安装）

两个包按场景二选一。前置：目标机已装 **Docker 引擎 + compose 插件**（`docker --version`、`docker compose version` 都能用）。

## 先下载（任选一种）

```bash
# 方式①：gh CLI（已登录）
gh release download v1.0.0 -R fxp/mindcanvas

# 方式②：curl 直链
curl -LO https://github.com/fxp/mindcanvas/releases/download/v1.0.0/mindcanvas-offline-amd64.tgz
curl -LO https://github.com/fxp/mindcanvas/releases/download/v1.0.0/mindcanvas-release.tgz
curl -LO https://github.com/fxp/mindcanvas/releases/download/v1.0.0/SHA256SUMS

# 校验完整性
sha256sum -c SHA256SUMS      # macOS: shasum -a 256 -c SHA256SUMS
```

---

## A. 离线镜像包 `mindcanvas-offline-amd64.tgz`（内网 / 无外网，linux/amd64）

镜像已打包在内，**全程零联网**。

```bash
tar xzf mindcanvas-offline-amd64.tgz      # 解出目录 mindcanvas-offline/
cd mindcanvas-offline

# 一键安装（载入镜像 → 生成 .env → 起服务）
./install.sh
```

`install.sh` 等价于手动三步：

```bash
docker load -i mindcanvas-image.tar.gz                       # 载入镜像 mindcanvas:latest
cp .env.example .env && vi .env                              # 改密码/端口；Key 可留空
docker compose -f docker-compose.offline.yml up -d           # 启动（不构建）
```

---

## B. 源码 / 构建包 `mindcanvas-release.tgz`（能联网，现场构建）

构建时会拉 `node:22-alpine` + npm 装 `ws`（需可达 Docker Hub 或镜像加速）。

```bash
mkdir mindcanvas && tar xzf mindcanvas-release.tgz -C mindcanvas   # 包内无顶层目录，解到新目录
cd mindcanvas

cp .env.example .env && vi .env            # 改密码/端口；Key 可留空
docker compose up -d --build               # 构建并启动
```

> 拉不动基础镜像时：在 `/etc/docker/daemon.json` 配 `{"registry-mirrors":["https://docker.m.daocloud.io"]}` 后 `systemctl restart docker` 再来一遍（详见 [DEPLOY.md](DEPLOY.md) §6）。

---

## 启动后（两种包通用）

```bash
# A 包：docker compose -f docker-compose.offline.yml ps   （B 包：docker compose ps）
docker compose ps                          # 应为 healthy
curl http://localhost:8080/api/health      # 端口 = .env 里的 HOST_PORT，默认 8080
```

1. 浏览器开 `http://<本机IP>:<HOST_PORT>/admin`，用 `.env` 里的管理员账号登录（默认用户名 `admin`，密码取自 `MINDCANVAS_ADMIN_PASSWORD`）。
2. 在 **/admin** 配置「综合引擎 API Key」（智谱 GLM / Claude / 内网网关）→ 保存校验 → 持久化到数据卷（镜像 keyless）。不配也能跑（启发式降级）。
3. **尽快改掉默认 `admin` / `speaker` 密码**（/admin → 用户管理）。
4. 把观众链接发出去：`http://<本机IP>:<HOST_PORT>/?room=<房间号>`。

**配置项**（在 `.env` 改）：`HOST_PORT`、`MINDCANVAS_ADMIN_PASSWORD` / `SPEAKER_PASSWORD`、`BIGMODEL_API_KEY`、`MINDCANVAS_SEARCH_MODE`（web/local/off）、`MINDCANVAS_VISION`（off 关视觉）等。改完执行 `docker compose ... up -d` 生效。

**运维**：`docker compose ... {ps, logs -f, restart, down}`（A 包记得带 `-f docker-compose.offline.yml`）。数据都在卷 `mindcanvas_data`，`down` 不删数据、`down -v` 才清。

更多见 [DEPLOY.md](DEPLOY.md)（部署）与 [USAGE.md](USAGE.md)（使用）。
