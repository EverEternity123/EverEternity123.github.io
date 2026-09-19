/* ==========================================================================
   order.js — 文章显示顺序（前台和写作台共用这一份）
   --------------------------------------------------------------------------
   数据在 data/order.json，形如：
       { "ids": ["p-mu1abc", "p-mu2def", ...] }

   排序规则（两段拼起来）：
     1. **不在 ids 里的文章**（＝新发的）按日期降序排在**最前面**
        —— 新文章默认还是「最新的在最上面」，不用手动去调。
     2. **在 ids 里的文章**按 ids 的顺序排在后面 —— 这就是自定义顺序。

   所以：
     · order.json 不存在 / ids 是空的  → 完全退化成「按日期降序」，和以前一样
     · 删掉一篇文章                     → ids 里多一个不存在的 id，直接忽略，不用清理
     · 新发一篇文章                     → 它不在 ids 里，自动落到最前面
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
    return fresh.concat(ranked);
  }

  /* 按当前显示顺序生成要写进 order.json 的 id 列表 */
  function idsFrom(posts) {
    return (posts || []).map(function (p) { return p && p.id; })
                        .filter(function (x) { return typeof x === 'string' && x; });
  }

  window.EE_ORDER = {
    apply: apply,
    idsOf: idsOf,
    idsFrom: idsFrom,
    byDateDesc: byDateDesc
  };
})();
