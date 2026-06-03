/**
 * 文档生成智能体 - 前端应用
 */
(function () {
  "use strict";

  // ── 状态 ────────────────────────────────────────────────────
  let sessionId = null;
  let outline = null;
  let chaptersContent = {};  // id -> markdown string
  let currentStep = 1;
  let generatingChapter = null;
  let generatingAbort = null;
  let selectedChapters = new Set();  // 多选章节集合

  // 文件上传状态
  let uploadedFiles = [];  // [{filename, text, length}]

  // 当前激活模型
  let activeModel = null;  // {base_url, api_key, model, display_name, model_type}

  // 表单快照（用于检测需求是否修改）
  let formSnapshot = null;  // 上次生成大纲时的表单值快照

  // ── DOM引用 ──────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── 工具函数 ──────────────────────────────────────────────────
  const BASE = "/doc-generation";

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${BASE}/api${path}`, opts);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || resp.statusText);
    }
    return resp.json();
  }

  function toast(msg, type = "info") {
    let container = $(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // 模型类型中文描述
  function modelTypeLabel(t) {
    const map = { qwen3: "Qwen3", qwen3x: "Qwen3.x", other: "通用" };
    return map[t] || t;
  }

  // ── 表单快照（检测需求是否修改） ──────────────────────────────
  function captureFormSnapshot() {
    return {
      topic: $("#inp-topic").value,
      docType: $("#inp-type").value,
      audience: $("#inp-audience").value,
      depth: $("#inp-depth").value,
      requirements: $("#inp-requirements").value,
      uploadedFilenames: uploadedFiles.map(f => f.filename).join(","),
    };
  }

  function isFormModified() {
    if (!formSnapshot) return false;
    const current = captureFormSnapshot();
    return current.topic !== formSnapshot.topic
      || current.docType !== formSnapshot.docType
      || current.audience !== formSnapshot.audience
      || current.depth !== formSnapshot.depth
      || current.requirements !== formSnapshot.requirements
      || current.uploadedFilenames !== formSnapshot.uploadedFilenames;
  }

  // ── 步骤切换 ──────────────────────────────────────────────────
  function setStep(step) {
    currentStep = step;
    $$(".panel").forEach((p) => p.classList.remove("active"));
    $(`#panel-${step}`).classList.add("active");
    $$(".step").forEach((s) => {
      const sn = parseInt(s.dataset.step);
      s.classList.remove("active", "completed");
      if (sn < step) s.classList.add("completed");
      if (sn === step) s.classList.add("active");
    });
  }

  // ── 会话管理 ──────────────────────────────────────────────────
  async function ensureSession() {
    if (!sessionId) {
      const data = await api("POST", "/session");
      sessionId = data.session_id;
    }
    return sessionId;
  }

  // ── 文件上传 ──────────────────────────────────────────────────
  function initUploadArea() {
    const uploadArea = $("#upload-area");
    const fileInput = $("#file-input");

    uploadArea.addEventListener("click", () => fileInput.click());
    uploadArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      uploadArea.classList.add("dragover");
    });
    uploadArea.addEventListener("dragleave", () => {
      uploadArea.classList.remove("dragover");
    });
    uploadArea.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadArea.classList.remove("dragover");
      if (e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) {
        handleFiles(fileInput.files);
        fileInput.value = "";
      }
    });
  }

  async function handleFiles(fileList) {
    for (const file of fileList) {
      // 检查是否已存在
      if (uploadedFiles.some(f => f.filename === file.name)) {
        toast(`文件 ${file.name} 已上传`, "info");
        continue;
      }

      const ext = file.name.split(".").pop().toLowerCase();
      const allowed = ["pdf", "doc", "docx", "txt", "md"];
      if (!allowed.includes(ext)) {
        toast(`不支持的格式: .${ext}`, "error");
        continue;
      }

      // 上传
      const formData = new FormData();
      formData.append("file", file);

      try {
        const resp = await fetch(`${BASE}/api/upload-file`, {
          method: "POST",
          body: formData,
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ detail: resp.statusText }));
          throw new Error(err.detail || "上传失败");
        }
        const data = await resp.json();
        uploadedFiles.push({
          filename: data.filename,
          text: data.text,
          length: data.length,
        });
        toast(`${data.filename} 上传成功（${data.length} 字）`, "success");
      } catch (err) {
        toast(`${file.name} 上传失败: ${err.message}`, "error");
      }
    }
    renderUploadedFiles();
  }

  function renderUploadedFiles() {
    const listEl = $("#upload-filelist");
    const placeholder = $("#upload-placeholder");

    if (uploadedFiles.length === 0) {
      placeholder.style.display = "";
      listEl.innerHTML = "";
      return;
    }
    placeholder.style.display = "none";
    listEl.innerHTML = "";

    uploadedFiles.forEach((f, idx) => {
      const item = document.createElement("div");
      item.className = "upload-file-item";
      const ext = f.filename.split(".").pop().toLowerCase();
      const iconMap = { pdf: "fa-file-pdf", doc: "fa-file-word", docx: "fa-file-word", txt: "fa-file-alt", md: "fa-file-code" };
      const icon = iconMap[ext] || "fa-file";
      item.innerHTML = `
        <i class="fas ${icon} file-icon"></i>
        <span class="file-name" title="${f.filename}">${f.filename}</span>
        <span class="file-size">${f.length} 字</span>
        <span class="file-status success"><i class="fas fa-check"></i></span>
        <button class="file-remove" data-idx="${idx}" title="移除"><i class="fas fa-times"></i></button>
      `;
      item.querySelector(".file-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        uploadedFiles.splice(idx, 1);
        renderUploadedFiles();
      });
      listEl.appendChild(item);
    });
  }

  function getCombinedRequirements() {
    const userText = $("#inp-requirements").value.trim();
    const fileTexts = uploadedFiles.map(f => `--- 文档：${f.filename} ---\n${f.text}`).join("\n\n");

    if (fileTexts && userText) {
      return fileTexts + "\n\n--- 用户补充需求 ---\n" + userText;
    }
    return fileTexts || userText;
  }

  // ── 第1步：需求收集 → 生成大纲 ────────────────────────────────
  async function handleGenerateOutline(e) {
    e.preventDefault();
    const topic = $("#inp-topic").value.trim();
    const docType = $("#inp-type").value;
    const audience = $("#inp-audience").value.trim();
    const depth = parseInt($("#inp-depth").value) || 3;
    const requirements = getCombinedRequirements();

    if (!topic) {
      toast("请填写文档主题", "error");
      return;
    }
    if (!requirements) {
      toast("请输入需求描述或上传需求文档", "error");
      return;
    }

    const btn = $("#btn-gen-outline");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 正在生成大纲...';

    try {
      const sid = await ensureSession();
      outline = await api("POST", "/generate-outline", {
        session_id: sid,
        topic,
        doc_type: docType,
        audience,
        requirements,
        depth,
      });
      // 保存表单快照
      formSnapshot = captureFormSnapshot();
      renderOutlineTree();
      setStep(2);
      toast("大纲生成成功！请检查并编辑后确认", "success");
    } catch (err) {
      toast("大纲生成失败: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magic"></i> 生成大纲';
    }
  }

  // ── 第2步：大纲树渲染与编辑 ────────────────────────────────────
  function renderOutlineTree() {
    const container = $("#outline-tree");
    container.innerHTML = "";
    if (!outline || !outline.chapters) return;
    outline.chapters.forEach((ch) => container.appendChild(createOutlineNode(ch, 0)));
  }

  function createOutlineNode(ch, depth) {
    const node = document.createElement("div");
    node.className = "outline-node";
    node.dataset.id = ch.id;

    const hasChildren = ch.children && ch.children.length > 0;
    const header = document.createElement("div");
    header.className = "outline-node-header";
    header.style.paddingLeft = `${16 + depth * 8}px`;

    const toggle = document.createElement("span");
    toggle.className = `outline-toggle ${hasChildren ? "expanded" : "empty"}`;
    toggle.innerHTML = '<i class="fas fa-chevron-right"></i>';
    if (hasChildren) {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const childrenEl = node.querySelector(":scope > .outline-children");
        toggle.classList.toggle("expanded");
        childrenEl.classList.toggle("collapsed");
      });
    }

    const idBadge = document.createElement("span");
    idBadge.className = "outline-id";
    idBadge.textContent = ch.id;

    const title = document.createElement("span");
    title.className = "outline-title";
    title.textContent = ch.title;
    title.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      title.contentEditable = "true";
      title.focus();
      const range = document.createRange();
      range.selectNodeContents(title);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    title.addEventListener("blur", () => {
      title.contentEditable = "false";
      ch.title = title.textContent.trim();
    });
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); title.blur(); }
    });

    const desc = document.createElement("span");
    desc.className = "outline-desc";
    desc.textContent = ch.description || "";

    const actions = document.createElement("div");
    actions.className = "outline-actions";
    const btnMoveUp = createOutlineBtn("fas fa-arrow-up", "上移", () => moveChapter(ch.id, -1), "move");
    const btnMoveDown = createOutlineBtn("fas fa-arrow-down", "下移", () => moveChapter(ch.id, 1), "move");
    const btnInsertBefore = createOutlineBtn("fas fa-level-up-alt", "在前面插入", () => openChapterModal(null, null, ch.id, "before"), "insert");
    const btnAdd = createOutlineBtn("fas fa-plus", "添加子章节", () => openChapterModal(ch.id), "add");
    const btnEdit = createOutlineBtn("fas fa-edit", "编辑", () => openChapterModal(null, ch));
    const btnMergeUp = createOutlineBtn("fas fa-compress-arrows-alt", "并入上级章节", () => mergeIntoParent(ch.id), "merge");
    const btnDel = createOutlineBtn("fas fa-trash", "删除", () => confirmDeleteChapter(ch.id, node), "danger");
    actions.append(btnMoveUp, btnMoveDown, btnInsertBefore, btnAdd, btnEdit, btnMergeUp, btnDel);
    header.append(toggle, idBadge, title, desc, actions);
    node.appendChild(header);

    if (hasChildren) {
      const childContainer = document.createElement("div");
      childContainer.className = "outline-children";
      ch.children.forEach((c) => childContainer.appendChild(createOutlineNode(c, depth + 1)));
      node.appendChild(childContainer);
    }

    return node;
  }

  function createOutlineBtn(iconClass, title, onClick, btnClass) {
    const btn = document.createElement("button");
    btn.className = "outline-action-btn" + (btnClass ? " " + btnClass : "");
    btn.title = title;
    btn.innerHTML = `<i class="${iconClass}"></i>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return btn;
  }

  function openChapterModal(parentId, editChapter, siblingId, insertMode) {
    const modal = $("#modal-chapter");
    if (editChapter) {
      $("#chapter-modal-title").textContent = "编辑章节";
      $("#ch-title").value = editChapter.title;
      $("#ch-description").value = editChapter.description || "";
      $("#ch-edit-id").value = editChapter.id;
      $("#ch-parent-id").value = "";
      $("#ch-sibling-id").value = "";
      $("#ch-insert-mode").value = "";
    } else if (siblingId && insertMode) {
      $("#chapter-modal-title").textContent = insertMode === "before" ? "在前面插入章节" : "在后面插入章节";
      $("#ch-title").value = "";
      $("#ch-description").value = "";
      $("#ch-edit-id").value = "";
      $("#ch-parent-id").value = "";
      $("#ch-sibling-id").value = siblingId;
      $("#ch-insert-mode").value = insertMode;
    } else {
      $("#chapter-modal-title").textContent = "添加子章节";
      $("#ch-title").value = "";
      $("#ch-description").value = "";
      $("#ch-edit-id").value = "";
      $("#ch-parent-id").value = parentId || "";
      $("#ch-sibling-id").value = "";
      $("#ch-insert-mode").value = "";
    }
    modal.classList.add("open");
    $("#ch-title").focus();
  }

  function closeChapterModal() {
    $("#modal-chapter").classList.remove("open");
  }

  function handleSaveChapter() {
    const title = $("#ch-title").value.trim();
    const desc = $("#ch-description").value.trim();
    const editId = $("#ch-edit-id").value;
    const parentId = $("#ch-parent-id").value;
    const siblingId = $("#ch-sibling-id").value;
    const insertMode = $("#ch-insert-mode").value;

    if (!title) { toast("请输入章节标题", "error"); return; }

    if (editId) {
      // 编辑现有章节
      const node = findChapterNode(outline.chapters, editId);
      if (node) { node.title = title; node.description = desc; }
    } else if (siblingId && insertMode) {
      // 在兄弟节点前/后插入
      const newChapter = { id: "", title, description: desc, children: [] };
      const result = findSiblingArrayAndIndex(outline.chapters, siblingId);
      if (result) {
        const insertIdx = insertMode === "before" ? result.index : result.index + 1;
        result.array.splice(insertIdx, 0, newChapter);
      }
    } else {
      // 添加子章节（到末尾）
      const newChapter = { id: "", title, description: desc, children: [] };
      if (parentId) {
        const parent = findChapterNode(outline.chapters, parentId);
        if (parent) {
          if (!parent.children) parent.children = [];
          parent.children.push(newChapter);
        }
      } else {
        outline.chapters.push(newChapter);
      }
    }

    renumberChapters(outline.chapters);
    renderOutlineTree();
    closeChapterModal();
  }

  // 行内确认删除：在节点下方显示确认条
  function confirmDeleteChapter(id, node) {
    // 如果已有确认条，先移除
    const existing = document.querySelector(".outline-delete-confirm");
    if (existing) existing.remove();

    const confirmBar = document.createElement("div");
    confirmBar.className = "outline-delete-confirm";
    confirmBar.innerHTML = `
      <span class="confirm-text">确定删除该章节及其所有子章节？</span>
      <div class="confirm-btns">
        <button class="btn btn-danger btn-sm confirm-yes">删除</button>
        <button class="btn btn-ghost btn-sm confirm-no">取消</button>
      </div>
    `;

    // 插入到该节点的 header 后面
    const header = node.querySelector(":scope > .outline-node-header");
    header.after(confirmBar);

    confirmBar.querySelector(".confirm-yes").addEventListener("click", (e) => {
      e.stopPropagation();
      doDeleteChapter(id);
    });
    confirmBar.querySelector(".confirm-no").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmBar.remove();
    });
  }

  function doDeleteChapter(id) {
    const removed = removeFromTree(outline.chapters, id);
    if (removed) {
      renumberChapters(outline.chapters);
      renderOutlineTree();
      toast("章节已删除", "success");
    } else {
      toast("未找到要删除的章节", "error");
    }
  }

  // 并入上级章节：将本章节（含所有子章节）的标题和描述合并到上级章节的描述中，然后删除本章节
  function mergeIntoParent(id) {
    // 找到本章节和其父节点
    const { parentArray, index } = findParentArrayAndIndex(outline.chapters, id);
    if (!parentArray) {
      toast("顶级章节无法并入上级", "error");
      return;
    }

    const chapter = parentArray[index];
    if (!chapter) return;

    // 收集本章节及其所有子章节的信息
    const mergedParts = [];
    function collectInfo(node, indent = 0) {
      const prefix = "  ".repeat(indent) + "- ";
      const title = node.title || "";
      const desc = node.description || "";
      if (desc) {
        mergedParts.push(`${prefix}${title}：${desc}`);
      } else {
        mergedParts.push(`${prefix}${title}`);
      }
      if (node.children && node.children.length > 0) {
        node.children.forEach(c => collectInfo(c, indent + 1));
      }
    }

    // 找到父章节节点
    const parentNode = findParentNode(outline.chapters, id);
    if (!parentNode) {
      toast("未找到上级章节", "error");
      return;
    }

    // 构建合并内容
    mergedParts.push(`包括${chapter.title}`);
    collectInfo(chapter, 0);

    // 追加到父章节的 description
    const parentDesc = (parentNode.description || "").trim();
    parentNode.description = parentDesc + "\n" + mergedParts.join("\n");

    // 从父章节的 children 中删除本章节
    const parentChildren = parentNode.children || [];
    const childIdx = parentChildren.findIndex(c => c.id === id);
    if (childIdx !== -1) {
      parentChildren.splice(childIdx, 1);
    }

    renumberChapters(outline.chapters);
    renderOutlineTree();
    toast(`已将"${chapter.title}"并入上级章节"${parentNode.title}"`, "success");
  }

  // 查找某个章节所在的数组及索引
  function findParentArrayAndIndex(chapters, id) {
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].id === id) {
        return { parentArray: chapters, index: i };
      }
      const children = chapters[i].children || [];
      if (children.length > 0) {
        const result = findParentArrayAndIndex(children, id);
        if (result) return result;
      }
    }
    return null;
  }

  // 查找某个章节的父节点
  function findParentNode(chapters, targetId) {
    for (const ch of chapters) {
      const children = ch.children || [];
      for (const child of children) {
        if (child.id === targetId) return ch;
      }
      if (children.length > 0) {
        const found = findParentNode(children, targetId);
        if (found) return found;
      }
    }
    return null;
  }

  // 移动章节：direction = -1 上移, +1 下移
  function moveChapter(id, direction) {
    const result = findSiblingArrayAndIndex(outline.chapters, id);
    if (!result) return;

    const { array, index } = result;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= array.length) return; // 边界

    // 交换
    const temp = array[index];
    array[index] = array[newIndex];
    array[newIndex] = temp;

    renumberChapters(outline.chapters);
    renderOutlineTree();
    toast(direction === -1 ? "已上移" : "已下移", "success");
  }

  function findChapterNode(chapters, id) {
    for (const ch of chapters) {
      if (ch.id === id) return ch;
      if (ch.children) {
        const found = findChapterNode(ch.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function findSiblingArrayAndIndex(chapters, id) {
    const idx = chapters.findIndex((c) => c.id === id);
    if (idx !== -1) return { array: chapters, index: idx };
    for (const ch of chapters) {
      if (ch.children) {
        const found = findSiblingArrayAndIndex(ch.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function removeFromTree(chapters, id) {
    const idx = chapters.findIndex((c) => c.id === id);
    if (idx !== -1) { chapters.splice(idx, 1); return true; }
    for (const ch of chapters) {
      if (ch.children && removeFromTree(ch.children, id)) return true;
    }
    return false;
  }

  function generateNewId(parentId) {
    if (!parentId) {
      return String(outline.chapters.length + 1);
    }
    const parent = findChapterNode(outline.chapters, parentId);
    if (parent && parent.children) {
      return `${parentId}.${parent.children.length + 1}`;
    }
    return `${parentId}.1`;
  }

  function renumberChapters(chapters, prefix = "") {
    chapters.forEach((ch, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      ch.id = num;
      if (ch.children && ch.children.length > 0) {
        renumberChapters(ch.children, num);
      }
    });
  }

  // ── 确认大纲，进入第3步 ──────────────────────────────────────
  async function handleConfirmOutline() {
    // 为每个非叶子节点的描述追加"包括"+下一级子标题
    function enrichParentDescriptions(chapters) {
      for (const ch of chapters) {
        const children = ch.children || [];
        if (children.length > 0) {
          const childTitles = children.map(c => c.title).join("、");
          const desc = (ch.description || "").trim();
          ch.description = desc ? `${desc}\n子标题：${childTitles}` : `子标题：${childTitles}`;
          enrichParentDescriptions(children);
        }
      }
    }
    enrichParentDescriptions(outline.chapters);

    // 保存编辑后的大纲
    try {
      await api("POST", `/update-outline?session_id=${sessionId}`, outline);
    } catch (err) {
      console.warn("保存大纲失败:", err);
    }

    // 生成全局上下文（整体摘要+大纲树）
    const btn = $("#btn-confirm-outline");
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 正在准备生成上下文...';

    try {
      const result = await api("POST", `/prepare-generation?session_id=${sessionId}`);
      toast("全局上下文已生成，可以开始生成章节内容", "success");
    } catch (err) {
      toast("全局上下文生成失败: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }

    renderChapterNav();
    setStep(3);
  }

  // ── 第3步：章节导航与内容生成 ──────────────────────────────────

  // 收集某节点及所有子孙节点的id
  function collectDescendantIds(node) {
    const ids = [node.id];
    if (node.children) {
      node.children.forEach(c => ids.push(...collectDescendantIds(c)));
    }
    return ids;
  }

  // 从树中找到节点（含children）
  function findChapterNodeInTree(chapters, id) {
    for (const ch of chapters) {
      if (ch.id === id) return ch;
      if (ch.children) {
        const found = findChapterNodeInTree(ch.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  // 更新侧边栏进度条
  function updateProgress() {
    const bar = $("#gen-progress-bar");
    if (!bar || !outline) return;
    const flat = flattenOutline(outline.chapters);
    const total = flat.length;
    const done = flat.filter(c => chaptersContent[c.id]).length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    bar.innerHTML = `<div class="progress-fill${pct >= 100 ? ' complete' : ''}" style="width:${pct}%"></div>`;

    // 更新"生成全文"按钮状态
    const btn = $("#btn-generate-all");
    if (btn) {
      const remaining = flat.filter(c => !chaptersContent[c.id] && generatingChapter !== c.id).length;
      if (remaining === 0) {
        btn.innerHTML = '<i class="fas fa-check"></i> 全部完成';
        btn.disabled = true;
        btn.className = "btn btn-success btn-sm";
      } else {
        btn.innerHTML = `<i class="fas fa-bolt"></i> 生成全文 (${remaining}章)`;
        btn.disabled = !!generatingChapter;
        btn.className = "btn btn-primary btn-sm";
      }
    }
  }

  // 一键生成全文
  async function handleGenerateAll() {
    if (generatingChapter) {
      toast("请等待当前章节生成完成", "error");
      return;
    }
    if (!outline) return;

    const flat = flattenOutline(outline.chapters);
    // 按大纲顺序收集所有未生成的章节
    const needGen = flat.filter(c => !chaptersContent[c.id]).map(c => c.id);

    if (needGen.length === 0) {
      toast("所有章节已生成", "info");
      return;
    }

    // 清除选择，进入批量生成
    selectedChapters = new Set(needGen);
    renderChapterNav();
    renderContentArea();
    await startBatchGenerate(needGen);
  }

  function renderChapterNav() {
    const nav = $("#chapter-nav");
    nav.innerHTML = "";
    const flat = flattenOutline(outline.chapters);
    flat.forEach((ch) => {
      const item = document.createElement("div");
      item.className = "nav-item" + (selectedChapters.has(ch.id) ? " selected" : "");
      item.dataset.id = ch.id;

      const indent = ch.id.split(".").length - 1;
      item.style.paddingLeft = `${12 + indent * 16}px`;

      const idSpan = document.createElement("span");
      idSpan.className = "nav-id";
      idSpan.textContent = ch.id;

      const titleSpan = document.createElement("span");
      titleSpan.className = "nav-title";
      titleSpan.textContent = ch.title;

      const statusSpan = document.createElement("span");
      statusSpan.className = "nav-status";
      if (generatingChapter === ch.id) {
        statusSpan.className = "nav-status generating";
        statusSpan.textContent = "生成中...";
      } else if (chaptersContent[ch.id]) {
        statusSpan.className = "nav-status done";
        statusSpan.innerHTML = '<i class="fas fa-check-circle"></i>';
      } else {
        statusSpan.className = "nav-status pending";
        statusSpan.innerHTML = '<i class="far fa-circle"></i>';
      }

      item.append(idSpan, titleSpan, statusSpan);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd+点击：选中该节点及所有子节点
          const node = findChapterNodeInTree(outline.chapters, ch.id);
          if (node) {
            const ids = collectDescendantIds(node);
            const allSelected = ids.every(id => selectedChapters.has(id));
            if (allSelected) {
              ids.forEach(id => selectedChapters.delete(id));
            } else {
              ids.forEach(id => selectedChapters.add(id));
            }
          }
        } else {
          // 普通点击：切换单个选中
          if (selectedChapters.has(ch.id)) {
            selectedChapters.delete(ch.id);
          } else {
            selectedChapters.add(ch.id);
          }
        }
        renderChapterNav();
        renderContentArea();
      });
      nav.appendChild(item);
    });
    updateProgress();
  }

  function flattenOutline(chapters, result = []) {
    chapters.forEach((ch) => {
      result.push({ id: ch.id, title: ch.title, description: ch.description || "" });
      if (ch.children) flattenOutline(ch.children, result);
    });
    return result;
  }

  function renderContentArea() {
    const area = $("#content-area");
    const flat = flattenOutline(outline.chapters);
    const selected = flat.filter(c => selectedChapters.has(c.id));

    if (selected.length === 0) {
      area.innerHTML = `
        <div class="content-empty">
          <i class="fas fa-hand-pointer" style="font-size:32px;color:var(--gray-300)"></i>
          <p style="color:var(--gray-400);margin-top:12px">请在左侧选择章节</p>
          <p style="color:var(--gray-300);font-size:12px">单击选择单个章节，Ctrl+点击选择章节及所有子章节</p>
        </div>
      `;
      return;
    }

    if (selected.length === 1) {
      // 单选
      const ch = selected[0];
      if (chaptersContent[ch.id]) {
        renderSingleContent(area, ch, chaptersContent[ch.id]);
      } else if (generatingChapter === ch.id) {
        // 正在生成，不更新
      } else {
        area.innerHTML = `
          <div class="content-header">
            <div>
              <h1 style="margin:0">${ch.title}</h1>
              <p style="margin:4px 0 0;color:var(--gray-500);font-size:14px">${ch.description}</p>
            </div>
            <button class="btn btn-primary" id="btn-start-gen">
              <i class="fas fa-play"></i> 生成本章内容
            </button>
          </div>
        `;
        $("#btn-start-gen").addEventListener("click", () => startBatchGenerate([ch.id]));
      }
      return;
    }

    // 多选
    const needGen = selected.filter(c => !chaptersContent[c.id] && generatingChapter !== c.id);
    const done = selected.filter(c => chaptersContent[c.id]);

    let listHtml = selected.map(c => {
      let statusIcon = "";
      if (chaptersContent[c.id]) {
        statusIcon = '<i class="fas fa-check-circle" style="color:var(--green-500)"></i>';
      } else if (generatingChapter === c.id) {
        statusIcon = '<i class="fas fa-spinner fa-spin" style="color:var(--primary)"></i>';
      } else {
        statusIcon = '<i class="far fa-circle" style="color:var(--gray-300)"></i>';
      }
      const clickable = chaptersContent[c.id] ? 'batch-item-clickable' : '';
      return `<div class="batch-item ${clickable}" data-chapter-id="${c.id}"><span class="batch-item-id">${c.id}</span> ${c.title} ${statusIcon}</div>`;
    }).join("");

    const btnText = needGen.length > 0
      ? `<i class="fas fa-play"></i> 生成${needGen.length}个章节内容`
      : '<i class="fas fa-check"></i> 全部已生成';

    area.innerHTML = `
      <div class="content-header">
        <div>
          <h1 style="margin:0">已选择 ${selected.length} 个章节</h1>
          <p style="margin:4px 0 0;color:var(--gray-500);font-size:14px">
            ${done.length} 个已生成 · ${needGen.length} 个待生成
          </p>
        </div>
        <button class="btn btn-primary" id="btn-start-gen" ${needGen.length === 0 ? 'disabled' : ''}>
          ${btnText}
        </button>
      </div>
      <div class="batch-list">${listHtml}</div>
      <div id="batch-output"></div>
    `;

    // 点击已完成的章节查看内容
    area.querySelectorAll(".batch-item-clickable").forEach(el => {
      el.addEventListener("click", () => {
        const chId = el.dataset.chapterId;
        const ch = flat.find(c => c.id === chId);
        if (ch && chaptersContent[chId]) {
          // 高亮当前选中项
          area.querySelectorAll(".batch-item").forEach(b => b.classList.remove("active"));
          el.classList.add("active");
          // 在下方显示内容
          const output = $("#batch-output");
          output.innerHTML = `
            <div class="batch-content-header">
              <h2>${ch.title}</h2>
              <button class="btn btn-ghost btn-sm" id="btn-regen-batch" data-id="${ch.id}">
                <i class="fas fa-redo"></i> 重新生成
              </button>
            </div>
            <div class="markdown-body">${renderMarkdown(chaptersContent[chId])}</div>
          `;
          const regenBtn = $("#btn-regen-batch");
          if (regenBtn) {
            regenBtn.addEventListener("click", () => {
              delete chaptersContent[chId];
              renderContentArea();
              startBatchGenerate([chId]);
            });
          }
        }
      });
    });

    if (needGen.length > 0) {
      $("#btn-start-gen").addEventListener("click", () => {
        startBatchGenerate(needGen.map(c => c.id));
      });
    }
  }

  function renderSingleContent(area, ch, content) {
    area.innerHTML = `
      <div class="content-header">
        <div>
          <h1 style="margin:0">${ch.title}</h1>
          <p style="margin:4px 0 0;color:var(--gray-500);font-size:14px">${ch.description}</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" id="btn-regen" data-id="${ch.id}">
            <i class="fas fa-redo"></i> 重新生成
          </button>
        </div>
      </div>
      <div class="gen-progress" id="gen-progress"></div>
      <div class="markdown-body" id="md-content"></div>
    `;
    const mdEl = $("#md-content");
    mdEl.innerHTML = renderMarkdown(content);

    const regenBtn = $("#btn-regen");
    if (regenBtn) {
      regenBtn.addEventListener("click", () => {
        delete chaptersContent[ch.id];
        selectedChapters = new Set([ch.id]);
        renderChapterNav();
        renderContentArea();
        startBatchGenerate([ch.id]);
      });
    }
  }

  let batchQueue = [];       // 批量生成队列
  let batchStopped = false;  // 是否已停止批量生成
  const BATCH_CHAPTER_DELAY = 3;  // 多章节间延迟秒数，让LLM服务端释放资源

  async function startBatchGenerate(chIds) {
    if (generatingChapter) {
      toast("请等待当前章节生成完成", "error");
      return;
    }

    // 按大纲顺序排序，确保从前到后生成（以便前章摘要可用）
    const flat = flattenOutline(outline.chapters);
    const orderMap = {};
    flat.forEach((c, i) => { orderMap[c.id] = i; });
    chIds.sort((a, b) => (orderMap[a] ?? 0) - (orderMap[b] ?? 0));

    if (chIds.length === 1) {
      // 单章节：直接流式生成
      await generateSingleChapter(chIds[0], 0);
    } else {
      // 多章节：逐个生成，章节间加入延迟
      batchQueue = [...chIds];
      batchStopped = false;
      for (let i = 0; i < batchQueue.length; i++) {
        if (batchStopped) break;
        // 第二个章节开始加入延迟，让LLM服务端释放资源
        const delay = i > 0 ? BATCH_CHAPTER_DELAY : 0;
        await generateSingleChapter(batchQueue[i], delay);
      }
      batchQueue = [];
      toast(batchStopped ? "批量生成已停止" : "批量生成全部完成", batchStopped ? "info" : "success");
      renderContentArea();
    }
  }

  async function generateSingleChapter(chId, preDelay) {
    generatingChapter = chId;
    renderChapterNav();
    renderContentArea();

    const area = $("#content-area");
    const flat = flattenOutline(outline.chapters);
    const ch = flat.find((c) => c.id === chId);

    area.innerHTML = `
      <div class="content-header">
        <div>
          <h1 style="margin:0">${ch.title}</h1>
          <p style="margin:4px 0 0;color:var(--gray-500);font-size:14px">${ch.description}</p>
        </div>
        <button class="btn btn-danger btn-sm" id="btn-stop-gen">
          <i class="fas fa-stop"></i> 停止
        </button>
      </div>
      <div class="gen-progress active" id="gen-progress"></div>
      <div class="markdown-body" id="md-content"></div>
    `;

    const stopBtn = $("#btn-stop-gen");
    stopBtn.addEventListener("click", () => {
      batchStopped = true;
      if (generatingAbort) generatingAbort.abort();
      finishGeneration(chId, false);
    });

    let fullContent = "";
    const mdEl = $("#md-content");

    try {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${BASE}/ws/generate-chapter`);
      generatingAbort = new AbortController();

      ws.onopen = () => {
        ws.send(JSON.stringify({
          session_id: sessionId,
          chapter_id: chId,
          min_words: 800,
          pre_delay: preDelay || 0,
        }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "token") {
          fullContent += data.content;
          mdEl.innerHTML = renderMarkdown(fullContent);
          mdEl.classList.add("typing-cursor");
          area.scrollTop = area.scrollHeight;
        } else if (data.type === "delay") {
          // 多章节间延迟提示
          mdEl.innerHTML = `<p style="color:var(--gray-400)"><i class="fas fa-hourglass-half"></i> 等待 ${data.seconds} 秒，释放服务端资源...</p>`;
          mdEl.classList.add("typing-cursor");
        } else if (data.type === "done") {
          ws.close();
          chaptersContent[chId] = fullContent;
          finishGeneration(chId, true);
        } else if (data.type === "error") {
          toast("生成失败: " + data.message, "error");
          ws.close();
          finishGeneration(chId, false);
        }
      };

      ws.onerror = () => {
        toast("WebSocket连接失败", "error");
        finishGeneration(chId, false);
      };

      ws.onclose = () => {
        if (generatingChapter === chId) {
          if (fullContent) {
            chaptersContent[chId] = fullContent;
          }
          finishGeneration(chId, !!fullContent);
        }
      };

    } catch (err) {
      toast("生成异常: " + err.message, "error");
      finishGeneration(chId, false);
    }
  }

  function finishGeneration(chId, success) {
    generatingChapter = null;
    generatingAbort = null;

    const progress = $("#gen-progress");
    if (progress) progress.classList.remove("active");

    const mdEl = $("#md-content");
    if (mdEl) mdEl.classList.remove("typing-cursor");

    renderChapterNav();
    updateProgress();

    if (batchQueue.length > 0 && !batchStopped) {
      // 批量模式中，继续下一个
      return;
    }

    if (success) {
      if (batchQueue.length === 0 && !batchStopped) {
        toast("章节内容生成完成", "success");
      }
    } else {
      if (!batchStopped) toast("章节生成已停止", "info");
    }

    if (batchQueue.length === 0) {
      renderContentArea();
    }
  }

  // ── Markdown简易渲染 ──────────────────────────────────────────
  function renderMarkdown(md) {
    if (!md) return "";
    let html = md
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
      .replace(/^[\-\*] (.+)$/gm, "<li>$1</li>")
      .replace(/^\d+[.、] (.+)$/gm, "<li>$1</li>")
      .replace(/^\|(.+)\|$/gm, (match, content) => {
        const cells = content.split("|").map(c => c.trim());
        if (cells.every(c => /^[\-:]+$/.test(c))) return "";
        const tag = "td";
        return `<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      });

    html = html.replace(/((<tr>.*<\/tr>\n?)+)/g, "<table>$1</table>");
    html = html.replace(/((<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
    html = html.replace(/\n{2,}/g, "</p><p>");
    html = `<p>${html}</p>`;
    html = html.replace(/<p>\s*<\/p>/g, "");
    html = html.replace(/<p>\s*(<h[1-4]|<pre|<ul|<ol|<blockquote|<table)/g, "$1");
    html = html.replace(/(<\/h[1-4]>|<\/pre>|<\/ul>|<\/ol>|<\/blockquote>|<\/table>)\s*<\/p>/g, "$1");

    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── 导出DOCX ──────────────────────────────────────────────────
  let exportSelectedChapters = new Set();  // 导出弹窗中选中的一级目录id

  function handleExport() {
    if (!sessionId) { toast("无活动会话", "error"); return; }
    exportSelectedChapters = new Set();
    renderExportModal();
    $("#modal-export").classList.add("open");
  }

  function renderExportModal() {
    const flat = flattenOutline(outline.chapters);
    const total = flat.length;
    const done = flat.filter(c => chaptersContent[c.id]).length;
    const allDone = done === total;

    // 全文导出
    const btnFull = $("#btn-export-full");
    const descFull = $("#export-full-desc");
    if (allDone) {
      descFull.textContent = `全部 ${total} 个章节已生成，可导出完整文档`;
      descFull.classList.remove("warning");
      btnFull.disabled = false;
    } else {
      descFull.textContent = `还有 ${total - done} 个章节未生成，无法全文导出`;
      descFull.classList.add("warning");
      btnFull.disabled = true;
    }

    // 一级目录列表
    const topChapters = (outline.chapters || []);
    const listEl = $("#export-chapters-list");
    listEl.innerHTML = "";

    const exportable = [];  // 可导出的一级目录

    topChapters.forEach(ch => {
      // 收集该一级目录下所有节点（含自身）
      const allIds = collectDescendantIds(ch);
      const allGenerated = allIds.every(id => chaptersContent[id]);
      const generatedCount = allIds.filter(id => chaptersContent[id]).length;

      const item = document.createElement("div");
      item.className = "export-chapter-item" + (allGenerated ? "" : " disabled");
      if (exportSelectedChapters.has(ch.id)) item.classList.add("selected");

      item.innerHTML = `
        <div class="chapter-check">${exportSelectedChapters.has(ch.id) ? '<i class="fas fa-check"></i>' : ''}</div>
        <div class="chapter-title">${ch.id} ${ch.title}</div>
        <div class="chapter-status ${allGenerated ? 'done' : 'incomplete'}">
          ${allGenerated ? '<i class="fas fa-check-circle"></i> 已完成' : generatedCount + '/' + allIds.length + ' 已生成'}
        </div>
      `;

      if (allGenerated) {
        exportable.push(ch.id);
        item.addEventListener("click", () => {
          if (exportSelectedChapters.has(ch.id)) {
            exportSelectedChapters.delete(ch.id);
          } else {
            exportSelectedChapters.add(ch.id);
          }
          renderExportModal();
        });
      }

      listEl.appendChild(item);
    });

    // 按一级目录导出按钮
    const btnPartial = $("#btn-export-partial");
    if (exportSelectedChapters.size > 0) {
      btnPartial.disabled = false;
      btnPartial.innerHTML = `<i class="fas fa-download"></i> 导出 ${exportSelectedChapters.size} 个目录`;
    } else {
      btnPartial.disabled = true;
      btnPartial.innerHTML = '<i class="fas fa-download"></i> 导出选中目录';
    }
  }

  function handleExportFull() {
    // 全文导出：忽略任何已选择的章节，导出全部内容
    exportSelectedChapters = new Set();
    window.open(`${BASE}/api/export-docx/${sessionId}?mode=full&filename=${encodeURIComponent(getDocTopic())}`, "_blank");
    $("#modal-export").classList.remove("open");
  }

  function handleExportPartial() {
    // 按一级目录导出：只导出用户选中的目录
    const ids = Array.from(exportSelectedChapters).join(",");
    window.open(`${BASE}/api/export-docx/${sessionId}?mode=partial&chapters=${ids}&filename=${encodeURIComponent(getDocTopic())}`, "_blank");
    $("#modal-export").classList.remove("open");
  }

  function getDocTopic() {
    // 从需求收集步骤获取文档主题
    return ($("#inp-topic").value.trim() || outline?.title || "文档");
  }

  // ── 模型管理 ──────────────────────────────────────────────────
  async function openConfigModal() {
    $("#modal-config").classList.add("open");
    await loadVerifiedModels();
    await loadCurrentConfig();
  }

  function closeConfigModal() {
    $("#modal-config").classList.remove("open");
  }

  async function loadCurrentConfig() {
    try {
      const cfg = await api("GET", "/config");
      $("#cfg-base-url").value = cfg.base_url || "";
      $("#cfg-model").value = cfg.model || "";
      updateModelTypeHint(cfg.model);
      if (cfg.model) {
        activeModel = { base_url: cfg.base_url, api_key: "", model: cfg.model, display_name: cfg.display_name || "", model_type: cfg.model_type };
        updateModelBadge(cfg.display_name || cfg.model, cfg.model_type);
      }
    } catch (err) {
      // ignore
    }
  }

  async function loadVerifiedModels() {
    try {
      const [models, cfg] = await Promise.all([api("GET", "/models"), api("GET", "/config")]);
      if (cfg.model) {
        activeModel = activeModel || { base_url: cfg.base_url, model: cfg.model, display_name: cfg.display_name || "", model_type: cfg.model_type };
      }
      renderVerifiedModels(models, cfg.model);
    } catch (err) {
      console.warn("加载模型列表失败:", err);
    }
  }

  function renderVerifiedModels(models, currentModelName) {
    const listEl = $("#verified-models-list");
    if (!models || models.length === 0) {
      listEl.innerHTML = '<p class="empty-hint">暂无已验证模型，请在下方添加并验证</p>';
      return;
    }

    listEl.innerHTML = "";
    models.forEach((m, idx) => {
      const item = document.createElement("div");
      item.className = "model-item";
      const displayName = m.display_name || m.model;
      // 通过 model + base_url 匹配当前激活模型
      if (activeModel && m.model === activeModel.model && m.base_url === activeModel.base_url) {
        item.classList.add("active");
      }

      const iconClass = m.model_type === "qwen3" || m.model_type === "qwen3x"
        ? "fa-robot" : "fa-brain";

      item.innerHTML = `
        <div class="model-icon"><i class="fas ${iconClass}"></i></div>
        <div class="model-info">
          <div class="model-name">${displayName}</div>
          <div class="model-detail">${m.model} · ${m.base_url}</div>
        </div>
        <span class="model-type-tag ${m.model_type}">${modelTypeLabel(m.model_type)}</span>
        <button class="model-select-btn" data-idx="${idx}">选择</button>
        <span class="model-active-label"><i class="fas fa-check-circle"></i> 当前</span>
        <button class="model-delete-btn" data-idx="${idx}" title="删除"><i class="fas fa-trash-alt"></i></button>
      `;

      item.querySelector(".model-select-btn").addEventListener("click", async () => {
        try {
          const result = await api("POST", `/select-model?idx=${idx}`);
          activeModel = m;
          updateModelBadge(displayName, m.model_type);
          toast(`已切换到模型 ${displayName}`, "success");
          renderVerifiedModels(models, m.model);
        } catch (err) {
          toast("切换模型失败: " + err.message, "error");
        }
      });

      item.querySelector(".model-delete-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除模型 "${displayName}" 吗？`)) return;
        try {
          const result = await api("DELETE", `/delete-model?idx=${idx}`);
          toast(`已删除模型 ${displayName}`, "success");
          // 刷新列表和当前配置
          const [newModels, cfg] = await Promise.all([api("GET", "/models"), api("GET", "/config")]);
          renderVerifiedModels(newModels, cfg.model);
          updateModelBadge(cfg.display_name || cfg.model, cfg.model_type);
        } catch (err) {
          toast("删除模型失败: " + err.message, "error");
        }
      });

      listEl.appendChild(item);
    });
  }

  function updateModelBadge(displayName, modelType) {
    const badge = $("#current-model-badge");
    badge.textContent = `${displayName} (${modelTypeLabel(modelType)})`;
    badge.classList.add("visible");
  }

  function updateModelTypeHint(modelName) {
    const hint = $("#model-type-hint");
    if (!modelName) {
      hint.textContent = "";
      return;
    }
    const name = modelName.toLowerCase().trim();
    if (name.startsWith("qwen3-")) {
      hint.textContent = "检测为 Qwen3 模型，将自动关闭 thinking 模式 (enable_thinking=False)";
      hint.style.color = "#92400e";
    } else if (/^qwen3[^-]/.test(name)) {
      hint.textContent = "检测为 Qwen3.x 模型，将通过 chat_template_kwargs 关闭 thinking 模式";
      hint.style.color = "#1e40af";
    } else {
      hint.textContent = "通用模型，无需特殊 thinking 处理";
      hint.style.color = "";
    }
  }

  async function handleVerifyModel() {
    const baseUrl = $("#cfg-base-url").value.trim();
    const apiKey = $("#cfg-api-key").value.trim();
    const model = $("#cfg-model").value.trim();
    const displayName = $("#cfg-display-name").value.trim();

    if (!baseUrl || !model) {
      toast("请填写 Base URL 和模型ID", "error");
      return;
    }

    if (!displayName) {
      toast("请填写显示名称", "error");
      return;
    }

    const btn = $("#btn-verify-model");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 验证中...';

    try {
      const result = await api("POST", "/verify-model", {
        base_url: baseUrl,
        api_key: apiKey,
        model: model,
        display_name: displayName,
      });

      if (result.ok) {
        toast(result.message, "success");
        activeModel = { base_url: baseUrl, api_key: apiKey, model: model, display_name: displayName, model_type: result.model_type };
        updateModelBadge(displayName, result.model_type);
        // 刷新已验证模型列表
        const models = await api("GET", "/models");
        renderVerifiedModels(models, model);
        // 清空显示名称输入框，方便下次添加
        $("#cfg-display-name").value = "";
      } else {
        toast(result.message, "error");
      }
    } catch (err) {
      toast("验证请求失败: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> 验证并添加';
    }
  }

  // ── 事件绑定 ──────────────────────────────────────────────────
  function init() {
    // 第1步
    $("#form-requirements").addEventListener("submit", handleGenerateOutline);
    initUploadArea();

    // 第2步
    $("#btn-add-chapter").addEventListener("click", () => openChapterModal(null));
    $("#btn-confirm-outline").addEventListener("click", handleConfirmOutline);
    $("#btn-save-chapter").addEventListener("click", handleSaveChapter);
    $("#btn-cancel-chapter").addEventListener("click", closeChapterModal);

    // 第3步
    $("#btn-export").addEventListener("click", handleExport);
    $("#btn-generate-all").addEventListener("click", handleGenerateAll);

    // 导出弹窗
    $("#btn-export-full").addEventListener("click", handleExportFull);
    $("#btn-export-partial").addEventListener("click", handleExportPartial);

    // 模型管理
    $("#btn-config").addEventListener("click", openConfigModal);
    $("#btn-verify-model").addEventListener("click", handleVerifyModel);
    $("#cfg-model").addEventListener("input", (e) => updateModelTypeHint(e.target.value));

    // 弹窗关闭
    $$(".modal-close").forEach((btn) => {
      btn.addEventListener("click", () => btn.closest(".modal").classList.remove("open"));
    });
    $$(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", () => overlay.closest(".modal").classList.remove("open"));
    });

    // 步骤点击导航
    $$(".step").forEach((stepEl) => {
      stepEl.addEventListener("click", () => handleStepClick(parseInt(stepEl.dataset.step)));
    });

    // 初始加载当前模型信息 + 设置步骤1高亮
    loadCurrentConfig();
    setStep(1);
  }

  // ── 步骤导航逻辑 ──────────────────────────────────────────────
  function handleStepClick(targetStep) {
    if (targetStep === currentStep) return;

    if (targetStep < currentStep) {
      // 回退：直接切换
      setStep(targetStep);
      return;
    }

    // 前进导航
    if (!outline) {
      toast("请先生成大纲", "error");
      return;
    }

    if (targetStep === 2) {
      goToStep2();
    } else if (targetStep === 3) {
      goToStep3();
    }
  }

  async function goToStep3() {
    if (!outline) {
      toast("请先生成大纲", "error");
      return;
    }

    // 从步骤1跳步骤3时，检查表单是否修改
    if (currentStep === 1 && isFormModified()) {
      showStepNavConfirm("step3");
      return;
    }

    // 保存大纲到后端
    try {
      await api("POST", `/update-outline?session_id=${sessionId}`, outline);
    } catch (err) {
      console.warn("保存大纲失败:", err);
    }

    renderChapterNav();
    setStep(3);
  }

  async function goToStep2() {
    if (!outline) {
      toast("请先生成大纲", "error");
      return;
    }

    // 检查表单是否修改
    if (isFormModified()) {
      showStepNavConfirm("step2");
    } else {
      // 未修改，直接切到大纲页
      renderOutlineTree();
      setStep(2);
    }
  }

  function showStepNavConfirm(targetStep) {
    // 如果已有确认条，先移除
    const existing = document.querySelector(".step-nav-confirm");
    if (existing) existing.remove();

    const bar = document.createElement("div");
    bar.className = "step-nav-confirm";
    bar.innerHTML = `
      <span class="confirm-text"><i class="fas fa-exclamation-triangle"></i> 需求收集已修改，是否重新生成大纲？</span>
      <div class="confirm-btns">
        <button class="btn btn-primary btn-sm confirm-regen">重新生成大纲</button>
        <button class="btn btn-ghost btn-sm confirm-discard">放弃修改</button>
      </div>
    `;

    const stepsBar = $(".steps-bar");
    stepsBar.after(bar);

    bar.querySelector(".confirm-regen").addEventListener("click", async () => {
      bar.remove();
      // 按修改后的需求重新生成大纲
      await handleGenerateOutline(new Event("submit", { cancelable: true }));
    });

    bar.querySelector(".confirm-discard").addEventListener("click", () => {
      bar.remove();
      // 恢复表单到上次生成的快照
      if (formSnapshot) {
        $("#inp-topic").value = formSnapshot.topic;
        $("#inp-type").value = formSnapshot.docType;
        $("#inp-audience").value = formSnapshot.audience;
        $("#inp-depth").value = formSnapshot.depth;
        $("#inp-requirements").value = formSnapshot.requirements;
      }
      if (targetStep === "step3") {
        renderChapterNav();
        setStep(3);
      } else {
        renderOutlineTree();
        setStep(2);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
