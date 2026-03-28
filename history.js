// Persistent history store for converted documents
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const RETENTION_DAYS = 30;

class HistoryStore {
    constructor() {
        fs.ensureDirSync(path.dirname(HISTORY_FILE));
        this.data = this._load();
        this.cleanup(); // Remove expired entries on startup
    }

    _load() {
        try {
            if (fs.existsSync(HISTORY_FILE)) {
                return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Failed to load history, starting fresh:', e.message);
        }
        return { entries: [] };
    }

    _save() {
        try {
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error('Failed to save history:', e.message);
        }
    }

    add(entry) {
        const record = {
            id: uuidv4(),
            originalFilename: entry.originalFilename,
            textFilename: entry.textFilename,
            timestamp: Date.now(),
            fileSize: entry.fileSize || 0,
            pageCount: entry.pageCount || 1,
            extractionMethod: entry.extractionMethod || 'unknown',
            cost: entry.cost || 0,
            status: entry.status || 'success'
        };
        this.data.entries.unshift(record); // newest first
        this._save();
        return record;
    }

    getAll() {
        return this.data.entries;
    }

    getById(id) {
        return this.data.entries.find(e => e.id === id);
    }

    findByTextFilename(textFilename) {
        return this.data.entries.find(e => e.textFilename === textFilename);
    }

    save() {
        this._save();
    }

    remove(id, textsDir) {
        const entry = this.getById(id);
        if (!entry) return false;

        // Delete the text file from disk
        if (entry.textFilename && textsDir) {
            const filePath = path.join(textsDir, entry.textFilename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        this.data.entries = this.data.entries.filter(e => e.id !== id);
        this._save();
        return true;
    }

    cleanup() {
        const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const expired = this.data.entries.filter(e => e.timestamp < cutoff);

        if (expired.length === 0) return;

        // Delete expired text files
        const textsDir = path.join(__dirname, 'uploads', 'texts');
        for (const entry of expired) {
            if (entry.textFilename) {
                const filePath = path.join(textsDir, entry.textFilename);
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
                }
            }
        }

        this.data.entries = this.data.entries.filter(e => e.timestamp >= cutoff);
        this._save();
        console.log(`History cleanup: removed ${expired.length} expired entries`);
    }

    getTextFiles(textsDir) {
        // Returns array of { filename, filepath } for all valid entries
        return this.data.entries
            .filter(e => e.status === 'success' && e.textFilename)
            .map(e => ({
                filename: e.originalFilename.replace(/\.pdf$/i, '.txt'),
                filepath: path.join(textsDir, e.textFilename)
            }))
            .filter(f => fs.existsSync(f.filepath));
    }
}

module.exports = HistoryStore;
