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

  var VERSION = "1.6.2";
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

  /** 运费档位里的最高上限（如 3kg）；超过它就要分段计费 */
  function maxTierLimit(tiers) {
    var m = 0;
    for (var i = 0; i < tiers.length; i++) {
      if (tiers[i].max != null && tiers[i].max > m) m = tiers[i].max;
    }
    return m;
  }

  /** 最后一段的重量恰好等于上限时（如整 3kg），按最高档计费 */
  function feeForChunk(chunk, tiers, limit) {
    if (limit > 0 && chunk + EPS >= limit) {
      var last = null;
      for (var i = 0; i < tiers.length; i++) {
        if (tiers[i].max != null && (last == null || tiers[i].max > last.max)) last = tiers[i];
      }
      return last ? last.fee : null;
    }
    return freightFor(chunk, tiers);
  }

  /** 重量不超最高档 → 按档位算一次；超过 → 每段不超过最高档，逐段计费后累加
   *  返回 { fee, over, segments:[{weight, fee}], text }
   */
  function freightDetail(weight, tiers) {
    var limit = maxTierLimit(tiers);
    if (weight == null || isNaN(weight) || weight < 0) {
      return { fee: null, over: true, segments: [], text: OVER_LIMIT_TEXT };
    }
    if (weight <= EPS) return { fee: 0, over: false, segments: [], text: "0kg" };
    if (limit <= 0) return { fee: null, over: true, segments: [], text: OVER_LIMIT_TEXT };

    // 单段：不超最高档
    if (weight < limit - EPS) {
      var single = freightFor(weight, tiers);
      if (single == null) return { fee: null, over: true, segments: [], text: OVER_LIMIT_TEXT };
      return {
        fee: single,
        over: false,
        segments: [{ weight: weight, fee: single }],
        text: formatNum(weight, 3) + "kg " + money(single, 2)
      };
    }

    // 多段：累加
    var rest = weight;
    var segments = [];
    var total = 0;
    var guard = 0;
    while (rest > EPS && guard++ < 2000) {
      var chunk = rest > limit ? limit : rest;
      var fee = feeForChunk(chunk, tiers, limit);
      if (fee == null) return { fee: null, over: true, segments: segments, text: OVER_LIMIT_TEXT };
      segments.push({ weight: chunk, fee: fee });
      total += fee;
      rest = rest - chunk;
      if (Math.abs(rest) < EPS) rest = 0;
    }
    var parts = segments.map(function (s) {
      return formatNum(s.weight, 3) + "kg " + money(s.fee, 2);
    });
    return {
      fee: total,
      over: false,
      segments: segments,
      text: parts.join(" + ") + " = " + money(total, 2)
    };
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
        var restDetail = rest > 0
          ? freightDetail(unitWeight * rest, tiers)
          : { fee: 0, over: false, segments: [], text: "—" };
        var restFee = restDetail.fee;
        var restOk = !restDetail.over;
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
          freightText: rest > 0
            ? "整箱×" + k + " " + money(boxFee, 2) + " + 散" + rest + "包(" + restDetail.text + ")"
            : "整箱×" + k + " " + money(boxFee, 2) + " = " + money(k * boxFee, 2),
          fee: restOk ? k * boxFee + restFee : null,
          over: !restOk,
          costWith: costWith,
          costWithout: costWithout,
          perWith: restOk ? costWith / n : null,
          perWithout: costWithout / n
        });
        continue;
      }

      // ---- 整箱以内：按档位计费，超过最高档则分段累加 ----
      var detail = freightDetail(weight, tiers);
      var over = detail.fee == null;
      var costWithoutSingle = baseCost * n;
      rows.push({
        packs: n,
        weight: weight,
        mode: "single",
        boxes: 0,
        rest: n,
        boxCost: 0,
        restCost: over ? null : costWithoutSingle + detail.fee,
        tier: over
          ? OVER_LIMIT_TEXT
          : (detail.segments.length > 1
            ? detail.segments.length + " 段计费"
            : tierLabelFor(weight, tiers)),
        freightText: detail.text,
        fee: detail.fee,
        over: over,
        costWith: over ? null : costWithoutSingle + detail.fee,
        costWithout: costWithoutSingle,
        perWith: over ? null : (costWithoutSingle + detail.fee) / n,
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

  /** 利润测算：逐行套用参考表公式
   *  计价方式 priceMode：
   *    "total" 按整单报价 → 售卖价取 salePrice，单包售价 = 售卖价 ÷ 包数
   *    "unit"  按单包报价 → 单包售价取 unitPrice，售卖价 = 单包售价 × 包数
   *  单包售价 = 售卖价 ÷ 包数
   *  含百补综合扣点 = 平台扣点 + 黑标扣点 + 百补扣点
   *  合计费比 = 含百补综合扣点 + 计提费比
   *  结算价 = 售卖价 − 成本 × 合计费比
   *  利润率 = (结算价 − 成本) ÷ 结算价
   *  保本 ROI = 1 ÷ 利润率 ÷ (1 − 退款率)
   *  保本售价 = 成本 × (1 + 合计费比)
   */
  function computeProfitRows(costRows, input) {
    var mode = input.priceMode === "unit" ? "unit" : "total";
    var totalPrice = num(input.salePrice);
    var unitPriceInput = num(input.unitPrice);
    var hasPrice = mode === "unit" ? unitPriceInput > 0 : totalPrice > 0;
    var platform = num(input.platformRate) / 100;
    var black = num(input.blackRate) / 100;
    var subsidy = num(input.subsidyRate) / 100;
    var accrual = num(input.accrualRate) / 100;
    var refund = num(input.refundRate) / 100;
    var combinedSubsidy = platform + black + subsidy;
    var totalRate = combinedSubsidy + accrual;
    var keep = 1 - refund;

    return (costRows || []).map(function (r) {
      var cost = r.costWith;
      // 每一包都按当前计价方式折算成该行的整单售价
      var salePrice = mode === "unit" ? unitPriceInput * r.packs : totalPrice;
      var perUnit = mode === "unit"
        ? unitPriceInput
        : (r.packs > 0 ? totalPrice / r.packs : null);

      var out = {
        packs: r.packs,
        over: !!r.over,
        cost: cost,
        priceMode: mode,
        salePrice: hasPrice ? salePrice : null,
        unitPrice: hasPrice ? perUnit : null,
        platform: platform,
        black: black,
        subsidy: subsidy,
        accrual: accrual,
        combinedSubsidy: combinedSubsidy,
        totalRate: totalRate,
        settlement: null,
        profitRate: null,
        breakEvenRoi: null,
        breakEvenPrice: null
      };
      if (cost == null || !hasPrice) return out;

      var settlement = salePrice - cost * totalRate;
      out.settlement = settlement;
      out.breakEvenPrice = cost * (1 + totalRate);
      if (settlement > 0) {
        var pr = (settlement - cost) / settlement;
        out.profitRate = pr;
        if (pr > 0 && keep > 0) out.breakEvenRoi = 1 / pr / keep;
      }
      return out;
    });
  }

  /** 利润测算的费率汇总 */
  function profitSummary(input) {
    var platform = num(input.platformRate) / 100;
    var black = num(input.blackRate) / 100;
    var subsidy = num(input.subsidyRate) / 100;
    var accrual = num(input.accrualRate) / 100;
    return {
      combinedSubsidy: platform + black + subsidy,
      totalRate: platform + black + subsidy + accrual
    };
  }

  /** 折扣档位（1 = 原价） */
  var DISCOUNTS = [1, 0.95, 0.9, 0.88, 0.85, 0.8, 0.75, 0.7, 0.6, 0.55, 0.5];

  /** 折扣文字：1 → 原价；0.95 → 9.5折；0.9 → 9折；0.88 → 8.8折 */
  function discountLabel(rate) {
    if (rate >= 1 - EPS) return "原价";
    var zhe = rate * 10;
    var s = zhe.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return s + "折";
  }

  /** 按折扣逐档测算：售卖价 × 各折扣后的售价与利润 */
  function computeDiscountRows(costRow, input) {
    var base = computeProfitRows([costRow], input)[0];
    if (!base || base.cost == null || base.salePrice == null) return [];
    var keep = 1 - num(input.refundRate) / 100;
    var cost = base.cost;
    var rate = base.totalRate;
    var packs = base.packs;

    return DISCOUNTS.map(function (d) {
      var sale = base.salePrice * d;
      var settlement = sale - cost * rate;
      var profitRate = settlement > 0 ? (settlement - cost) / settlement : null;
      var roi = (profitRate != null && profitRate > 0 && keep > 0) ? 1 / profitRate / keep : null;
      return {
        rate: d,
        label: discountLabel(d),
        packs: packs,
        cost: cost,
        salePrice: sale,
        unitPrice: packs > 0 ? sale / packs : null,
        settlement: settlement,
        profitRate: profitRate,
        breakEvenRoi: roi,
        loss: profitRate != null && profitRate < 0
      };
    });
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
    VERSION: VERSION,
    DEFAULT_TIERS: DEFAULT_TIERS,
    OVER_LIMIT_TEXT: OVER_LIMIT_TEXT,
    freightFor: freightFor,
    tierLabelFor: tierLabelFor,
    computeRows: computeRows,
    bestRow: bestRow,
    reverseCase: reverseCase,
    summarize: summarize,
    computeProfitRows: computeProfitRows,
    computeDiscountRows: computeDiscountRows,
    discountLabel: discountLabel,
    DISCOUNTS: DISCOUNTS,
    freightDetail: freightDetail,
    maxTierLimit: maxTierLimit,
    profitSummary: profitSummary,
    validateTiers: validateTiers,
    formatNum: formatNum,
    money: money,
    num: num
  };
});
