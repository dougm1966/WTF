// ── Usage Tracker (localStorage, actual API costs from server) ──
class UsageTracker {
    constructor() {
        this.STORAGE_KEY = 'pdf2txt_usage';
        this.PRICING = {
            inputPerMillion: 0.10,
            outputPerMillion: 0.40
        };
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
            // Only vision uses the API — use actual token counts
            if (r.extractionMethod === 'vision' && r.usage) {
                const inp = r.usage.promptTokens || 0;
                const out = r.usage.completionTokens || 0;
                totalInputTokens += inp;
                totalOutputTokens += out;
                totalCost += (inp * this.PRICING.inputPerMillion + out * this.PRICING.outputPerMillion) / 1e6;
            }
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

// ── Main App ──
class PDFConverter {
    constructor() {
        this.files = [];
        this.currentJobId = null;
        this.conversionResults = [];
        this.convertedMap = new Map(); // originalName → { textFile, status }
        this.activePreview = null;
        this.usageTracker = new UsageTracker();
        this.initElements();
        this.attachEvents();
        this.updateStats();
        this.loadConfig();
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

        this.convertBtn = document.getElementById('convertBtn');
        this.clearBtn = document.getElementById('clearBtn');
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

        this.convertBtn.addEventListener('click', () => this.startConversion());
        this.clearBtn.addEventListener('click', () => this.clearFiles());
        this.downloadAllBtn.addEventListener('click', () => this.downloadAllFiles());
        if (this.clearAllBtn) this.clearAllBtn.addEventListener('click', () => this.clearFiles());
        this.newConversionBtn.addEventListener('click', () => this.resetApp());
        this.retryBtn.addEventListener('click', () => this.resetApp());
        this.resetStatsBtn.addEventListener('click', () => { this.usageTracker.reset(); this.updateStats(); });
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

        this.renderFileList();
        this.fileInput.value = '';
    }

    renderFileList() {
        // Show/hide file area and action bar
        const hasFiles = this.files.length > 0;
        this.fileArea.style.display = hasFiles ? 'flex' : 'none';
        this.actionBar.style.display = hasFiles ? 'flex' : 'none';

        this.fileList.innerHTML = '';
        this.files.forEach((f, i) => {
            const converted = this.convertedMap.get(f.name);
            const el = document.createElement('div');
            el.className = 'file-item fade-in';

            let icon = 'fa-file-pdf';
            if (converted) {
                icon = converted.status === 'success' ? 'fa-check-circle' : 'fa-times-circle';
                if (converted.status === 'success') el.classList.add('clickable');
                if (this.activePreview === f.name) el.classList.add('active');
            }

            el.innerHTML = `
                <div class="file-info-item">
                    <i class="fas ${icon}"></i>
                    <div>
                        <div class="file-name">${f.name}</div>
                        <div class="file-size">${this.fmtSize(f.size)}</div>
                    </div>
                </div>
                ${converted && converted.status === 'success' ? `<a class="file-dl-btn" href="/api/download/${converted.textFile}" download title="Download text"><i class="fas fa-download"></i></a>` : ''}
                ${!converted ? `<button class="remove-file" data-i="${i}"><i class="fas fa-times"></i></button>` : ''}`;

            if (!converted) {
                const rmBtn = el.querySelector('.remove-file');
                if (rmBtn) rmBtn.addEventListener('click', () => this.removeFile(i));
            }

            if (converted && converted.status === 'success') {
                el.addEventListener('click', () => this.previewFile(converted.textFile, f.name));
            }

            this.fileList.appendChild(el);
        });
    }

    removeFile(i) {
        this.files.splice(i, 1);
        if (!this.files.length) {
            this.showLandingView();
        }
        this.renderFileList();
    }

    clearFiles() {
        this.files = [];
        this.convertedMap.clear();
        this.fileInput.value = '';
        this.fileArea.style.display = 'none';
        this.actionBar.style.display = 'none';
        this.progressArea.style.display = 'none';
        this.resultsBar.style.display = 'none';
        this.errorArea.style.display = 'none';
        this.hidePreview();
        this.showLandingView();
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

    // ── Conversion Flow ──
    async startConversion() {
        if (!this.files.length) { this.notify('Add files first', 'error'); return; }

        // Show progress, hide results/error
        this.progressArea.style.display = 'flex';
        this.resultsBar.style.display = 'none';
        this.errorArea.style.display = 'none';
        this.actionBar.style.display = 'none';
        this.statusMessages.innerHTML = '';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '0%';
        this.showLoading(true);

        try {
            const fd = new FormData();
            this.files.forEach(f => fd.append('pdfs', f));

            const res = await fetch('/api/upload', { method: 'POST', body: fd });
            if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);

            const data = await res.json();
            this.currentJobId = data.jobId;
            this.pollProgress();
        } catch (err) {
            this.showError(err.message);
            this.showLoading(false);
        }
    }

    async pollProgress() {
        if (!this.currentJobId) return;
        try {
            const res = await fetch(`/api/status/${this.currentJobId}`);
            if (!res.ok) throw new Error('Status check failed');
            const status = await res.json();
            this.updateProgress(status);

            if (status.status === 'completed') { await this.fetchResults(); }
            else if (status.status === 'failed') { this.showError('Conversion failed.'); this.showLoading(false); }
            else { setTimeout(() => this.pollProgress(), 1000); }
        } catch (err) {
            this.showError(err.message);
            this.showLoading(false);
        }
    }

    updateProgress(status) {
        const pct = status.progress || 0;
        this.progressFill.style.width = `${pct}%`;
        this.progressText.textContent = `${pct}%`;
        if (status.currentFile) this.addLog(`Processing: ${status.currentFile}`, 'processing');
        status.messages?.forEach(m => this.addLog(m.text, m.type));
    }

    addLog(msg, type = 'info') {
        const el = document.createElement('div');
        el.className = `status-message ${type}`;
        el.textContent = msg;
        this.statusMessages.appendChild(el);
        this.statusMessages.scrollTop = this.statusMessages.scrollHeight;
        if (this.statusMessages.children.length > 50) this.statusMessages.removeChild(this.statusMessages.firstChild);
    }

    async fetchResults() {
        try {
            const res = await fetch(`/api/results/${this.currentJobId}`);
            if (!res.ok) throw new Error('Failed to fetch results');
            this.conversionResults = await res.json();
            this.showResults();
            this.showLoading(false);
        } catch (err) {
            this.showError(err.message);
            this.showLoading(false);
        }
    }

    showResults() {
        const ok = this.conversionResults.filter(r => r.status === 'success');
        const fail = this.conversionResults.filter(r => r.status === 'error');

        // Record usage from actual server results
        const conv = this.usageTracker.recordConversion(this.conversionResults);
        this.updateStats();

        // Build converted map for file list status indicators
        this.conversionResults.forEach(r => {
            this.convertedMap.set(r.originalName, {
                status: r.status,
                textFile: r.textFile || null
            });
        });

        // Re-render file list with status icons
        this.renderFileList();

        // Summary bar
        this.resultsSummary.innerHTML = `
            <span class="result-stat success"><i class="fas fa-check"></i> ${ok.length} converted</span>
            ${fail.length ? `<span class="result-stat error"><i class="fas fa-times"></i> ${fail.length} failed</span>` : ''}
            <span class="result-stat cost"><i class="fas fa-dollar-sign"></i> $${conv.cost.toFixed(4)}</span>`;

        this.progressArea.style.display = 'none';
        this.resultsBar.style.display = 'flex';

        // Auto-preview first successful file
        if (ok.length > 0) {
            this.previewFile(ok[0].textFile, ok[0].originalName);
        }
    }

    async downloadAllFiles() {
        try {
            const res = await fetch(`/api/download/batch/${this.currentJobId}`);
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

    // ── Text Preview ──
    async previewFile(textFilename, originalName) {
        if (!textFilename) return;
        this.activePreview = originalName;
        this.renderFileList(); // update active highlight

        this.previewFilename.textContent = originalName.replace(/\.pdf$/i, '.txt');
        this.previewBody.textContent = 'Loading...';
        this.previewEmpty.style.display = 'none';
        this.previewContent.style.display = 'flex';
        this.previewDownload.href = `/api/download/${textFilename}`;

        try {
            const res = await fetch(`/api/download/${textFilename}`);
            if (!res.ok) throw new Error('Failed to load preview');
            const text = await res.text();
            this.previewBody.textContent = text || '(empty file)';
        } catch (err) {
            this.previewBody.textContent = `Error loading preview: ${err.message}`;
        }
    }

    hidePreview() {
        this.activePreview = null;
        this.previewEmpty.style.display = 'flex';
        this.previewContent.style.display = 'none';
        this.previewBody.textContent = '';
    }

    // ── Config (dynamic model/pricing from server) ──
    async loadConfig() {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) return;
            const cfg = await res.json();
            const el = document.getElementById('modelInfo');
            if (el && cfg.model) {
                const m = cfg.model.split('/').pop().replace(/-/g, ' ');
                el.textContent = `${m} \u00b7 $${cfg.pricing.inputPerMillion}/1M in \u00b7 $${cfg.pricing.outputPerMillion}/1M out \u00b7 via OpenRouter`;
            }
        } catch (e) { /* use default footer text */ }
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
        this.files = [];
        this.currentJobId = null;
        this.conversionResults = [];
        this.convertedMap.clear();
        this.fileInput.value = '';
        this.statusMessages.innerHTML = '';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '0%';
        this.fileArea.style.display = 'none';
        this.actionBar.style.display = 'none';
        this.progressArea.style.display = 'none';
        this.resultsBar.style.display = 'none';
        this.errorArea.style.display = 'none';
        this.hidePreview();
        this.showLoading(false);
        this.showLandingView();
    }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => new PDFConverter());
