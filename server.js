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
app.use(express.static('public'));

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

// Job cleanup interval (remove jobs older than 1 hour)
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        if (now - job.createdAt > 3600000) { // 1 hour
            cleanupJob(jobId);
        }
    }
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
    maxVisionPages: parseInt(process.env.MAX_VISION_PAGES) || 10,
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

        const jobId = uuidv4();
        const job = {
            id: jobId,
            files: req.files.map(file => ({
                originalName: file.originalname,
                filename: file.filename,
                path: file.path,
                size: file.size
            })),
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

    res.download(filePath, (err) => {
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
            const filePath = path.join('uploads/texts', result.textFile);
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

// Get server config (model + pricing for frontend)
app.get('/api/config', (req, res) => {
    res.json({
        model: process.env.OPENROUTER_MODEL || 'google/gemini-flash-2.0',
        pricing: {
            inputPerMillion: 0.10,
            outputPerMillion: 0.40
        }
    });
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

                // Process the PDF file
                const result = await pdfProcessor.processPDF(file.path, file.originalName);
                
                job.results.push(result);
                
                if (result.status === 'success') {
                    job.completed++;
                    // Save to persistent history — only vision has real API costs
                    const pageCount = result.pageCount || 1;
                    const usage = result.usage || { promptTokens: 0, completionTokens: 0 };
                    const actualCost = result.extractionMethod === 'vision'
                        ? (usage.promptTokens * 0.10 + usage.completionTokens * 0.40) / 1_000_000
                        : 0;
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
                    error: error.message
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

        // Text files are now managed by HistoryStore (30-day retention)
        // Do NOT delete them here — they persist for the user's document library

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
        // Refresh health every 5 minutes
        setInterval(async () => {
            cachedHealth = await pdfProcessor.checkDependencies();
        }, 300000);

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
