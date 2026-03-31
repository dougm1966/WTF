// Load environment variables
require('dotenv').config();

// PDF to Text Converter - Backend Server
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const archiver = require('archiver');
const mime = require('mime-types');

// Import PDF processing functionality
const EnhancedPDFProcessor = require('./pdf-processor-enhanced');
const HistoryStore = require('./history');

// Available vision models
const AVAILABLE_MODELS = [
    { id: 'meta-llama/llama-4-scout',             name: 'Fast',           inputPerMillion: 0.08,  outputPerMillion: 0.30, provider: { order: ['Groq'], allow_fallbacks: true } },
    { id: 'google/gemini-3.1-flash-lite-preview', name: 'Better Quality', inputPerMillion: 0.25,  outputPerMillion: 1.50, provider: null },
];

const CLEANUP_MODEL = 'meta-llama/llama-3.3-70b-instruct';
const CLEANUP_PROVIDER = { order: ['Groq'], allow_fallbacks: true };
const CLEANUP_PRICING = { inputPerMillion: 0.12, outputPerMillion: 0.12 };

function getModelPricing(modelId) {
    return AVAILABLE_MODELS.find(m => m.id === modelId) || AVAILABLE_MODELS[0];
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Configure logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ 
            filename: 'logs/error.log', 
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        new winston.transports.File({ 
            filename: 'logs/combined.log',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
            connectSrc: ["'self'"]
        }
    }
}));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static('public', {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
        // No caching for HTML/JS/CSS — forces fresh fetch every time
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Ensure required directories exist
const ensureDirectories = async () => {
    const dirs = ['uploads/pdfs', 'uploads/texts', 'uploads/temp', 'logs', 'data'];
    for (const dir of dirs) {
        await fs.ensureDir(dir);
    }
};

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/pdfs/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const fileFilter = (req, file, cb) => {
    // Accept all PDF files regardless of their specific MIME type
    // Some fillable PDFs may have different MIME types
    if (file.mimetype === 'application/pdf' || 
        file.mimetype === 'application/x-pdf' ||
        file.mimetype === 'application/x-bzpdf' ||
        file.mimetype === 'application/x-gzpdf' ||
        file.originalname.toLowerCase().endsWith('.pdf')) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF files are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024, // 100MB limit per file
        files: parseInt(process.env.MAX_FILES_PER_BATCH) || 100 // Maximum 100 files at once
    }
});

// Job management
const jobs = new Map();
const classifications = new Map();
const FILE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — max time any file stays on disk

// Cleanup interval — remove jobs, classifications, and orphaned files older than TTL
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        if (now - job.createdAt > FILE_TTL_MS) {
            cleanupJob(jobId);
        }
    }
    for (const [cid, cls] of classifications.entries()) {
        if (now - cls.createdAt > FILE_TTL_MS) {
            // Clean up uploaded PDFs that were never converted
            for (const file of cls.files) {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            }
            classifications.delete(cid);
        }
    }
    // Clean expired text files from history and sweep orphans
    history.cleanupFiles();
    sweepOrphanedFiles();
}, 300000); // Run every 5 minutes

// Initialize PDF processor
const pdfProcessor = new EnhancedPDFProcessor({
    concurrency: parseInt(process.env.CONCURRENT_PROCESSING) || 3,
    tempDir: 'uploads/temp',
    outputDir: 'uploads/texts',
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openRouterModel: process.env.OPENROUTER_MODEL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    useOCR: true,
    useVision: true,
    logger: logger
});

// Cached dependency health (refreshed on startup and periodically)
let cachedHealth = null;

// Initialize history store
const history = new HistoryStore();

// Run history cleanup daily
setInterval(() => history.cleanup(), 24 * 60 * 60 * 1000);

// Routes

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        activeJobs: jobs.size,
        dependencies: cachedHealth
    });
});

