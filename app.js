/* 小安的手术配合知识库 — 三层路由：首页科别 → 科别详情 → 文章 */
(function () {
  "use strict";

  var DATA = window.KB_DATA || { meta: {}, pages: {}, tree: [] };
  var pages = DATA.pages, tree = DATA.tree, meta = DATA.meta;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var body = document.body;
  var homeEl = $("#home"), deptDetailEl = $("#deptDetail"), pageViewEl = $("#pageView");
  var deptGridEl = $("#deptGrid"), deptHeaderEl = $("#deptHeader"),
      deptListEl = $("#deptList"), deptEmptyEl = $("#deptEmpty"),
      deptSearchEl = $("#deptSearch"), deptTypeEl = $("#deptTypeFilter");
  var navEl = $("#nav"), mobileNavEl = $("#mobileNav"),
      articleEl = $("#article"), overlay = $("#overlay");

  /* ====== 树关系 ====== */
  var parentOf = {}, childOf = {}, iconOf = {}, isSpecialty = {};
  (function walk(nodes, parent) {
    nodes.forEach(function (n) {
      if (n.id) {
        if (parent) parentOf[n.id] = parent.id;
        if (n.icon) iconOf[n.id] = n.icon;
      }
      if (n.children) {
        if (n.id) childOf[n.id] = n.children.map(function (c) { return c.id; });
        walk(n.children, n.id);
      }
    });
  })(tree);
  // 标记"科别"节点（有 icon 且 title 是外科/产科/妇科）
  tree.forEach(function (n) {
    if (n.icon && /外科|产科|妇科/.test(n.title)) isSpecialty[n.id] = true;
  });

  var SPECIALTY_ORDER = ["产科", "妇科", "关节外科", "神经外科", "泌尿外科",
                         "胃肠外科", "胸外科", "脊柱外科", "一些资料",
                         "达芬奇机器人操作教学视频"];
  var specialties = tree.filter(function (n) { return n.icon && pages[n.id]; });
  // 按指定顺序排
  specialties.sort(function (a, b) {
    return SPECIALTY_ORDER.indexOf(a.title) - SPECIALTY_ORDER.indexOf(b.title);
  });

  function ancestorsOf(id) {
    var arr = [], cur = parentOf[id];
    while (cur) { arr.unshift(cur); cur = parentOf[cur]; }
    return arr;
  }
  function rootSpecialty(id) {
    var anc = ancestorsOf(id);
    for (var i = anc.length - 1; i >= 0; i--) {
      if (isSpecialty[anc[i]]) return anc[i];
    }
    // fallback: 找有 icon 的祖先
    for (var j = anc.length - 1; j >= 0; j--) {
      if (iconOf[anc[j]]) return anc[j];
    }
    return anc[0] || id;
  }
  function pageRoot(id) { return rootSpecialty(id); }

  function countPages(nodeId) {
    var c = 0, stack = [nodeId], seen = {};
    while (stack.length) {
      var nid = stack.pop();
      if (seen[nid]) continue; seen[nid] = true;
      if (pages[nid] && !(childOf[nid] && childOf[nid].length)) c++;
      (childOf[nid] || []).forEach(function (k) { stack.push(k); });
    }
    return c;
  }

  /* ====== 页面元数据 ====== */
  var NOISE = /请按实际术式填写|勾选项使用|^untitled$/i;
  function makeDesc(text, title) {
    var lines = String(text || "").split("\n"), out = [];
    for (var i = 0; i < lines.length && out.join("").length < 90; i++) {
      var ln = lines[i].replace(/\s+/g, " ").trim();
      if (ln.length < 8) continue; if (NOISE.test(ln)) continue;
      if (title && (ln === title || ln.indexOf(title) === 0 && ln.length < title.length + 4)) continue;
      out.push(ln);
    }
    var s = out.join(" ").trim();
    if (s.length > 78) s = s.slice(0, 78) + "…";
    return s;
  }

  function classify(p) {
    var t = p.title || "", tags = p.tags || [];
    if (tags.indexOf("器械图谱") >= 0 || /器械|图谱/.test(t)) return "器械图谱";
    if (tags.indexOf("手术视频") >= 0) return "手术视频";
    if (tags.indexOf("体位垫") >= 0 || /体位/.test(t)) return "体位摆放";
    if (tags.indexOf("手术笔记") >= 0 || /术$|切除|置换|修补|内固定|镜|成形|重建|取出|造口|剖宫产|肌瘤|囊肿/.test(t)) return "手术笔记";
    if (/图片库/.test(t)) return "图片库";
    if (/电子书|收费标准/.test(t)) return "参考资料";
    return "参考资料";
  }
  var typeOrder = ["手术笔记", "器械图谱", "手术视频", "体位摆放", "图片库", "参考资料"];
  var typeIcon = { "手术笔记": "📝", "器械图谱": "🔧", "手术视频": "🎬", "体位摆放": "🛏️", "图片库": "🖼️", "参考资料": "📄" };

  var pageMeta = {};
  Object.keys(pages).forEach(function (id) {
    var p = pages[id], html = p.html || "";
    var imgs = (html.match(/<img\b/gi) || []).length;
    var vids = (html.match(/<video\b/gi) || []).length;
    var deptId = pageRoot(id);
    var dept = pages[deptId] ? pages[deptId].title : "通用资料";
    var type = classify(p);
    var tags = (p.tags || []).filter(function (t) { return t !== "科别"; });
    pageMeta[id] = {
      id: id, title: p.title || "未命名", dept: dept, deptId: deptId,
      type: type, imgs: imgs, vids: vids, chars: (p.text || "").length,
      desc: makeDesc(p.text, p.title) || dept + " · " + type,
      tags: tags, icon: iconOf[id] || iconOf[deptId] || typeIcon[type] || "📄"
    };
  });

  // 汇总
  var totalImgs = 0, totalVids = 0;
  Object.values(pageMeta).forEach(function (m) { totalImgs += m.imgs; totalVids += m.vids; });
  var totalPages = Object.keys(pages).length;
  $("#heroLede").innerHTML =
    "当前收录 <strong>" + totalPages + "</strong> 篇手术配合资料，覆盖 <strong>" +
    specialties.length + "</strong> 个专科，含 <strong>" + totalImgs + "</strong> 张图片与 <strong>" +
    totalVids + "</strong> 段手术视频。点击科别卡片进入浏览。";
  $("#footerNote").textContent =
    "共 " + totalPages + " 篇资料 · " + totalImgs + " 图 · " + totalVids +
    " 视频 · 整理自 " + (meta.source || "Notion 知识库");

  /* ====== 首页：科别卡片 ====== */
  function renderHome() {
    homeEl.hidden = false; deptDetailEl.hidden = true; pageViewEl.hidden = true;
    body.className = ""; closeNav();

    deptGridEl.innerHTML = specialties.map(function (n) {
      var cnt = countPages(n.id);
      return '<a class="dept-card anim-in" href="#/d/' + n.id + '">' +
        '<div class="dept-illustration">' + (n.icon || "📁") + "</div>" +
        "<h3>" + esc(n.title) + "</h3>" +
        "<p>共 <b>" + cnt + "</b> 篇资料</p>" +
        '<span class="dept-more">浏览资料 →</span>' +
        "</a>";
    }).join("");
    // 入场动画：逐张上浮（延迟按索引递增）
    Array.prototype.forEach.call(deptGridEl.querySelectorAll(".anim-in"), function (el, i) {
      el.style.animationDelay = (i * 70) + "ms";
    });
  }

  /* ====== 科别详情页 ====== */
  var currentDept = null;
  function renderDept(id) {
    var deptPage = pages[id];
    if (!deptPage) { showHome(); return; }
    currentDept = id;
    homeEl.hidden = true; deptDetailEl.hidden = false; pageViewEl.hidden = true;
    body.className = ""; closeNav();

    deptHeaderEl.innerHTML =
      '<p class="eyebrow">' + esc(deptPage.title) + "</p>" +
      "<h1>" + esc(deptPage.title) + " · 手术配合资料</h1>" +
      "<p>以下为该科别下的所有手术配合笔记、器械图谱、教学视频与参考资料。</p>";

    // 收集该科别下所有叶子页面
    var items = [];
    function collect(nodeId) {
      var kids = childOf[nodeId] || [];
      if (kids.length) kids.forEach(collect);
      else if (pages[nodeId] && pageMeta[nodeId]) items.push(pageMeta[nodeId]);
    }
    if (childOf[id]) childOf[id].forEach(collect);
    else {
      // 科别节点本身没有子节点？直接收
      items.push(pageMeta[id]);
    }
    items.sort(function (a, b) { return a.title.localeCompare(b.title, "zh"); });

    // 类型下拉
    var types = [];
    items.forEach(function (it) { if (types.indexOf(it.type) < 0) types.push(it.type); });
    types.sort(function (a, b) { return typeOrder.indexOf(a) - typeOrder.indexOf(b); });
    deptTypeEl.innerHTML = '<option value="">全部类型</option>' +
      types.map(function (t) { return '<option value="' + esc(t) + '">' + t + "</option>"; }).join("");

    window.__deptItems = items;
    applyDeptFilter();
  }

  function applyDeptFilter() {
    var q = deptSearchEl.value.trim().toLowerCase();
    var t = deptTypeEl.value;
    var list = window.__deptItems || [];
    if (q) list = list.filter(function (it) {
      return it.title.toLowerCase().indexOf(q) >= 0 ||
             it.desc.toLowerCase().indexOf(q) >= 0;
    });
    if (t) list = list.filter(function (it) { return it.type === t; });

    deptListEl.innerHTML = list.map(function (it, i) {
      return '<a class="subpage-card anim-in" style="animation-delay:' + (i * 50) + 'ms" href="#/p/' + it.id + '">' +
        '<div class="sp-icon">' + it.icon + "</div>" +
        '<div class="sp-body"><h4>' + esc(it.title) + "</h4>" +
        "<p>" + esc(it.desc) + "</p></div>" +
        '<div class="sp-meta">' +
          '<span class="sp-badge">' + esc(it.type) + "</span>" +
          (it.imgs ? '<span class="sp-badge">' + it.imgs + " 图</span>" : "") +
          (it.vids ? '<span class="sp-badge">' + it.vids + " 视频</span>" : "") +
        "</div>" +
        '<span class="sp-arrow">→</span>' +
        "</a>";
    }).join("");
    deptEmptyEl.hidden = list.length > 0;
    deptListEl.hidden = list.length === 0;
  }
  deptSearchEl.addEventListener("input", applyDeptFilter);
  deptTypeEl.addEventListener("change", applyDeptFilter);

  /* ====== 侧边目录（桌面文章页 + 移动端全局抽屉） ====== */
  function renderNav() {
    navEl.innerHTML = "";
    mobileNavEl.innerHTML = "";
    var frag = document.createDocumentFragment();
    tree.forEach(function (n) { frag.appendChild(renderNode(n, 0)); });
    navEl.appendChild(frag.cloneNode(true));
    mobileNavEl.appendChild(frag);
  }
  function renderNode(node, depth) {
    if (node.children && node.children.length) {
      var wrap = document.createElement("div");
      wrap.className = "nav-group";
      var head = document.createElement("div");
      head.className = "nav-head";
      var tog = document.createElement("button");
      tog.className = "nav-toggle"; tog.type = "button";
      tog.textContent = "▶"; tog.setAttribute("aria-label", "展开或收起");
      var label;
      if (node.id && pages[node.id]) {
        label = document.createElement("a");
        label.className = "nav-head-link"; label.href = "#/p/" + node.id;
        label.dataset.pid = node.id;
      } else {
        label = document.createElement("span");
        label.className = "nav-head-title";
      }
      label.innerHTML = (node.icon ? '<span class="nav-icon">' + node.icon + "</span>" : "") + esc(node.title);
      head.appendChild(tog); head.appendChild(label);
      var kids = document.createElement("div");
      kids.className = "nav-children";
      node.children.forEach(function (c) { kids.appendChild(renderNode(c, depth + 1)); });
      tog.addEventListener("click", function (e) { e.stopPropagation(); wrap.classList.toggle("open"); });
      wrap.appendChild(head); wrap.appendChild(kids);
      return wrap;
    }
    var a = document.createElement("a");
    a.className = "nav-leaf"; a.href = "#/p/" + node.id;
    a.textContent = node.title; a.dataset.pid = node.id;
    return a;
  }

  /* ====== 文章页 ====== */
  function showPage(id) {
    var p = pages[id];
    if (!p) { showHome(); return; }
    homeEl.hidden = true; deptDetailEl.hidden = true; pageViewEl.hidden = false;
    body.className = ""; closeNav();

    var deptId = pageRoot(id);
    var deptTitle = pages[deptId] ? pages[deptId].title : "";
    var chain = ancestorsOf(id);
    var crumb = '<a href="#/">资料目录</a>' +
      (deptId ? '<span class="sep">/</span><a href="#/d/' + deptId + '">' + esc(deptTitle) + "</a>" : "") +
      chain.filter(function (aid) { return aid !== deptId; }).map(function (aid) {
        return pages[aid] ? '<span class="sep">/</span><a href="#/p/' + aid + '">' + esc(pages[aid].title) + "</a>" : "";
      }).join("");

    var m = pageMeta[id];
    var chips = m ? [m.type].concat(m.tags).map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("") +
      (m.imgs ? "<span>" + m.imgs + " 张图片</span>" : "") +
      (m.vids ? "<span>" + m.vids + " 段视频</span>" : "") : "";

    articleEl.innerHTML =
      '<div class="crumbs">' + crumb + "</div>" +
      '<header class="article-head">' +
        (m ? '<p class="eyebrow">' + esc(deptTitle) + "</p>" : "") +
        "<h1>" + esc(p.title) + "</h1>" +
        (chips ? '<div class="tag-row">' + chips + "</div>" : "") +
      "</header>" +
      '<div class="pv-body">' + p.html + "</div>" +
      (deptId ? '<a class="article-back-link" href="#/d/' + deptId + '">← 返回「' + esc(deptTitle) + "」</a>" : "");

    [navEl, mobileNavEl].forEach(function (nav) {
      Array.prototype.forEach.call(nav.querySelectorAll(".active"), function (n) { n.classList.remove("active"); });
      var cur = nav.querySelector('[data-pid="' + id + '"]');
      if (cur) cur.classList.add("active");
      chain.forEach(function (aid) {
        var el = nav.querySelector('.nav-head-link[data-pid="' + aid + '"]');
        var grp = el && el.closest(".nav-group");
        if (grp) grp.classList.add("open");
      });
      if (cur) {
        var g = cur.closest(".nav-group");
        while (g) { g.classList.add("open"); g = g.parentElement && g.parentElement.closest(".nav-group"); }
      }
    });
    window.scrollTo(0, 0);
  }

  /* ====== 导航交互 ====== */
  function openNav() { body.classList.add("nav-open"); }
  function closeNav() { body.classList.remove("nav-open"); }
  $("#menuBtn").addEventListener("click", openNav);
  overlay.addEventListener("click", closeNav);
  // 移动端抽屉里点链接后自动收起
  mobileNavEl.addEventListener("click", function (e) {
    if (e.target.closest("a")) closeNav();
  });

  /* ====== 路由 ====== */
  function route() {
    var h = location.hash || "";
    var pm = h.match(/^#\/p\/([^/]+)$/);
    if (pm && pages[pm[1]]) { showPage(pm[1]); return; }
    var dm = h.match(/^#\/d\/([^/]+)$/);
    if (dm && pages[dm[1]]) { renderDept(dm[1]); return; }
    renderHome();
  }
  window.addEventListener("hashchange", route);

  /* ====== 启动 ====== */
  if (meta.title) { document.title = meta.title; $("#brandTitle").textContent = meta.title; }
  renderNav();
  route();

  /* ====== PWA：离线缓存 + 添加主屏提示 ====== */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* 忽略 */ });
  }

  var deferredPrompt = null;
  var A2HS_KEY = "kb_a2hs_dismissed";
  var A2HS_SHOWN_KEY = "kb_a2hs_shown";
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var inStandalone = window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  function buildBanner(html) {
    var banner = document.createElement("div");
    banner.className = "a2hs-banner";
    banner.innerHTML =
      '<div class="a2hs-text">' + html + "</div>" +
      '<button type="button" class="a2hs-btn" id="a2hsInstall">知道了</button>' +
      '<button type="button" class="a2hs-close" id="a2hsClose" aria-label="关闭">×</button>';
    document.body.appendChild(banner);
    var installBtn = banner.querySelector("#a2hsInstall");
    var closeBtn = banner.querySelector("#a2hsClose");
    installBtn.addEventListener("click", function () {
      localStorage.setItem(A2HS_KEY, "1");
      banner.remove();
    });
    closeBtn.addEventListener("click", function () {
      localStorage.setItem(A2HS_KEY, "1");
      banner.remove();
    });
    return { banner: banner, installBtn: installBtn };
  }

  function showIOSGuide() {
    if (inStandalone) return;
    if (localStorage.getItem(A2HS_KEY)) return;
    var html =
      "<strong>装到手机，随时查</strong>" +
      "<span>① 点下方「分享」按钮 → ② 选「添加到主屏幕」<br />之后像 App 一样全屏打开，无需网络也能看</span>";
    var r = buildBanner(html);
    r.banner.querySelector(".a2hs-btn").textContent = "好";
  }

  function maybeShowA2HS() {
    if (inStandalone) return;
    if (localStorage.getItem(A2HS_KEY)) return;
    if (!deferredPrompt) return;
    if (localStorage.getItem(A2HS_SHOWN_KEY)) return;
    localStorage.setItem(A2HS_SHOWN_KEY, "1");
    var r = buildBanner(
      "<strong>装到手机，随时查</strong>" +
      "<span>添加到主屏幕后，像 App 一样全屏打开</span>"
    );
    r.installBtn.textContent = "添加";
    r.installBtn.addEventListener("click", function () {
      deferredPrompt.prompt();
    });
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowA2HS();
  });
  // iOS Safari 不支持 beforeinstallprompt，用首次访问提示手动添加
  if (isIOS && !inStandalone && !localStorage.getItem(A2HS_KEY)) {
    window.addEventListener("load", function () {
      setTimeout(showIOSGuide, 1200);
    });
  }
})();
