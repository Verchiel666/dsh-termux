// .deb 是 ar 归档（!<arch>\n + 60 字节成员头），这里只取 data.tar.*。纯 JS，无依赖。

export function parseAr(buf) {
  if (buf.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('不是 ar 归档（缺少 !<arch> 魔术串）');
  const members = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const h = buf.subarray(off, off + 60);
    const rawName = h.subarray(0, 16).toString().trim();
    const size = Number.parseInt(h.subarray(48, 58).toString().trim(), 10);
    if (!Number.isFinite(size) || size < 0) break;
    const start = off + 60;
    if (start + size > buf.length) break;
    // BSD/GNU 扩展名：// 是长名表，#1/ 是内联长名
    members.push({ name: rawName.replace(/\/+$/, ''), size, data: buf.subarray(start, start + size) });
    off = start + size + (size % 2);
  }
  return members;
}

export function debData(buf) {
  const members = parseAr(buf);
  const data = members.find((m) => /^data\.tar/.test(m.name));
  if (!data) throw new Error(`归档里没有 data.tar.*（成员：${members.map((m) => m.name).join(', ')}）`);
  const control = members.find((m) => /^control\.tar/.test(m.name));
  return { data, control, members };
}
