# MindCanvas 部署文档

实时会议 Agent：把「一人讲、几百人听」的单向广播，变成一块实时把群体声音收敛成连贯内容的协作认知画布。

---

## 1. 架构与依赖

- **运行时**：Node.js 22 + 内嵌 SQLite（`node:sqlite`）+ WebSocket。唯一第三方 npm 依赖是 `ws`。
- **无需外部基础设施**：不依赖 MySQL/Postgres/Redis/消息队列。
- **数据持久化**：全部落在 `/data` 卷
  - `mindcanvas.db`：会议、音频、用户、引擎配置（Key/端点）
  - `digests/`：分享版纪要快照（`/d/<id>`）
  - `docs/`、`docs-index.json`：本地资料检索语料（可选）
- **唯一对外依赖 = 综合引擎（LLM）**，且端点全部可配置：
  | 能力 | 用途 | 缺失时 |
  |---|---|---|
  | Chat（核心） | 分段起标题、聚类、纠错、纪要、AI 同事 | 降级为启发式，仍可运行 |
  | ASR | 语音转写 | 无实时转写，仅幻灯片+评论 |
  | Vision（可选） | 幻灯片图片 OCR | 手填幻灯片标题/正文 |
  | Web Search（可选） | 资料补充 | 可改本地文件检索或关闭 |

---

## 2. 部署前准备

- **方式 A（推荐）Docker**：主机装 Docker + compose；能拉取 `node:22-alpine`（公网，或配镜像加速，见 §6）。
- **方式 B 直接 Node**：主机装 Node ≥ 22.x（无需 Docker）。
- **网络**：能访问某个 LLM 端点（公网智谱 GLM / 内网 OpenAI 兼容网关 / Anthropic）；完全离线也能跑（启发式 + 本地资料）。

---

## 3. 快速开始（Docker Compose）

```bash
# 1. 取得源码（rsync / git / 拷贝目录）到主机，例如 ~/mindcanvas
cd ~/mindcanvas

# 2. 生成配置
cp .env.example .env
vi .env                 # 至少修改 admin/speaker 密码；HOST_PORT 改成空闲端口

# 3. 构建并启动
docker compose up -d --build

# 4. 查看状态 / 日志
docker compose ps
docker compose logs -f
```

访问 `http://<主机IP>:<HOST_PORT>`（默认 8080）。首次启动会自动创建 `admin` / `speaker` 两个账号（密码取自 `.env`）。

> 容器内固定监听 8080，对外端口由 `HOST_PORT` 决定。状态存命名卷 `mindcanvas_data`，`docker compose down` 不会删数据；`down -v` 才会清空。

---

## 4. 配置项（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST_PORT` | 8080 | 宿主机端口 |
| `MINDCANVAS_ADMIN_PASSWORD` | admin | 首启 seed 的管理员密码（之后在 /admin 改） |
| `MINDCANVAS_SPEAKER_PASSWORD` | speaker | 首启 seed 的主讲密码 |
| `BIGMODEL_API_KEY` | 空 | 智谱 GLM Key。**建议留空**，运行后在 /admin 配置（持久化、不入镜像） |
| `BIGMODEL_BASE_URL` | open.bigmodel.cn | 自定义/内网 LLM 端点（OpenAI 兼容） |
| `MINDCANVAS_MODEL` | glm-5.1 | Chat 模型 |
| `MINDCANVAS_ASR_MODEL` | glm-asr | ASR 模型 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | 空 | 切 Claude 时用 |
| `MINDCANVAS_SEARCH_MODE` | web | 资料补充来源：`web` / `local` / `off` |
| `MINDCANVAS_DOCS_DIR` | /data/docs | local 模式：放 txt/md 的目录 |
| `MINDCANVAS_DOCS_INDEX` | /data/docs-index.json | local 模式：Word/PDF/PPT 预建索引 |
| `MINDCANVAS_VISION` | 开 | 设 `off` 关闭幻灯片视觉 OCR |
| `MINDCANVAS_DB` | /data/mindcanvas.db | SQLite 路径（一般不用改） |

---

## 5. 配置综合引擎 Key（两种方式）

**方式 1（推荐）运行时在管理后台配置** —— 镜像保持 keyless，Key 校验后持久化到 `/data` 卷，重启/重新部署都不丢，也不会进镜像层：

1. 浏览器打开 `http://<主机>:<端口>/admin`，用管理员账号登录。
2. 「综合引擎 · API Key」处填 Provider / Key /（可选）Endpoint / 模型 → 保存并校验。
3. 看到「✓ 已保存并持久化」即生效。

**方式 2 通过 .env 注入** —— 适合自动化批量部署。把 `BIGMODEL_API_KEY=...` 写进 `.env`，`docker compose up -d` 即注入为运行时环境变量（不写进镜像层）。