// Upload files and start conversion
app.post('/api/upload', upload.array('pdfs'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const selectedModel = req.body.model || AVAILABLE_MODELS[0].id;
        const modelConfig = getModelPricing(selectedModel);

        const jobId = uuidv4();
        const job = {
            id: jobId,
            files: req.files.map(file => ({
                originalName: file.originalname,
                filename: file.filename,
                path: file.path,
                size: file.size
            })),
            model: selectedModel,
            modelPricing: modelConfig,
            status: 'queued',
            progress: 0,
            completed: 0,
            failed: 0,
            total: req.files.length,
            results: [],
            createdAt: Date.now(),
            messages: []
        };

        jobs.set(jobId, job);

        // Start processing asynchronously
        processJob(jobId);

        logger.info(`Job ${jobId} created with ${req.files.length} files`);

        res.json({
            jobId: jobId,
            status: 'queued',
            files: req.files.length
        });

    } catch (error) {
        logger.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get job status
app.get('/api/status/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
        status: job.status,
        progress: Math.round((job.completed / job.total) * 100),
        completed: job.completed,
        failed: job.failed,
        total: job.total,
        currentFile: job.currentFile,
        messages: job.messages.slice(-10) // Return last 10 messages
    });
});

// Get job results
app.get('/api/results/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'completed') {
        return res.status(400).json({ error: 'Job not completed yet' });
    }

    res.json(job.results);
});

// Download individual text file
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join('uploads/texts', filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const displayName = req.query.name || filename;

    res.download(filePath, displayName, (err) => {
        if (err) {
            logger.error('Download error:', err);
            res.status(500).json({ error: 'Download failed' });
        }
    });
});

// Download all files as ZIP
app.get('/api/download/batch/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'completed') {
        return res.status(400).json({ error: 'Job not completed yet' });
    }

    try {
        // Create ZIP archive
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        res.attachment(`converted-files-${jobId}.zip`);
        archive.pipe(res);

        // Add all successful text files to the archive
        const successfulResults = job.results.filter(r => r.status === 'success');
        
        for (const result of successfulResults) {
            const cleanFile = result.textFile.replace(/\.txt$/, '.clean.txt');
            const cleanPath = path.join('uploads/texts', cleanFile);
            const rawPath = path.join('uploads/texts', result.textFile);
            const filePath = fs.existsSync(cleanPath) ? cleanPath : rawPath;
            if (fs.existsSync(filePath)) {
                archive.file(filePath, { name: result.originalName.replace('.pdf', '.txt') });
            }
        }

        archive.finalize();

    } catch (error) {
        logger.error('Batch download error:', error);
        res.status(500).json({ error: 'Batch download failed' });
    }
});

// Clean up job files
app.delete('/api/cleanup/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    cleanupJob(jobId);
    res.json({ message: 'Job cleaned up successfully' });
});

// ── History API ──

// Get all history entries
app.get('/api/history', (req, res) => {
    res.json(history.getAll());
});

// Delete a history entry
app.delete('/api/history/:id', (req, res) => {
    const removed = history.remove(req.params.id, 'uploads/texts');
    if (removed) {
        res.json({ message: 'Entry deleted' });
    } else {
        res.status(404).json({ error: 'Entry not found' });
    }
});

// Export all history as ZIP
app.get('/api/history/export', async (req, res) => {
    const textFiles = history.getTextFiles('uploads/texts');
    if (textFiles.length === 0) {
        return res.status(404).json({ error: 'No files to export' });
    }

    try {
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('pdf2txt-export.zip');
        archive.pipe(res);

        for (const file of textFiles) {
            archive.file(file.filepath, { name: file.filename });
        }

        archive.finalize();
    } catch (error) {
        logger.error('History export error:', error);
        res.status(500).json({ error: 'Export failed' });
    }
});

// ── AI Cleanup API ──

