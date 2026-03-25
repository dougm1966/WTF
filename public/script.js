// ── Usage Tracker (localStorage-backed, GPT-4o Vision pricing) ──
class UsageTracker {
    constructor() {
        this.STORAGE_KEY = 'wtf_usage';
        // GPT-4o pricing (2025)
        this.PRICING = {
            inputPerMillion: 2.50,
            outputPerMillion: 10.00,
            tokensPerPageInput: 1105, // Vision high-detail: 85 base + 170 * ~6 tiles
            tokensPerPageOutput: 500, // Estimated extracted text per page
            bytesPerPage: 150 * 1024 // ~150KB per PDF page (rough heuristic)
        };
        this.data = this.load();
        this.lastConvCost = 0;
    }

    load() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) return JSON.parse(stored);
        } catch (e) { /* ignore */ }
        return { files: 0, pages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    }

    save() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
        } catch (e) { /* ignore */ }
    }

    recordConversion(files) {
        const successful = files.filter(f => f.success);
        let totalPages = 0;

        for (const file of successful) {
            const pages = Math.max(1, Math.round(file.size / this.PRICING.bytesPerPage));
            totalPages += pages;
        }

        const inputTokens = totalPages * this.PRICING.tokensPerPageInput;
        const outputTokens = totalPages * this.PRICING.tokensPerPageOutput;
        const cost = (inputTokens * this.PRICING.inputPerMillion +
                      outputTokens * this.PRICING.outputPerMillion) / 1_000_000;

        this.data.files += successful.length;
        this.data.pages += totalPages;
        this.data.inputTokens += inputTokens;
        this.data.outputTokens += outputTokens;
        this.data.cost += cost;
        this.lastConvCost = cost;

        this.save();
        return { pages: totalPages, inputTokens, outputTokens, cost };
    }

    formatTokens(n) {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
        return String(n);
    }

    getStats() {
        return {
            files: this.data.files,
            pages: this.data.pages,
            tokens: this.formatTokens(this.data.inputTokens + this.data.outputTokens),
            cost: this.data.cost.toFixed(2)
        };
    }

    getLastConversionCost() {
        return this.lastConvCost;
    }
}

// ── PDF to Text Converter — Frontend JavaScript ──
class PDFConverter {
    constructor() {
        this.files = [];
        this.currentJobId = null;
        this.conversionResults = [];
        this.usageTracker = new UsageTracker();
        this.initializeElements();
        this.attachEventListeners();
        this.updateUsageDisplay();
    }

    initializeElements() {
        // Upload elements
        this.uploadArea = document.getElementById('uploadArea');
        this.fileInput = document.getElementById('fileInput');
        this.browseBtn = document.getElementById('browseBtn');

        // Section elements
        this.fileListSection = document.getElementById('fileListSection');
        this.fileList = document.getElementById('fileList');
        this.progressSection = document.getElementById('progressSection');
        this.resultsSection = document.getElementById('resultsSection');
        this.errorSection = document.getElementById('errorSection');

        // Progress elements
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.statusMessages = document.getElementById('statusMessages');

        // Button elements
        this.convertBtn = document.getElementById('convertBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.downloadAllBtn = document.getElementById('downloadAllBtn');
        this.newConversionBtn = document.getElementById('newConversionBtn');
        this.retryBtn = document.getElementById('retryBtn');
        this.addMoreBtn = document.getElementById('addMoreBtn');

        // Results elements
        this.resultsSummary = document.getElementById('resultsSummary');
        this.individualDownloads = document.getElementById('individualDownloads');

        // Error elements
        this.errorMessage = document.getElementById('errorMessage');

        // Loading overlay
        this.loadingOverlay = document.getElementById('loadingOverlay');
    }

    attachEventListeners() {
        // File upload events
        this.browseBtn.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e.target.files));

