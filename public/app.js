const STORAGE_KEYS = {
  theme: "discord-drive-theme",
  viewMode: "discord-drive-view-mode",
  sortBy: "discord-drive-sort-by"
};

applySavedTheme();

const state = {
  user: null,
  files: [],
  selectedId: null,
  selectedIds: new Set(),
  chunkSize: 8 * 1024 * 1024,
  uploads: new Map(),
  query: "",
  filter: "all",
  sortBy: localStorage.getItem(STORAGE_KEYS.sortBy) || "updated-desc",
  viewMode: localStorage.getItem(STORAGE_KEYS.viewMode) || "list",
  loading: false,
  renameTargetId: null,
  users: [],
  usersLoading: false,
  settings: null,
  settingsLoading: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  auth: $("#auth"),
  app: $("#app"),
  fileInput: $("#fileInput"),
  dropZone: $("#dropZone"),
  uploadQueue: $("#uploadQueue"),
  clearUploadsButton: $("#clearUploadsButton"),
  accountAdminButton: $("#accountAdminButton"),
  adminUserCount: $("#adminUserCount"),
  filePane: $("#filePane"),
  fileList: $("#fileList"),
  emptyState: $("#emptyState"),
  emptyTitle: $("#emptyTitle"),
  emptyText: $("#emptyText"),
  previewEmpty: $("#previewEmpty"),
  previewContent: $("#previewContent"),
  fileCount: $("#fileCount"),
  totalSize: $("#totalSize"),
  favoriteCount: $("#favoriteCount"),
  latestActivity: $("#latestActivity"),
  searchInput: $("#searchInput"),
  sortSelect: $("#sortSelect"),
  refreshButton: $("#refreshButton"),
  themeButton: $("#themeButton"),
  listViewButton: $("#listViewButton"),
  gridViewButton: $("#gridViewButton"),
  selectVisibleCheckbox: $("#selectVisibleCheckbox"),
  selectionBar: $("#selectionBar"),
  selectedCount: $("#selectedCount"),
  bulkDeleteButton: $("#bulkDeleteButton"),
  clearSelectionButton: $("#clearSelectionButton"),
  logoutButton: $("#logoutButton"),
  avatar: $("#avatar"),
  displayName: $("#displayName"),
  userName: $("#userName"),
  renameDialog: $("#renameDialog"),
  renameForm: $("#renameForm"),
  renameInput: $("#renameInput"),
  renameCancelButton: $("#renameCancelButton"),
  renameCloseButton: $("#renameCloseButton"),
  accountDialog: $("#accountDialog"),
  accountList: $("#accountList"),
  accountCloseButton: $("#accountCloseButton"),
  refreshAccountsButton: $("#refreshAccountsButton"),
  settingsForm: $("#settingsForm"),
  maxFileSizeInput: $("#maxFileSizeInput"),
  maxUserStorageInput: $("#maxUserStorageInput"),
  maxFilesInput: $("#maxFilesInput"),
  uploadRateInput: $("#uploadRateInput"),
  settingsSaveButton: $("#settingsSaveButton"),
  toastRegion: $("#toastRegion")
};

boot();

async function boot() {
  bindEvents();
  renderThemeButton();
  renderViewToggle();

  try {
    const me = await api("/api/me");
    state.user = me.user;
    state.chunkSize = me.config.chunkSizeBytes;
    renderUser();
    showApp();
    await loadFiles({ quiet: true });
    if (state.user.isAdmin) {
      await loadAccounts({ quiet: true });
    }
  } catch {
    showAuth();
  }
}