// Single-file cleanup
app.post('/api/cleanup', express.json(), async (req, res) => {
    try {
        const { filename, originalName } = req.body;
        if (!filename) {
            return res.status(400).json({ error: 'Missing filename' });
        }

        const rawPath = path.join('uploads/texts', filename);
        if (!fs.existsSync(rawPath)) {
            return res.status(404).json({ error: 'Text file not found' });
        }

        const rawText = await fs.promises.readFile(rawPath, 'utf8');
        const cleanup = await pdfProcessor.aiCleanupText(rawText, CLEANUP_MODEL, CLEANUP_PROVIDER);

        const cleanFilename = filename.replace(/\.txt$/, '.clean.txt');
        const cleanPath = path.join('uploads/texts', cleanFilename);
        await fs.promises.writeFile(cleanPath, cleanup.text, 'utf8');

        const cleanupCost = (cleanup.usage.promptTokens * CLEANUP_PRICING.inputPerMillion
            + cleanup.usage.completionTokens * CLEANUP_PRICING.outputPerMillion) / 1_000_000;

        // Update history entry with cleanup cost
        const entry = history.findByTextFilename(filename);
        if (entry) {
            entry.cleanTextFilename = cleanFilename;
            entry.cleanupCost = cleanupCost;
            entry.cost = (entry.cost || 0) + cleanupCost;
            history.save();
        }

        logger.info(`[Cleanup] ${originalName || filename}: ${cleanup.usage.promptTokens + cleanup.usage.completionTokens} tokens, $${cleanupCost.toFixed(6)}`);

        res.json({
            status: 'success',
            cleanTextFile: cleanFilename,
            cleanupUsage: cleanup.usage,
            cost: cleanupCost
        });
    } catch (error) {
        logger.error('Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Batch cleanup — creates a job for polling
app.post('/api/cleanup-batch', express.json(), async (req, res) => {
    try {
        const { files } = req.body;
        if (!files || !files.length) {
            return res.status(400).json({ error: 'No files provided' });
        }

        const jobId = uuidv4();
        const job = {
            id: jobId,
            type: 'cleanup',
            files: files,
            status: 'processing',
            progress: 0,
            completed: 0,
            failed: 0,
            total: files.length,
            results: [],
            createdAt: Date.now(),
            messages: [{ text: 'Starting AI cleanup...', type: 'info' }]
        };

        jobs.set(jobId, job);

        // Process cleanup asynchronously
        (async () => {
            try {
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    job.messages.push({ text: `Cleaning: ${file.originalName || file.filename}`, type: 'processing' });

                    try {
                        const rawPath = path.join('uploads/texts', file.filename);
                        if (!fs.existsSync(rawPath)) {
                            throw new Error('Text file not found');
                        }

                        const rawText = await fs.promises.readFile(rawPath, 'utf8');
                        const cleanup = await pdfProcessor.aiCleanupText(rawText, CLEANUP_MODEL, CLEANUP_PROVIDER);

                        const cleanFilename = file.filename.replace(/\.txt$/, '.clean.txt');
                        const cleanPath = path.join('uploads/texts', cleanFilename);
                        await fs.promises.writeFile(cleanPath, cleanup.text, 'utf8');

                        const cleanupCost = (cleanup.usage.promptTokens * CLEANUP_PRICING.inputPerMillion
                            + cleanup.usage.completionTokens * CLEANUP_PRICING.outputPerMillion) / 1_000_000;

                        // Update history
                        const entry = history.findByTextFilename(file.filename);
                        if (entry) {
                            entry.cleanTextFilename = cleanFilename;
                            entry.cleanupCost = cleanupCost;
                            entry.cost = (entry.cost || 0) + cleanupCost;
                            history.save();
                        }

                        job.results.push({
                            originalName: file.originalName,
                            filename: file.filename,
                            cleanTextFile: cleanFilename,
                            cleanupUsage: cleanup.usage,
                            cost: cleanupCost,
                            status: 'success'
                        });
                        job.completed++;
                        job.messages.push({ text: `Cleaned: ${file.originalName || file.filename}`, type: 'success' });
                    } catch (err) {
                        job.results.push({
                            originalName: file.originalName,
                            filename: file.filename,
                            status: 'error',
                            error: err.message
                        });
                        job.failed++;
                        job.messages.push({ text: `Cleanup failed: ${file.originalName || file.filename} - ${err.message}`, type: 'error' });
                    }

                    job.progress = Math.round(((i + 1) / files.length) * 100);
                }

                job.status = 'completed';
                job.messages.push({ text: `Cleanup complete: ${job.completed} cleaned, ${job.failed} failed`, type: 'info' });
            } catch (error) {
                job.status = 'failed';
                job.messages.push({ text: `Cleanup batch failed: ${error.message}`, type: 'error' });
            }
        })();

        res.json({ jobId, status: 'processing', total: files.length });
    } catch (error) {
        logger.error('Batch cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get server config (available models + pricing for frontend)
app.get('/api/config', (req, res) => {
    res.json({
        models: AVAILABLE_MODELS,
        defaultModel: AVAILABLE_MODELS[0].id,
        cleanupModel: CLEANUP_MODEL,
        cleanupAvailable: !!process.env.OPENROUTER_API_KEY
    });
});

// ── Vision Diagnostic Endpoint ──

// Minimal 1x1 white PNG for testing (68 bytes)
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

app.get('/api/vision-test', async (req, res) => {
    const result = {
        apiKeySet: !!process.env.OPENROUTER_API_KEY,
        keyValid: false,
        keyLabel: null,
        models: {},
        testCall: null
    };

    if (!process.env.OPENROUTER_API_KEY) {
        return res.json({ ...result, error: 'OPENROUTER_API_KEY not set in environment' });
    }

    // Step 1: Validate API key
    try {
        const keyRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
            headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
        });
        if (keyRes.ok) {
            const keyData = await keyRes.json();
            result.keyValid = true;
            result.keyLabel = keyData.data?.label || 'unlabeled';
        } else {
            result.keyValid = false;
            result.keyLabel = `HTTP ${keyRes.status}`;
        }
    } catch (e) {
        result.keyLabel = `Error: ${e.message}`;
    }

    // Step 2: Validate model IDs
    try {
        const modelsRes = await fetch('https://openrouter.ai/api/v1/models');
        if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            const validIds = new Set((modelsData.data || []).map(m => m.id));
            for (const model of AVAILABLE_MODELS) {
                result.models[model.id] = validIds.has(model.id) ? 'valid' : 'NOT FOUND';
            }
            result.models[CLEANUP_MODEL] = validIds.has(CLEANUP_MODEL) ? 'valid' : 'NOT FOUND';
        }
    } catch (e) {
        result.models._error = e.message;
    }

    // Step 3: Test cleanup model (text completion)
    try {
        const start = Date.now();
        const cleanupRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'X-Title': 'Pdf2Txt Cleanup Test'
            },
            body: JSON.stringify({
                model: CLEANUP_MODEL,
                messages: [
                    { role: 'system', content: 'You are a text formatter. Return only cleaned text.' },
                    { role: 'user', content: 'Hello world.' }
                ],
                max_tokens: 50
            })
        });
        const latency = Date.now() - start;
        const cleanupBody = await cleanupRes.text();
        result.cleanupTest = {
            model: CLEANUP_MODEL,
            success: cleanupRes.ok,
            status: cleanupRes.status,
            latencyMs: latency,
            response: cleanupBody.substring(0, 500)
        };
    } catch (e) {
        result.cleanupTest = { success: false, error: e.message };
    }

    // Step 4: Test vision call with tiny image
    try {
        const start = Date.now();
        const testModel = AVAILABLE_MODELS[0].id;
        const testRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'X-Title': 'Pdf2Txt Vision Test'
            },
            body: JSON.stringify({
                model: testModel,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe this image in one word.' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_PNG_BASE64}` } }
                    ]
                }],
                max_tokens: 50
            })
        });
        const latency = Date.now() - start;
        const body = await testRes.text();
        result.testCall = {
            model: testModel,
            success: testRes.ok,
            status: testRes.status,
            latencyMs: latency,
            response: body.substring(0, 500)
        };
        if (!testRes.ok) {
            result.testCall.error = body.substring(0, 1000);
        }
    } catch (e) {
        result.testCall = { success: false, error: e.message };
    }

    res.json(result);
});

