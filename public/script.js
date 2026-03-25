// PDF to Text Converter - Frontend JavaScript
class PDFConverter {
    constructor() {
        this.files = [];
        this.currentJobId = null;
        this.conversionResults = [];
        this.initializeElements();
        this.attachEventListeners();
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
            // Accept any file that ends with .pdf (case insensitive)
            const fileName = file.name.toLowerCase();
            if (!fileName.endsWith('.pdf')) {
                this.showNotification(`Only PDF files are allowed. ${file.name} was skipped.`, 'error');
                return false;
            }
            if (file.size > 100 * 1024 * 1024) { // 100MB limit
                this.showNotification(`File ${file.name} is too large. Maximum size is 100MB.`, 'error');
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) {
            return;
        }

        // Add new files, avoiding duplicates
        validFiles.forEach(file => {
            if (!this.files.some(existingFile => existingFile.name === file.name && existingFile.size === file.size)) {
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
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    async startConversion() {
        if (this.files.length === 0) {
            this.showNotification('Please select files to convert.', 'error');
            return;
        }

        this.showSection('progressSection');
        this.showLoading(true);

        try {
            // Create form data for upload
            const formData = new FormData();
            this.files.forEach(file => {
                formData.append('pdfs', file);
            });

            // Upload files and start conversion
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Upload failed: ${response.statusText}`);
            }

            const result = await response.json();
            this.currentJobId = result.jobId;

            // Start polling for progress
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
                // Continue polling
                setTimeout(() => this.pollProgress(), 1000);
            }

        } catch (error) {
            this.showError(error.message);
            this.showLoading(false);
        }
    }

    updateProgress(status) {
        // Update progress bar
        const percentage = status.progress || 0;
        this.progressFill.style.width = `${percentage}%`;
        this.progressText.textContent = `${percentage}%`;

        // Update status messages
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

        // Remove old messages to prevent memory issues
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

        // Show summary
        this.resultsSummary.innerHTML = `
            <h3>Conversion Summary</h3>
            <p><strong>Successfully converted:</strong> ${successful.length} files</p>
            <p><strong>Failed:</strong> ${failed.length} files</p>
            <p><strong>Total:</strong> ${this.conversionResults.length} files</p>
        `;

        // Show individual downloads
        this.individualDownloads.innerHTML = '<h3>Individual Downloads</h3>';
        
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
            const failedSection = document.createElement('div');
            failedSection.innerHTML = '<h4>Failed Files</h4>';
            failed.forEach(result => {
                const errorItem = document.createElement('div');
                errorItem.className = 'download-item';
                errorItem.innerHTML = `
                    <span><i class="fas fa-exclamation-triangle" style="color: #dc3545;"></i> ${result.originalName}</span>
                    <span style="color: #dc3545;">${result.error}</span>
                `;
                failedSection.appendChild(errorItem);
            });
            this.individualDownloads.appendChild(failedSection);
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
        // Hide all sections
        const sections = ['uploadSection', 'fileListSection', 'progressSection', 'resultsSection', 'errorSection'];
        sections.forEach(id => {
            const section = document.getElementById(id);
            if (section) {
                section.style.display = 'none';
            }
        });

        // Show the requested section
        const targetSection = document.getElementById(sectionId);
        if (targetSection) {
            targetSection.style.display = 'block';
            targetSection.classList.add('fade-in');
        }
    }

    showLoading(show) {
        this.loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    showNotification(message, type = 'info') {
        // Create a simple notification (could be enhanced with a toast library)
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'error' ? '#dc3545' : '#28a745'};
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.2);
            z-index: 1001;
            max-width: 300px;
            word-wrap: break-word;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        // Remove notification after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
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

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new PDFConverter();
});

// Handle page visibility changes to pause/resume polling
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page is hidden, could pause polling to save resources
        console.log('Page hidden - polling paused');
    } else {
        // Page is visible, resume polling if needed
        console.log('Page visible - polling resumed');
    }
});

// Handle page unload to clean up resources
window.addEventListener('beforeunload', () => {
    // Could notify server about client disconnect
    console.log('Page unloading - cleaning up resources');
});
