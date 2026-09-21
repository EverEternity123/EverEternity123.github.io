/* ==========================================================================
   order.js — 文章顺序 + 标签顺序（前台和写作台共用这一份）
   --------------------------------------------------------------------------
   数据在 data/order.json，形如：
       { "ids": ["p-mu1abc", "p-mu2def", ...], "tags": ["随笔", "读书"] }

   两个字段互不相干，都可以缺：
     · ids  —— 文章的显示顺序
     · tags —— 标签的显示顺序（首页标签栏、归档标签云、写作台筛选栏）

   【文章】排序规则（两段拼起来）：
     1. **在 ids 里的文章**按 ids 的顺序排 —— 这就是自定义顺序。
     2. **不在 ids 里的文章**（＝新发的）**按日期插进**上面那一串里对应的位置，
        而不是一律顶到最前面。
        ⚠️ 2026-09-21 按主人要求改的：日期填对之后，新文章应该落到「它该在的地方」，
           否则一篇 2019 年的旧文一发出来就赖在首页最顶上。
        找不到比它更老的就放到最后，所以「order.json 本身就是日期倒序」时，
        整表结果和直接按日期排完全一致。

   【标签】排序规则同理：
     1. **在 tags 里的标签**按 tags 的顺序排在前面
     2. **不在 tags 里的标签**按调用方给的顺序排在**后面**
        （前台是「第一次出现」的先后，写作台是「出现次数多的在前」）

   所以：
     · order.json 不存在 / ids 是空的  → 完全退化成「按日期降序」，和以前一样
     · 删掉一篇文章                     → ids 里多一个不存在的 id，直接忽略，不用清理
     · 新发一篇文章                     → 它不在 ids 里，按日期自动落到对应位置
     · 新加一个标签                     → 它不在 tags 里，自动落到最后面
     · 老仓库里没有 tags 字段           → 标签顺序完全按调用方给的顺序，跟以前一样
   ========================================================================== */
(function () {
  'use strict';

  function byDateDesc(a, b) {
    return String(b.date).localeCompare(String(a.date));
  }

  /* 从 order.json 的内容里安全地取出 id 数组 */
  function idsOf(order) {
    if (!order) return [];
    var raw = Array.isArray(order) ? order : order.ids;
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (x) { return typeof x === 'string' && x; });
  }

  /* 从 order.json 的内容里安全地取出标签顺序。
     ⚠️ 老文件只有 ids、没有 tags —— 那就在这里返回空数组，
        调用方会当成「没排过标签」，顺序维持原样。 */
  function tagsOf(order) {
    if (!order || Array.isArray(order)) return [];
    var raw = order.tags;
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (x) { return typeof x === 'string' && x; });
  }

  /* posts：原始数组；ids：order.json 里的 id 顺序。返回排好序的新数组（不改原数组） */
  function apply(posts, ids) {
    var list = Array.isArray(posts) ? posts.slice() : [];
    var pos = Object.create(null);
    (ids || []).forEach(function (id, i) {
      if (pos[id] === undefined) pos[id] = i;   // 重复 id 以第一次出现的为准
    });

    var ranked = [], fresh = [];
    list.forEach(function (p) {
      if (p && p.id != null && pos[p.id] !== undefined) ranked.push(p);
      else fresh.push(p);
    });

    ranked.sort(function (a, b) { return pos[a.id] - pos[b.id]; });
    fresh.sort(byDateDesc);                     // sort 是稳定的，同一天保持文件顺序

    // 没排过的按日期**插进**排过的那一串里（不是一律顶到最前面）：
    // 从头往后跳过所有「不比它老」的（含同一天），插在第一个比它老的前面；
    // 全是比它新的就落最后。
    // ⚠️ 必须是 `>= 0` 而不是 `> 0` —— 用 `> 0` 的话同一天的新文章会被插到
    //    旧文章**前面**，一天发两篇时顺序会被翻过来（check-content.js 有断言钉着）。
    // ids 为空时 ranked 也是空的，结果＝纯日期降序，和以前完全一样。
    var out = ranked;
    fresh.forEach(function (p) {
      var i = 0;
      while (i < out.length && byDateDesc(p, out[i]) >= 0) i++;
      out.splice(i, 0, p);
    });
    return out;
  }

  /* 按当前显示顺序生成要写进 order.json 的 id 列表 */
  function idsFrom(posts) {
    return (posts || []).map(function (p) { return p && p.id; })
                        .filter(function (x) { return typeof x === 'string' && x; });
  }

  /* list：按调用方口径排好的标签数组；orderTags：order.json 里的 tags。
     返回新数组（不改原数组）：排过的按 tags 的顺序在前，没排过的保持原相对先后在后。
     ⚠️ 只重排，不增删 —— list 里没有的标签不会被塞进来（那个标签已经没人用了）。 */
  function sortTags(list, orderTags) {
    var pos = Object.create(null);
    (orderTags || []).forEach(function (t, i) {
      if (pos[t] === undefined) pos[t] = i;     // 重复的以第一次出现的为准
    });

    var ranked = [], fresh = [];
    (list || []).forEach(function (t) {
      if (pos[t] !== undefined) ranked.push(t);
      else fresh.push(t);
    });

    ranked.sort(function (a, b) { return pos[a] - pos[b]; });
    return ranked.concat(fresh);
  }

  window.EE_ORDER = {
    apply: apply,
    idsOf: idsOf,
    tagsOf: tagsOf,
    sortTags: sortTags,
    idsFrom: idsFrom,
    byDateDesc: byDateDesc
  };
})();