// ── Classification API ──

// Classify uploaded PDFs into text/ocr/vision groups
app.post('/api/classify', upload.array('pdfs'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const classificationId = uuidv4();

        // Classify files in parallel (batches of 5 to avoid overwhelming Ghostscript)
        const CLASSIFY_CONCURRENCY = 5;
        const fileInfos = req.files.map(file => ({
            originalName: file.originalname,
            filename: file.filename,
            path: file.path,
            size: file.size
        }));

        const fileResults = [];
        for (let i = 0; i < fileInfos.length; i += CLASSIFY_CONCURRENCY) {
            const batch = fileInfos.slice(i, i + CLASSIFY_CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map(async (fileInfo) => {
                    const result = await pdfProcessor.classifyPDF(fileInfo.path);
                    return { ...fileInfo, pageCount: result.pageCount, classification: result.classification, confidence: result.confidence };
                })
            );
            results.forEach((r, idx) => {
                if (r.status === 'fulfilled') {
                    fileResults.push(r.value);
                } else {
                    logger.warn(`Classification failed for ${batch[idx].originalName}: ${r.reason?.message}`);
                    fileResults.push({ ...batch[idx], pageCount: 1, classification: 'vision', confidence: 'low' });
                }
            });
        }

        classifications.set(classificationId, {
            id: classificationId,
            files: fileResults,
            createdAt: Date.now()
        });

        logger.info(`Classification ${classificationId}: ${fileResults.length} files classified`);

        res.json({
            classificationId,
            files: fileResults.map(f => ({
                originalName: f.originalName,
                filename: f.filename,
                size: f.size,
                pageCount: f.pageCount,
                classification: f.classification,
                confidence: f.confidence
            }))
        });

    } catch (error) {
        logger.error('Classification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Check if a classification still exists (for session restore after refresh)
app.get('/api/classify/:classificationId/check', (req, res) => {
    const cls = classifications.get(req.params.classificationId);
    if (!cls) {
        return res.status(404).json({ exists: false });
    }
    res.json({ exists: true, fileCount: cls.files.length, createdAt: cls.createdAt });
});

// Convert a group of already-classified files
app.post('/api/convert-group', express.json(), async (req, res) => {
    try {
        const { classificationId, files, model, forceMethod } = req.body;

        if (!classificationId || !files || !files.length) {
            return res.status(400).json({ error: 'Missing classificationId or files' });
        }

        const cls = classifications.get(classificationId);
        if (!cls) {
            return res.status(404).json({ error: 'Classification not found or expired' });
        }

        // Resolve file paths from the classification record
        const resolvedFiles = [];
        for (const reqFile of files) {
            const match = cls.files.find(f => f.filename === reqFile.filename);
            if (match && fs.existsSync(match.path)) {
                resolvedFiles.push(match);
            } else {
                logger.warn(`File not found for conversion: ${reqFile.filename}`);
            }
        }

        if (resolvedFiles.length === 0) {
            return res.status(400).json({ error: 'No valid files found' });
        }

        const selectedModel = model || AVAILABLE_MODELS[0].id;
        const modelConfig = getModelPricing(selectedModel);
        const modelProvider = AVAILABLE_MODELS.find(m => m.id === selectedModel)?.provider || null;

        const jobId = uuidv4();
        const job = {
            id: jobId,
            files: resolvedFiles.map(f => ({
                originalName: f.originalName,
                filename: f.filename,
                path: f.path,
                size: f.size
            })),
            model: selectedModel,
            modelPricing: modelConfig,
            modelProvider,
            forceMethod: forceMethod || null,
            status: 'queued',
            progress: 0,
            completed: 0,
            failed: 0,
            total: resolvedFiles.length,
            results: [],
            createdAt: Date.now(),
            messages: []
        };

        jobs.set(jobId, job);
        processJob(jobId);

        logger.info(`Group conversion job ${jobId}: ${resolvedFiles.length} files, method: ${forceMethod || 'auto'}`);

        res.json({
            jobId,
            status: 'queued',
            files: resolvedFiles.length
        });

    } catch (error) {
        logger.error('Convert-group error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Process job function
async function processJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
        job.status = 'processing';
        job.messages.push({ text: 'Starting conversion...', type: 'info' });

        // Process files in batches
        for (let i = 0; i < job.files.length; i++) {
            const file = job.files[i];
            job.currentFile = file.originalName;

            try {
                job.messages.push({ 
                    text: `Processing: ${file.originalName}`, 
                    type: 'processing' 
                });

                // Process the PDF file with selected model and optional forced method
                const result = await pdfProcessor.processPDF(file.path, file.originalName, {
                    model: job.model,
                    modelProvider: job.modelProvider || null,
                    forceMethod: job.forceMethod || null
                });

                job.results.push(result);

                if (result.status === 'success') {
                    job.completed++;
                    // Save to persistent history — only vision has real extraction costs
                    const pageCount = result.pageCount || 1;
                    const usage = result.usage || { promptTokens: 0, completionTokens: 0 };
                    const pricing = job.modelPricing;
                    const actualCost = result.extractionMethod === 'vision'
                        ? (usage.promptTokens * pricing.inputPerMillion + usage.completionTokens * pricing.outputPerMillion) / 1_000_000
                        : 0;
                    result.cost = actualCost;
                    history.add({
                        originalFilename: file.originalName,
                        textFilename: result.textFile,
                        fileSize: file.size,
                        pageCount: pageCount,
                        extractionMethod: result.extractionMethod,
                        inputTokens: usage.promptTokens,
                        outputTokens: usage.completionTokens,
                        cost: actualCost,
                        status: 'success'
                    });
                    job.messages.push({
                        text: `Successfully converted: ${file.originalName}`,
                        type: 'success'
                    });
                } else {
                    job.failed++;
                    const errorMsg = result.errorDetails
                        ? Object.entries(result.errorDetails).map(([k, v]) => `${k}: ${v}`).join('; ')
                        : result.error;
                    job.messages.push({
                        text: `Failed to convert: ${file.originalName} - ${errorMsg}`,
                        type: 'error'
                    });
                }

                // Update progress
                job.progress = Math.round(((job.completed + job.failed) / job.total) * 100);

            } catch (error) {
                job.failed++;
                job.results.push({
                    originalName: file.originalName,
                    status: 'error',
                    error: error.message,
                    cost: 0
                });
                
                job.messages.push({ 
                    text: `Error processing ${file.originalName}: ${error.message}`, 
                    type: 'error' 
                });
            }
        }

        job.status = 'completed';
        job.currentFile = null;
        job.messages.push({ 
            text: `Conversion completed. Success: ${job.completed}, Failed: ${job.failed}`, 
            type: 'info' 
        });

        logger.info(`Job ${jobId} completed. Success: ${job.completed}, Failed: ${job.failed}`);

    } catch (error) {
        job.status = 'failed';
        job.messages.push({ 
            text: `Job failed: ${error.message}`, 
            type: 'error' 
        });
        logger.error(`Job ${jobId} failed:`, error);
    }
}

// Clean up job function
function cleanupJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
        // Remove uploaded PDF files
        for (const file of job.files) {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        }

        // Remove converted text files (2-hour TTL for all files on disk)
        const textsDir = path.join(__dirname, 'uploads', 'texts');
        for (const result of (job.results || [])) {
            if (result.textFile) {
                const textPath = path.join(textsDir, result.textFile);
                if (fs.existsSync(textPath)) {
                    fs.unlinkSync(textPath);
                }
            }
        }

        // Remove job from memory
        jobs.delete(jobId);

        logger.info(`Job ${jobId} cleaned up successfully`);

    } catch (error) {
        logger.error(`Error cleaning up job ${jobId}:`, error);
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    logger.error('Unhandled error:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 50MB per file.' });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Too many files. Maximum is 100 files at once.' });
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ error: 'Unexpected file field.' });
        }
    }
    
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    
    // Clean up all jobs
    for (const jobId of jobs.keys()) {
        cleanupJob(jobId);
    }
    
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    
    // Clean up all jobs
    for (const jobId of jobs.keys()) {
        cleanupJob(jobId);
    }
    
    process.exit(0);
});