function bindEvents() {
  els.sortSelect.value = state.sortBy;

  els.dropZone.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    enqueueFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });

  for (const eventName of ["dragenter", "dragover"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragging");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragging");
    });
  }

  els.dropZone.addEventListener("drop", (event) => {
    enqueueFiles([...event.dataTransfer.files]);
  });

  els.searchInput.addEventListener("input", () => {
    state.query = els.searchInput.value.trim().toLowerCase();
    renderFiles();
  });

  els.sortSelect.addEventListener("change", () => {
    state.sortBy = els.sortSelect.value;
    localStorage.setItem(STORAGE_KEYS.sortBy, state.sortBy);
    renderFiles();
  });

  $("#typeFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) {
      return;
    }
    state.filter = button.dataset.filter;
    renderFilters();
    renderFiles();
  });

  els.refreshButton.addEventListener("click", () => loadFiles());
  els.themeButton.addEventListener("click", toggleTheme);
  els.listViewButton.addEventListener("click", () => setViewMode("list"));
  els.gridViewButton.addEventListener("click", () => setViewMode("grid"));

  els.selectVisibleCheckbox.addEventListener("change", () => {
    const visibleIds = getVisibleFiles().map((file) => file.id);
    if (els.selectVisibleCheckbox.checked) {
      for (const id of visibleIds) {
        state.selectedIds.add(id);
      }
    } else {
      for (const id of visibleIds) {
        state.selectedIds.delete(id);
      }
    }
    renderFiles();
    renderSelection();
  });

  els.bulkDeleteButton.addEventListener("click", () => {
    const selectedFiles = state.files.filter((file) => state.selectedIds.has(file.id));
    deleteFiles(selectedFiles);
  });

  els.clearSelectionButton.addEventListener("click", clearSelection);
  els.clearUploadsButton.addEventListener("click", clearFinishedUploads);
  els.accountAdminButton.addEventListener("click", openAccountDialog);
  els.refreshAccountsButton.addEventListener("click", () => loadAccounts());
  els.settingsForm.addEventListener("submit", submitSettings);
  els.accountCloseButton.addEventListener("click", closeAccountDialog);
  els.accountDialog.addEventListener("click", (event) => {
    if (event.target === els.accountDialog) {
      closeAccountDialog();
    }
  });

  els.logoutButton.addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  });

  els.renameForm.addEventListener("submit", submitRename);
  els.renameCancelButton.addEventListener("click", closeRenameDialog);
  els.renameCloseButton.addEventListener("click", closeRenameDialog);
  els.renameDialog.addEventListener("click", (event) => {
    if (event.target === els.renameDialog) {
      closeRenameDialog();
    }
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.searchInput.focus();
      return;
    }

    if (!isTyping && event.key === "Escape" && state.selectedIds.size > 0) {
      clearSelection();
    }
  });
}

function showAuth() {
  els.auth.classList.remove("hidden");
  els.app.classList.add("hidden");
}

function showApp() {
  els.auth.classList.add("hidden");
  els.app.classList.remove("hidden");
}

async function loadFiles({ quiet = false } = {}) {
  state.loading = true;
  els.refreshButton.disabled = true;
  renderFiles();

  try {
    const result = await api("/api/files");
    state.files = result.files.map(normalizeFile);
    reconcileSelections();
    if (!state.selectedId && state.files.length > 0) {
      state.selectedId = getVisibleFiles()[0]?.id || sortFiles([...state.files])[0]?.id || null;
    }
    if (!quiet) {
      toast("檔案已更新");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.loading = false;
    els.refreshButton.disabled = false;
    renderAll();
  }
}

function normalizeFile(file) {
  return {
    favorite: false,
    progress: 0,
    uploadedChunks: 0,
    ...file,
    favorite: Boolean(file.favorite),
    progress: Number(file.progress) || 0,
    uploadedChunks: Number(file.uploadedChunks) || 0
  };
}

function reconcileSelections() {
  const ids = new Set(state.files.map((file) => file.id));
  state.selectedIds = new Set([...state.selectedIds].filter((id) => ids.has(id)));
  if (state.selectedId && !ids.has(state.selectedId)) {
    state.selectedId = null;
  }
}

function renderAll() {
  renderStats();
  renderFilters();
  renderFiles();
  renderSelection();
  renderPreview();
  renderUploads();
  renderThemeButton();
  renderViewToggle();
  renderAdminControls();
}

function renderUser() {
  const label = state.user.globalName || state.user.username;
  els.displayName.textContent = label;
  els.userName.textContent = state.user.isAdmin ? `@${state.user.username} · 管理員` : `@${state.user.username}`;
  renderAdminControls();

  if (state.user.avatar) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = `https://cdn.discordapp.com/avatars/${state.user.id}/${state.user.avatar}.png?size=128`;
    els.avatar.replaceChildren(img);
  } else {
    els.avatar.textContent = initials(label);
  }
}

function renderAdminControls() {
  const isAdmin = Boolean(state.user?.isAdmin);
  els.accountAdminButton.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) {
    return;
  }

  els.adminUserCount.textContent = state.users.length > 0 ? String(state.users.length) : "--";
}

function renderStats() {
  const totalSize = state.files.reduce((sum, file) => sum + file.size, 0);
  const favorites = state.files.filter((file) => file.favorite).length;
  const latest = sortFiles([...state.files], "updated-desc")[0]?.updatedAt;

  els.fileCount.textContent = String(state.files.length);
  els.totalSize.textContent = formatBytes(totalSize);
  els.favoriteCount.textContent = String(favorites);
  els.latestActivity.textContent = latest ? `最近更新 ${formatDate(latest)}` : "尚無檔案";
}

function renderFilters() {
  const counts = {
    all: state.files.length,
    favorite: state.files.filter((file) => file.favorite).length,
    image: state.files.filter(isImage).length,
    video: state.files.filter(isVideo).length,
    audio: state.files.filter(isAudio).length,
    text: state.files.filter(isText).length
  };

  for (const button of $$("#typeFilters [data-filter]")) {
    const filter = button.dataset.filter;
    button.classList.toggle("is-active", filter === state.filter);
    const count = button.querySelector("[data-count]");
    if (count) {
      count.textContent = String(counts[filter] || 0);
    }
  }
}

