// 纯 Node 文本抽取（无第三方依赖）：txt/md 直读；docx/pptx 解 ZIP + 去标签；pdf 不支持。
// 用于 speaker 上传资料到「资料补充·本地检索」语料。
import zlib from 'node:zlib';

// 最小 ZIP 读取（走中央目录，兼容带 data descriptor 的 Office 文件）
function* zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data = null;
    try { data = method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp); } catch { /* skip */ }
    yield { name, data };
    p += 46 + nameLen + extraLen + commentLen;
  }
}

function stripXml(xml) {
  return xml
    .replace(/<\/(w:p|a:p|p)>/g, '\n')                 // 段落 → 换行
    .replace(/<(w:br|a:br|br)\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')                            // 去所有标签
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

const slideNum = (n) => { const m = n.match(/(\d+)\.xml$/); return m ? +m[1] : 0; };

// → { ok, text? , reason? }
export function extractText(filename, buf) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') return { ok: true, text: buf.toString('utf8') };
  if (ext === 'docx') {
    for (const e of zipEntries(buf)) if (e.name === 'word/document.xml' && e.data) return { ok: true, text: stripXml(e.data.toString('utf8')) };
    return { ok: false, reason: 'docx 解析失败' };
  }
  if (ext === 'pptx') {
    const slides = [];
    for (const e of zipEntries(buf)) if (/^ppt\/slides\/slide\d+\.xml$/.test(e.name) && e.data) slides.push([e.name, e.data]);
    slides.sort((a, b) => slideNum(a[0]) - slideNum(b[0]));
    const parts = slides.map(([, d]) => stripXml(d.toString('utf8'))).filter(Boolean);
    return parts.length ? { ok: true, text: parts.join('\n') } : { ok: false, reason: 'pptx 未取到文本' };
  }
  if (ext === 'pdf') return { ok: false, reason: 'PDF 暂不支持在线解析：请转成 txt/docx 上传，或用 tools/index_docs.py 生成索引' };
  return { ok: false, reason: '不支持的类型（支持 txt / md / docx / pptx）' };
}