// Safety net: sweep any orphaned files older than TTL from all upload dirs
function sweepOrphanedFiles() {
    const dirs = ['uploads/pdfs', 'uploads/texts', 'uploads/temp'];
    const cutoff = Date.now() - FILE_TTL_MS;
    for (const dir of dirs) {
        const fullDir = path.join(__dirname, dir);
        if (!fs.existsSync(fullDir)) continue;
        try {
            const files = fs.readdirSync(fullDir);
            for (const file of files) {
                const filePath = path.join(fullDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile() && stat.mtimeMs < cutoff) {
                        fs.unlinkSync(filePath);
                        logger.info(`Swept orphaned file: ${dir}/${file}`);
                    }
                } catch (e) { /* ignore individual file errors */ }
            }
        } catch (e) {
            logger.warn(`Could not sweep directory ${dir}:`, e.message);
        }
    }
}

// Start server
async function startServer() {
    try {
        await ensureDirectories();

        // Run dependency health check
        cachedHealth = await pdfProcessor.checkDependencies();
        logger.info('Dependency health check:', cachedHealth);
        if (!cachedHealth.ghostscript.available) {
            logger.error('Ghostscript NOT available — scanned PDF processing will fail');
        }
        if (!cachedHealth.visionAPI.available && pdfProcessor.useVision) {
            logger.warn('Vision API not reachable — Vision extraction will fail');
        }

        // Validate OpenRouter API key and model IDs
        if (process.env.OPENROUTER_API_KEY) {
            try {
                const keyRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
                    headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
                });
                if (keyRes.ok) {
                    const keyData = await keyRes.json();
                    logger.info(`OpenRouter API key valid (label: ${keyData.data?.label || 'none'})`);
                } else {
                    logger.error(`OpenRouter API key INVALID (HTTP ${keyRes.status}) — Vision and AI Cleanup will fail`);
                    console.error('WARNING: OpenRouter API key is invalid. Vision extraction will not work.');
                }
            } catch (e) {
                logger.warn(`Could not validate OpenRouter API key: ${e.message}`);
            }

            try {
                const modelsRes = await fetch('https://openrouter.ai/api/v1/models');
                if (modelsRes.ok) {
                    const modelsData = await modelsRes.json();
                    const validIds = new Set((modelsData.data || []).map(m => m.id));
                    const invalid = AVAILABLE_MODELS.filter(m => !validIds.has(m.id)).map(m => m.id);
                    const valid = AVAILABLE_MODELS.filter(m => validIds.has(m.id)).map(m => m.id);
                    if (valid.length > 0) logger.info(`Validated vision models: ${valid.join(', ')}`);
                    if (invalid.length > 0) {
                        logger.error(`INVALID model IDs (will fail at runtime): ${invalid.join(', ')}`);
                        console.error(`WARNING: These model IDs are not found on OpenRouter: ${invalid.join(', ')}`);
                    }
                    if (!validIds.has(CLEANUP_MODEL)) {
                        logger.error(`INVALID cleanup model: ${CLEANUP_MODEL}`);
                        console.error(`WARNING: Cleanup model ${CLEANUP_MODEL} not found on OpenRouter`);
                    }
                }
            } catch (e) {
                logger.warn(`Could not validate model IDs: ${e.message}`);
            }
        } else {
            logger.warn('OPENROUTER_API_KEY not set — Vision and AI Cleanup will not work');
            console.warn('WARNING: OPENROUTER_API_KEY not set. Vision extraction disabled.');
        }

        // Refresh health every 5 minutes
        setInterval(async () => {
            cachedHealth = await pdfProcessor.checkDependencies();
        }, 300000);

        // Clean up any orphaned files from previous runs
        sweepOrphanedFiles();
        history.cleanupFiles();

        app.listen(PORT, () => {
            logger.info(`PDF Converter server running on port ${PORT}`);
            console.log(`PDF Converter server running on port ${PORT}`);
            console.log(`Open http://localhost:${PORT} to use the application`);
        });

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer();

module.exports = app;