function renderFiles() {
  els.filePane.classList.toggle("is-grid", state.viewMode === "grid");
  els.fileList.className = `file-list is-${state.viewMode}`;

  if (state.loading && state.files.length === 0) {
    els.fileList.replaceChildren(...skeletonRows());
    els.emptyState.classList.add("hidden");
    updateSelectVisible([]);
    return;
  }

  const visible = getVisibleFiles();
  els.fileList.replaceChildren(...visible.map(fileRow));

  const hasVisible = visible.length > 0;
  els.emptyState.classList.toggle("hidden", hasVisible);
  els.emptyTitle.textContent = state.files.length > 0 ? "沒有符合條件的檔案" : "還沒有檔案";
  els.emptyText.textContent =
    state.files.length > 0 ? "調整搜尋或篩選條件" : "上傳新檔案後會出現在這裡";

  updateSelectVisible(visible);
}

function skeletonRows() {
  return Array.from({ length: 5 }, () => {
    const row = document.createElement("div");
    row.className = "file-row is-skeleton";
    row.innerHTML = `
      <span class="skeleton-dot"></span>
      <span class="skeleton-line wide"></span>
      <span class="skeleton-line"></span>
      <span class="skeleton-line"></span>
      <span class="skeleton-line short"></span>
      <span class="skeleton-actions"></span>
    `;
    return row;
  });
}

function fileRow(file) {
  const row = document.createElement("article");
  row.className = [
    "file-row",
    file.id === state.selectedId ? "is-selected" : "",
    file.favorite ? "is-favorite" : "",
    file.status !== "complete" ? "is-incomplete" : ""
  ]
    .filter(Boolean)
    .join(" ");
  row.tabIndex = 0;
  row.addEventListener("click", (event) => {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    selectPreview(file.id);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectPreview(file.id);
    }
  });

  const check = selectionCheckbox(file);

  const main = document.createElement("div");
  main.className = "file-main";

  const kind = document.createElement("span");
  kind.className = `file-kind ${kindClass(file)}`;
  kind.innerHTML = `<svg><use href="#${kindIcon(file)}"></use></svg>`;

  const name = document.createElement("span");
  name.className = "file-name";
  const title = document.createElement("strong");
  title.append(highlightText(file.name, state.query));
  const sub = document.createElement("span");
  sub.textContent = `${kindLabel(file)} · ${file.type || "application/octet-stream"}`;
  name.append(title, sub);
  main.append(kind, name);

  const size = document.createElement("span");
  size.className = "size-cell";
  size.textContent = formatBytes(file.size);

  const updated = document.createElement("span");
  updated.className = "updated-cell";
  updated.textContent = formatShortDate(file.updatedAt);

  const statusCell = document.createElement("span");
  statusCell.className = "status-cell";
  statusCell.append(statusPill(file));

  const actions = document.createElement("span");
  actions.className = "row-actions";
  actions.append(
    iconButton("icon-star", file.favorite ? "取消收藏" : "加入收藏", (event) => {
      event.stopPropagation();
      toggleFavorite(file);
    }, file.favorite ? "favorite is-active" : "favorite"),
    iconButton("icon-edit", "重新命名", (event) => {
      event.stopPropagation();
      openRenameDialog(file);
    }),
    iconButton("icon-copy", "複製下載連結", (event) => {
      event.stopPropagation();
      copyFileLink(file);
    }),
    iconLink(`/api/files/${file.id}/download`, "icon-download", "下載", { download: file.name }),
    iconButton("icon-trash", "刪除", (event) => {
      event.stopPropagation();
      deleteFiles([file]);
    }, "danger")
  );

  row.append(check, main, size, updated, statusCell, actions);
  return row;
}

function selectionCheckbox(file) {
  const label = document.createElement("label");
  label.className = "check-cell row-check";
  label.title = "選取";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = state.selectedIds.has(file.id);
  input.addEventListener("change", () => {
    if (input.checked) {
      state.selectedIds.add(file.id);
    } else {
      state.selectedIds.delete(file.id);
    }
    renderFiles();
    renderSelection();
  });

  label.append(input, document.createElement("span"));
  return label;
}

function renderSelection() {
  const count = state.selectedIds.size;
  els.selectionBar.classList.toggle("hidden", count === 0);
  els.selectedCount.textContent = `${count} 個已選取`;
}

function updateSelectVisible(visible) {
  const ids = visible.map((file) => file.id);
  const selectedCount = ids.filter((id) => state.selectedIds.has(id)).length;
  els.selectVisibleCheckbox.disabled = ids.length === 0;
  els.selectVisibleCheckbox.checked = ids.length > 0 && selectedCount === ids.length;
  els.selectVisibleCheckbox.indeterminate = selectedCount > 0 && selectedCount < ids.length;
}

