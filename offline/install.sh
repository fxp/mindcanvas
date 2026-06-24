#!/usr/bin/env bash
# MindCanvas 离线一键安装 —— 完全不联网。前置：已装 Docker（含 compose 插件，docker compose version 可用）。
# 用法：解包后在本目录执行  ./install.sh
set -e
cd "$(dirname "$0")"

IMG_TAR="mindcanvas-image.tar.gz"
COMPOSE="docker-compose.offline.yml"

command -v docker >/dev/null || { echo "✗ 未检测到 docker，请先安装 Docker 引擎（见 DEPLOY.md §6）"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ 未检测到 docker compose 插件"; exit 1; }

echo "[1/3] 载入镜像（$IMG_TAR）…"
docker load -i "$IMG_TAR"

echo "[2/3] 准备配置…"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  → 已生成 .env。建议先修改 MINDCANVAS_ADMIN_PASSWORD / MINDCANVAS_SPEAKER_PASSWORD / HOST_PORT。"
  echo "    （Key 可留空，启动后在 /admin 配置并持久化。）"
fi

echo "[3/3] 启动服务…"
docker compose -f "$COMPOSE" up -d

PORT="$(grep -E '^HOST_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8080}"
echo
echo "✓ 完成。"
echo "  健康检查：curl http://localhost:${PORT}/api/health"
echo "  管理后台：http://<本机IP>:${PORT}/admin"
echo "  运维：docker compose -f $COMPOSE {ps,logs -f,restart,down}"
