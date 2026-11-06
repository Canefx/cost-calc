/* 包装成本测算系统 - 界面逻辑 */
(function () {
  "use strict";

  var C = window.CostCalc;
  var LAST_KEY = "cost_calc_last_v1";
  var SCHEME_KEY = "cost_calc_schemes_v1";

  // 版本号：三个文件必须同版本，否则功能会缺失
  var APP_VERSION = "1.11.0";
  var CALC_VERSION = "1.11.0";

  // 档位以「上限 + 运费」存储，起点由上一档上限推导
  var tiers = [];
  var rowsCache = [];
  // 多个利润测算实例：每个实例独立保存输入、结果、联动状态
  var profitInstances = [];
  var activeProfitId = null;
  var bestPacks = null;
  // 标价反推板块：联动包数
  var lpLinkedPacks = null;

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
    renderProfitList();
    syncListPriceLink(rows);
    persistLast(params);
  }

  /** 成本测算变化时，同步标价反推板块的联动成本 */
  function syncListPriceLink(rows) {
    if (lpLinkedPacks == null) return;
    var linked = (rows || []).filter(function (r) { return r.packs === lpLinkedPacks && !r.over; })[0];
    if (linked) {
      $("lpPacks").value = String(linked.packs);
      $("lpCost").value = C.money(linked.costWith, 2);
    } else {
      lpLinkedPacks = null;
      renderLpLinkState();
    }
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

/* 多实例利润测算逻辑（替换 app.js 中旧的 profitInput..renderProfitBlocks 段） */
  var PROFIT_KEY = "cost_calc_profit_instances_v1";

  function uid() {
    return "pi-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function defaultProfitInstance(id) {
    return {
      id: id || uid(),
      name: "",
      packs: "",
      cost: "",
      salePrice: "",
      targetRate: "",
      platformRate: "5",
      blackRate: "0",
      subsidyRate: "0",
      accrualRate: "0",
      refundRate: "10",
      linkedPacks: null,
      discounts: null,   // 自定义折扣数组（0~1 小数）；null 用默认档位
      result: null,   // { rows:[...], weight, cost, packs, sum } 或 null
      collapsed: false
    };
  }

  function persistProfitInstances() {
    try {
      localStorage.setItem(PROFIT_KEY, JSON.stringify(profitInstances.map(function (p) {
        return {
          id: p.id, name: p.name, packs: p.packs, cost: p.cost, salePrice: p.salePrice,
          targetRate: p.targetRate, platformRate: p.platformRate, blackRate: p.blackRate,
          subsidyRate: p.subsidyRate, accrualRate: p.accrualRate, refundRate: p.refundRate,
          linkedPacks: p.linkedPacks, collapsed: p.collapsed, discounts: p.discounts
        };
      })));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function loadProfitInstances() {
    try {
      var v = JSON.parse(localStorage.getItem(PROFIT_KEY) || "null");
      if (!Array.isArray(v) || !v.length) return null;
      return v.map(function (o) {
        var p = defaultProfitInstance(o.id);
        Object.keys(p).forEach(function (k) {
          if (k === "result") return;
          if (o[k] != null) p[k] = o[k];
        });
        return p;
      });
    } catch (e) { return null; }
  }

  function getProfitInstance(id) {
    return profitInstances.filter(function (p) { return p.id === id; })[0] || null;
  }

  function activeInstance() {
    return getProfitInstance(activeProfitId) || profitInstances[0] || null;
  }

  function addProfitInstance() {
    var p = defaultProfitInstance();
    profitInstances.push(p);
    activeProfitId = p.id;
    persistProfitInstances();
    renderProfitList();
    return p.id;
  }

  function removeProfitInstance(id) {
    if (profitInstances.length <= 1) {
      // 只剩一个时不删除，仅清空
      var only = profitInstances[0];
      Object.assign(only, defaultProfitInstance(only.id));
      persistProfitInstances();
      renderProfitList();
      return;
    }
    profitInstances = profitInstances.filter(function (p) { return p.id !== id; });
    if (activeProfitId === id) activeProfitId = profitInstances[profitInstances.length - 1].id;
    persistProfitInstances();
    renderProfitList();
  }

  function setActiveProfit(id) {
    activeProfitId = id;
    persistProfitInstances();
    renderProfitList();
  }

  function toggleProfitCollapse(id) {
    var p = getProfitInstance(id);
    if (!p) return;
    p.collapsed = !p.collapsed;
    persistProfitInstances();
    renderProfitList();
  }

  /** 输入框改动时把值写回实例，只更新数据不重建 DOM（避免输入框失焦断输） */
  function onProfitFieldInput(id, field) {
    var p = getProfitInstance(id);
    if (!p) return;
    var el = $("pi-" + id + "-" + field);
    if (!el) return;
    p[field] = el.value;
    // 手动改包数或成本 → 解除联动（只更新明细表格高亮）
    if (field === "packs" || field === "cost") {
      if (p.linkedPacks != null) {
        p.linkedPacks = null;
        renderTable(rowsCache, null);
        // 局部刷新该实例头部联动提示
        updateInstanceHead(p);
      }
    }
    persistProfitInstances();
  }

  /** 局部更新某实例头部的联动/结果摘要文字（不重建输入框） */
  function updateInstanceHead(p) {
    var head = document.querySelector ? document.querySelector(".profit-instance#pi-" + p.id + " .pi-summary") : null;
    if (!head) return;
    var linkedTxt = p.linkedPacks != null ? "已联动明细 " + p.linkedPacks + " 包行" : "独立填写";
    var summary = p.result
      ? "原价 " + m2(p.result.rows[0].salePrice) + " 元 · 利润率 " + pct(p.result.rows[0].profitRate)
      : "未测算";
    head.textContent = linkedTxt + " · " + summary;
  }

  /** 点击测算明细某一行：带入到当前激活的测算实例，同时同步到标价反推板块 */
  function pickRowFromCost(n) {
    var row = (rowsCache || []).filter(function (r) { return r.packs === n && !r.over; })[0];
    if (!row) return;
    var p = activeInstance();
    if (!p) p = getProfitInstance(addProfitInstance());
    p.packs = String(n);
    p.cost = C.money(row.costWith, 2);
    p.linkedPacks = n;
    persistProfitInstances();
    renderTable(rowsCache, null);
    renderProfitList();

    // 同步到标价反推板块（若该板块处于联动状态）
    if (lpLinkedPacks != null) {
      $("lpPacks").value = String(n);
      $("lpCost").value = C.money(row.costWith, 2);
      lpLinkedPacks = n;
      renderLpLinkState();
    }
  }

  /** 当前激活实例点「确定测算」 */
  function runProfit() {
    var p = activeInstance();
    if (!p) return;
    renderProfitInstanceResult(p);
    persistProfitInstances();
    renderProfitList();
  }

  /* ---------------- 标价反推板块 ---------------- */
  function lpInput() {
    return {
      packs: $("lpPacks").value,
      cost: $("lpCost").value,
      discount: $("lpDiscount").value,
      targetRate: $("lpTargetRate").value,
      platformRate: $("lpPlatformRate").value,
      blackRate: $("lpBlackRate").value,
      subsidyRate: $("lpSubsidyRate").value,
      accrualRate: $("lpAccrualRate").value,
      refundRate: $("lpRefundRate").value
    };
  }

  function renderLpLinkState() {
    var el = $("lpLink");
    if (!el) return;
    el.textContent = lpLinkedPacks != null
      ? "已联动明细 " + lpLinkedPacks + " 包行：成本测算变化会自动同步"
      : "独立填写；点击上方「测算明细」某一行可带入包数与成本";
  }

  function runListPrice() {
    var input = lpInput();
    var packs = parseInt(input.packs, 10);
    var cost = parseFloat(input.cost);
    var discount = C.normalizeDiscount(input.discount);
    var targetRate = input.targetRate === "" || input.targetRate == null ? 0 : parseFloat(input.targetRate);
    var sum = C.profitSummary({
      platformRate: input.platformRate,
      blackRate: input.blackRate,
      subsidyRate: input.subsidyRate,
      accrualRate: input.accrualRate
    });

    var out = $("lpResult");
    if (!out) return;

    if (!(packs > 0) || isNaN(cost) || cost < 0) {
      out.innerHTML = '<div class="stat">请填写包数与成本，或点击上方「测算明细」某一行带入</div>';
      return;
    }
    if (discount == null) {
      out.innerHTML = '<div class="stat">请填写目标折扣（0.01~10，如 7 表示 7 折）</div>';
      return;
    }
    if (isNaN(targetRate) || targetRate < 0 || targetRate >= 100) {
      out.innerHTML = '<div class="stat">目标利润率需在 0~100 之间（留空表示保本）</div>';
      return;
    }

    var p = targetRate / 100;
    var listPrice = C.targetListPriceOf(cost, sum.totalRate, discount, p);
    if (listPrice == null) {
      out.innerHTML = '<div class="stat">无法计算，请检查输入</div>';
      return;
    }
    var salePrice = listPrice * discount;      // 折后价
    var settlement = salePrice - cost * sum.totalRate;
    var profitAmount = settlement - cost;
    var profitRate = settlement > 0 ? (settlement - cost) / settlement : null;
    var keep = 1 - C.num(input.refundRate) / 100;
    var roi = (profitRate != null && profitRate > 0 && keep > 0) ? 1 / profitRate / keep : null;
    var unitList = packs > 0 ? listPrice / packs : null;
    var unitSale = packs > 0 ? salePrice / packs : null;

    var rateTxt = (targetRate > 0) ? (targetRate.toFixed(2) + "%") : "保本";
    var loss = profitRate != null && profitRate < 0;

    out.innerHTML =
      '<div class="stat-row">' +
      stat("需定价（原价）", m2(listPrice) + " 元", "单包 " + m2(unitList) + " 元") +
      stat("折后售价（" + C.discountLabel(discount) + "）", m2(salePrice) + " 元", "单包 " + m2(unitSale) + " 元") +
      stat("目标利润率", rateTxt, "目标折扣 " + C.discountLabel(discount) + " 下达成") +
      stat("结算价", m2(settlement) + " 元", "折后价 − 成本 × 合计费比 " + pct(sum.totalRate)) +
      stat("单包利润", m2(profitAmount / packs) + " 元", "合计利润 " + m2(profitAmount) + " 元") +
      stat("实际利润率", pct(profitRate), loss ? "低于成本，亏损" : "按当前定价计算") +
      stat("保本 ROI", roi == null ? "—" : roi.toFixed(2), "退款率 " + pct(C.num(input.refundRate) / 100)) +
      "</div>" +
      '<div class="hint" style="margin-top:10px">' +
      "含百补综合扣点 " + pct(sum.combinedSubsidy) + "，计提费比 " + pct(C.num(input.accrualRate) / 100) +
      "，合计费比 " + pct(sum.totalRate) + "；标价 = 成本 × (费比 + 1÷(1−利润率)) ÷ 折扣率。折后价 = 标价 × 折扣率。" +
      "</div>";
  }

  function renderProfitList() {
    var container = $("profitList");
    if (!container) return;
    if (!profitInstances.length) {
      var first = defaultProfitInstance();
      profitInstances.push(first);
      activeProfitId = first.id;
    }
    if (!getProfitInstance(activeProfitId)) activeProfitId = profitInstances[0].id;

    // 联动模式下，同步当前激活实例的成本（成本测算变化时）
    var act = activeInstance();
    if (act && act.linkedPacks != null) {
      var linked = (rowsCache || []).filter(function (r) { return r.packs === act.linkedPacks && !r.over; })[0];
      if (linked) {
        act.packs = String(linked.packs);
        act.cost = C.money(linked.costWith, 2);
      } else {
        act.linkedPacks = null;
        renderTable(rowsCache, null);
      }
    }

    var html = profitInstances.map(function (p) {
      return renderProfitInstance(p);
    }).join("");
    container.innerHTML = html;

    // 绑定事件
    profitInstances.forEach(function (p) {
      ["packs", "cost", "salePrice", "targetRate", "platformRate", "blackRate", "subsidyRate", "accrualRate", "refundRate"].forEach(function (f) {
        var el = $("pi-" + p.id + "-" + f);
        if (el) {
          stopWheel(el);
          el.addEventListener("input", function () { onProfitFieldInput(p.id, f); });
        }
      });
      var nameEl = $("pi-" + p.id + "-name");
      if (nameEl) {
        nameEl.addEventListener("input", function () {
          p.name = nameEl.value;
          persistProfitInstances();
        });
      }
      // 折扣数值修改：写回 discounts，不重建 DOM（避免断输）
      bindDiscountInputs(p);
    });
  }

  /** 绑定折扣数值输入框：改动只写回数据 + 更新标签文字，不重建 DOM */
  function bindDiscountInputs(p) {
    var container = $("pi-" + p.id);
    if (!container || typeof container.querySelectorAll !== "function") return;
    var inputs = container.querySelectorAll(".discount-val");
    inputs.forEach(function (el) {
      var idx = parseInt(el.getAttribute("data-idx"), 10);
      var rates = (p.discounts && p.discounts.length) ? p.discounts : C.DISCOUNTS.slice();
      if (!el._bound) {
        el._bound = true;
        el.addEventListener("input", function () {
          var v = parseFloat(el.value);
          if (isNaN(v) || v <= 0 || v > 1) return;
          // 确保 discounts 独立数组
          if (!p.discounts || !p.discounts.length) p.discounts = C.DISCOUNTS.slice();
          p.discounts[idx] = v;
          persistProfitInstances();
          // 更新旁边标签
          var label = el.parentNode;
          if (label) {
            var span = label.querySelector(".discount-label");
            if (span) span.textContent = C.discountLabel(v);
          }
        });
      }
    });
  }

  /** 新增一个折扣到实例 */
  function addDiscount(id) {
    var p = getProfitInstance(id);
    if (!p) return;
    var input = $("pi-" + id + "-newDiscount");
    var v = input ? parseFloat(input.value) : NaN;
    if (isNaN(v) || v <= 0 || v > 1) { alert("请输入 0~1 之间的折扣值（如 0.66 表示 6.6 折）"); return; }
    if (!p.discounts || !p.discounts.length) p.discounts = C.DISCOUNTS.slice();
    p.discounts.push(v);
    p.discounts.sort(function (a, b) { return b - a; });
    persistProfitInstances();
    renderProfitList();
  }

  /** 删除实例某位置的折扣 */
  function removeDiscount(id, idx) {
    var p = getProfitInstance(id);
    if (!p) return;
    if (!p.discounts || !p.discounts.length) p.discounts = C.DISCOUNTS.slice();
    if (p.discounts.length <= 1) { alert("至少保留一个折扣档位"); return; }
    p.discounts.splice(idx, 1);
    persistProfitInstances();
    renderProfitList();
  }

  /** 恢复默认折扣档位 */
  function resetDiscounts(id) {
    var p = getProfitInstance(id);
    if (!p) return;
    p.discounts = null;
    persistProfitInstances();
    renderProfitList();
  }

  /** 渲染单个实例外壳（含输入区 + 结果区） */
  function renderProfitInstance(p) {
    var isActive = p.id === activeProfitId;
    var linkedTxt = p.linkedPacks != null ? "已联动明细 " + p.linkedPacks + " 包行" : "独立填写";
    var summary = p.result
      ? "原价 " + m2(p.result.rows[0].salePrice) + " 元 · 利润率 " + pct(p.result.rows[0].profitRate)
      : "未测算";
    return '<div class="profit-instance' + (isActive ? " active" : "") + (p.collapsed ? " collapsed" : "") + '" id="pi-' + p.id + '">' +
      '<div class="pi-head" onclick="setActiveProfit(\'' + p.id + '\'); toggleProfitCollapse(\'' + p.id + '\')">' +
      '<span class="pi-title">测算 ' + (profitInstances.indexOf(p) + 1) + "</span>" +
      (isActive ? '<span class="pi-badge">当前带入</span>' : "") +
      '<span class="pi-summary">' + esc(linkedTxt) + " · " + esc(summary) + "</span>" +
      '<span style="flex:1"></span>' +
      '<button class="ghost small" onclick="event.stopPropagation();removeProfitInstance(\'' + p.id + '\')">删除</button>' +
      "</div>" +
      '<div class="pi-body">' +
      '<div class="fields">' +
      fieldInput(p.id, "name", "备注名（可选）", p.name, "text") +
      fieldInput(p.id, "packs", "测算包数（包）", p.packs, "number", "1") +
      fieldInput(p.id, "cost", "成本/含快递费（元）", p.cost, "number", "0.01") +
      fieldInput(p.id, "salePrice", "售卖价（整单，元）", p.salePrice, "number", "0.01") +
      fieldInput(p.id, "targetRate", "目标利润率（%）", p.targetRate, "number", "0.01") +
      fieldInput(p.id, "platformRate", "平台扣点（%）", p.platformRate, "number", "0.01") +
      fieldInput(p.id, "blackRate", "黑标扣点（%）", p.blackRate, "number", "0.01") +
      fieldInput(p.id, "subsidyRate", "百补扣点（%）", p.subsidyRate, "number", "0.01") +
      fieldInput(p.id, "accrualRate", "计提费比（%）", p.accrualRate, "number", "0.01") +
      fieldInput(p.id, "refundRate", "退款率（%）", p.refundRate, "number", "0.01") +
      "</div>" +
      '<div class="pi-toolbar">' +
      '<button class="small" onclick="runProfitInstance(\'' + p.id + '\')">确定测算</button>' +
      '<span class="hint">' + esc(linkedTxt) + "</span>" +
      "</div>" +
      renderDiscountManager(p) +
      '<div id="pi-result-' + p.id + '" class="profit-result">' + renderProfitInstanceResultHtml(p) + "</div>" +
      "</div></div>";
  }

  /** 折扣增删改管理区：列出当前折扣，可改数值、删除、新增 */
  function renderDiscountManager(p) {
    var rates = (p.discounts && p.discounts.length) ? p.discounts : C.DISCOUNTS.slice();
    var chips = rates.map(function (r, i) {
      return '<div class="discount-chip">' +
        '<input class="discount-val" type="number" step="0.01" min="0.01" max="1" value="' + r + '"' +
        ' data-pi="' + p.id + '" data-idx="' + i + '">' +
        '<span class="discount-label">' + esc(C.discountLabel(C.num(r))) + "</span>" +
        '<button class="ghost small" onclick="removeDiscount(\'' + p.id + '\',' + i + ')">×</button>' +
        "</div>";
    }).join("");
    return '<div class="discount-manager">' +
      '<div class="dm-head">折扣明细（增删改，改后点「确定测算」生效）</div>' +
      '<div class="discount-chips">' + chips + "</div>" +
      '<div class="dm-toolbar">' +
      '<input id="pi-' + p.id + '-newDiscount" type="number" step="0.01" min="0.01" max="1" placeholder="如 0.66 或 0.9">' +
      '<button class="small" onclick="addDiscount(\'' + p.id + '\')">+ 添加折扣</button>' +
      '<button class="ghost small" onclick="resetDiscounts(\'' + p.id + '\')">恢复默认</button>' +
      "</div></div>";
  }

  function fieldInput(id, field, label, value, type, step) {
    var v = value == null ? "" : value;
    return '<label class="field">' + esc(label) +
      '<input id="pi-' + id + "-" + field + '" type="' + type + '"' +
      (step ? ' step="' + step + '"' : "") +
      ' value="' + esc(v) + '">' +
      "</label>";
  }

  /** 计算并写回某实例结果（纯数据，不触碰 DOM） */
  function computeProfitInstance(p) {
    var input = {
      salePrice: p.salePrice,
      targetRate: p.targetRate,
      platformRate: p.platformRate,
      blackRate: p.blackRate,
      subsidyRate: p.subsidyRate,
      accrualRate: p.accrualRate,
      refundRate: p.refundRate,
      profitCost: p.cost,
      discounts: (p.discounts && p.discounts.length) ? p.discounts : null
    };
    var packs = parseInt(p.packs, 10);
    var cost = parseFloat(p.cost);
    var valid = (rowsCache || []).filter(function (r) { return !r.over; });
    if (!(packs > 0) || isNaN(cost) || cost < 0 || !(parseFloat(p.salePrice) > 0)) {
      p.result = null;
      return;
    }
    var matched = valid.filter(function (r) { return r.packs === packs; })[0];
    var row = { packs: packs, costWith: cost, weight: matched ? matched.weight : null };
    var sum = C.profitSummary(input);
    var list = C.computeDiscountRows(row, input);
    if (!list.length) { p.result = null; return; }
    p.result = { packs: packs, weight: row.weight, cost: cost, rows: list, sum: sum };
  }

  function renderProfitInstanceResult(p) {
    computeProfitInstance(p);
    var el = $("pi-result-" + p.id);
    if (el) el.innerHTML = renderProfitInstanceResultHtml(p);
  }

  function runProfitInstance(id) {
    var p = getProfitInstance(id);
    if (!p) return;
    activeProfitId = id;
    renderProfitInstanceResult(p);
    persistProfitInstances();
    renderProfitList();
  }

  function renderProfitInstanceResultHtml(p) {
    if (!p.result) {
      return '<div class="hint" style="margin-top:8px">' +
        (parseFloat(p.salePrice) > 0 ? "填写包数与成本后点「确定测算」" : "填写包数、成本、售卖价后点「确定测算」") +
        "</div>";
    }
    var r = p.result;
    var wTxt = r.weight != null ? C.formatNum(r.weight, 3) + " kg · " : "";
    var first = r.rows[0];
    var body = r.rows.map(function (d) {
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
    var target = first.targetPrice;
    var targetTxt = target != null
      ? m2(target) + " 元（单包 " + m2(r.packs > 0 ? target / r.packs : null) + " 元）"
      : "—";
    return '<div class="profit-block" style="margin-top:10px">' +
      '<div class="profit-head">' + r.packs + " 包" +
      '<span class="sub">' + wTxt + "成本 " + m2(r.cost) + " 元 · 原价 " +
      m2(first.salePrice) + " 元（单包 " + m2(first.unitPrice) + " 元）</span></div>" +
      '<div class="stat-row" style="padding:10px 12px;background:#fafbfd">' +
      stat("保本售价", m2(first.breakEvenPrice) + " 元", "成本 × (1 + 合计费比 " + pct(r.sum.totalRate) + ")，低于此价亏损") +
      stat("目标利润率 " + (first.targetRate != null ? pct(first.targetRate) : "未填"),
        targetTxt,
        first.targetRate != null
          ? "按当前成本与费比反推；售价 = 成本 × (1 + 费比 − 利润率×费比) ÷ (1 − 利润率)"
          : "填写目标利润率后显示需定价") +
      "</div>" +
      '<div class="table-wrap"><table><thead><tr>' +
      "<th>折扣</th><th class=\"num\">整单价/元</th><th class=\"num\">单包价/元</th>" +
      "<th class=\"num\">结算价/元</th><th class=\"num\">利润额/元</th>" +
      "<th class=\"num\">利润率</th><th class=\"num\">保本ROI</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div></div>";
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
    // 当前激活实例联动的包数
    var act = activeInstance();
    var actLinked = act ? act.linkedPacks : null;
    var html = rows.map(function (r) {
      var cls = r.over ? "over" : (bestPacks === r.packs ? "best" : "");
      if (actLinked === r.packs) cls = (cls ? cls + " " : "") + "picked";
      var mark = bestPacks === r.packs ? '<span class="badge">最低</span>' : "";
      if (actLinked === r.packs) mark += '<span class="badge warn">已带入</span>';
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
    return ["测算编号", "备注", "包数", "克重/kg", "成本/含快递费", "折扣", "整单价/元", "单包价/元",
      "结算价/元", "利润额/元", "利润率", "保本ROI"];
  }

  /** 汇总所有已测算实例的结果行 */
  function profitBody() {
    var out = [];
    profitInstances.forEach(function (p) {
      if (!p.result) return;
      p.result.rows.forEach(function (d) {
        var profitAmount = d.settlement != null ? d.settlement - d.cost : null;
        out.push([
          profitInstances.indexOf(p) + 1,
          p.name || "",
          p.result.packs,
          p.result.weight != null ? C.formatNum(p.result.weight, 3) : "—",
          m2(p.result.cost),
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
    var body = profitBody();
    if (!body.length) return alert("请先对至少一个测算区点「确定测算」");
    var lines = [profitHeader().join(",")];
    body.forEach(function (row) {
      lines.push(row.map(function (v) {
        var t = String(v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }).join(","));
    });
    download("利润测算-" + stamp() + ".csv", "\uFEFF" + lines.join("\r\n"), "text/csv;charset=utf-8");
  }

  function exportProfitExcel() {
    var body = profitBody();
    if (!body.length) return alert("请先对至少一个测算区点「确定测算」");
    var head = "<tr>" + profitHeader().map(function (h) { return '<th style="background:#f0f3f7">' + esc(h) + "</th>"; }).join("") + "</tr>";
    var bodyHtml = body.map(function (row) {
      return "<tr>" + row.map(function (v) { return "<td>" + esc(v) + "</td>"; }).join("") + "</tr>";
    }).join("");
    var html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
      '<head><meta charset="utf-8"><style>td,th{border:1px solid #ccc;padding:4px 8px;font-family:"Microsoft YaHei";font-size:12px}</style></head>' +
      "<body><table><thead>" + head + "</thead><tbody>" + bodyHtml + "</tbody></table></body></html>";
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
      caseCost: $("caseCost").value
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
    if (Array.isArray(c.tiers) && c.tiers.length) {
      tiers = c.tiers.map(function (t) { return { max: t.max, fee: t.fee }; });
    }
    $("schemeName").value = name;
    // 换方案后清除所有利润实例的明细行联动
    profitInstances.forEach(function (p) { p.linkedPacks = null; });
    persistProfitInstances();
    renderTiers();
    renderCase();
    render();
    renderProfitList();
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

  /* ---------------- 区域折叠 ---------------- */
  var FOLD_KEY = "cost_calc_fold_v1";
  var SECTION_IDS = ["sec-params", "sec-tiers", "sec-case", "sec-summary", "sec-chart", "sec-detail", "sec-profit", "sec-price"];

  function readFold() {
    try {
      var v = JSON.parse(localStorage.getItem(FOLD_KEY) || "null");
      return v && typeof v === "object" ? v : {};
    } catch (e) { return {}; }
  }

  function writeFold(o) {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(o)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function isCollapsed(id) {
    var el = $(id);
    return !!el && (" " + el.className + " ").indexOf(" collapsed ") >= 0;
  }

  function setCollapsed(id, collapsed) {
    var el = $(id);
    if (!el) return;
    if (collapsed && !isCollapsed(id)) el.className = (el.className + " collapsed").trim();
    if (!collapsed && isCollapsed(id)) {
      el.className = el.className.replace(/\bcollapsed\b/g, "").replace(/\s+/g, " ").trim();
    }
  }

  /** 点击卡片标题：切换收起/展开，并记住状态 */
  function toggleSection(id) {
    var next = !isCollapsed(id);
    setCollapsed(id, next);
    var fold = readFold();
    fold[id] = next;
    writeFold(fold);
    updateFoldAllBtn();
  }

  /** 顶部按钮：有任一展开 → 全部收起；否则全部展开 */
  function toggleAllSections() {
    var anyOpen = SECTION_IDS.some(function (id) { return !isCollapsed(id); });
    var fold = {};
    SECTION_IDS.forEach(function (id) {
      setCollapsed(id, anyOpen);
      fold[id] = anyOpen;
    });
    writeFold(fold);
    updateFoldAllBtn();
  }

  function updateFoldAllBtn() {
    var btn = $("foldAllBtn");
    if (!btn) return;
    btn.textContent = SECTION_IDS.some(function (id) { return !isCollapsed(id); }) ? "收起全部" : "展开全部";
  }

  /** 初始化折叠状态：优先用上次记忆，无记忆时保持页面默认 */
  function initFold() {
    var fold = readFold();
    SECTION_IDS.forEach(function (id) {
      setCollapsed(id, id in fold ? !!fold[id] : isCollapsed(id));
    });
    updateFoldAllBtn();
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
        caseCost: $("caseCost").value
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
    tiers = Array.isArray(raw.tiers) && raw.tiers.length
      ? raw.tiers.map(function (t) { return { max: t.max, fee: t.fee }; })
      : C.DEFAULT_TIERS.map(function (t) { return { max: t.max, fee: t.fee }; });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    checkVersion();
    initFold();

    // 所有数字输入框禁用滚轮改值，避免滚动页面时误改参数（成本测算参数区）
    [
      "unitWeight", "baseCost", "count",
      "casePacks", "caseWeight", "caseCost",
      "lpPacks", "lpCost", "lpDiscount", "lpTargetRate",
      "lpPlatformRate", "lpBlackRate", "lpSubsidyRate", "lpAccrualRate", "lpRefundRate"
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

    // 标价反推板块：手动改包数或成本 → 解除联动
    ["lpPacks", "lpCost"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        if (lpLinkedPacks != null) {
          lpLinkedPacks = null;
          renderLpLinkState();
        }
      });
    });

    // 利润测算多实例：加载历史实例，没有则建一个默认实例
    var saved = loadProfitInstances();
    if (saved) {
      profitInstances = saved;
    } else {
      var first = defaultProfitInstance();
      profitInstances = [first];
    }
    activeProfitId = profitInstances[0].id;

    // 暴露给内联 onclick
    window.addTier = addTier;
    window.removeTier = removeTier;
    window.resetTiers = resetTiers;
    window.applyCase = applyCase;
    window.pickRowFromCost = pickRowFromCost;
    window.runProfit = runProfit;
    window.addProfitInstance = addProfitInstance;
    window.removeProfitInstance = removeProfitInstance;
    window.setActiveProfit = setActiveProfit;
    window.toggleProfitCollapse = toggleProfitCollapse;
    window.runProfitInstance = runProfitInstance;
    window.addDiscount = addDiscount;
    window.removeDiscount = removeDiscount;
    window.resetDiscounts = resetDiscounts;
    window.runListPrice = runListPrice;
    window.toggleSection = toggleSection;
    window.toggleAllSections = toggleAllSections;
    window.saveScheme = saveScheme;
    window.loadScheme = loadScheme;
    window.deleteScheme = deleteScheme;
    window.exportCsv = exportCsv;
    window.exportExcel = exportExcel;
    window.exportProfitCsv = exportProfitCsv;
    window.exportProfitExcel = exportProfitExcel;

    // 供测试与调试读取的只读状态接口
    window.__profitState = function () {
      return {
        instances: profitInstances.map(function (p) {
          return { id: p.id, name: p.name, packs: p.packs, cost: p.cost, linkedPacks: p.linkedPacks, discounts: p.discounts, hasResult: !!p.result };
        }),
        activeId: activeProfitId
      };
    };

    renderCase();
    render();
    renderProfitList();
    renderLpLinkState();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