function clearSelection() {
  state.selectedIds.clear();
  renderFiles();
  renderSelection();
}

function selectPreview(id) {
  state.selectedId = id;
  renderFiles();
  renderPreview();
}

function renderPreview() {
  const file = state.files.find((item) => item.id === state.selectedId);
  if (!file) {
    els.previewEmpty.classList.remove("hidden");
    els.previewContent.classList.add("hidden");
    els.previewContent.replaceChildren();
    return;
  }

  els.previewEmpty.classList.add("hidden");
  els.previewContent.classList.remove("hidden");

  const head = document.createElement("div");
  head.className = "preview-head";

  const titleBlock = document.createElement("div");
  titleBlock.className = "preview-title";
  const kind = document.createElement("span");
  kind.className = `file-kind ${kindClass(file)}`;
  kind.innerHTML = `<svg><use href="#${kindIcon(file)}"></use></svg>`;
  const text = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = file.name;
  const meta = document.createElement("span");
  meta.textContent = `${formatBytes(file.size)} · ${kindLabel(file)} · ${formatShortDate(file.updatedAt)}`;
  text.append(title, meta);
  titleBlock.append(kind, text);

  const actions = document.createElement("div");
  actions.className = "preview-actions";
  actions.append(
    iconButton("icon-star", file.favorite ? "取消收藏" : "加入收藏", () => toggleFavorite(file), file.favorite ? "favorite is-active" : "favorite"),
    iconButton("icon-edit", "重新命名", () => openRenameDialog(file)),
    iconButton("icon-copy", "複製下載連結", () => copyFileLink(file)),
    iconLink(`/api/files/${file.id}/raw`, "icon-external", "開啟", { target: "_blank" }),
    iconLink(`/api/files/${file.id}/download`, "icon-download", "下載", { download: file.name }),
    iconButton("icon-trash", "刪除", () => deleteFiles([file]), "danger")
  );

  head.append(titleBlock, actions);

  const stage = document.createElement("div");
  stage.className = "preview-stage";
  renderPreviewStage(stage, file);

  const details = fileDetails(file);
  els.previewContent.replaceChildren(head, stage, details);
}

function renderPreviewStage(stage, file) {
  if (file.status !== "complete") {
    const pending = document.createElement("div");
    pending.className = "pending-preview";
    const icon = document.createElement("span");
    icon.className = `file-kind ${kindClass(file)}`;
    icon.innerHTML = `<svg><use href="#${kindIcon(file)}"></use></svg>`;
    const title = document.createElement("strong");
    title.textContent = statusText(file);
    const progress = progressBar(file.progress);
    pending.append(icon, title, progress);
    stage.append(pending);
    return;
  }

  if (isImage(file)) {
    const img = document.createElement("img");
    img.alt = file.name;
    img.src = `/api/files/${file.id}/raw`;
    stage.append(img);
    return;
  }

  if (isVideo(file)) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = `/api/files/${file.id}/raw`;
    stage.append(video);
    return;
  }

  if (isAudio(file)) {
    const audioWrap = document.createElement("div");
    audioWrap.className = "audio-preview";
    const icon = document.createElement("span");
    icon.className = "file-kind audio";
    icon.innerHTML = `<svg><use href="#icon-audio"></use></svg>`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = `/api/files/${file.id}/raw`;
    audioWrap.append(icon, audio);
    stage.append(audioWrap);
    return;
  }

  if (isPdf(file)) {
    const frame = document.createElement("iframe");
    frame.className = "pdf-preview";
    frame.title = file.name;
    frame.src = `/api/files/${file.id}/raw`;
    stage.append(frame);
    return;
  }

  if (isText(file)) {
    const pre = document.createElement("pre");
    pre.className = "text-preview";
    pre.textContent = "載入中...";
    stage.append(pre);
    api(`/api/files/${file.id}/text-preview`)
      .then((result) => {
        if (state.selectedId !== file.id) {
          return;
        }
        const text = result.text || "(空白檔案)";
        pre.textContent = result.truncated ? `${text}\n\n[預覽已截斷]` : text;
      })
      .catch((error) => {
        pre.textContent = error.message;
      });
    return;
  }

  const generic = document.createElement("div");
  generic.className = "generic-preview";
  const icon = document.createElement("span");
  icon.className = `file-kind ${kindClass(file)}`;
  icon.innerHTML = `<svg><use href="#${kindIcon(file)}"></use></svg>`;
  const title = document.createElement("strong");
  title.textContent = file.name;
  const sub = document.createElement("span");
  sub.textContent = file.type || "application/octet-stream";
  generic.append(icon, title, sub);
  stage.append(generic);
}

