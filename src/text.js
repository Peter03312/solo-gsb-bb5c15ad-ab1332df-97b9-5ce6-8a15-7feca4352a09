'use strict';
// 文本工具：全程以 Unicode 码点（character）为偏移单位，前端用 Array.from 保持一致。

function codeLength(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

function sliceCP(s, start, end) {
  return Array.from(s).slice(start, end).join('');
}

// 校验并归一化范围：返回 {start,end,length,excerpt}，非法范围抛出带 reason 的错误
function validateRange(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw Object.assign(new Error('范围端点必须为整数'), { status: 400 });
  }
  const length = codeLength(text);
  if (start < 0 || end < 0 || start > end || end > length) {
    throw Object.assign(
      new Error(`非法范围 [${start},${end})：当前段共 ${length} 个字符，须满足 0 ≤ start ≤ end ≤ ${length}`),
      { status: 400, code: 'BAD_RANGE' }
    );
  }
  return { start, end, length, excerpt: sliceCP(text, start, end) };
}

// 两处范围是否重叠（半开区间；[0,2) 与 [2,4) 不重叠，可无缝相接）
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 将一组同段内互不重叠的替换应用到原文（右起应用，避免偏移漂移）
function applyEdits(text, edits) {
  let result = text;
  for (const e of edits.slice().sort((a, b) => b.start - a.start)) {
    result = sliceCP(result, 0, e.start) + e.replace + sliceCP(result, e.end);
  }
  return result;
}

// 发布时把旧引用范围经一组互不重叠的修订映射到新文本坐标。
// 返回 {start,end,affected}。affected=true 表示引用与某次修订相交，
// 被引文字可能已不存在；此时坐标只是粗略几何记录，调用方必须把异议标记为
// needs_relocation 并保留原文快照，UI 不得据此悄悄指向新文字。
function transformRange(range, edits) {
  let { start, end } = range;
  let affected = false;
  for (const e of edits.slice().sort((a, b) => a.start - b.start)) {
    const d = codeLength(e.replace) - (e.end - e.start);
    if (e.end <= start) {
      start += d;
      end += d;
    } else if (e.start >= end) {
      // 修订完全在引用之后，不变
    } else {
      affected = true;
      start = Math.min(start, e.start);
      end = Math.max(start, e.start + codeLength(e.replace));
    }
  }
  return { start, end, affected };
}

// 续提换算：把基版坐标下的半开选区映射过一组同段互不重叠的修订（同一版本步内）。
// 与 transformRange 的差异：比较始终在原坐标系进行、位移累积计算（相邻修订互不干扰）；
// 零长度选区（插入点）被任何修订区间触及（start <= k <= end）即视为受影响——
// 此时插入点相对新旧文字的位置无法可靠推断，调用方必须拒绝自动换算，
// 不得凭同文搜索猜测位置。
function transformRangeRebase(range, edits) {
  const { start, end } = range;
  const point = start === end;
  let delta = 0;
  for (const e of edits.slice().sort((a, b) => a.start - b.start)) {
    const d = codeLength(e.replace) - (e.end - e.start);
    if (point) {
      if (e.start <= start && start <= e.end) return { start, end, affected: true };
      if (e.end < start) delta += d;
    } else if (e.end <= start) {
      delta += d;
    } else if (e.start < end) {
      return { start, end, affected: true };
    }
  }
  return { start: start + delta, end: end + delta, affected: false };
}

// 发布前回应门槛：暂存修订（edit）是否触及异议当前锚点（anchor）。
// - 非零长度修订：两个半开区间相交即触及（[0,2) 与 [2,4) 相接不算）；
// - 零长度修订（纯插入）：插入点落在引用范围 [anchor.start, anchor.end) 内即触及
//   （点等于引用起点算触及，等于引用终点不算，与半开区间口径一致）。
function editTouchesAnchor(edit, anchor) {
  if (edit.start === edit.end) {
    return anchor.start <= edit.start && edit.start < anchor.end;
  }
  return edit.start < anchor.end && anchor.start < edit.end;
}

// ---------- 正文来源重放 ----------
// 码点身份：每个码点带稳定身份键 key 与“最后写入来源” origin：
// - origin 为 null 表示初始导入码点（key 形如 i<v1下标>）；
// - origin 为 {proposalId,version} 表示由该已发布提议在该版本插入/重写（key 形如 p<提议号>-<序号>）。
// 身份只来自逐次发布的几何切片（splice），绝不按同文搜索配对：把文字改成与原文相同，
// 新码点仍是该提议身份，因此“改回原文”不会与旧码点配对——两端同文由上层按几何整块判定为无净变化。
function identityKeyFor(origin, seq) {
  return origin ? `p${origin.proposalId}-${seq}` : `i${seq}`;
}

// 初始版本码点身份数组：逐码点一个身份（emoji 等增补平面字符按 1 个码点计）
function identityTokens(initialText) {
  return Array.from(initialText).map((ch, i) => ({ ch, key: `i${i}`, origin: null }));
}

