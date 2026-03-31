// ── Usage Tracker (localStorage, actual API costs from server) ──
class UsageTracker {
    constructor() {
        this.STORAGE_KEY = 'pdf2txt_usage';
        this.data = this.load();
    }

    load() {
        try {
            const s = localStorage.getItem(this.STORAGE_KEY);
            if (s) return JSON.parse(s);
        } catch (e) { /* ignore */ }
        return { files: 0, pages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    }

    save() {
        try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data)); }
        catch (e) { /* ignore */ }
    }

    recordConversion(results) {
        const ok = results.filter(r => r.status === 'success');
        let totalPages = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCost = 0;

        for (const r of ok) {
            totalPages += r.pageCount || 1;
            if (r.extractionMethod === 'vision' && r.usage) {
                totalInputTokens += r.usage.promptTokens || 0;
                totalOutputTokens += r.usage.completionTokens || 0;
            }
            // Use server-calculated per-file cost (dynamic pricing)
            totalCost += r.cost || 0;
        }

        this.data.files += ok.length;
        this.data.pages += totalPages;
        this.data.inputTokens += totalInputTokens;
        this.data.outputTokens += totalOutputTokens;
        this.data.cost += totalCost;
        this.save();
        return { pages: totalPages, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cost: totalCost };
    }

    fmtTokens(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(n);
    }

    reset() {
        this.data = { files: 0, pages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
        this.save();
    }

    getStats() {
        return {
            files: this.data.files,
            pages: this.data.pages,
            tokens: this.fmtTokens(this.data.inputTokens + this.data.outputTokens),
            cost: '$' + this.data.cost.toFixed(4)
        };
    }
}

// ── Session Persistence (survives page refresh) ──
class SessionPersistence {
    constructor() {
        this.STORAGE_KEY = 'pdf2txt_session';
        this.MAX_AGE_MS = 110 * 60 * 1000; // 110 minutes (server TTL is 2 hours)
    }

    save(state) {
        try {
            state.savedAt = Date.now();
            // Convert Map to array of entries for JSON serialization
            if (state.convertedMap instanceof Map) {
                state.convertedMap = [...state.convertedMap.entries()];
            }
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* ignore quota errors */ }
    }

    load() {
        try {
            const s = localStorage.getItem(this.STORAGE_KEY);
            if (!s) return null;
            const data = JSON.parse(s);
            if (Date.now() - data.savedAt > this.MAX_AGE_MS) {
                this.clear();
                return null;
            }
            return data;
        } catch (e) {
            this.clear();
            return null;
        }
    }

    clear() {
        localStorage.removeItem(this.STORAGE_KEY);
    }
}

// ── Main App ──
class PDFConverter {
    constructor() {
        this.files = [];
        this.convertedMap = new Map(); // originalName → { textFile, cleanTextFile, status, cost, cleanupStatus }
        this.activePreview = null;
        this.previewTextCache = {}; // { raw: string, cleaned: string }
        this.previewMode = 'cleaned'; // 'raw' or 'cleaned'
        this.availableModels = [];
        this.selectedModel = 'meta-llama/llama-4-scout-17b-16e-instruct';
        this.selectedCleanupModel = 'llama-3.3-70b-versatile';
        this.usageTracker = new UsageTracker();
        this.sessionPersistence = new SessionPersistence();

        // Classification state
        this.classificationId = null;
        this.classifiedFiles = { text: [], ocr: [], vision: [] };
        this.serverFileMap = {}; // originalName → { filename, size, pageCount, classification }
        this.groupJobs = {};     // groupName → jobId
        this.groupStatus = {};   // groupName → 'idle' | 'converting' | 'done'
        this.groupPollers = {};  // groupName → timeout id

        this.initElements();
        this.attachEvents();
        this.updateStats();
        this.loadConfig();
        this.restoreSession(); // async, fire-and-forget — switches to working view if valid session exists
    }

    initElements() {
        this.uploadArea = document.getElementById('uploadArea');
        this.fileInput = document.getElementById('fileInput');
        this.browseBtn = document.getElementById('browseBtn');

        this.fileArea = document.getElementById('fileArea');
        this.fileList = document.getElementById('fileList');
        this.actionBar = document.getElementById('actionBar');

        this.progressArea = document.getElementById('progressArea');
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.statusMessages = document.getElementById('statusMessages');

        this.resultsBar = document.getElementById('resultsBar');
        this.resultsSummary = document.getElementById('resultsSummary');

        this.errorArea = document.getElementById('errorArea');
        this.errorMessage = document.getElementById('errorMessage');

        this.convertAllBtn = document.getElementById('convertAllBtn');
        this.cleanupAllBtn = document.getElementById('cleanupAllBtn');
        this.downloadAllBtn = document.getElementById('downloadAllBtn');
        this.clearAllBtn = document.getElementById('clearAllBtn');
        this.newConversionBtn = document.getElementById('newConversionBtn');
        this.retryBtn = document.getElementById('retryBtn');
        this.resetStatsBtn = document.getElementById('resetStats');

        this.loadingOverlay = document.getElementById('loadingOverlay');

        // Landing page
        this.landingView = document.getElementById('landingView');
        this.workingView = document.getElementById('workingView');
        this.landingDrop = document.getElementById('landingDrop');
        this.landingBrowseBtn = document.getElementById('landingBrowseBtn');

        // Preview
        this.previewEmpty = document.getElementById('previewEmpty');
        this.previewContent = document.getElementById('previewContent');
        this.previewFilename = document.getElementById('previewFilename');
        this.previewBody = document.getElementById('previewBody');
        this.previewDownload = document.getElementById('previewDownload');
        this.previewToggle = document.getElementById('previewToggle');
    }

