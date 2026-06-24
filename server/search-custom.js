// 客户自定义检索接入点（当 MINDCANVAS_SEARCH_MODE=custom 时启用）。
//
// 想把「资料补充」接到你自己的检索系统（ES / 向量库 / 内部知识库 SDK / 任意 API），
// 只需改这一个文件的两个函数即可，其余流程（把命中片段交 LLM 提炼成一条带来源的补充）
// 系统已经接好。
//
// 约定：search() 返回命中数组，每项 { file, loc, text }
//   file 来源名（文件名/标题/库名，会作为补充的来源标注）
//   loc  位置（页码/URL/段落，可空）
//   text 命中正文片段（用于提炼，建议 50~400 字）

export function available() {
  // 改造完成后返回 true（或读你自己的开关 / 环境变量）
  return false;
}

export async function search(query, k = 3) {
  // TODO: 在此调用你内部的检索，并映射成 [{ file, loc, text }]
  //
  // 示例（伪代码）：
  //   const r = await myEnterpriseSearch.query(query, { topK: k });
  //   return r.docs.map((d) => ({ file: d.title, loc: d.path, text: d.passage }));
  return [];
}
