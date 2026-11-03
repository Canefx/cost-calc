/* 成本测算核心逻辑（可在浏览器与 Node 中复用）
 * 逻辑来源：桌面「成本测算.xlsx」
 *  - 整箱费用：整箱含快递成本 - 该重量档位运费 = 整箱不含快递成本；再除以整箱包数得单包成本
 *  - 多包：总重量 = 单包克重 × 包数；含快递成本 = 单包成本 × 包数 + 档位运费；单包成本 = 含快递成本 / 包数
 *  - 运费档位（min 含、max 不含）：[0,0.5)→1.8, [0.5,1)→2, [1,2)→2.5, [2,3)→2.95, ≥3kg 不可算
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CostCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var EPS = 1e-9;

  var DEFAULT_TIERS = [
    { min: 0, max: 0.5, fee: 1.8 },
    { min: 0.5, max: 1, fee: 2 },
    { min: 1, max: 2, fee: 2.5 },
    { min: 2, max: 3, fee: 2.95 }
  ];

  var OVER_LIMIT_TEXT = "超过3kg";

  /** 按重量查运费；超出所有档位返回 null（即「超过3kg」） */
  function freightFor(weight, tiers) {
    if (weight == null || isNaN(weight) || weight < 0) return null;
    for (var i = 0; i < tiers.length; i++) {
      var lo = tiers[i].min == null ? 0 : tiers[i].min;
      var hi = tiers[i].max;
      if (hi == null) continue;
      if (weight + EPS >= lo && weight < hi - EPS) return tiers[i].fee;
    }
    return null;
  }

  /** 重量命中的档位描述，如 "0.5 ~ 1kg" */
  function tierLabelFor(weight, tiers) {
    for (var i = 0; i < tiers.length; i++) {
      var lo = tiers[i].min == null ? 0 : tiers[i].min;
      var hi = tiers[i].max;
      if (hi == null) continue;
      if (weight + EPS >= lo && weight < hi - EPS) {
        return formatNum(lo, 3) + " ~ " + formatNum(hi, 3) + "kg";
      }
    }
    return OVER_LIMIT_TEXT;
  }

  /** 整箱叠加时的计价说明，如「整箱×1 + 散5包」 */
  function stackLabel(boxes, rest) {
    return "整箱×" + boxes + (rest > 0 ? " + 散" + rest + "包" : "");
  }

  /** 多包测算：返回每个包数的一行结果
   *  params 扩展（用于超量叠加）：
   *   stackEnabled  超过整箱包数时是否按整箱叠加
   *   boxPacks      整箱包数
   *   boxWeight     整箱克重（缺省按 单包克重 × 整箱包数）
   *   boxCostWith   整箱含快递成本
   */
  function computeRows(params) {
    var unitWeight = num(params.unitWeight);
    var baseCost = num(params.baseCost);
    var count = Math.max(1, Math.floor(num(params.count) || 1));
    var tiers = params.tiers && params.tiers.length ? params.tiers : DEFAULT_TIERS;

    var boxPacks = num(params.boxPacks);
    var boxWeight = params.boxWeight != null && params.boxWeight !== ""
      ? num(params.boxWeight)
      : unitWeight * boxPacks;
    var boxCostWith = num(params.boxCostWith);
    var boxFee = freightFor(boxWeight, tiers);
    // 整箱规格可用：已启用叠加、包数/成本有效、整箱重量能命中运费档位
    var boxUsable = !!params.stackEnabled && boxPacks > 0 && boxCostWith > 0 && boxFee != null;

    var rows = [];
    for (var n = 1; n <= count; n++) {
      var weight = unitWeight * n;

      // ---- 超过整箱包数：整箱 × k + 散包 ----
      if (boxUsable && n > boxPacks) {
        var k = Math.floor(n / boxPacks);
        var rest = n - k * boxPacks;
        var restFee = rest > 0 ? freightFor(unitWeight * rest, tiers) : 0;
        var restOk = !(rest > 0 && restFee == null);
        var boxCost = k * boxCostWith;
        var restGoods = baseCost * rest;
        var restCost = restGoods + (restFee == null ? 0 : restFee);
        var costWithout = k * (boxCostWith - boxFee) + restGoods;
        var costWith = restOk ? boxCost + restCost : null;
        rows.push({
          packs: n,
          weight: weight,
          mode: "stack",
          boxes: k,
          rest: rest,
          boxCost: boxCost,
          restCost: restOk ? restCost : null,
          tier: restOk ? stackLabel(k, rest) : OVER_LIMIT_TEXT,
          fee: restOk ? k * boxFee + restFee : null,
          over: !restOk,
          costWith: costWith,
          costWithout: costWithout,
          perWith: restOk ? costWith / n : null,
          perWithout: costWithout / n
        });
        continue;
      }

      // ---- 整箱以内：单票计费（原表逻辑） ----
      var fee = freightFor(weight, tiers);
      var over = fee == null;
      var costWithoutSingle = baseCost * n;
      rows.push({
        packs: n,
        weight: weight,
        mode: "single",
        boxes: 0,
        rest: n,
        boxCost: 0,
        restCost: over ? null : costWithoutSingle + fee,
        tier: tierLabelFor(weight, tiers),
        fee: fee,
        over: over,
        costWith: over ? null : costWithoutSingle + fee,
        costWithout: costWithoutSingle,
        perWith: over ? null : (costWithoutSingle + fee) / n,
        perWithout: baseCost
      });
    }
    return rows;
  }

  /** 找出单包（含快递）成本最低的行；并列时取包数大的（总运费更省） */
  function bestRow(rows) {
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.over || r.perWith == null) continue;
      if (!best || r.perWith < best.perWith - EPS) best = r;
    }
    return best;
  }

  /** 整箱反算：整箱包数 / 整箱克重 / 整箱含快递成本 → 单包成本与运费明细 */
  function reverseCase(input) {
    var packs = num(input.packs);
    var weight = num(input.weight);
    var costWith = num(input.costWith);
    var tiers = input.tiers && input.tiers.length ? input.tiers : DEFAULT_TIERS;
    var fee = freightFor(weight, tiers);
    if (fee == null) {
      return { packs: packs, weight: weight, costWith: costWith, fee: null, over: true };
    }
    var costWithout = costWith - fee;
    return {
      packs: packs,
      weight: weight,
      costWith: costWith,
      fee: fee,
      over: false,
      tier: tierLabelFor(weight, tiers),
      costWithout: costWithout,
      perWith: packs > 0 ? costWith / packs : null,
      perWithout: packs > 0 ? costWithout / packs : null,
      baseCost: packs > 0 ? costWithout / packs : null
    };
  }

  /** 汇总多包测算的整体结论 */
  function summarize(rows) {
    var best = bestRow(rows);
    var valid = rows.filter(function (r) { return !r.over; });
    var overCount = rows.length - valid.length;
    return {
      best: best,
      validCount: valid.length,
      overCount: overCount,
      maxValidWeight: valid.length ? valid[valid.length - 1].weight : 0
    };
  }

  function num(v) {
    var n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  function formatNum(v, digits) {
    if (v == null || isNaN(v)) return "—";
    var d = digits == null ? 2 : digits;
    var s = Number(v).toFixed(d);
    if (d > 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  function money(v, digits) {
    if (v == null || isNaN(v)) return "—";
    // 金额默认保留两位小数
    var d = digits == null ? 2 : digits;
    return Number(v).toFixed(d);
  }

  /** 运费档位合法性检查，返回错误信息数组 */
  function validateTiers(tiers) {
    var errs = [];
    if (!tiers || !tiers.length) return ["至少需要一个运费档位"];
    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i];
      if (t.max == null || isNaN(t.max)) errs.push("第 " + (i + 1) + " 档的重量上限必须填写");
      if (t.fee == null || isNaN(t.fee) || t.fee < 0) errs.push("第 " + (i + 1) + " 档的运费必须是不小于 0 的数字");
      if (i > 0) {
        var prev = tiers[i - 1].max;
        if (prev != null && t.min != null && t.min !== prev) errs.push("第 " + (i + 1) + " 档起点应等于上一档上限（" + prev + "kg）");
      }
    }
    return errs;
  }

  return {
    DEFAULT_TIERS: DEFAULT_TIERS,
    OVER_LIMIT_TEXT: OVER_LIMIT_TEXT,
    freightFor: freightFor,
    tierLabelFor: tierLabelFor,
    computeRows: computeRows,
    bestRow: bestRow,
    reverseCase: reverseCase,
    summarize: summarize,
    validateTiers: validateTiers,
    formatNum: formatNum,
    money: money,
    num: num
  };
});