    attachEvents() {
        this.browseBtn.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', e => this.handleFileSelect(e.target.files));
        this.uploadArea.addEventListener('dragover', e => this.handleDragOver(e));
        this.uploadArea.addEventListener('dragleave', e => this.handleDragLeave(e));
        this.uploadArea.addEventListener('drop', e => this.handleFileDrop(e));

        // Landing page events
        if (this.landingBrowseBtn) {
            this.landingBrowseBtn.addEventListener('click', () => this.fileInput.click());
        }
        if (this.landingDrop) {
            this.landingDrop.addEventListener('dragover', e => { e.preventDefault(); this.landingDrop.classList.add('dragover'); });
            this.landingDrop.addEventListener('dragleave', e => { e.preventDefault(); this.landingDrop.classList.remove('dragover'); });
            this.landingDrop.addEventListener('drop', e => {
                e.preventDefault();
                this.landingDrop.classList.remove('dragover');
                this.processFiles(Array.from(e.dataTransfer.files));
            });
        }

        if (this.convertAllBtn) this.convertAllBtn.addEventListener('click', () => this.convertAll());
        if (this.cleanupAllBtn) this.cleanupAllBtn.addEventListener('click', () => this.cleanupAll());
        if (this.downloadAllBtn) this.downloadAllBtn.addEventListener('click', () => this.downloadAllFiles());
        if (this.clearAllBtn) this.clearAllBtn.addEventListener('click', () => this.clearFiles());
        if (this.newConversionBtn) this.newConversionBtn.addEventListener('click', () => this.resetApp());
        if (this.retryBtn) this.retryBtn.addEventListener('click', () => this.resetApp());
        if (this.resetStatsBtn) this.resetStatsBtn.addEventListener('click', () => { this.usageTracker.reset(); this.updateStats(); });

        // Preview toggle
        if (this.previewToggle) {
            this.previewToggle.querySelectorAll('.preview-toggle-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.previewMode = btn.dataset.mode;
                    this.previewToggle.querySelectorAll('.preview-toggle-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.updatePreviewContent();
                });
            });
        }
    }

    // ── Drag & Drop ──
    handleDragOver(e) { e.preventDefault(); this.uploadArea.classList.add('dragover'); }
    handleDragLeave(e) { e.preventDefault(); this.uploadArea.classList.remove('dragover'); }

    handleFileDrop(e) {
        e.preventDefault();
        this.uploadArea.classList.remove('dragover');
        this.processFiles(Array.from(e.dataTransfer.files));
    }

    handleFileSelect(files) { this.processFiles(Array.from(files)); }

    processFiles(files) {
        const valid = files.filter(f => {
            if (!f.name.toLowerCase().endsWith('.pdf')) {
                this.notify(`${f.name} skipped — PDF only`, 'error');
                return false;
            }
            if (f.size > 100 * 1024 * 1024) {
                this.notify(`${f.name} too large (max 100 MB)`, 'error');
                return false;
            }
            return true;
        });
        if (!valid.length) return;

        const wasEmpty = this.files.length === 0;

        valid.forEach(f => {
            if (!this.files.some(x => x.name === f.name && x.size === f.size))
                this.files.push(f);
        });

        // Switch from landing to working view on first file
        if (wasEmpty && this.files.length > 0) {
            this.showWorkingView();
        }

        this.fileInput.value = '';
        this.classifyFiles(valid);
    }

    // ── Classification Flow ──
    async classifyFiles(newFiles) {
        this.fileArea.style.display = 'flex';
        this.actionBar.style.display = 'none';
        this.errorArea.style.display = 'none';

        // Show classifying spinner
        this.fileList.innerHTML = `
            <div class="classifying-overlay">
                <i class="fas fa-circle-notch fa-spin"></i>
                <p>Analyzing files...</p>
            </div>`;

        try {
            const fd = new FormData();
            newFiles.forEach(f => fd.append('pdfs', f));

            const res = await fetch('/api/classify', { method: 'POST', body: fd });
            if (!res.ok) throw new Error(`Classification failed: ${res.statusText}`);

            const data = await res.json();
            this.classificationId = data.classificationId;

            // Merge new classifications into existing groups
            for (const file of data.files) {
                // Remove from any existing group (in case of re-upload)
                for (const group of ['text', 'ocr', 'vision']) {
                    this.classifiedFiles[group] = this.classifiedFiles[group].filter(
                        f => f.originalName !== file.originalName
                    );
                }
                this.serverFileMap[file.originalName] = file;
                this.classifiedFiles[file.classification].push(file);
            }

            this.renderGroupedFileList();
            this.saveSession();
        } catch (err) {
            this.showError(err.message);
        }
    }

    // ── Grouped File List ──
    renderGroupedFileList() {
        this.fileArea.style.display = 'flex';
        this.fileList.innerHTML = '';

        const groups = [
            { key: 'text', label: 'Text-Based', icon: 'fa-file-lines', badge: 'free', badgeClass: 'free' },
            { key: 'ocr', label: 'OCR', icon: 'fa-eye', badge: 'free', badgeClass: 'free' },
            { key: 'vision', label: 'AI Vision', icon: 'fa-brain', badge: '$ paid', badgeClass: 'paid' }
        ];

        // Check if any group has files (to decide whether to show empty groups as drop targets)
        const totalFiles = groups.reduce((n, g) => n + this.classifiedFiles[g.key].length, 0);
        const anyIdle = Object.values(this.groupStatus).some(s => s === 'idle') || Object.keys(this.groupStatus).length === 0;

        for (const g of groups) {
            const files = this.classifiedFiles[g.key];
            // Show empty groups as drop targets only when there are files elsewhere and groups are idle
            if (!files.length && !(totalFiles > 0 && anyIdle)) continue;

            const status = this.groupStatus[g.key] || 'idle';
            const groupEl = document.createElement('div');
            groupEl.className = `file-group group-${g.key} fade-in`;

            // Header
            const header = document.createElement('div');
            header.className = 'file-group-header';
            header.innerHTML = `
                <div class="file-group-title">
                    <i class="fas ${g.icon}"></i>
                    ${g.label} (${files.length})
                </div>
                <span class="file-group-badge ${g.badgeClass}">${g.badge}</span>
                <div class="file-group-right">
                    ${status === 'idle' ? `<button class="file-group-convert" data-group="${g.key}"><i class="fas fa-bolt"></i> Convert</button>` : ''}
                    ${status === 'converting' ? '<span style="font-size:0.72rem;color:#667eea;"><i class="fas fa-spinner fa-spin"></i> Converting...</span>' : ''}
                    ${status === 'done' ? '<span style="font-size:0.72rem;color:#28a745;"><i class="fas fa-check"></i> Done</span>' : ''}
                </div>`;
            groupEl.appendChild(header);

            // File list body
            const body = document.createElement('div');
            body.className = 'file-group-body';

            if (!files.length) {
                body.innerHTML = '<div class="drop-hint"><i class="fas fa-arrows-alt"></i> Drag files here</div>';
                groupEl.appendChild(header);
                groupEl.appendChild(body);
                this.fileList.appendChild(groupEl);
                continue;
            }

            files.forEach(file => {
                const converted = this.convertedMap.get(file.originalName);
                const el = document.createElement('div');
                el.className = 'file-item';

                // Determine icon based on state
                let icon = 'fa-file-pdf';
                let iconStyle = '';
                if (converted && converted.status === 'success') {
                    if (converted.cleanTextFile) {
                        icon = 'fa-sparkles';
                        iconStyle = 'color:#667eea;';
                    } else {
                        icon = 'fa-check-circle';
                        iconStyle = 'color:#28a745;';
                    }
                    el.classList.add('clickable');
                    if (this.activePreview === file.originalName) el.classList.add('active');
                } else if (converted && converted.status === 'error') {
                    icon = 'fa-times-circle';
                    iconStyle = 'color:#dc3545;';
                }

                // Build state badge
                let badgeHtml = '';
                if (converted && converted.status === 'error') {
                    const errText = converted.errorDetails
                        ? Object.entries(converted.errorDetails).map(([k, v]) => `${k}: ${v}`).join('; ')
                        : converted.error || 'Unknown error';
                    const safeErr = errText.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
                    badgeHtml = `<span class="file-badge badge-error" title="${safeErr}">${safeErr.substring(0, 80)}</span>`;
                } else if (converted && converted.status === 'success') {
                    if (converted.cleanTextFile) {
                        badgeHtml = '<span class="file-badge badge-cleaned"><i class="fas fa-sparkles"></i> Cleaned</span>';
                    } else if (converted.cleanupStatus === 'cleaning') {
                        badgeHtml = '<span class="file-badge badge-cleaning"><i class="fas fa-spinner"></i> Cleaning...</span>';
                    } else {
                        badgeHtml = '<span class="file-badge badge-converted">Converted</span>';
                    }
                }

                // Build per-file action buttons
                let actionsHtml = '';
                if (converted && converted.status === 'success') {
                    // Cleanup / Reclean / Cleaning... button
                    const needsReclean = converted.cleanTextFile && converted.lastCleanupModel && converted.lastCleanupModel !== this.selectedCleanupModel;
                    if (converted.cleanupStatus === 'cleaning') {
                        actionsHtml += `<button class="file-action-btn cleaning-btn" disabled><i class="fas fa-spinner"></i> Cleaning...</button>`;
                    } else if (needsReclean) {
                        actionsHtml += `<button class="file-action-btn reclean-btn" data-file="${file.originalName}" data-textfile="${converted.textFile}"><i class="fas fa-rotate"></i> Reclean</button>`;
                    } else if (!converted.cleanTextFile) {
                        actionsHtml += `<button class="file-action-btn cleanup-btn" data-file="${file.originalName}" data-textfile="${converted.textFile}"><i class="fas fa-sparkles"></i> Cleanup</button>`;
                    }
                    // Download button — show text label for cleaned files
                    const dlFile = converted.cleanTextFile || converted.textFile;
                    const dlName = file.originalName.replace(/\.pdf$/i, converted.cleanTextFile ? '.clean.txt' : '.txt');
                    actionsHtml += `<a class="file-action-btn dl-btn" href="/api/download/${dlFile}?name=${encodeURIComponent(dlName)}" download title="Download text file"><i class="fas fa-download"></i> Download</a>`;
                } else if (!converted) {
                    // Disabled cleanup button (teaches feature exists)
                    actionsHtml += `<button class="file-action-btn cleanup-btn" disabled><i class="fas fa-sparkles"></i> Cleanup</button>`;
                }

                // Drag handle for unconverted files (to move between groups)
                const draggable = !converted && status === 'idle';
                if (draggable) {
                    el.draggable = true;
                    el.dataset.group = g.key;
                    el.dataset.file = file.originalName;
                }

                el.innerHTML = `
                    ${draggable ? '<div class="drag-handle" title="Drag to another group"><i class="fas fa-grip-vertical"></i></div>' : ''}
                    <div class="file-info-item">
                        <i class="fas ${icon}" style="${iconStyle}"></i>
                        <div>
                            <div class="file-name">${file.originalName}</div>
                            <div class="file-size">${this.fmtSize(file.size)} · ${file.pageCount} pg${converted && converted.cost ? ` · <span style="color:#667eea;font-weight:500;">${this.fmtCost(converted.cost)}</span>` : ''} ${badgeHtml}</div>
                        </div>
                    </div>
                    <div class="file-actions">
                        ${actionsHtml}
                        ${!converted && status === 'idle' ? `<button class="remove-file" data-group="${g.key}" data-file="${file.originalName}"><i class="fas fa-times"></i></button>` : ''}
                    </div>`;

                body.appendChild(el);
            });

            groupEl.appendChild(body);

            // Per-group progress bar
            if (status === 'converting') {
                const prog = document.createElement('div');
                prog.className = 'file-group-progress';
                prog.id = `group-progress-${g.key}`;
                prog.innerHTML = `
                    <div class="progress-row">
                        <span class="progress-label"><i class="fas fa-spinner fa-spin"></i> Converting...</span>
                        <span class="progress-pct" id="group-pct-${g.key}">0%</span>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill" id="group-fill-${g.key}"></div>
                    </div>`;
                groupEl.appendChild(prog);
            }

            this.fileList.appendChild(groupEl);
        }

        // Attach event listeners
        this.fileList.querySelectorAll('.file-group-convert').forEach(btn => {
            btn.addEventListener('click', () => this.startGroupConversion(btn.dataset.group));
        });

        this.fileList.querySelectorAll('.remove-file').forEach(btn => {
            btn.addEventListener('click', () => this.removeClassifiedFile(btn.dataset.group, btn.dataset.file));
        });

        // Drag-and-drop between groups
        this.fileList.querySelectorAll('.file-item[draggable="true"]').forEach(el => {
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({ group: el.dataset.group, file: el.dataset.file }));
                el.classList.add('dragging');
            });
            el.addEventListener('dragend', () => el.classList.remove('dragging'));
        });

        this.fileList.querySelectorAll('.file-group').forEach(groupEl => {
            const targetGroup = groupEl.classList.contains('group-text') ? 'text'
                : groupEl.classList.contains('group-ocr') ? 'ocr' : 'vision';

            groupEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                groupEl.classList.add('drag-over');
            });
            groupEl.addEventListener('dragleave', (e) => {
                if (!groupEl.contains(e.relatedTarget)) groupEl.classList.remove('drag-over');
            });
            groupEl.addEventListener('drop', (e) => {
                e.preventDefault();
                groupEl.classList.remove('drag-over');
                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                    if (data.group !== targetGroup) {
                        this.moveFile(data.group, targetGroup, data.file);
                    }
                } catch (err) { /* ignore bad drag data */ }
            });
        });

        // Per-file cleanup / reclean buttons
        this.fileList.querySelectorAll('.file-action-btn.cleanup-btn:not(:disabled), .file-action-btn.reclean-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cleanupFile(btn.dataset.textfile, btn.dataset.file);
            });
        });

        // Attach preview click handlers for converted files
        this.fileList.querySelectorAll('.file-item.clickable').forEach(el => {
            const nameEl = el.querySelector('.file-name');
            if (nameEl) {
                const name = nameEl.textContent;
                const converted = this.convertedMap.get(name);
                if (converted) {
                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.file-actions')) return; // Don't preview when clicking action buttons
                        this.previewFile(converted.textFile, name, converted.cleanTextFile);
                    });
                }
            }
        });

        // Show action bar and update batch button states
        this.actionBar.style.display = 'flex';
        this.updateBatchButtons();
    }

    moveFile(fromGroup, toGroup, fileName) {
        const idx = this.classifiedFiles[fromGroup].findIndex(f => f.originalName === fileName);
        if (idx === -1) return;
        const [file] = this.classifiedFiles[fromGroup].splice(idx, 1);
        file.classification = toGroup;
        this.classifiedFiles[toGroup].push(file);
        this.renderGroupedFileList();
        this.saveSession();
    }

    removeClassifiedFile(group, fileName) {
        this.classifiedFiles[group] = this.classifiedFiles[group].filter(f => f.originalName !== fileName);
        this.files = this.files.filter(f => f.name !== fileName);
        delete this.serverFileMap[fileName];

        // If no files left in any group, go back to landing
        const totalFiles = this.classifiedFiles.text.length + this.classifiedFiles.ocr.length + this.classifiedFiles.vision.length;
        if (totalFiles === 0) {
            this.sessionPersistence.clear();
            this.showLandingView();
            return;
        }

        this.renderGroupedFileList();
        this.saveSession();
    }

    // ── Per-Group Conversion ──
    async startGroupConversion(groupName) {
        const files = this.classifiedFiles[groupName];
        if (!files.length) return;

        this.groupStatus[groupName] = 'converting';
        this.renderGroupedFileList();

        try {
            const res = await fetch('/api/convert-group', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    classificationId: this.classificationId,
                    files: files.map(f => ({ filename: f.filename, originalName: f.originalName })),
                    model: this.selectedModel,
                    forceMethod: groupName
                })
            });

            if (!res.ok) throw new Error(`Conversion failed: ${res.statusText}`);

            const data = await res.json();
            this.groupJobs[groupName] = data.jobId;
            this.saveSession();
            this.pollGroupProgress(groupName);
        } catch (err) {
            this.groupStatus[groupName] = 'idle';
            this.renderGroupedFileList();
            this.notify(err.message, 'error');
        }
    }

    async pollGroupProgress(groupName) {
        const jobId = this.groupJobs[groupName];
        if (!jobId) return;

        try {
            const res = await fetch(`/api/status/${jobId}`);
            if (res.status === 404) {
                this.groupStatus[groupName] = 'idle';
                delete this.groupJobs[groupName];
                this.saveSession();
                this.renderGroupedFileList();
                this.notify('Server session expired — please re-upload files', 'error');
                return;
            }
            if (!res.ok) throw new Error('Status check failed');
            const status = await res.json();

            // Update inline progress bar
            const fillEl = document.getElementById(`group-fill-${groupName}`);
            const pctEl = document.getElementById(`group-pct-${groupName}`);
            if (fillEl) fillEl.style.width = `${status.progress || 0}%`;
            if (pctEl) pctEl.textContent = `${status.progress || 0}%`;

            if (status.status === 'completed') {
                await this.fetchGroupResults(groupName);
            } else if (status.status === 'failed') {
                this.groupStatus[groupName] = 'idle';
                this.renderGroupedFileList();
                const errMsgs = (status.messages || []).filter(m => m.type === 'error').map(m => m.text).join(' | ');
                this.notify(errMsgs || `${groupName} conversion failed`, 'error');
            } else {
                this.groupPollers[groupName] = setTimeout(() => this.pollGroupProgress(groupName), 1000);
            }
        } catch (err) {
            this.groupStatus[groupName] = 'idle';
            this.renderGroupedFileList();
            this.notify(err.message, 'error');
        }
    }

    async fetchGroupResults(groupName) {
        const jobId = this.groupJobs[groupName];
        try {
            const res = await fetch(`/api/results/${jobId}`);
            if (!res.ok) throw new Error('Failed to fetch results');
            const results = await res.json();

            // Record usage
            this.usageTracker.recordConversion(results);
            this.updateStats();

            // Update converted map
            results.forEach(r => {
                this.convertedMap.set(r.originalName, {
                    status: r.status,
                    textFile: r.textFile || null,
                    cleanTextFile: r.cleanTextFile || null,
                    cleanupStatus: null,
                    cost: r.cost || 0,
                    error: r.error || null,
                    errorDetails: r.errorDetails || null
                });
                if (r.status !== 'success') {
                    this.notify(`Conversion failed: ${r.originalName} — ${r.error || 'unknown error'}`, 'error');
                }
            });

            this.groupStatus[groupName] = 'done';
            this.renderGroupedFileList();
            this.saveSession();

            // Show results bar
            this.updateResultsBar();

            // Auto-preview first successful file from this group
            const firstOk = results.find(r => r.status === 'success');
            if (firstOk) {
                this.previewFile(firstOk.textFile, firstOk.originalName);
            }
        } catch (err) {
            this.notify(err.message, 'error');
        }
    }

    updateResultsBar() {
        const allConverted = [...this.convertedMap.values()];
        if (!allConverted.length) return;

        const ok = allConverted.filter(r => r.status === 'success').length;
        const fail = allConverted.filter(r => r.status === 'error').length;
        const totalCost = allConverted.reduce((sum, r) => sum + (r.cost || 0), 0);

        this.resultsSummary.innerHTML = `
            <span class="result-stat success"><i class="fas fa-check"></i> ${ok} converted</span>
            ${fail ? `<span class="result-stat error"><i class="fas fa-times"></i> ${fail} failed</span>` : ''}
            <span class="result-stat cost"><i class="fas fa-dollar-sign"></i> $${totalCost.toFixed(4)}</span>`;

        this.resultsBar.style.display = 'flex';
    }

    async downloadAllFiles() {
        // Find any completed job to download from
        const completedJobId = Object.values(this.groupJobs).find(id => id);
        if (!completedJobId) { this.notify('No files to download', 'error'); return; }

        try {
            const res = await fetch(`/api/download/batch/${completedJobId}`);
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `converted-${Date.now()}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            this.notify(err.message, 'error');
        }
    }

    clearFiles() {
        this.files = [];
        this.convertedMap.clear();
        this.classificationId = null;
        this.classifiedFiles = { text: [], ocr: [], vision: [] };
        this.serverFileMap = {};
        this.groupJobs = {};
        this.groupStatus = {};
        for (const id of Object.values(this.groupPollers)) clearTimeout(id);
        this.groupPollers = {};
        this.fileInput.value = '';
        this.fileArea.style.display = 'none';
        this.actionBar.style.display = 'none';
        this.progressArea.style.display = 'none';
        this.resultsBar.style.display = 'none';
        this.errorArea.style.display = 'none';
        this.hidePreview();
        this.showLandingView();
        this.sessionPersistence.clear();
    }

    // ── Session Persistence ──
    saveSession() {
        if (!this.classificationId) return;
        this.sessionPersistence.save({
            classificationId: this.classificationId,
            classifiedFiles: this.classifiedFiles,
            serverFileMap: this.serverFileMap,
            groupJobs: this.groupJobs,
            groupStatus: this.groupStatus,
            convertedMap: this.convertedMap, // SessionPersistence.save() handles Map→entries
            selectedModel: this.selectedModel,
            selectedCleanupModel: this.selectedCleanupModel,
            aiCleanup: this.aiCleanupToggle ? this.aiCleanupToggle.checked : false
        });
    }

    async restoreSession() {
        const session = this.sessionPersistence.load();
        if (!session || !session.classificationId) return;

        // Validate classification still exists on server
        try {
            const res = await fetch(`/api/classify/${session.classificationId}/check`);
            if (!res.ok) {
                this.sessionPersistence.clear();
                this.notify('Previous session expired — please re-upload files', 'info');
                return;
            }
        } catch {
            this.sessionPersistence.clear();
            return;
        }

        // Restore state
        this.classificationId = session.classificationId;
        this.classifiedFiles = session.classifiedFiles || { text: [], ocr: [], vision: [] };
        this.serverFileMap = session.serverFileMap || {};
        this.groupJobs = session.groupJobs || {};
        this.groupStatus = session.groupStatus || {};
        this.convertedMap = new Map(session.convertedMap || []);
        if (session.selectedModel) this.selectedModel = session.selectedModel;
        if (session.selectedCleanupModel) this.selectedCleanupModel = session.selectedCleanupModel;
        if (session.aiCleanup && this.aiCleanupToggle) this.aiCleanupToggle.checked = true;

        // Switch to working view and render
        this.showWorkingView();
        this.renderGroupedFileList();
        this.updateResultsBar();

        // Resume polling for any in-progress conversions
        for (const [group, status] of Object.entries(this.groupStatus)) {
            if (status === 'converting' && this.groupJobs[group]) {
                try {
                    const statusRes = await fetch(`/api/status/${this.groupJobs[group]}`);
                    if (statusRes.ok) {
                        const jobStatus = await statusRes.json();
                        if (jobStatus.status === 'completed') {
                            await this.fetchGroupResults(group);
                        } else if (jobStatus.status === 'failed') {
                            this.groupStatus[group] = 'idle';
                            this.notify(`${group} conversion failed while away`, 'error');
                        } else {
                            this.pollGroupProgress(group);
                        }
                    } else {
                        this.groupStatus[group] = 'idle';
                    }
                } catch {
                    this.groupStatus[group] = 'idle';
                }
            }
        }

        this.saveSession(); // persist any status corrections
        this.renderGroupedFileList();
    }

    showWorkingView() {
        if (this.landingView) this.landingView.style.display = 'none';
        if (this.workingView) this.workingView.style.display = 'grid';
    }

    showLandingView() {
        if (this.landingView) this.landingView.style.display = 'flex';
        if (this.workingView) this.workingView.style.display = 'none';
    }

    fmtSize(b) {
        if (!b) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(b) / Math.log(1024));
        return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
    }

    fmtCost(cost) {
        return (!cost || cost === 0) ? 'Free' : '$' + cost.toFixed(4);
    }

    // ── Text Preview ──
    async previewFile(textFilename, originalName, cleanTextFile) {
        if (!textFilename) return;
        this.activePreview = originalName;
        this.previewTextCache = {};
        this.renderGroupedFileList(); // update active highlight

        this.previewFilename.textContent = originalName.replace(/\.pdf$/i, '.txt');
        this.previewBody.textContent = 'Loading...';
        this.previewEmpty.style.display = 'none';
        this.previewContent.style.display = 'flex';

        // Show/hide toggle based on whether cleaned version exists
        if (cleanTextFile && this.previewToggle) {
            this.previewToggle.style.display = 'flex';
            this.previewMode = 'cleaned';
            this.previewToggle.querySelectorAll('.preview-toggle-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.mode === 'cleaned');
            });
        } else if (this.previewToggle) {
            this.previewToggle.style.display = 'none';
            this.previewMode = 'raw';
        }

        // Load raw text
        try {
            const res = await fetch(`/api/download/${textFilename}`);
            if (!res.ok) throw new Error('Failed to load preview');
            this.previewTextCache.raw = await res.text();
        } catch (err) {
            this.previewTextCache.raw = `Error loading preview: ${err.message}`;
        }

        // Load cleaned text if available
        if (cleanTextFile) {
            try {
                const res = await fetch(`/api/download/${cleanTextFile}`);
                if (res.ok) {
                    this.previewTextCache.cleaned = await res.text();
                }
            } catch (err) { /* fall back to raw */ }
        }

        this.updatePreviewContent();
    }

    updatePreviewContent() {
        const text = this.previewMode === 'cleaned' && this.previewTextCache.cleaned
            ? this.previewTextCache.cleaned
            : this.previewTextCache.raw;
        this.previewBody.textContent = text || '(empty file)';

        // Update download link to match current mode
        const converted = this.activePreview ? this.convertedMap.get(this.activePreview) : null;
        if (converted) {
            const dlFile = (this.previewMode === 'cleaned' && converted.cleanTextFile) || converted.textFile;
            const isClean = this.previewMode === 'cleaned' && converted.cleanTextFile;
            const dlName = this.activePreview.replace(/\.pdf$/i, isClean ? '.clean.txt' : '.txt');
            this.previewDownload.href = `/api/download/${dlFile}?name=${encodeURIComponent(dlName)}`;
        }
    }

    hidePreview() {
        this.activePreview = null;
        this.previewTextCache = {};
        this.previewEmpty.style.display = 'flex';
        this.previewContent.style.display = 'none';
        this.previewBody.textContent = '';
        if (this.previewToggle) this.previewToggle.style.display = 'none';
    }

    // ── Per-File Cleanup ──
    async cleanupFile(textFilename, originalName) {
        const entry = this.convertedMap.get(originalName);
        if (!entry || entry.cleanupStatus === 'cleaning') return;

        entry.cleanupStatus = 'cleaning';
        this.renderGroupedFileList();

        try {
            const res = await fetch('/api/cleanup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: textFilename, originalName, cleanupModel: this.selectedCleanupModel })
            });
            if (!res.ok) throw new Error(`Cleanup failed: ${res.statusText}`);

            const data = await res.json();
            entry.cleanTextFile = data.cleanTextFile;
            entry.cleanupStatus = null;
            entry.lastCleanupModel = this.selectedCleanupModel;
            entry.cost = (entry.cost || 0) + (data.cost || 0);

            // Track usage
            this.usageTracker.data.cost += data.cost || 0;
            this.usageTracker.save();
            this.updateStats();

            this.renderGroupedFileList();
            this.updateResultsBar();

            // Always auto-preview the cleaned result
            this.previewFile(entry.textFile, originalName, entry.cleanTextFile);
        } catch (err) {
            entry.cleanupStatus = null;
            this.renderGroupedFileList();
            this.notify(err.message, 'error');
        }
    }

    // ── Batch Operations ──
    async convertAll() {
        const groupOrder = ['text', 'ocr', 'vision'];
        for (const g of groupOrder) {
            if (this.classifiedFiles[g].length > 0 && this.groupStatus[g] !== 'done') {
                await this.startGroupConversionAndWait(g);
            }
        }
    }

    startGroupConversionAndWait(groupName) {
        return new Promise((resolve) => {
            const origFetch = this.fetchGroupResults.bind(this);
            const self = this;

            // Temporarily wrap fetchGroupResults to resolve when done
            this.fetchGroupResults = async function(gn) {
                await origFetch(gn);
                self.fetchGroupResults = origFetch; // restore
                if (gn === groupName) resolve();
            };

            this.startGroupConversion(groupName);
        });
    }

    async cleanupAll() {
        // Collect all converted-but-uncleaned files
        const filesToClean = [];
        for (const [name, entry] of this.convertedMap) {
            if (entry.status === 'success' && !entry.cleanTextFile && entry.cleanupStatus !== 'cleaning') {
                filesToClean.push({ filename: entry.textFile, originalName: name });
            }
        }

        if (!filesToClean.length) {
            this.notify('No files to clean up', 'info');
            return;
        }

        // Mark all as cleaning
        filesToClean.forEach(f => {
            const entry = this.convertedMap.get(f.originalName);
            if (entry) entry.cleanupStatus = 'cleaning';
        });
        this.renderGroupedFileList();

        try {
            const res = await fetch('/api/cleanup-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: filesToClean, cleanupModel: this.selectedCleanupModel })
            });
            if (!res.ok) throw new Error(`Batch cleanup failed: ${res.statusText}`);

            const data = await res.json();
            this.pollCleanupProgress(data.jobId, filesToClean);
        } catch (err) {
            filesToClean.forEach(f => {
                const entry = this.convertedMap.get(f.originalName);
                if (entry) entry.cleanupStatus = null;
            });
            this.renderGroupedFileList();
            this.notify(err.message, 'error');
        }
    }

    async pollCleanupProgress(jobId, files) {
        try {
            const res = await fetch(`/api/status/${jobId}`);
            if (!res.ok) throw new Error('Status check failed');
            const status = await res.json();

            if (status.status === 'completed') {
                // Fetch results and update convertedMap
                const resultsRes = await fetch(`/api/results/${jobId}`);
                if (resultsRes.ok) {
                    const results = await resultsRes.json();
                    let totalCleanupCost = 0;
                    results.forEach(r => {
                        if (r.status === 'success') {
                            const entry = this.convertedMap.get(r.originalName);
                            if (entry) {
                                entry.cleanTextFile = r.cleanTextFile;
                                entry.cleanupStatus = null;
                                entry.lastCleanupModel = this.selectedCleanupModel;
                                entry.cost = (entry.cost || 0) + (r.cost || 0);
                                totalCleanupCost += r.cost || 0;
                            }
                        } else {
                            const entry = this.convertedMap.get(r.originalName);
                            if (entry) entry.cleanupStatus = null;
                            this.notify(`Cleanup failed: ${r.originalName} — ${r.error || 'unknown error'}`, 'error');
                        }
                    });
                    this.usageTracker.data.cost += totalCleanupCost;
                    this.usageTracker.save();
                    this.updateStats();

                    // Auto-preview the first successfully cleaned file
                    const firstCleaned = results.find(r => r.status === 'success');
                    if (firstCleaned) {
                        const entry = this.convertedMap.get(firstCleaned.originalName);
                        if (entry) {
                            this.previewFile(entry.textFile, firstCleaned.originalName, entry.cleanTextFile);
                        }
                    }
                }
                this.renderGroupedFileList();
                this.updateResultsBar();
            } else if (status.status === 'failed') {
                files.forEach(f => {
                    const entry = this.convertedMap.get(f.originalName);
                    if (entry) entry.cleanupStatus = null;
                });
                this.renderGroupedFileList();
                this.notify('Batch cleanup failed', 'error');
            } else {
                setTimeout(() => this.pollCleanupProgress(jobId, files), 1000);
            }
        } catch (err) {
            files.forEach(f => {
                const entry = this.convertedMap.get(f.originalName);
                if (entry) entry.cleanupStatus = null;
            });
            this.renderGroupedFileList();
            this.notify(err.message, 'error');
        }
    }

    updateBatchButtons() {
        const anyUnconverted = ['text', 'ocr', 'vision'].some(g =>
            this.classifiedFiles[g].length > 0 && this.groupStatus[g] !== 'done'
        );
        const anyConverted = [...this.convertedMap.values()].some(r => r.status === 'success');
        const anyUncleaned = [...this.convertedMap.values()].some(r =>
            r.status === 'success' && !r.cleanTextFile && r.cleanupStatus !== 'cleaning'
        );

        if (this.convertAllBtn) this.convertAllBtn.disabled = !anyUnconverted;
        if (this.cleanupAllBtn) this.cleanupAllBtn.disabled = !anyUncleaned;
        if (this.downloadAllBtn) this.downloadAllBtn.disabled = !anyConverted;
    }

    // ── Config (dynamic model/pricing from server) ──
    async loadConfig() {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) return;
            const cfg = await res.json();
            this.availableModels = cfg.models || [];
            const defaultModel = cfg.defaultModel || this.availableModels[0]?.id;
            // Only set default if no session-restored model
            if (!this.classificationId) this.selectedModel = defaultModel;
            this.cleanupAvailable = cfg.cleanupAvailable || false;

            const select = document.getElementById('modelSelect');
            if (select && this.availableModels.length) {
                select.innerHTML = '';
                this.availableModels.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = `${m.name}  —  $${m.inputPerMillion}/1M in · $${m.outputPerMillion}/1M out`;
                    select.appendChild(opt);
                });
                select.value = this.selectedModel;
                select.addEventListener('change', () => {
                    this.selectedModel = select.value;
                });
            }

            const cleanupModels = cfg.cleanupModels || [];
            const cleanupSelect = document.getElementById('cleanupModelSelect');
            if (cleanupSelect && cleanupModels.length) {
                cleanupSelect.innerHTML = '';
                cleanupModels.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = `${m.name}  —  $${m.inputPerMillion}/1M in · $${m.outputPerMillion}/1M out`;
                    cleanupSelect.appendChild(opt);
                });
                if (!this.classificationId) this.selectedCleanupModel = cfg.defaultCleanupModel || cleanupModels[0]?.id;
                cleanupSelect.value = this.selectedCleanupModel;
                cleanupSelect.addEventListener('change', () => {
                    this.selectedCleanupModel = cleanupSelect.value;
                    this.renderGroupedFileList();
                });
            }
        } catch (e) { /* use default */ }
    }

    // ── UI Helpers ──
    showError(msg) {
        this.errorMessage.textContent = msg;
        this.progressArea.style.display = 'none';
        this.resultsBar.style.display = 'none';
        this.errorArea.style.display = 'flex';
        this.actionBar.style.display = 'flex';
    }

    showLoading(on) { this.loadingOverlay.style.display = on ? 'flex' : 'none'; }

    notify(msg, type = 'info') {
        const n = document.createElement('div');
        n.style.cssText = `
            position:fixed; top:12px; right:12px; padding:8px 14px;
            background:${type === 'error' ? '#3b1810' : '#102a15'};
            color:${type === 'error' ? '#e8886a' : '#86efac'};
            border:1px solid ${type === 'error' ? '#5c2a1a' : '#1a4d26'};
            border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,0.4);
            z-index:1001; max-width:280px; font-size:0.75rem;
            font-family:'DM Sans',system-ui,sans-serif;`;
        n.textContent = msg;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 3500);
    }

    updateStats() {
        const s = this.usageTracker.getStats();
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('statFiles', s.files);
        set('statPages', s.pages);
        set('statTokens', s.tokens);
        set('statCost', s.cost);

        document.querySelectorAll('.stat-chip').forEach(c => {
            c.classList.remove('updated');
            void c.offsetWidth;
            c.classList.add('updated');
        });
    }

    resetApp() {
        this.clearFiles();
    }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => new PDFConverter());
