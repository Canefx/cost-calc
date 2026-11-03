/* 包装成本测算系统 - 界面逻辑 */
(function () {
  "use strict";

  var C = window.CostCalc;
  var LAST_KEY = "cost_calc_last_v1";
  var SCHEME_KEY = "cost_calc_schemes_v1";

  // 版本号：三个文件必须同版本，否则功能会缺失
  var APP_VERSION = "1.7.0";
  var CALC_VERSION = "1.7.0";

  // 档位以「上限 + 运费」存储，起点由上一档上限推导
  var tiers = [];
  var rowsCache = [];
  var profitCache = [];
  // linkedPacks：点击测算明细行后联动的包数；null 表示独立测算（手动填包数与成本）
  var linkedPacks = null;
  var lastProfitInput = "";
  var bestPacks = null;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var m2 = function (v) { return v == null ? "—" : C.money(v, 2); };

  /* ---------------- 档位管理 ---------------- */
  function resetTiers() {
    tiers = C.DEFAULT_TIERS.map(function (t) { return { max: t.max, fee: t.fee }; });
    renderTiers();
    render();
  }

  function addTier() {
    var last = tiers.length ? parseFloat(tiers[tiers.length - 1].max) : 0;
    var nextMax = isNaN(last) ? 1 : Math.round((last + 1) * 1000) / 1000;
    var lastFee = tiers.length ? parseFloat(tiers[tiers.length - 1].fee) : 2.95;
    tiers.push({ max: nextMax, fee: isNaN(lastFee) ? 3 : lastFee });
    renderTiers();
    render();
  }

  function removeTier(i) {
    if (tiers.length <= 1) return;
    tiers.splice(i, 1);
    renderTiers();
    render();
  }

  function renderTiers() {
    var html = "";
    for (var i = 0; i < tiers.length; i++) {
      var start = i === 0 ? 0 : parseFloat(tiers[i - 1].max);
      var startTxt = isNaN(start) ? "—" : C.formatNum(start, 3);
      html +=
        '<div class="tier-row">' +
        '<span class="range">第 ' + (i + 1) + ' 档：' + startTxt + ' ~ ' +
        '<input type="number" step="0.001" min="0" value="' + esc(tiers[i].max) + '" data-tier-max="' + i + '"> kg</span>' +
        '<span>运费 <input type="number" step="0.01" min="0" value="' + esc(tiers[i].fee) + '" data-tier-fee="' + i + '"> 元</span>' +
        (tiers.length > 1 ? '<button class="ghost small" onclick="removeTier(' + i + ')">删除</button>' : "") +
        "</div>";
    }
    $("tierList").innerHTML = html;

    $("tierList").querySelectorAll("[data-tier-max]").forEach(function (el) {
      stopWheel(el);
      el.addEventListener("input", function () {
        tiers[+el.getAttribute("data-tier-max")].max = el.value;
        renderTiers(); // 起点随上一档变化，需重绘
        render();
      });
    });
    $("tierList").querySelectorAll("[data-tier-fee]").forEach(function (el) {
      stopWheel(el);
      el.addEventListener("input", function () {
        tiers[+el.getAttribute("data-tier-fee")].fee = el.value;
        render();
      });
    });
  }

  /** 禁止鼠标滚轮改动数字输入框的值（滚轮只用于滚动页面） */
  function stopWheel(el) {
    if (!el || typeof el.addEventListener !== "function") return;
    el.addEventListener("wheel", function (e) {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (typeof el.blur === "function") el.blur();
    }, { passive: false });
  }

  /** 把「上限+运费」转成 calc 需要的 {min,max,fee} 并校验 */
  function buildTiers() {
    var out = [];
    var min = 0;
    for (var i = 0; i < tiers.length; i++) {
      var max = parseFloat(tiers[i].max);
      var fee = parseFloat(tiers[i].fee);
      out.push({ min: min, max: isNaN(max) ? null : max, fee: isNaN(fee) ? null : fee });
      if (!isNaN(max)) min = max;
    }
    return out;
  }

  function tierErrors(built) {
    var errs = C.validateTiers(built);
    for (var i = 1; i < built.length; i++) {
      if (built[i].max != null && built[i - 1].max != null && built[i].max <= built[i - 1].max) {
        errs.push("第 " + (i + 1) + " 档上限必须大于第 " + i + " 档上限");
      }
    }
    return errs.filter(function (v, i, a) { return a.indexOf(v) === i; });
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    var built = buildTiers();
    var errs = tierErrors(built);
    $("tierErr").textContent = errs.join("；");
    $("paramErr").textContent = "";

    var unitWeight = parseFloat($("unitWeight").value);
    var baseCost = parseFloat($("baseCost").value);
    var count = parseInt($("count").value, 10);

    if (isNaN(unitWeight) || unitWeight <= 0) { $("paramErr").textContent = "单包克重需大于 0"; }
    if (isNaN(baseCost) || baseCost < 0) { $("paramErr").textContent = "单包成本不能为负数"; }

    if (errs.length || isNaN(unitWeight) || unitWeight <= 0 || isNaN(baseCost) || baseCost < 0) {
      rowsCache = [];
      $("rows").innerHTML = '<tr><td colspan="10" class="hint">请先修正上方参数或运费档位</td></tr>';
      $("summaryRow").innerHTML = "";
      $("chartSvg").innerHTML = "";
      $("profitBlocks").innerHTML = '<div class="stat">请先修正上方参数或运费档位</div>';
      $("profitNote").textContent = "";
      return;
    }

    var params = {
      unitWeight: unitWeight,
      baseCost: baseCost,
      count: Math.min(Math.max(count || 20, 1), 500),
      tiers: built,
      // 超额叠加：整箱规格取自「整箱反算」的三个输入
      stackEnabled: $("stackEnabled").checked,
      boxPacks: parseFloat($("casePacks").value),
      boxWeight: parseFloat($("caseWeight").value),
      boxCostWith: parseFloat($("caseCost").value)
    };
    var rows = C.computeRows(params);
    var s = C.summarize(rows);
    rowsCache = rows;
    bestPacks = s.best ? s.best.packs : null;

    renderSummary(s, params);
    renderChart(rows, s.best);
    renderTable(rows, s);
    renderProfit(rows);
    persistLast(params);
  }

  /* ---------------- 利润测算 ---------------- */
  var pct = function (v) { return v == null || isNaN(v) ? "—" : (Number(v) * 100).toFixed(2) + "%"; };

  /** 版本/依赖自检：文件没一起更新时给出明确提示，而不是静默失效 */
  function checkVersion() {
    var issues = [];
    var calcVer = C && C.VERSION ? C.VERSION : "未知";
    if (!C) {
      issues.push("calc.js 未加载。");
    } else {
      if (typeof C.computeProfitRows !== "function" || typeof C.computeDiscountRows !== "function") {
        issues.push("calc.js 缺少利润测算功能（实际版本 " + calcVer + "）。");
      }
      if (calcVer !== "未知" && calcVer !== CALC_VERSION) {
        issues.push("页面需要 calc.js " + CALC_VERSION + "，实际加载 " + calcVer + "。");
      }
    }
    // 页面自身版本：index.html 与脚本不同版本时可能缺少新输入框
    var pageVer = null;
    try {
      var meta = document.querySelector ? document.querySelector('meta[name="app-version"]') : null;
      if (meta) pageVer = meta.getAttribute("content");
    } catch (e) { pageVer = null; }
    if (pageVer && pageVer !== APP_VERSION) {
      issues.push("index.html 版本 " + pageVer + " 与脚本 " + APP_VERSION + " 不一致。");
    }
    var warn = $("versionWarn");
    if (warn) {
      if (issues.length) {
        warn.className = "version-warn";
        warn.innerHTML = "<b>文件版本不一致：</b>" + issues.join(" ") +
          " 请把 index.html、calc.js、app.js 三个文件一起重新上传到 GitHub（或直接上传单文件版的 index.html）。";
      } else {
        warn.className = "hidden";
        warn.innerHTML = "";
      }
    }
    var ver = $("appVersion");
    if (ver) ver.textContent = "v" + APP_VERSION;
  }

  function profitInput() {
    return {
      salePrice: $("salePrice").value,
      platformRate: $("ratePlatform").value,
      blackRate: $("rateBlack").value,
      subsidyRate: $("rateSubsidy").value,
      accrualRate: $("rateAccrual").value,
      refundRate: $("rateRefund").value,
      profitCost: $("profitCost") ? $("profitCost").value : ""
    };
  }

  /** 利润输入快照：用于判断输入是否有未应用的改动 */
  function profitSnapshot() {
    var o = profitInput();
    o.packs = $("profitPacks") ? String($("profitPacks").value) : "";
    return JSON.stringify(o);
  }

  /** 有未应用的改动时，按钮文字给出提示 */
  function markProfitDirty() {
    var btn = $("profitRun");
    if (!btn) return;
    btn.textContent = profitSnapshot() !== lastProfitInput ? "确定测算（输入有改动）" : "确定测算";
  }

  /** 更新联动状态提示文字 */
  function renderLinkState() {
    var el = $("profitLink");
    if (!el) return;
    el.textContent = linkedPacks != null
      ? "已联动明细 " + linkedPacks + " 包行：成本测算变化会自动同步"
      : "独立测算：包数与成本手动填写";
  }

  /** 点击测算明细某一行：带入该行包数与成本，并保持联动 */
  function pickRowFromCost(n) {
    var row = (rowsCache || []).filter(function (r) { return r.packs === n && !r.over; })[0];
    if (!row) return;
    linkedPacks = n;
    $("profitPacks").value = String(n);
    $("profitCost").value = C.money(row.costWith, 2);
    renderTable(rowsCache, null);
    renderLinkState();
    renderProfit(rowsCache);
  }

  /** 「确定测算」按钮：点击后才按当前输入重新测算 */
  function runProfit() {
    renderProfit(rowsCache);
  }

  function renderProfit(rows) {
    renderProfitInner(rows);
    // 本次渲染所应用的输入即成为基准；按钮提示随之刷新
    lastProfitInput = profitSnapshot();
    markProfitDirty();
  }

  function renderProfitInner(rows) {
    // calc.js 版本过旧时不抛异常，给出可操作的提示
    if (typeof C.computeDiscountRows !== "function" || typeof C.profitSummary !== "function") {
      $("profitBlocks").innerHTML = '<div class="stat" style="color:#c0392b">' +
        "calc.js 版本过旧，缺少折扣测算功能。请把 calc.js、app.js、index.html 一起重新上传。</div>";
      $("profitNote").textContent = "";
      profitCache = [];
      return;
    }

    // 联动模式：所选行仍在可算范围内时，同步该行的最新成本
    if (linkedPacks != null) {
      var linked = (rows || []).filter(function (r) { return r.packs === linkedPacks && !r.over; })[0];
      if (linked) {
        $("profitPacks").value = String(linkedPacks);
        $("profitCost").value = C.money(linked.costWith, 2);
      } else {
        // 该包数已不可算：解除联动，保留输入框当前值让用户自行处理
        linkedPacks = null;
        renderLinkState();
        renderTable(rowsCache, null);
      }
    }

    var packs = parseInt($("profitPacks").value, 10);
    var cost = parseFloat($("profitCost").value);
    var valid = (rows || []).filter(function (r) { return !r.over; });

    if (!(packs > 0) || isNaN(cost) || cost < 0) {
      $("profitBlocks").innerHTML = '<div class="stat">' +
        (valid.length
          ? "填写测算包数与成本，或点击上方测算明细的某一行带入"
          : "当前成本参数下没有可测算的行，可直接手动填写包数与成本") +
        "</div>";
      $("profitNote").textContent = "";
      profitCache = [];
      return;
    }

    // 独立模式下按输入框构造成本行；能对上明细行时顺便带上重量
    var matched = valid.filter(function (r) { return r.packs === packs; })[0];
    var fakeRow = { packs: packs, costWith: cost, weight: matched ? matched.weight : null };
    renderProfitBlocks(fakeRow);
  }

  /** 所选包数的折扣测算表 */
  function renderProfitBlocks(row) {
    var input = profitInput();
    var price = parseFloat(input.salePrice);
    var sum = C.profitSummary(input);

    if (!(price > 0)) {
      $("profitBlocks").innerHTML = '<div class="stat">填写整单售卖价（元）后自动测算</div>';
      $("profitNote").textContent = "";
      profitCache = [];
      return;
    }

    var list = C.computeDiscountRows(row, input);
    if (!list.length) {
      $("profitBlocks").innerHTML = '<div class="stat">无可用数据</div>';
      $("profitNote").textContent = "";
      profitCache = [];
      return;
    }

    var body = list.map(function (d) {
      var profitAmount = d.settlement != null ? d.settlement - d.cost : null;
      var cls = d.loss ? "loss" : "";
      var roiTxt = d.breakEvenRoi == null ? "—" : d.breakEvenRoi.toFixed(2);
      return '<tr class="' + cls + '">' +
        "<td>" + esc(d.label) + "</td>" +
        '<td class="num">' + m2(d.salePrice) + "</td>" +
        '<td class="num">' + m2(d.unitPrice) + "</td>" +
        '<td class="num">' + m2(d.settlement) + "</td>" +
        '<td class="num">' + m2(profitAmount) + "</td>" +
        '<td class="num">' + pct(d.profitRate) + "</td>" +
        '<td class="num">' + roiTxt + "</td>" +
        "</tr>";
    }).join("");

    profitCache = [{ packs: row.packs, weight: row.weight, cost: row.costWith, rows: list }];

    var wTxt = row.weight != null ? C.formatNum(row.weight, 3) + " kg · " : "";
    $("profitBlocks").innerHTML =
      '<div class="profit-block">' +
      '<div class="profit-head">' + row.packs + " 包" +
      '<span class="sub">' + wTxt + "成本 " + m2(row.costWith) + " 元 · 原价 " +
      m2(list[0].salePrice) + " 元（单包 " + m2(list[0].unitPrice) + " 元）</span></div>" +
      '<div class="table-wrap"><table><thead><tr>' +
      "<th>折扣</th><th class=\"num\">整单价/元</th><th class=\"num\">单包价/元</th>" +
      "<th class=\"num\">结算价/元</th><th class=\"num\">利润额/元</th>" +
      "<th class=\"num\">利润率</th><th class=\"num\">保本ROI</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div></div>";

    $("profitNote").innerHTML =
      "含百补综合扣点 " + pct(sum.combinedSubsidy) + "，计提费比 " + pct(C.num(input.accrualRate) / 100) +
      "，合计费比 " + pct(sum.totalRate) + "，退款率 " + pct(C.num(input.refundRate) / 100) +
      "；结算价 = 售价 − 成本 × 合计费比；利润率 = (结算价 − 成本) ÷ 结算价；保本 ROI = 1 ÷ 利润率 ÷ (1 − 退款率)。";
  }

  function renderSummary(s, params) {
    var best = s.best;
    var html = "";
    if (best) {
      html += stat("最低单包成本（含快递）", m2(best.perWith) + " 元", "对应 " + best.packs + " 包 / " + C.formatNum(best.weight, 3) + " kg");
      html += stat("该单总成本（含快递）", m2(best.costWith) + " 元", "其中运费 " + m2(best.fee) + " 元，档位 " + best.tier);
      html += stat("单包成本（不含快递）", m2(params.baseCost) + " 元", "商品成本基准，与包数无关");
      html += stat("可测算包数", s.validCount + " / " + (s.validCount + s.overCount) + " 个", "上限 " + C.formatNum(s.maxValidWeight, 3) + " kg 以内可算");
    } else {
      html += stat("最低单包成本（含快递）", "—", "当前参数下没有可用包数");
    }
    $("summaryRow").innerHTML = html;
  }

  function stat(k, v, s) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      '</div><div class="s">' + esc(s) + "</div></div>";
  }

  function renderTable(rows, s) {
    var html = rows.map(function (r) {
      var cls = r.over ? "over" : (bestPacks === r.packs ? "best" : "");
      if (linkedPacks === r.packs) cls = (cls ? cls + " " : "") + "picked";
      var mark = bestPacks === r.packs ? '<span class="badge">最低</span>' : "";
      if (linkedPacks === r.packs) mark += '<span class="badge warn">已带入</span>';
      var isStack = r.mode === "stack";
      var modeTxt = isStack
        ? '<span class="badge warn">' + esc(r.tier) + "</span>"
        : esc(r.tier);
      return (
        '<tr class="' + cls + '"' + (r.over ? "" : ' onclick="pickRowFromCost(' + r.packs + ')" title="点击把该行包数与成本带入利润测算"') + ">" +
        '<td class="num">' + r.packs + mark + "</td>" +
        '<td class="num">' + C.formatNum(r.weight, 3) + "</td>" +
        "<td>" + (r.over ? '<span class="badge warn">' + C.OVER_LIMIT_TEXT + "</span>" : modeTxt) + "</td>" +
        '<td class="num">' + (isStack ? m2(r.boxCost) : "—") + "</td>" +
        '<td class="num">' + (isStack ? (r.rest > 0 ? m2(r.restCost) : "—") : "—") + "</td>" +
        '<td class="num">' + (r.over ? "—" : m2(r.fee)) + "</td>" +
        '<td class="num">' + (r.over ? "—" : m2(r.costWith)) + "</td>" +
        '<td class="num">' + m2(r.costWithout) + "</td>" +
        '<td class="num">' + (r.over ? "—" : m2(r.perWith)) + "</td>" +
        '<td class="num">' + m2(r.perWithout) + "</td>" +
        "</tr>"
      );
    }).join("");
    $("rows").innerHTML = html || '<tr><td colspan="10" class="hint">无数据</td></tr>';
  }

  /* ---------------- 走势图 ---------------- */
  function renderChart(rows, best) {
    var svg = $("chartSvg");
    var valid = rows.filter(function (r) { return !r.over && r.perWith != null; });
    if (valid.length < 1) { svg.innerHTML = ""; return; }

    var W = 760, H = 260, PL = 62, PR = 18, PT = 18, PB = 38;
    var xs = valid.map(function (r) { return r.packs; });
    var ys = valid.map(function (r) { return r.perWith; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    if (maxY - minY < 1e-9) { maxY += 0.05; minY -= 0.05; }
    var padY = (maxY - minY) * 0.15;
    minY = Math.max(0, minY - padY); maxY = maxY + padY;

    var X = function (v) { return PL + (maxX === minX ? 0.5 : (v - minX) / (maxX - minX)) * (W - PL - PR); };
    var Y = function (v) { return PT + (1 - (v - minY) / (maxY - minY)) * (H - PT - PB); };

    var s = "";
    // 横向网格 + Y 轴刻度（成本统一保留两位小数；仅当刻度会重复时才补一位避免重叠）
    var g = 4;
    var axisDigits = 2;
    var prevLabel = null;
    for (var t = 0; t <= g; t++) {
      var probe = C.money(minY + (maxY - minY) * (t / g), 2);
      if (prevLabel !== null && probe === prevLabel) { axisDigits = 3; break; }
      prevLabel = probe;
    }
    for (var i = 0; i <= g; i++) {
      var val = minY + (maxY - minY) * (i / g);
      var y = Y(val);
      s += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) +
        '" stroke="#eef1f5" stroke-width="1"/>';
      s += '<text x="' + (PL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#8b96a3">' +
        C.money(val, axisDigits) + "</text>";
    }
    // 轴
    s += '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '" stroke="#cfd8e3"/>';
    s += '<line x1="' + PL + '" y1="' + PT + '" x2="' + PL + '" y2="' + (H - PB) + '" stroke="#cfd8e3"/>';

    // 折线
    var pts = valid.map(function (r) { return X(r.packs).toFixed(1) + "," + Y(r.perWith).toFixed(1); }).join(" ");
    s += '<polyline points="' + pts + '" fill="none" stroke="#2d7ff9" stroke-width="2" stroke-linejoin="round"/>';
    // 数据点
    valid.forEach(function (r) {
      var isBest = best && r.packs === best.packs;
      s += '<circle cx="' + X(r.packs).toFixed(1) + '" cy="' + Y(r.perWith).toFixed(1) + '" r="' + (isBest ? 4.5 : 2.6) +
        '" fill="' + (isBest ? "#27ae60" : "#2d7ff9") + '"/>';
    });

    // 最优点标注
    if (best) {
      var bx = X(best.packs), by = Y(best.perWith);
      var anchor = bx > W * 0.72 ? "end" : "start";
      var dx = anchor === "end" ? -10 : 10;
      s += '<text x="' + (bx + dx).toFixed(1) + '" y="' + (by - 10).toFixed(1) + '" text-anchor="' + anchor +
        '" font-size="12" fill="#27ae60" font-weight="bold">最低 ' + C.money(best.perWith, 2) + ' 元 / ' + best.packs + ' 包</text>';
    }

    // X 轴标签（最多 8 个）
    var stepX = Math.max(1, Math.ceil(valid.length / 8));
    for (var k = 0; k < valid.length; k += stepX) {
      var r2 = valid[k];
      s += '<text x="' + X(r2.packs).toFixed(1) + '" y="' + (H - PB + 16) + '" text-anchor="middle" font-size="11" fill="#8b96a3">' +
        r2.packs + "</text>";
    }
    var lastR = valid[valid.length - 1];
    if (X(lastR.packs) - X(valid[valid.length - 1 - ((valid.length - 1) % stepX)].packs) > 24) {
      s += '<text x="' + X(lastR.packs).toFixed(1) + '" y="' + (H - PB + 16) + '" text-anchor="middle" font-size="11" fill="#8b96a3">' +
        lastR.packs + "</text>";
    }
    s += '<text x="' + ((W - PR + PL) / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="#8b96a3">包数</text>';

    svg.innerHTML = s;
  }

  /* ---------------- 整箱反算 ---------------- */
  function renderCase() {
    var built = buildTiers();
    var packs = parseFloat($("casePacks").value);
    var weight = parseFloat($("caseWeight").value);
    var costWith = parseFloat($("caseCost").value);
    var errEl = $("caseErr");
    errEl.textContent = "";

    if (isNaN(packs) || packs <= 0 || isNaN(weight) || weight < 0 || isNaN(costWith) || costWith < 0) {
      $("caseOut").innerHTML = "";
      errEl.textContent = "请填写有效的整箱包数、克重与成本";
      return;
    }
    var r = C.reverseCase({ packs: packs, weight: weight, costWith: costWith, tiers: built });
    if (r.over) {
      $("caseOut").innerHTML = "";
      errEl.textContent = "整箱克重 " + C.formatNum(weight, 3) + " kg 超出最高档位（" + C.OVER_LIMIT_TEXT + "），无法反算运费";
      return;
    }
    $("caseOut").innerHTML =
      stat("命中运费档位", r.tier, "运费 " + m2(r.fee) + " 元") +
      stat("整箱成本/不含快递费", m2(r.costWithout) + " 元", "含快递 " + m2(r.costWith) + " − 运费 " + m2(r.fee)) +
      stat("单包成本/含快递费", m2(r.perWith) + " 元", "整箱含快递 ÷ " + C.formatNum(packs, 0) + " 包") +
      stat("单包成本/不含快递费", m2(r.perWithout) + " 元", "可直接作为测算的单包成本");
  }

  function applyCase() {
    var built = buildTiers();
    var packs = parseFloat($("casePacks").value);
    var weight = parseFloat($("caseWeight").value);
    var costWith = parseFloat($("caseCost").value);
    if (isNaN(packs) || packs <= 0 || isNaN(weight) || isNaN(costWith)) {
      $("caseErr").textContent = "请填写有效的整箱包数、克重与成本";
      return;
    }
    var r = C.reverseCase({ packs: packs, weight: weight, costWith: costWith, tiers: built });
    if (r.over) {
      $("caseErr").textContent = "整箱克重超出最高档位，无法反算";
      return;
    }
    $("unitWeight").value = +(weight / packs).toFixed(6);
    $("baseCost").value = +r.perWithout.toFixed(6);
    render();
  }

  /* ---------------- 导出 ---------------- */
  function tableHeader() {
    return ["包数", "克重/kg", "计价方式", "整箱成本/元", "散包成本/元", "运费合计/元",
      "成本/含快递费", "成本/不含快递费", "单包成本/含快递费", "单包成本/不含快递费"];
  }

  function tableBody() {
    return rowsCache.map(function (r) {
      var isStack = r.mode === "stack";
      return [
        r.packs,
        C.formatNum(r.weight, 3),
        r.over ? C.OVER_LIMIT_TEXT : r.tier,
        isStack ? m2(r.boxCost) : "—",
        isStack ? (r.rest > 0 ? m2(r.restCost) : "—") : "—",
        r.over ? "—" : m2(r.fee),
        r.over ? "—" : m2(r.costWith),
        m2(r.costWithout),
        r.over ? "—" : m2(r.perWith),
        m2(r.perWithout)
      ];
    });
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }

  function exportCsv() {
    if (!rowsCache.length) return alert("当前没有可导出的数据");
    var lines = [tableHeader().join(",")];
    tableBody().forEach(function (row) {
      lines.push(row.map(function (v) {
        var t = String(v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }).join(","));
    });
    // BOM 让 Excel 正确识别 UTF-8
    download("成本测算-" + stamp() + ".csv", "\uFEFF" + lines.join("\r\n"), "text/csv;charset=utf-8");
  }

  function exportExcel() {
    if (!rowsCache.length) return alert("当前没有可导出的数据");
    var head = "<tr>" + tableHeader().map(function (h) { return '<th style="background:#f0f3f7">' + esc(h) + "</th>"; }).join("") + "</tr>";
    var body = tableBody().map(function (row) {
      return "<tr>" + row.map(function (v) { return "<td>" + esc(v) + "</td>"; }).join("") + "</tr>";
    }).join("");
    var html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
      '<head><meta charset="utf-8"><style>td,th{border:1px solid #ccc;padding:4px 8px;font-family:"Microsoft YaHei";font-size:12px}</style></head>' +
      "<body><table><thead>" + head + "</thead><tbody>" + body + "</tbody></table></body></html>";
    download("成本测算-" + stamp() + ".xls", "\uFEFF" + html, "application/vnd.ms-excel;charset=utf-8");
  }

  /* ---------------- 利润测算导出 ---------------- */
  function profitHeader() {
    return ["包数", "克重/kg", "成本/含快递费", "折扣", "整单价/元", "单包价/元",
      "结算价/元", "利润额/元", "利润率", "保本ROI"];
  }

  function profitBody() {
    var out = [];
    (profitCache || []).forEach(function (block) {
      block.rows.forEach(function (d) {
        var profitAmount = d.settlement != null ? d.settlement - d.cost : null;
        out.push([
          block.packs,
          C.formatNum(block.weight, 3),
          m2(block.cost),
          d.label,
          m2(d.salePrice),
          m2(d.unitPrice),
          m2(d.settlement),
          m2(profitAmount),
          pct(d.profitRate),
          d.breakEvenRoi == null ? "—" : d.breakEvenRoi.toFixed(2)
        ]);
      });
    });
    return out;
  }

  function exportProfitCsv() {
    if (!profitCache.length) return alert("请先勾选包数并填写售卖价");
    var lines = [profitHeader().join(",")];
    profitBody().forEach(function (row) {
      lines.push(row.map(function (v) {
        var t = String(v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }).join(","));
    });
    download("利润测算-" + stamp() + ".csv", "\uFEFF" + lines.join("\r\n"), "text/csv;charset=utf-8");
  }

  function exportProfitExcel() {
    if (!profitCache.length) return alert("请先勾选包数并填写售卖价");
    var head = "<tr>" + profitHeader().map(function (h) { return '<th style="background:#f0f3f7">' + esc(h) + "</th>"; }).join("") + "</tr>";
    var body = profitBody().map(function (row) {
      return "<tr>" + row.map(function (v) { return "<td>" + esc(v) + "</td>"; }).join("") + "</tr>";
    }).join("");
    var html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
      '<head><meta charset="utf-8"><style>td,th{border:1px solid #ccc;padding:4px 8px;font-family:"Microsoft YaHei";font-size:12px}</style></head>' +
      "<body><table><thead>" + head + "</thead><tbody>" + body + "</tbody></table></body></html>";
    download("利润测算-" + stamp() + ".xls", "\uFEFF" + html, "application/vnd.ms-excel;charset=utf-8");
  }

  /* ---------------- 方案存取 ---------------- */
  function readSchemes() {
    try {
      var v = JSON.parse(localStorage.getItem(SCHEME_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function writeSchemes(list) {
    localStorage.setItem(SCHEME_KEY, JSON.stringify(list));
    renderSchemeOptions();
  }

  function currentConfig() {
    return {
      unitWeight: $("unitWeight").value,
      baseCost: $("baseCost").value,
      count: $("count").value,
      stackEnabled: $("stackEnabled").checked,
      tiers: tiers.map(function (t) { return { max: t.max, fee: t.fee }; }),
      casePacks: $("casePacks").value,
      caseWeight: $("caseWeight").value,
      caseCost: $("caseCost").value,
      salePrice: $("salePrice").value,
      profitPacks: $("profitPacks").value,
      profitCost: $("profitCost").value,
      linkedPacks: linkedPacks,
      ratePlatform: $("ratePlatform").value,
      rateBlack: $("rateBlack").value,
      rateSubsidy: $("rateSubsidy").value,
      rateAccrual: $("rateAccrual").value,
      rateRefund: $("rateRefund").value
    };
  }

  function saveScheme() {
    var name = $("schemeName").value.trim();
    if (!name) return alert("请先填写方案名称");
    var list = readSchemes();
    var item = { name: name, config: currentConfig(), savedAt: Date.now() };
    var idx = list.findIndex(function (s) { return s.name === name; });
    if (idx >= 0) {
      if (!confirm("已有同名方案「" + name + "」，是否覆盖？")) return;
      list[idx] = item;
    } else {
      list.push(item);
    }
    writeSchemes(list);
    $("schemeSelect").value = name;
    alert("方案已保存");
  }

  function loadScheme(name) {
    if (!name) return;
    var found = readSchemes().filter(function (s) { return s.name === name; })[0];
    if (!found) return;
    var c = found.config || {};
    if (c.unitWeight != null) $("unitWeight").value = c.unitWeight;
    if (c.baseCost != null) $("baseCost").value = c.baseCost;
    if (c.count != null) $("count").value = c.count;
    if (c.stackEnabled != null) $("stackEnabled").checked = !!c.stackEnabled;
    if (c.casePacks != null) $("casePacks").value = c.casePacks;
    if (c.caseWeight != null) $("caseWeight").value = c.caseWeight;
    if (c.caseCost != null) $("caseCost").value = c.caseCost;
    if (c.salePrice != null) $("salePrice").value = c.salePrice;
    if (c.profitPacks != null) $("profitPacks").value = c.profitPacks;
    if (c.profitCost != null) $("profitCost").value = c.profitCost;
    if (c.ratePlatform != null) $("ratePlatform").value = c.ratePlatform;
    if (c.rateBlack != null) $("rateBlack").value = c.rateBlack;
    if (c.rateSubsidy != null) $("rateSubsidy").value = c.rateSubsidy;
    if (c.rateAccrual != null) $("rateAccrual").value = c.rateAccrual;
    if (c.rateRefund != null) $("rateRefund").value = c.rateRefund;
    if (Array.isArray(c.tiers) && c.tiers.length) {
      tiers = c.tiers.map(function (t) { return { max: t.max, fee: t.fee }; });
    }
    $("schemeName").value = name;
    // 换方案后解除明细行联动，回到独立测算
    linkedPacks = null;
    renderLinkState();
    renderTiers();
    renderCase();
    render();
  }

  function deleteScheme() {
    var name = $("schemeSelect").value;
    if (!name) return alert("请先在下拉框选择要删除的方案");
    if (!confirm("确定删除方案「" + name + "」？")) return;
    writeSchemes(readSchemes().filter(function (s) { return s.name !== name; }));
    $("schemeSelect").value = "";
    $("schemeName").value = "";
  }

  function renderSchemeOptions() {
    var list = readSchemes();
    var sel = $("schemeSelect");
    var cur = sel.value;
    sel.innerHTML = '<option value="">— 选择已保存方案 —</option>' +
      list.map(function (s) {
        return '<option value="' + esc(s.name) + '">' + esc(s.name) + "</option>";
      }).join("");
    if (list.some(function (s) { return s.name === cur; })) sel.value = cur;
  }

  /* ---------------- 本地记忆 ---------------- */
  function persistLast(params) {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({
        unitWeight: params.unitWeight,
        baseCost: params.baseCost,
        count: params.count,
        stackEnabled: params.stackEnabled,
        tiers: tiers.map(function (t) { return { max: t.max, fee: t.fee }; }),
        casePacks: $("casePacks").value,
        caseWeight: $("caseWeight").value,
        caseCost: $("caseCost").value,
        salePrice: $("salePrice").value,
        profitPacks: $("profitPacks").value,
        profitCost: $("profitCost").value,
        linkedPacks: linkedPacks,
        ratePlatform: $("ratePlatform").value,
        rateBlack: $("rateBlack").value,
        rateSubsidy: $("rateSubsidy").value,
        rateAccrual: $("rateAccrual").value,
        rateRefund: $("rateRefund").value
      }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function restoreLast() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LAST_KEY) || "null"); } catch (e) { raw = null; }
    if (!raw) {
      tiers = C.DEFAULT_TIERS.map(function (t) { return { max: t.max, fee: t.fee }; });
      return;
    }
    if (raw.unitWeight != null) $("unitWeight").value = raw.unitWeight;
    if (raw.baseCost != null) $("baseCost").value = raw.baseCost;
    if (raw.count != null) $("count").value = raw.count;
    if (raw.stackEnabled != null) $("stackEnabled").checked = !!raw.stackEnabled;
    if (raw.casePacks != null) $("casePacks").value = raw.casePacks;
    if (raw.caseWeight != null) $("caseWeight").value = raw.caseWeight;
    if (raw.caseCost != null) $("caseCost").value = raw.caseCost;
    if (raw.salePrice != null) $("salePrice").value = raw.salePrice;
    if (raw.profitPacks != null) $("profitPacks").value = raw.profitPacks;
    if (raw.profitCost != null) $("profitCost").value = raw.profitCost;
    if (raw.linkedPacks != null) linkedPacks = raw.linkedPacks;
    if (raw.ratePlatform != null) $("ratePlatform").value = raw.ratePlatform;
    if (raw.rateBlack != null) $("rateBlack").value = raw.rateBlack;
    if (raw.rateSubsidy != null) $("rateSubsidy").value = raw.rateSubsidy;
    if (raw.rateAccrual != null) $("rateAccrual").value = raw.rateAccrual;
    if (raw.rateRefund != null) $("rateRefund").value = raw.rateRefund;
    tiers = Array.isArray(raw.tiers) && raw.tiers.length
      ? raw.tiers.map(function (t) { return { max: t.max, fee: t.fee }; })
      : C.DEFAULT_TIERS.map(function (t) { return { max: t.max, fee: t.fee }; });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    checkVersion();

    // 所有数字输入框禁用滚轮改值，避免滚动页面时误改参数
    [
      "unitWeight", "baseCost", "count",
      "casePacks", "caseWeight", "caseCost",
      "salePrice", "profitPacks", "profitCost",
      "ratePlatform", "rateBlack", "rateSubsidy", "rateAccrual", "rateRefund"
    ].forEach(function (id) { stopWheel($(id)); });

    restoreLast();
    renderTiers();
    renderSchemeOptions();

    ["unitWeight", "baseCost", "count"].forEach(function (id) {
      $(id).addEventListener("input", render);
    });
    // 整箱规格同时影响反算结果与超额叠加，二者都要刷新
    ["casePacks", "caseWeight", "caseCost"].forEach(function (id) {
      $(id).addEventListener("input", function () { renderCase(); render(); });
    });
    $("stackEnabled").addEventListener("change", render);
    // 利润测算：输入只做「有改动」标记，点「确定测算」才重算
    ["salePrice", "ratePlatform", "rateBlack", "rateSubsidy", "rateAccrual", "rateRefund"].forEach(function (id) {
      $(id).addEventListener("input", markProfitDirty);
    });
    // 手动改包数或成本 → 解除明细行联动，进入独立测算
    ["profitPacks", "profitCost"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        if (linkedPacks != null) {
          linkedPacks = null;
          renderLinkState();
          renderTable(rowsCache, null);
        }
        markProfitDirty();
      });
    });

    // 暴露给内联 onclick
    window.addTier = addTier;
    window.removeTier = removeTier;
    window.resetTiers = resetTiers;
    window.applyCase = applyCase;
    window.pickRowFromCost = pickRowFromCost;
    window.runProfit = runProfit;
    window.saveScheme = saveScheme;
    window.loadScheme = loadScheme;
    window.deleteScheme = deleteScheme;
    window.exportCsv = exportCsv;
    window.exportExcel = exportExcel;
    window.exportProfitCsv = exportProfitCsv;
    window.exportProfitExcel = exportProfitExcel;

    renderCase();
    render();
    renderLinkState();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