        // Drag and drop events
        this.uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e));
        this.uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        this.uploadArea.addEventListener('drop', (e) => this.handleFileDrop(e));

        // Button events
        this.convertBtn.addEventListener('click', () => this.startConversion());
        this.clearBtn.addEventListener('click', () => this.clearFiles());
        this.downloadAllBtn.addEventListener('click', () => this.downloadAllFiles());
        this.newConversionBtn.addEventListener('click', () => this.resetApplication());
        this.retryBtn.addEventListener('click', () => this.resetApplication());

        // Add more files button
        if (this.addMoreBtn) {
            this.addMoreBtn.addEventListener('click', () => this.fileInput.click());
        }
    }

    handleDragOver(e) {
        e.preventDefault();
        this.uploadArea.classList.add('dragover');
    }

    handleDragLeave(e) {
        e.preventDefault();
        this.uploadArea.classList.remove('dragover');
    }

    handleFileDrop(e) {
        e.preventDefault();
        this.uploadArea.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        this.processFiles(files);
    }

    handleFileSelect(files) {
        this.processFiles(Array.from(files));
    }

    processFiles(files) {
        const validFiles = files.filter(file => {
            const fileName = file.name.toLowerCase();
            if (!fileName.endsWith('.pdf')) {
                this.showNotification(`Only PDF files are allowed. ${file.name} was skipped.`, 'error');
                return false;
            }
            if (file.size > 100 * 1024 * 1024) {
                this.showNotification(`File ${file.name} is too large. Maximum size is 100MB.`, 'error');
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) return;

        validFiles.forEach(file => {
            if (!this.files.some(existing => existing.name === file.name && existing.size === file.size)) {
                this.files.push(file);
            }
        });

        this.updateFileList();
        this.showSection('fileListSection');
    }

    updateFileList() {
        this.fileList.innerHTML = '';

        this.files.forEach((file, index) => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item fade-in';
            fileItem.innerHTML = `
                <div class="file-info-item">
                    <i class="fas fa-file-pdf"></i>
                    <div>
                        <div class="file-name">${file.name}</div>
                        <div class="file-size">${this.formatFileSize(file.size)}</div>
                    </div>
                </div>
                <button class="remove-file" data-index="${index}">
                    <i class="fas fa-times"></i>
                </button>
            `;

            const removeBtn = fileItem.querySelector('.remove-file');
            removeBtn.addEventListener('click', () => this.removeFile(index));

            this.fileList.appendChild(fileItem);
        });
    }

    removeFile(index) {
        this.files.splice(index, 1);
        this.updateFileList();

        if (this.files.length === 0) {
            this.showSection('uploadSection');
        }
    }

    clearFiles() {
        this.files = [];
        this.fileInput.value = '';
        this.showSection('uploadSection');
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    async startConversion() {
        if (this.files.length === 0) {
            this.showNotification('Please select files to convert.', 'error');
            return;
        }

        this.showSection('progressSection');
        this.showLoading(true);

        try {
            const formData = new FormData();
            this.files.forEach(file => {
                formData.append('pdfs', file);
            });

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Upload failed: ${response.statusText}`);
            }

            const result = await response.json();
            this.currentJobId = result.jobId;
            this.pollProgress();

        } catch (error) {
            this.showError(error.message);
            this.showLoading(false);
        }
    }

    async pollProgress() {
        if (!this.currentJobId) return;

        try {
            const response = await fetch(`/api/status/${this.currentJobId}`);

            if (!response.ok) {
                throw new Error(`Status check failed: ${response.statusText}`);
            }

            const status = await response.json();
            this.updateProgress(status);

            if (status.status === 'completed') {
                await this.fetchResults();
            } else if (status.status === 'failed') {
                this.showError('Conversion failed. Please try again.');
                this.showLoading(false);
            } else {
                setTimeout(() => this.pollProgress(), 1000);
            }

        } catch (error) {
            this.showError(error.message);
            this.showLoading(false);
        }
    }

    updateProgress(status) {
        const percentage = status.progress || 0;
        this.progressFill.style.width = `${percentage}%`;
        this.progressText.textContent = `${percentage}%`;

        if (status.currentFile) {
            this.addStatusMessage(`Processing: ${status.currentFile}`, 'processing');
        }

        if (status.completed && status.failed) {
            this.addStatusMessage(`Completed: ${status.completed}, Failed: ${status.failed}`, 'info');
        }

        status.messages?.forEach(message => {
            this.addStatusMessage(message.text, message.type);
        });
    }

    addStatusMessage(message, type = 'info') {
        const messageElement = document.createElement('div');
        messageElement.className = `status-message ${type}`;
        messageElement.textContent = message;

        this.statusMessages.appendChild(messageElement);
        this.statusMessages.scrollTop = this.statusMessages.scrollHeight;

        if (this.statusMessages.children.length > 50) {
            this.statusMessages.removeChild(this.statusMessages.firstChild);
        }
    }

    async fetchResults() {
        try {
            const response = await fetch(`/api/results/${this.currentJobId}`);

            if (!response.ok) {
                throw new Error(`Failed to fetch results: ${response.statusText}`);
            }

            this.conversionResults = await response.json();
            this.showResults();
            this.showLoading(false);

        } catch (error) {
            this.showError(error.message);
            this.showLoading(false);
        }
    }

    showResults() {
        const successful = this.conversionResults.filter(r => r.status === 'success');
        const failed = this.conversionResults.filter(r => r.status === 'error');

        // Record usage and calculate cost
        const fileData = this.files.map(file => {
            const result = this.conversionResults.find(r => r.originalName === file.name);
            return { size: file.size, success: result?.status === 'success' };
        });
        const convStats = this.usageTracker.recordConversion(fileData);
        this.updateUsageDisplay();

        // Compact summary with stats
        this.resultsSummary.innerHTML = `
            <span class="result-stat success"><i class="fas fa-check"></i> ${successful.length} converted</span>
            ${failed.length > 0 ? `<span class="result-stat error"><i class="fas fa-times"></i> ${failed.length} failed</span>` : ''}
            <span class="result-stat total"><i class="fas fa-file"></i> ${this.conversionResults.length} total</span>
            <span class="result-stat cost"><i class="fas fa-dollar-sign"></i> $${convStats.cost.toFixed(4)} est.</span>
        `;

        // Individual downloads
        this.individualDownloads.innerHTML = '';

        successful.forEach(result => {
            const downloadItem = document.createElement('div');
            downloadItem.className = 'download-item fade-in';
            downloadItem.innerHTML = `
                <span><i class="fas fa-file-alt"></i> ${result.originalName}</span>
                <a href="/api/download/${result.textFile}" download>
                    <i class="fas fa-download"></i> Download
                </a>
            `;
            this.individualDownloads.appendChild(downloadItem);
        });

        if (failed.length > 0) {
            const failedHeader = document.createElement('h4');
            failedHeader.textContent = 'Failed';
            this.individualDownloads.appendChild(failedHeader);

            failed.forEach(result => {
                const errorItem = document.createElement('div');
                errorItem.className = 'download-item';
                errorItem.innerHTML = `
                    <span><i class="fas fa-exclamation-triangle" style="color: var(--danger);"></i> ${result.originalName}</span>
                    <span style="color: var(--danger); font-size: 0.7rem;">${result.error}</span>
                `;
                this.individualDownloads.appendChild(errorItem);
            });
        }

        this.showSection('resultsSection');
    }

    async downloadAllFiles() {
        try {
            const response = await fetch(`/api/download/batch/${this.currentJobId}`);

            if (!response.ok) {
                throw new Error(`Failed to create batch download: ${response.statusText}`);
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `converted-files-${Date.now()}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

        } catch (error) {
            this.showNotification(`Failed to download all files: ${error.message}`, 'error');
        }
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.showSection('errorSection');
    }

    showSection(sectionId) {
        const sections = ['uploadSection', 'fileListSection', 'progressSection', 'resultsSection', 'errorSection'];
        sections.forEach(id => {
            const section = document.getElementById(id);
            if (section) section.style.display = 'none';
        });

        const targetSection = document.getElementById(sectionId);
        if (targetSection) {
            targetSection.style.display = 'flex';
            targetSection.classList.add('fade-in');
        }
    }

    showLoading(show) {
        this.loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 16px;
            right: 16px;
            padding: 10px 16px;
            background: ${type === 'error' ? '#7f1d1d' : '#14532d'};
            color: ${type === 'error' ? '#fca5a5' : '#86efac'};
            border: 1px solid ${type === 'error' ? '#991b1b' : '#166534'};
            border-radius: 6px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            z-index: 1001;
            max-width: 300px;
            font-size: 0.8rem;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 4000);
    }

    updateUsageDisplay() {
        const stats = this.usageTracker.getStats();
        const el = (id) => document.getElementById(id);

        if (el('statFiles')) el('statFiles').textContent = stats.files;
        if (el('statPages')) el('statPages').textContent = stats.pages;
        if (el('statTokens')) el('statTokens').textContent = stats.tokens;
        if (el('statCost')) el('statCost').textContent = stats.cost;

        // Flash animation on stat pills
        document.querySelectorAll('.stat-pill').forEach(pill => {
            pill.classList.remove('updated');
            void pill.offsetWidth; // force reflow for re-animation
            pill.classList.add('updated');
        });
    }

    resetApplication() {
        this.files = [];
        this.currentJobId = null;
        this.conversionResults = [];
        this.fileInput.value = '';
        this.statusMessages.innerHTML = '';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '0%';

        this.showSection('uploadSection');
        this.showLoading(false);
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new PDFConverter();
});

// Handle page visibility
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('Page hidden - polling paused');
    } else {
        console.log('Page visible - polling resumed');
    }
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    console.log('Page unloading - cleaning up resources');
});