function fileDetails(file) {
  const details = document.createElement("dl");
  details.className = "detail-grid";
  addDetail(details, "類型", file.type || "application/octet-stream");
  addDetail(details, "大小", formatBytes(file.size));
  addDetail(details, "建立", formatDate(file.createdAt));
  addDetail(details, "更新", formatDate(file.updatedAt));
  addDetail(details, "分片", `${file.uploadedChunks}/${file.chunkCount}`);
  addDetail(details, "狀態", statusText(file));
  return details;
}

function addDetail(details, label, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  details.append(dt, dd);
}

function progressBar(value) {
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  const bar = document.createElement("div");
  bar.className = "progress";
  const fill = document.createElement("span");
  fill.style.width = `${Math.round(progress * 100)}%`;
  bar.append(fill);
  return bar;
}

function enqueueFiles(files) {
  if (files.length === 0) {
    return;
  }

  for (const file of files) {
    const id = crypto.randomUUID();
    state.uploads.set(id, {
      id,
      file,
      name: file.name,
      size: file.size,
      progress: 0,
      status: "等待",
      running: false,
      done: false,
      failed: false
    });
  }
  toast(`${files.length} 個檔案已加入佇列`);
  renderUploads();
  processUploads();
}

let uploadWorker = Promise.resolve();

function processUploads() {
  uploadWorker = uploadWorker.then(async () => {
    const pending = [...state.uploads.values()].filter(
      (upload) => !upload.done && !upload.running && !upload.failed
    );
    for (const upload of pending) {
      upload.running = true;
      await uploadOne(upload);
      upload.running = false;
    }
  });
}

async function uploadOne(upload) {
  try {
    upload.status = "建立檔案";
    renderUploads();
    const init = await api("/api/uploads/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: upload.file.name,
        size: upload.file.size,
        type: upload.file.type || "application/octet-stream",
        lastModified: upload.file.lastModified
      })
    });

    const fileMeta = init.file;
    upload.fileId = fileMeta.id;
    if (fileMeta.chunkCount === 0) {
      upload.progress = 1;
    }

    for (let index = 0; index < fileMeta.chunkCount; index += 1) {
      const start = index * fileMeta.chunkSize;
      const end = Math.min(upload.file.size, start + fileMeta.chunkSize);
      const chunk = upload.file.slice(start, end);
      upload.status = `${index + 1}/${fileMeta.chunkCount}`;
      renderUploads();
      const response = await fetch(`/api/uploads/${fileMeta.id}/chunks/${index}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream"
        },
        body: chunk
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Upload failed with ${response.status}`);
      }
      upload.progress = (index + 1) / fileMeta.chunkCount;
      renderUploads();
    }

    upload.status = "完成";
    upload.done = true;
    renderUploads();
    await loadFiles({ quiet: true });
    toast(`${upload.name} 已上傳`);
    setTimeout(() => {
      state.uploads.delete(upload.id);
      renderUploads();
    }, 1800);
  } catch (error) {
    upload.status = error.message;
    upload.failed = true;
    renderUploads();
    toast(`${upload.name} 上傳失敗`, "error");
    await loadFiles({ quiet: true });
  }
}

function renderUploads() {
  els.clearUploadsButton.disabled = ![...state.uploads.values()].some(
    (upload) => upload.done || upload.failed
  );

  if (state.uploads.size === 0) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = "佇列空白";
    els.uploadQueue.replaceChildren(empty);
    return;
  }

  const items = [...state.uploads.values()].map((upload) => {
    const item = document.createElement("div");
    item.className = `upload-item ${upload.failed ? "is-failed" : ""}`;
    const head = document.createElement("div");
    head.className = "upload-head";
    const name = document.createElement("strong");
    name.textContent = upload.name;
    const remove = iconButton("icon-x", "移除", () => {
      state.uploads.delete(upload.id);
      renderUploads();
    });
    head.append(name, remove);

    const row = document.createElement("div");
    row.className = "upload-row";
    const status = document.createElement("span");
    status.textContent = upload.status;
    const percent = document.createElement("span");
    percent.textContent = `${formatBytes(upload.size)} · ${Math.round(upload.progress * 100)}%`;
    row.append(status, percent);

    item.append(head, row, progressBar(upload.progress));
    return item;
  });
  els.uploadQueue.replaceChildren(...items);
}

function clearFinishedUploads() {
  for (const [id, upload] of state.uploads) {
    if (upload.done || upload.failed) {
      state.uploads.delete(id);
    }
  }
  renderUploads();
}

async function openAccountDialog() {
  if (!state.user?.isAdmin) {
    return;
  }

  els.accountDialog.showModal();
  if (state.users.length === 0 || !state.settings) {
    await loadAccounts({ quiet: true });
  } else {
    renderSettingsForm();
    renderAccountList();
  }
}

function closeAccountDialog() {
  els.accountDialog.close();
}