// 取某提议在本次重放链内的下一个插入序号（同身份在阶段一/阶段二须一致，故由调用方持有 Map）
function nextSeq(seqOf, proposalId) {
  const n = seqOf.get(proposalId) || 0;
  seqOf.set(proposalId, n + 1);
  return n;
}

// 与 applyEdits 同序应用一次修订到身份数组（start 降序、并列 id 升序，右起切片），
// 返回被移除的旧身份码点（纯插入时为空数组）。新码点身份归本次提议。
function applyIdentityEdit(tokens, edit, seqOf) {
  const inserted = Array.from(edit.replace).map((ch) => {
    const origin = { proposalId: edit.id, version: edit.version };
    return { ch, key: identityKeyFor(origin, nextSeq(seqOf, edit.id)), origin };
  });
  const removed = tokens.slice(edit.start, edit.end);
  const out = tokens.slice(0, edit.start).concat(inserted, tokens.slice(edit.end));
  return { tokens: out, removed };
}

// 按逐次发布的修订逐码点重放正文来源（provenanceView 使用）。
// initialText：查询版本所在段的 v1 原文（码点数组，每个码点初始来源标签 tag(null)）；
// steps：[{ version, edits:[{id,start,end,replace}] }, ...]，edits 即该版发布时
//   实际合入该段的已采纳提议（坐标为该版基版坐标）。store 按 start、id 升序取出，
//   发布合版 applyEdits 以 start 降序稳定排序（同起点保持原 id 升序）右起应用；
//   此处使用相同迭代次序（start 降序、并列 id 升序），包括零长度插入与空串删除。
// 规则（纯几何重放，绝不按同文搜索猜测）：
// - 未被任何修订触及的码点保留原来源标签；
// - 被替换/插入的码点（含把原文换成相同文字的情形）标签改为本次提议 {proposalId,version}；
// - 删除（end>start、replace 为空）不产出码点，不占结果；
// - 零长度修订（纯插入）产出的码点同样归本次提议。
// 返回与 applyEdits 等价的 token 数组：[{ch, tag}]；相邻同标签的合并由调用方完成。
function replayProvenance(initialText, steps) {
  const seqOf = new Map();
  let tokens = identityTokens(initialText);
  for (const step of steps) {
    for (const e of step.edits.slice().sort((a, b) =>
      b.start - a.start || a.id - b.id
    )) {
      ({ tokens } = applyIdentityEdit(tokens, { ...e, version: step.version }, seqOf));
    }
  }
  return tokens.map((t) => ({ ch: t.ch, tag: t.origin }));
}

// ---------- 两版净变化（按码点身份对齐，绝不按同文搜索配对） ----------
// 沿每次发布的坐标映射把 initialText 重放到 steps 中的某一目标版本。
// untilVersion：重放到（含）该版本为止；seqOf 在同一比较的两次重放间共享，
// 使任一已发布提议的插入码点在旧版链与新版链中得到完全相同的稳定身份键。
// 返回 { tokens, deleters }：
// - tokens：该目标版本该段的身份码点数组（重放结果与不可变快照逐码点一致由调用方校验）；
// - deleters：Map<被移除码点身份 key, {proposalId,version}>，记录每个被删除码点
//   是被哪条跨版已发布提议、在哪个发布版本移除的（含中途插入又删除的临时码点）。
function replayIdentityTo(initialText, steps, untilVersion, seqOf) {
  let tokens = identityTokens(initialText);
  const deleters = new Map();
  for (const step of steps) {
    if (step.version > untilVersion) break;
    for (const e of step.edits.slice().sort((a, b) =>
      b.start - a.start || a.id - b.id
    )) {
      const res = applyIdentityEdit(tokens, { id: e.id, version: step.version, start: e.start, end: e.end, replace: e.replace }, seqOf);
      for (const rm of res.removed) {
        if (!deleters.has(rm.key)) deleters.set(rm.key, { proposalId: e.id, version: step.version });
      }
      tokens = res.tokens;
    }
  }
  return { tokens, deleters };
}

// 从“旧版身份码点”出发，只重放 (fromVersion,toVersion] 区间内的发布修订，得到新版码点，
// 并记录该区间内每个被移除码点身份的删除方（跨版已发布提议）。
// oldTokens 必须是 replayIdentityTo(initialText, steps, fromVersion, seqOf) 的结果（同一份 seqOf），
// 这里按对象拷贝，避免重放区间时改动旧版数组；插入序号沿用共享 seqOf，身份键稳定。
function replayIdentityContinuation(oldTokens, steps, fromVersion, toVersion, seqOf) {
  let tokens = oldTokens.map((t) => ({ ...t }));
  const deleters = new Map();
  for (const step of steps) {
    if (step.version <= fromVersion || step.version > toVersion) continue;
    for (const e of step.edits.slice().sort((a, b) =>
      b.start - a.start || a.id - b.id
    )) {
      const res = applyIdentityEdit(tokens, { id: e.id, version: step.version, start: e.start, end: e.end, replace: e.replace }, seqOf);
      for (const rm of res.removed) {
        if (!deleters.has(rm.key)) deleters.set(rm.key, { proposalId: e.id, version: step.version });
      }
      tokens = res.tokens;
    }
  }
  return { tokens, deleters };
}

