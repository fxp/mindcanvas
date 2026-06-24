# file-search · 目录 → 搜索 API 小服务

把本地某个目录 serve 成 MindCanvas `api` 模式可直接消费的检索接口。零第三方依赖（Node ≥ 18）。

## 运行

```bash
# txt / md 目录直接读
DOCS_DIR=/data/docs PORT=8079 node search-service/server.js

# Word / PDF / PPT：先用主仓 tools/index_docs.py 生成索引，再指过去
pip install python-docx python-pptx pypdf
python3 tools/index_docs.py /data/源文件目录 /data/docs-index.json
DOCS_INDEX=/data/docs-index.json PORT=8079 node search-service/server.js
```

## 接口契约

```
POST /search   {"query":"平安 免赔额", "top_k":3}
GET  /search?q=平安 免赔额&top_k=3
  → {"results":[{"title":"来源名","snippet":"命中正文片段","url":"位置/页码"}]}
GET  /health      → {"ok":true,"files":N,"chunks":M}
GET  /reload      → 重新加载目录/索引
```

## 接到 MindCanvas

在 MindCanvas 的 `.env` 或 /admin：

```bash
MINDCANVAS_SEARCH_MODE=api
MINDCANVAS_SEARCH_API_URL=http://<本服务IP>:8079/search
```

## 想接自己的检索系统？

两种方式：
1. **实现同样的契约**（上面的 `/search`），让本服务的位置换成你的服务即可（`api` 模式）。
2. **直接在主程序里改代码**：编辑 `server/search-custom.js` 的 `available()` / `search()`，然后设 `MINDCANVAS_SEARCH_MODE=custom`。
