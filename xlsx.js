/* xlsx.js —— 极简 xlsx 读写（零第三方依赖）
 * 读：解析 ZIP（store / deflate-raw）+ 工作表 XML
 * 写：生成 store 模式 ZIP + inlineStr 工作表（Excel / WPS 可直接打开）
 * 暴露到 window.Xlsx
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Xlsx = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 解压实现可注入：浏览器用 DecompressionStream，测试环境注入 zlib */
  var _inflate = null;
  function setInflater(fn) { _inflate = fn; }

  /* ---------------- 基础工具 ---------------- */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function utf8Encode(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var bin = unescape(encodeURIComponent(str));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }

  function crc32(bytes) {
    var t = crcTable(), c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&amp;/g, "&");
  }

  function xmlEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function colToIdx(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  function idxToCol(idx) {
    var s = "", n = idx + 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /* ---------------- 解压 ---------------- */
  async function inflateRaw(data) {
    if (_inflate) return await _inflate(data);
    if (typeof DecompressionStream === "undefined") {
      throw new Error("当前浏览器不支持 xlsx 解压，请把表格另存为 CSV 后导入");
    }
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([data]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* ---------------- 读 ZIP ---------------- */
  function readEntries(bytes) {
    var eocd = -1;
    var min = Math.max(0, bytes.length - 66000);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("不是有效的 xlsx 文件（缺少 ZIP 结构）");

    var count = u16(bytes, eocd + 10);
    var off = u32(bytes, eocd + 16);
    var list = [];
    for (var k = 0; k < count; k++) {
      if (u32(bytes, off) !== 0x02014b50) break;
      var method = u16(bytes, off + 10);
      var compSize = u32(bytes, off + 20);
      var nameLen = u16(bytes, off + 28);
      var extraLen = u16(bytes, off + 30);
      var cmtLen = u16(bytes, off + 32);
      var localOff = u32(bytes, off + 42);
      var name = utf8Decode(bytes.subarray(off + 46, off + 46 + nameLen));
      var dataStart = localOff + 30 + u16(bytes, localOff + 26) + u16(bytes, localOff + 28);
      list.push({ name: name, method: method, data: bytes.subarray(dataStart, dataStart + compSize) });
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return list;
  }

  async function entryText(entry) {
    var raw = entry.method === 0 ? entry.data : await inflateRaw(entry.data);
    return utf8Decode(raw);
  }

  /* ---------------- 读工作表 ---------------- */
  async function read(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var entries = readEntries(bytes);
    var map = {};
    entries.forEach(function (e) { map[e.name] = e; });

    // 共享字符串
    var shared = [];
    if (map["xl/sharedStrings.xml"]) {
      var ss = await entryText(map["xl/sharedStrings.xml"]);
      var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      var m;
      while ((m = siRe.exec(ss))) {
        var texts = [], tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g, t;
        while ((t = tRe.exec(m[1]))) texts.push(decodeXml(t[1]));
        shared.push(texts.join(""));
      }
    }

    // 第一个工作表
    var sheetName = "xl/worksheets/sheet1.xml";
    if (!map[sheetName]) {
      var cand = Object.keys(map)
        .filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); })
        .sort()[0];
      if (!cand) throw new Error("Excel 文件中找不到工作表");
      sheetName = cand;
    }
    var xml = await entryText(map[sheetName]);

    var rows = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while ((rm = rowRe.exec(xml))) {
      var row = [];
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      var cm;
      while ((cm = cellRe.exec(rm[1]))) {
        var attr = cm[1] || "";
        var inner = cm[2] || "";
        var refM = /\br="([A-Z]+)\d+"/.exec(attr);
        var ci = refM ? colToIdx(refM[1]) : row.length;
        var tm = /\bt="([^"]+)"/.exec(attr);
        var type = tm ? tm[1] : "n";
        var val = "";
        if (type === "inlineStr") {
          var im = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          val = im ? decodeXml(im[1]) : "";
        } else {
          var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          var raw = vm ? decodeXml(vm[1]) : "";
          val = type === "s" ? (shared[parseInt(raw, 10)] || "") : raw;
        }
        while (row.length < ci) row.push("");
        row[ci] = val;
      }
      rows.push(row);
    }
    return rows;
  }

  /* ---------------- 写 xlsx ---------------- */
  function cellXml(ref, value) {
    if (value === "" || value == null) return "";
    if (typeof value === "number" && isFinite(value)) {
      return '<c r="' + ref + '"><v>' + value + "</v></c>";
    }
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(value) + "</t></is></c>";
  }

  function sheetXml(rows) {
    var parts = [];
    (rows || []).forEach(function (row, ri) {
      var cells = "";
      (row || []).forEach(function (v, ci) {
        cells += cellXml(idxToCol(ci) + (ri + 1), v);
      });
      parts.push('<row r="' + (ri + 1) + '">' + cells + "</row>");
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      "<sheetData>" + parts.join("") + "</sheetData></worksheet>";
  }

  function buildZip(files) {
    var local = [], central = [], offset = 0;

    files.forEach(function (f) {
      var nameB = utf8Encode(f.name);
      var data = f.data instanceof Uint8Array ? f.data : utf8Encode(String(f.data));
      var crc = crc32(data);

      var lh = new Uint8Array(30 + nameB.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameB.length, true);
      lh.set(nameB, 30);

      var ch = new Uint8Array(46 + nameB.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameB, 46);

      local.push(lh, data);
      central.push(ch);
      offset += lh.length + data.length;
    });

    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var all = local.concat(central).concat([eocd]);
    var total = all.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total);
    var p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  function build(rows, sheetName) {
    var files = [
      {
        name: "[Content_Types].xml",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          "</Types>"
      },
      {
        name: "_rels/.rels",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>"
      },
      {
        name: "xl/workbook.xml",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="' + xmlEscape(sheetName || "Sheet1") + '" sheetId="1" r:id="rId1"/></sheets>' +
          "</workbook>"
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          "</Relationships>"
      },
      { name: "xl/worksheets/sheet1.xml", data: sheetXml(rows) }
    ];
    return buildZip(files);
  }

  return {
    read: read,
    build: build,
    setInflater: setInflater,
    colToIdx: colToIdx,
    idxToCol: idxToCol,
    xmlEscape: xmlEscape,
    decodeXml: decodeXml,
    crc32: crc32
  };
});