// 按码点身份（token.key）对齐两版码点序列，产出基本操作流。
// 身份只由逐次发布的几何重放决定（splice 保持相对次序），因此这里是基于坐标映射的
// 身份对齐，而非按同文搜索配对：
// - 两版共有的存活码点（key 相同）→ 'equal'；
// - 只在旧版出现的码点（后被删除）→ 'del'；
// - 只在新版出现的码点（区间内插入/重写）→ 'ins'。
// 每个操作带其在各自版本该段内的码点半开坐标 [start,end) 与文字。
function sameKey(a, b) {
  return !!a && !!b && a.key === b.key;
}

function alignIdentityTokens(oldTokens, newTokens) {
  const posInNew = new Map();
  newTokens.forEach((t, j) => {
    if (!posInNew.has(t.key)) posInNew.set(t.key, j);
  });
  const ops = [];
  let i = 0;
  let j = 0;
  let op2 = 0; // 旧版本段内码点坐标
  let np2 = 0; // 新版本段内码点坐标
  const emit = (kind, oStart, oLen, nStart, nLen, list) => {
    ops.push({
      kind,
      oldStart: oStart, oldEnd: oStart + oLen,
      newStart: nStart, newEnd: nStart + nLen,
      text: list ? list.map((t) => t.ch).join('') : '',
    });
  };

  while (i < oldTokens.length) {
    const k = posInNew.get(oldTokens[i].key);
    if (k === undefined || k < j) {
      // 旧码点在新版中已不存在（删除）；连续收集到下一个仍能对齐新版的锚点
      const start = i;
      while (i < oldTokens.length) {
        const kk = posInNew.get(oldTokens[i].key);
        if (kk !== undefined && kk >= j) break;
        i++;
      }
      emit('del', op2, i - start, np2, 0, oldTokens.slice(start, i));
      op2 += i - start;
      continue;
    }
    // 锚点优先：先输出新版在此锚点之前的插入（np 前移、旧坐标不动），
    // 再让共有码点对齐为 equal；删除总是在配对的插入之前输出，次序确定、不做同文猜测。
    if (k > j) {
      emit('ins', op2, 0, np2, k - j, newTokens.slice(j, k));
      np2 += k - j;
      j = k;
    }
    let eq = 0;
    while (i + eq < oldTokens.length && j + eq < newTokens.length &&
           sameKey(oldTokens[i + eq], newTokens[j + eq])) {
      eq++;
    }
    if (eq === 0) {
      // 理论上不会发生（k>=j 且当前 key 应能对齐）；防御性跳过，避免死循环
      i++;
      continue;
    }
    emit('equal', op2, eq, np2, eq, oldTokens.slice(i, i + eq));
    op2 += eq; np2 += eq; i += eq; j += eq;
  }
  if (j < newTokens.length) {
    emit('ins', op2, 0, np2, newTokens.length - j, newTokens.slice(j));
  }
  return ops;
}

// 把 alignIdentityTokens 产出的基本操作折叠为“变化块（hunks）”：连续的 del/ins
// （中间无存活码点锚点）合并为一块，块的旧坐标取被删范围、新坐标取插入/重写范围。
// 中途改动最终撤销、两端文字相同的整块（旧块文字 === 新块文字）不算净变化，直接跳过；
// 该判定基于几何整块边界（由身份对齐确定），不是跨段同文搜索配对。未变段因此不产生任何块。
function diffHunks(ops) {
  const hunks = [];
  for (let i = 0; i < ops.length; ) {
    if (ops[i].kind === 'equal') { i++; continue; }
    let j2 = i;
    const delParts = [];
    const insParts = [];
    let oldStart = null;
    let oldEnd = null;
    let newStart = null;
    let newEnd = null;
    while (j2 < ops.length && ops[j2].kind !== 'equal') {
      const o = ops[j2];
      if (o.kind === 'del') {
        delParts.push(o.text);
        if (oldStart === null) oldStart = o.oldStart;
        oldEnd = o.oldEnd;
        if (newStart === null) { newStart = o.newStart; newEnd = o.newStart; }
      } else {
        insParts.push(o.text);
        if (newStart === null) newStart = o.newStart;
        newEnd = o.newEnd;
        if (oldStart === null) { oldStart = o.oldStart; oldEnd = o.oldStart; }
      }
      j2++;
    }
    const oldText = delParts.join('');
    const newText = insParts.join('');
    // 纯删除时 newStart/newEnd 指向删除点（相等的插入坐标）；纯插入时 oldStart===oldEnd
    if (oldText !== newText) {
      hunks.push({
        oldStart, oldEnd, newStart, newEnd,
        oldText, newText,
      });
    }
    i = j2;
  }
  return hunks;
}

module.exports = {
  codeLength,
  sliceCP,
  validateRange,
  overlaps,
  applyEdits,
  transformRange,
  transformRangeRebase,
  editTouchesAnchor,
  identityTokens,
  replayProvenance,
  replayIdentityTo,
  replayIdentityContinuation,
  alignIdentityTokens,
  diffHunks,
};