async function loadAccounts({ quiet = false } = {}) {
  if (!state.user?.isAdmin) {
    return;
  }

  state.usersLoading = true;
  state.settingsLoading = true;
  els.refreshAccountsButton.disabled = true;
  els.settingsSaveButton.disabled = true;
  renderSettingsForm();
  renderAccountList();

  try {
    const [usersResult, settingsResult] = await Promise.all([
      api("/api/users"),
      api("/api/settings")
    ]);
    state.users = usersResult.users.map(normalizeUser);
    state.settings = normalizeSettings(settingsResult.settings);
    renderAdminControls();
    if (!quiet) {
      toast("帳號已更新");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.usersLoading = false;
    state.settingsLoading = false;
    els.refreshAccountsButton.disabled = false;
    els.settingsSaveButton.disabled = false;
    renderSettingsForm();
    renderAccountList();
  }
}

function normalizeUser(user) {
  return {
    role: "user",
    isAdmin: false,
    disabled: false,
    fileCount: 0,
    storageBytes: 0,
    activeSessions: 0,
    ...user,
    isAdmin: user.role === "admin" || Boolean(user.isAdmin),
    disabled: Boolean(user.disabled),
    fileCount: Number(user.fileCount) || 0,
    storageBytes: Number(user.storageBytes) || 0,
    activeSessions: Number(user.activeSessions) || 0
  };
}

function normalizeSettings(settings = {}) {
  return {
    maxFileSizeBytes: Number(settings.maxFileSizeBytes) || 0,
    maxUserStorageBytes: Number(settings.maxUserStorageBytes) || 0,
    maxFilesPerUser: Number(settings.maxFilesPerUser) || 0,
    uploadInitsPerMinute: Number(settings.uploadInitsPerMinute) || 0
  };
}

function renderSettingsForm() {
  const settings = state.settings || normalizeSettings();
  els.maxFileSizeInput.value = bytesToMiB(settings.maxFileSizeBytes);
  els.maxUserStorageInput.value = bytesToGiB(settings.maxUserStorageBytes);
  els.maxFilesInput.value = String(settings.maxFilesPerUser);
  els.uploadRateInput.value = String(settings.uploadInitsPerMinute);
  const disabled = state.settingsLoading || !state.user?.isAdmin;
  for (const input of [
    els.maxFileSizeInput,
    els.maxUserStorageInput,
    els.maxFilesInput,
    els.uploadRateInput
  ]) {
    input.disabled = disabled;
  }
  els.settingsSaveButton.disabled = disabled;
}

async function submitSettings(event) {
  event.preventDefault();
  if (!state.user?.isAdmin) {
    return;
  }

  const payload = {
    maxFileSizeBytes: mibToBytes(els.maxFileSizeInput.value),
    maxUserStorageBytes: gibToBytes(els.maxUserStorageInput.value),
    maxFilesPerUser: positiveInteger(els.maxFilesInput.value),
    uploadInitsPerMinute: positiveInteger(els.uploadRateInput.value)
  };

  state.settingsLoading = true;
  renderSettingsForm();

  try {
    const result = await api("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.settings = normalizeSettings(result.settings);
    toast("限制設定已儲存");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.settingsLoading = false;
    renderSettingsForm();
  }
}

function renderAccountList() {
  if (!els.accountDialog.open && state.users.length === 0 && !state.usersLoading) {
    return;
  }

  if (state.usersLoading && state.users.length === 0) {
    const loading = document.createElement("div");
    loading.className = "account-empty";
    loading.textContent = "載入帳號中...";
    els.accountList.replaceChildren(loading);
    return;
  }

  if (state.users.length === 0) {
    const empty = document.createElement("div");
    empty.className = "account-empty";
    empty.textContent = "尚無帳號";
    els.accountList.replaceChildren(empty);
    return;
  }

  els.accountList.replaceChildren(...state.users.map(accountRow));
}

function accountRow(user) {
  const row = document.createElement("article");
  row.className = ["account-row", user.disabled ? "is-disabled" : ""].filter(Boolean).join(" ");

  const identity = document.createElement("div");
  identity.className = "account-identity";
  identity.append(accountAvatar(user));

  const label = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = user.globalName || user.username;
  const meta = document.createElement("span");
  const lastLogin = user.lastLoginAt ? formatShortDate(user.lastLoginAt) : "尚未登入";
  meta.textContent = `@${user.username} · 最近登入 ${lastLogin}`;
  label.append(name, meta);
  identity.append(label);

  const status = document.createElement("div");
  status.className = "account-status";
  status.append(rolePill(user), statePill(user));

  const files = document.createElement("div");
  files.className = "account-files";
  files.textContent = `${user.fileCount} 個 · ${formatBytes(user.storageBytes)}`;

  const actions = document.createElement("div");
  actions.className = "account-actions";
  const isSelf = user.id === state.user.id;
  actions.append(
    textAction(
      user.isAdmin ? "改為使用者" : "設為管理員",
      () => patchUser(user.id, { role: user.isAdmin ? "user" : "admin" }),
      isSelf && user.isAdmin
    ),
    textAction(
      user.disabled ? "啟用" : "停用",
      () => patchUser(user.id, { disabled: !user.disabled }),
      isSelf,
      user.disabled ? "" : "danger"
    )
  );

  row.append(identity, status, files, actions);
  return row;
}

function accountAvatar(user) {
  const avatar = document.createElement("span");
  avatar.className = "avatar account-avatar";
  const label = user.globalName || user.username;
  if (user.avatar) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96`;
    avatar.append(img);
  } else {
    avatar.textContent = initials(label);
  }
  return avatar;
}

function rolePill(user) {
  const pill = document.createElement("span");
  pill.className = user.isAdmin ? "role-pill admin" : "role-pill";
  pill.textContent = user.isAdmin ? "管理員" : "使用者";
  return pill;
}

function statePill(user) {
  const pill = document.createElement("span");
  pill.className = user.disabled ? "role-pill disabled" : "role-pill active";
  pill.textContent = user.disabled ? "已停用" : `${user.activeSessions} 個連線`;
  return pill;
}

function textAction(label, onClick, disabled = false, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["text-button", extraClass].filter(Boolean).join(" ");
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

async function patchUser(id, payload) {
  try {
    const result = await api(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const updated = normalizeUser(result.user);
    state.users = state.users.map((user) => (user.id === updated.id ? updated : user));
    renderAdminControls();
    renderAccountList();
    toast("帳號已儲存");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function toggleFavorite(file) {
  try {
    await patchFile(file.id, { favorite: !file.favorite });
    toast(file.favorite ? "已取消收藏" : "已加入收藏");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openRenameDialog(file) {
  state.renameTargetId = file.id;
  els.renameInput.value = file.name;
  els.renameDialog.showModal();
  requestAnimationFrame(() => {
    els.renameInput.focus();
    els.renameInput.select();
  });
}

function closeRenameDialog() {
  state.renameTargetId = null;
  els.renameDialog.close();
}

async function submitRename(event) {
  event.preventDefault();
  const file = state.files.find((item) => item.id === state.renameTargetId);
  const name = els.renameInput.value.trim();
  if (!file || !name || name === file.name) {
    closeRenameDialog();
    return;
  }

  try {
    await patchFile(file.id, { name });
    closeRenameDialog();
    toast("檔名已更新");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function patchFile(id, payload) {
  const result = await api(`/api/files/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  state.files = state.files.map((file) => (file.id === id ? normalizeFile(result.file) : file));
  renderAll();
  return result.file;
}

async function deleteFiles(files) {
  if (files.length === 0) {
    return;
  }

  const label = files.length === 1 ? files[0].name : `${files.length} 個檔案`;
  if (!confirm(`刪除 ${label}？`)) {
    return;
  }

  try {
    for (const file of files) {
      await apiNoContent(`/api/files/${file.id}`, { method: "DELETE" });
      state.selectedIds.delete(file.id);
    }
    toast(`${label} 已刪除`);
    await loadFiles({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function copyFileLink(file) {
  const url = new URL(`/api/files/${file.id}/download`, location.origin).toString();
  try {
    await copyText(url);
    toast("下載連結已複製");
  } catch {
    toast("無法複製連結", "error");
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Copy failed");
  }
}

function getVisibleFiles() {
  const query = state.query;
  const filtered = state.files.filter((file) => matchesFilter(file) && matchesQuery(file, query));
  return sortFiles(filtered);
}

function matchesFilter(file) {
  if (state.filter === "all") return true;
  if (state.filter === "favorite") return file.favorite;
  if (state.filter === "image") return isImage(file);
  if (state.filter === "video") return isVideo(file);
  if (state.filter === "audio") return isAudio(file);
  if (state.filter === "text") return isText(file);
  return true;
}

function matchesQuery(file, query) {
  if (!query) {
    return true;
  }
  return `${file.name} ${file.type || ""}`.toLowerCase().includes(query);
}

function sortFiles(files, sortBy = state.sortBy) {
  return files.sort((a, b) => {
    if (sortBy === "name-asc") {
      return a.name.localeCompare(b.name, "zh-Hant", { numeric: true, sensitivity: "base" });
    }
    if (sortBy === "size-desc") {
      return b.size - a.size || a.name.localeCompare(b.name, "zh-Hant", { numeric: true });
    }
    if (sortBy === "created-desc") {
      return timestamp(b.createdAt) - timestamp(a.createdAt);
    }
    if (sortBy === "favorite-desc") {
      return Number(b.favorite) - Number(a.favorite) || timestamp(b.updatedAt) - timestamp(a.updatedAt);
    }
    return timestamp(b.updatedAt) - timestamp(a.updatedAt);
  });
}

function isInteractiveTarget(target) {
  return Boolean(target.closest("a, button, input, label, select, textarea"));
}

function statusPill(file) {
  const status = document.createElement("span");
  status.className = `status-pill ${file.status}`;
  status.textContent = statusText(file);
  return status;
}

function statusText(file) {
  if (file.status === "complete") {
    return "完成";
  }
  if (file.status === "uploading") {
    return `${Math.round(file.progress * 100)}%`;
  }
  return file.status || "--";
}

function iconLink(href, icon, label, options = {}) {
  const link = document.createElement("a");
  link.className = "icon-button";
  link.href = href;
  link.title = label;
  link.setAttribute("aria-label", label);
  if (options.target) {
    link.target = options.target;
    link.rel = "noreferrer";
  }
  if (options.download) {
    link.download = options.download;
  }
  link.addEventListener("click", (event) => event.stopPropagation());
  link.innerHTML = `<svg><use href="#${icon}"></use></svg>`;
  return link;
}

function iconButton(icon, label, onClick, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["icon-button", extraClass].filter(Boolean).join(" ");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg><use href="#${icon}"></use></svg>`;
  button.addEventListener("click", onClick);
  return button;
}

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return response.json();
}

async function apiNoContent(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
}

function isImage(file) {
  return file.type?.startsWith("image/");
}

function isVideo(file) {
  return file.type?.startsWith("video/");
}

function isAudio(file) {
  return file.type?.startsWith("audio/");
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function isText(file) {
  return (
    file.type?.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    /\.(md|json|txt|csv|log|xml|yaml|yml|ini|toml)$/i.test(file.name)
  );
}

function kindClass(file) {
  if (isImage(file)) return "image";
  if (isVideo(file)) return "video";
  if (isAudio(file)) return "audio";
  if (isText(file)) return "text";
  if (isPdf(file)) return "pdf";
  return "";
}

function kindIcon(file) {
  if (isImage(file)) return "icon-image";
  if (isVideo(file)) return "icon-video";
  if (isAudio(file)) return "icon-audio";
  if (isText(file)) return "icon-text";
  return "icon-file";
}

function kindLabel(file) {
  if (isImage(file)) return "圖片";
  if (isVideo(file)) return "影片";
  if (isAudio(file)) return "音訊";
  if (isPdf(file)) return "PDF";
  if (isText(file)) return "文字";
  return "檔案";
}

function highlightText(value, query) {
  const fragment = document.createDocumentFragment();
  if (!query) {
    fragment.append(document.createTextNode(value));
    return fragment;
  }

  const lowerValue = value.toLowerCase();
  const index = lowerValue.indexOf(query);
  if (index === -1) {
    fragment.append(document.createTextNode(value));
    return fragment;
  }

  fragment.append(document.createTextNode(value.slice(0, index)));
  const mark = document.createElement("mark");
  mark.textContent = value.slice(index, index + query.length);
  fragment.append(mark, document.createTextNode(value.slice(index + query.length)));
  return fragment;
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function bytesToMiB(bytes) {
  return String(Math.floor((Number(bytes) || 0) / 1024 / 1024));
}

function bytesToGiB(bytes) {
  return String(Math.floor((Number(bytes) || 0) / 1024 / 1024 / 1024));
}

function mibToBytes(value) {
  return positiveInteger(value) * 1024 * 1024;
}

function gibToBytes(value) {
  return positiveInteger(value) * 1024 * 1024 * 1024;
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.floor(number);
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-Hant", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatShortDate(value) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-Hant", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function timestamp(value) {
  return Date.parse(value || "") || 0;
}

function initials(name) {
  return String(name || "?")
    .trim()
    .slice(0, 2)
    .toUpperCase();
}

function setViewMode(viewMode) {
  state.viewMode = viewMode;
  localStorage.setItem(STORAGE_KEYS.viewMode, viewMode);
  renderViewToggle();
  renderFiles();
}

function renderViewToggle() {
  els.listViewButton.classList.toggle("is-active", state.viewMode === "list");
  els.gridViewButton.classList.toggle("is-active", state.viewMode === "grid");
}

function applySavedTheme() {
  if (localStorage.getItem(STORAGE_KEYS.theme) === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  if (next === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    delete document.documentElement.dataset.theme;
  }
  localStorage.setItem(STORAGE_KEYS.theme, next);
  renderThemeButton();
}

function renderThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  els.themeButton.innerHTML = `<svg><use href="#${dark ? "icon-sun" : "icon-moon"}"></use></svg>`;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  els.toastRegion.append(item);
  setTimeout(() => {
    item.classList.add("is-leaving");
    setTimeout(() => item.remove(), 180);
  }, 3000);
}