> 切换内网 LLM 网关：把 Endpoint 填成你的网关地址（需 OpenAI 兼容的 `/chat/completions`，ASR 需 `/audio/transcriptions`）。

---

## 6. 内网 / 离线部署要点

**Docker Hub 拉不动**（典型内网）→ 二选一：
- 配镜像加速：`/etc/docker/daemon.json` 写
  ```json
  { "registry-mirrors": ["https://docker.m.daocloud.io"] }
  ```
  然后 `systemctl restart docker`，正常 `docker compose up -d --build`。
- 或在有网机器 `docker build` + `docker save mindcanvas:latest | gzip > mc.tgz`，拷到内网 `docker load < mc.tgz`，compose 直接用已加载镜像。

**无法装/用 Docker** → 直接 Node 跑（主机需 Node ≥ 22）：
```bash
cd ~/mindcanvas
npm install --omit=dev                 # 仅装 ws，走 npm 源
mkdir -p ./data
MINDCANVAS_DB=$PWD/data/mindcanvas.db \
MINDCANVAS_ADMIN_PASSWORD=xxx MINDCANVAS_SPEAKER_PASSWORD=yyy \
PORT=8088 node server/server.js
# 生产建议用 systemd / pm2 守护
```

**资料补充离线化**（无外网时替代联网搜索）：
- 设 `MINDCANVAS_SEARCH_MODE=local`。
- 简单：把 `.txt/.md` 放进 `/data/docs`（容器内）即被检索。
- Word/PDF/PPT：在有 Python 的机器跑
  ```bash
  pip install python-docx python-pptx pypdf
  python3 tools/index_docs.py <文档目录> /path/to/docs-index.json
  ```
  把生成的 `docs-index.json` 放到 `/data/`（或 `MINDCANVAS_DOCS_INDEX` 指向处）。
- 项目自带 `seed-docs/`（平安健康公开资料）作为内置示例语料，随镜像发布。

**无视觉模型** → `MINDCANVAS_VISION=off`，幻灯片改手填标题/正文，主流程不受影响。

---

## 7. 运维

```bash
cd ~/mindcanvas
docker compose ps                 # 状态
docker compose logs -f            # 实时日志
docker compose restart            # 重启
docker compose up -d              # 改完 .env 后应用
docker compose down               # 停止（保留数据卷）

# 数据备份（命名卷 → tar）
docker run --rm -v mindcanvas_mindcanvas_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mindcanvas-backup.tgz -C /data .
# 恢复
docker run --rm -v mindcanvas_mindcanvas_data:/data -v "$PWD":/backup alpine \
  sh -c "cd /data && tar xzf /backup/mindcanvas-backup.tgz"
```

升级：更新源码后 `docker compose up -d --build`（数据卷不动）。健康检查：`GET /api/health`（compose 已内置 healthcheck）。

---

## 8. 安全

- **镜像 keyless**：不要把生产 Key 烤进镜像；用 /admin 配置（落卷）或 `.env`（运行时）。
- 首次启动后尽快在 /admin 改掉默认 `admin`/`speaker` 密码。
- 仅主讲台/管理后台需登录；观众页与大屏免登录（设计如此）。`/api/config`、`/api/asr`、`/api/ocr`、控制指令均要登录态。
- 建议前置 Nginx 反代 + HTTPS；公网暴露时务必改强密码。
- 鉴权用无状态 HMAC 令牌，密钥存卷，重启不掉线。

---

## 9. 部署后自检清单

- [ ] `docker compose ps` 显示容器 `healthy`
- [ ] 访问 `http://<主机>:<HOST_PORT>/admin`，用 `.env` 里设置的管理员账号能登录
- [ ] **已修改默认 `admin` / `speaker` 密码**（/admin → 用户管理）
- [ ] 在 /admin 配置综合引擎 Key（或 `.env` 注入），`/api/health` 显示 `enabled:true`
- [ ] 观众链接 `/?room=<房间号>` 可正常打开
- [ ] （可选）已规划数据卷备份（见 §7）

---

## 10. 故障排查

| 现象 | 处理 |
|---|---|
| `bind ... address already in use` | `HOST_PORT` 改空闲端口后 `docker compose up -d` |
| build 卡在 `FROM node:22-alpine` | Docker Hub 不通 → 配镜像加速（§6）或离线 load |
| /admin 配 Key 报「校验失败」 | 检查 Key、余额、Endpoint 是否可达；看 `docker compose logs` |
| 健康检查 `enabled:false` | 未配引擎，走启发式；配 Key 即启用 |
| ASR 不可用 | 仅智谱 GLM 提供 ASR；确认 provider=zhipu 且 Key 有效 |
| 资料补充不出现 | 需开「AI 同事」开关；且 `SEARCH_MODE` 不为 off（local 需有语料） |

更多用法见 [USAGE.md](USAGE.md)（使用说明）。
