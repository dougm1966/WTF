// Enhanced PDF Processing — PDF Text Extraction with OCR and Vision
const fs = require('fs-extra');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const CLEANUP_SYSTEM_PROMPT = `You are a text formatting assistant. Clean up raw text extracted from a PDF for use in a RAG (Retrieval-Augmented Generation) knowledge base.

Rules:
- PRESERVE all factual content, names, numbers, dates, and meaning exactly
- REMOVE visual artifacts: decorative lines (----, ====, ____), bullet symbols (●, ■, ▪, ►, ◆), ornamental characters, page numbers, headers/footers repeated on every page, watermark text
- REMOVE page break markers like "--- PAGE N ---" or "--- PAGE BREAK ---"
- FIX broken words split across lines (e.g., "docu-\\nment" → "document")
- FIX obvious OCR garble where the intended word is clear
- CONVERT broken tables into clear "Label: Value" format
- FORMAT as clean paragraphs with markdown ## headers where sections are apparent
- JOIN sentence fragments split by line breaks into flowing paragraphs
- DO NOT add information not in the original
- DO NOT summarize or omit content
- DO NOT add commentary about the cleanup

Return ONLY the cleaned text.`;

class EnhancedPDFProcessor {
    constructor(options = {}) {
        this.concurrency = options.concurrency || 3;
        this.tempDir = options.tempDir || 'uploads/temp';
        this.outputDir = options.outputDir || 'uploads/texts';
        this.useOCR = options.useOCR || false;
        this.useVision = options.useVision || false;
        this.maxVisionPages = null; // no page cap — process all pages
        this.logger = options.logger || console;

        // OpenRouter / OpenAI Vision config (called directly via fetch, no SDK wrapper)
        if (options.openRouterApiKey) {
            this.visionApiKey = options.openRouterApiKey;
            this.visionBaseURL = 'https://openrouter.ai/api/v1';
            this.visionModel = options.openRouterModel || 'google/gemini-flash-2.0';
            this.visionHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${options.openRouterApiKey}`,
                'X-Title': 'Pdf2Txt PDF Converter'
            };
        } else if (options.openaiApiKey) {
            this.visionApiKey = options.openaiApiKey;
            this.visionBaseURL = 'https://api.openai.com/v1';
            this.visionModel = 'gpt-4o';
            this.visionHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${options.openaiApiKey}`
            };
        }

        fs.ensureDirSync(this.tempDir);
        fs.ensureDirSync(this.outputDir);
    }

    // ─── PDF-to-Image Conversion (direct Ghostscript, no wrappers) ───

    async convertPdfToImages(filePath, { density = 150, maxPages = null } = {}) {
        const prefix = path.join(this.tempDir, `gs_${Date.now()}_`);
        const createdFiles = [];

        try {
            // Determine page count first
            const { stdout } = await execFileAsync('gs', [
                '-q', '-dNODISPLAY', '-dNOSAFER',
                '-c', `(${filePath.replace(/\\/g, '/').replace(/([()])/g, '\\$1')}) (r) file runpdfbegin pdfpagecount = quit`
            ]);
            const parsedPages = parseInt(stdout.trim());
            if (!parsedPages || parsedPages < 1) {
                this.logger.warn(`[ImageConvert] Page count command returned "${stdout.trim()}", defaulting to 1`);
            }
            const totalPages = (parsedPages && parsedPages > 0) ? parsedPages : 1;
            const pagesToConvert = maxPages ? Math.min(totalPages, maxPages) : totalPages;

            this.logger.info(`[ImageConvert] Converting ${pagesToConvert}/${totalPages} pages at ${density} DPI`);

            // Convert pages to PNG via Ghostscript directly
            const outputPattern = `${prefix}%03d.png`;
            await execFileAsync('gs', [
                '-dNOPAUSE', '-dBATCH', '-dSAFER',
                '-sDEVICE=png16m',
                `-r${density}`,
                '-dFirstPage=1',
                `-dLastPage=${pagesToConvert}`,
                `-sOutputFile=${outputPattern}`,
                filePath
            ]);

            // Read the generated PNGs into buffers
            const images = [];
            for (let i = 1; i <= pagesToConvert; i++) {
                const pagePath = `${prefix}${String(i).padStart(3, '0')}.png`;
                createdFiles.push(pagePath);

                if (await fs.pathExists(pagePath)) {
                    const buffer = await fs.readFile(pagePath);
                    if (buffer.length > 0) {
                        images.push({ buffer, page: i });
                    } else {
                        this.logger.warn(`[ImageConvert] Page ${i} produced empty image, skipping`);
                    }
                }
            }

            if (images.length === 0) {
                throw new Error('Ghostscript produced no images');
            }

            this.logger.info(`[ImageConvert] Successfully converted ${images.length} pages`);
            return images;

        } catch (error) {
            throw new Error(`PDF to image conversion failed: ${error.message}`);
        } finally {
            // Clean up all temp files matching this prefix (not just expected ones)
            try {
                const dir = path.dirname(prefix);
                const base = path.basename(prefix);
                const allFiles = await fs.readdir(dir);
                for (const f of allFiles) {
                    if (f.startsWith(base)) {
                        await fs.remove(path.join(dir, f)).catch(() => {});
                    }
                }
            } catch (e) {
                // Temp cleanup failure is non-fatal
            }
        }
    }

    // ─── Vision API (direct fetch, no SDK wrapper) ───

    async callVisionAPI(base64Image, pageNum, modelOverride) {
        const body = {
            model: modelOverride || this.visionModel,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Extract all text from this PDF page. Preserve the structure, formatting, and layout as much as possible. Include headers, paragraphs, lists, and any other text content. If there are tables, try to maintain the table structure. Return only the extracted text without any additional commentary.'
                    },
                    {
                        type: 'image_url',
                        image_url: { url: `data:image/png;base64,${base64Image}` }
                    }
                ]
            }],
            max_tokens: 4000
        };

        // Retry with exponential backoff
        const maxRetries = 3;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.visionBaseURL}/chat/completions`, {
                    method: 'POST',
                    headers: this.visionHeaders,
                    body: JSON.stringify(body)
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'unknown');
                    const status = response.status;
                    const retryable = [429, 500, 502, 503, 504].includes(status);

                    if (retryable && attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt), 10000) + Math.random() * 500;
                        this.logger.warn(`[Vision] Page ${pageNum} API ${status}, retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    const err = new Error(`API ${status}: ${errorText.substring(0, 200)}`);
                    err.status = status;
                    throw err;
                }

                const data = await response.json();
                return {
                    text: data.choices?.[0]?.message?.content || '',
                    promptTokens: data.usage?.prompt_tokens || 0,
                    completionTokens: data.usage?.completion_tokens || 0
                };

            } catch (error) {
                const isClientError = error.status && error.status >= 400 && error.status < 500 && error.status !== 429;
                if (attempt < maxRetries && error.name !== 'AbortError' && !isClientError) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 10000) + Math.random() * 500;
                    this.logger.warn(`[Vision] Page ${pageNum} error "${error.message}", retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw error;
            }
        }
    }

    // ─── AI Text Cleanup ───

    async callTextAPI(text, systemPrompt, model) {
        const body = {
            model: model || 'google/gemini-flash-2.0',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            max_tokens: 8000
        };

        const maxRetries = 3;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.visionBaseURL}/chat/completions`, {
                    method: 'POST',
                    headers: this.visionHeaders,
                    body: JSON.stringify(body)
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'unknown');
                    const status = response.status;
                    const retryable = [429, 500, 502, 503, 504].includes(status);

                    if (retryable && attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt), 10000) + Math.random() * 500;
                        this.logger.warn(`[TextAPI] ${status}, retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    const err = new Error(`API ${status}: ${errorText.substring(0, 200)}`);
                    err.status = status;
                    throw err;
                }

                const data = await response.json();
                return {
                    text: data.choices?.[0]?.message?.content || '',
                    promptTokens: data.usage?.prompt_tokens || 0,
                    completionTokens: data.usage?.completion_tokens || 0
                };

            } catch (error) {
                const isClientError = error.status && error.status >= 400 && error.status < 500 && error.status !== 429;
                if (attempt < maxRetries && error.name !== 'AbortError' && !isClientError) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 10000) + Math.random() * 500;
                    this.logger.warn(`[TextAPI] Error "${error.message}", retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw error;
            }
        }
    }

    async aiCleanupText(text, model) {
        const CHUNK_CHAR_LIMIT = 12000;
        const pagePattern = /---\s*PAGE\s+(?:BREAK|\d+)\s*---/g;

        // Split into pages, then batch into chunks
        const pages = text.split(pagePattern).filter(p => p.trim().length > 0);
        const chunks = [];
        let current = '';

        for (const page of pages) {
            if (current.length + page.length > CHUNK_CHAR_LIMIT && current.length > 0) {
                chunks.push(current);
                current = page;
            } else {
                current += (current ? '\n\n' : '') + page;
            }
        }
        if (current.trim()) chunks.push(current);

        // If no chunks (empty text), return as-is
        if (chunks.length === 0) return { text, usage: { promptTokens: 0, completionTokens: 0 } };

        this.logger.info(`[AICleanup] Processing ${chunks.length} chunk(s) with ${model || 'default model'}`);

        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        const cleanedChunks = [];

        for (let i = 0; i < chunks.length; i++) {
            this.logger.info(`[AICleanup] Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
            const result = await this.callTextAPI(chunks[i], CLEANUP_SYSTEM_PROMPT, model);
            cleanedChunks.push(result.text);
            totalPromptTokens += result.promptTokens;
            totalCompletionTokens += result.completionTokens;
        }

        return {
            text: cleanedChunks.join('\n\n'),
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
        };
    }

    // ─── Dependency Health Check ───

    async checkDependencies() {
        const results = {
            ghostscript: { available: false, version: null },
            graphicsMagick: { available: false, version: null },
            tesseract: { available: false },
            visionAPI: { available: false, model: null },
            tempDir: { writable: false }
        };

        // Ghostscript
        try {
            const { stdout } = await execFileAsync('gs', ['--version']);
            results.ghostscript = { available: true, version: stdout.trim() };
        } catch (e) {
            results.ghostscript.error = e.message;
        }

        // GraphicsMagick (informational only — we don't depend on it anymore)
        try {
            const { stdout } = await execFileAsync('gm', ['version']);
            const match = stdout.match(/GraphicsMagick\s+([\d.]+)/);
            results.graphicsMagick = { available: true, version: match ? match[1] : 'unknown' };
        } catch (e) {
            results.graphicsMagick.error = e.message;
        }

        // Tesseract — just check the module loaded (don't try to recognize junk data)
        results.tesseract = { available: typeof Tesseract.recognize === 'function' };

        // Vision API connectivity
        if (this.visionApiKey) {
            try {
                const res = await fetch(`${this.visionBaseURL}/models`, {
                    headers: { 'Authorization': `Bearer ${this.visionApiKey}` }
                });
                results.visionAPI = { available: res.ok, model: this.visionModel, status: res.status };
            } catch (e) {
                results.visionAPI.error = e.message;
            }
        }

        // Temp dir writable
        try {
            const testFile = path.join(this.tempDir, `.health_${Date.now()}`);
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
            results.tempDir = { writable: true };
        } catch (e) {
            results.tempDir.error = e.message;
        }

        results.allHealthy = results.ghostscript.available &&
            results.tempDir.writable &&
            (this.visionApiKey ? results.visionAPI.available : true);

        return results;
    }

    // ─── Page Count Helper ───

    async getPageCount(filePath) {
        try {
            const { stdout } = await execFileAsync('gs', [
                '-q', '-dNODISPLAY', '-dNOSAFER',
                '-c', `(${filePath.replace(/\\/g, '/').replace(/([()])/g, '\\$1')}) (r) file runpdfbegin pdfpagecount = quit`
            ]);
            const parsed = parseInt(stdout.trim());
            return (parsed && parsed > 0) ? parsed : 1;
        } catch (e) {
            return 1;
        }
    }

    // ─── Pre-Classification ───

    async classifyPDF(filePath) {
        let pageCount = 1;

        // Step 1: Try pdf-parse (fast, ~50ms)
        try {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdfParse(dataBuffer);
            pageCount = data.numpages || 1;
            if (this.isExtractionSuccessful(data)) {
                return { classification: 'text', pageCount, confidence: 'high' };
            }
        } catch (e) {
            // pdf-parse failed — try to get page count via Ghostscript
            pageCount = await this.getPageCount(filePath);
        }

        // Step 2: Quick OCR probe — convert page 1 only, run Tesseract
        if (this.useOCR) {
            try {
                const images = await this.convertPdfToImages(filePath, { density: 150, maxPages: 1 });
                if (images.length > 0) {
                    const { data: { text } } = await Tesseract.recognize(images[0].buffer, 'eng');
                    const readable = (text.match(/[a-zA-Z0-9\s.,!?;:]/g) || []).length;
                    if (text.trim().length > 30 && readable / text.length > 0.3) {
                        // Get full page count if we don't have it yet
                        if (pageCount === 1) pageCount = await this.getPageCount(filePath);
                        return { classification: 'ocr', pageCount, confidence: 'medium' };
                    }
                }
            } catch (e) {
                this.logger.warn(`[Classify] OCR probe failed: ${e.message}`);
            }
        }

        // Step 3: Falls through to vision
        if (pageCount === 1) pageCount = await this.getPageCount(filePath);
        return { classification: 'vision', pageCount, confidence: 'low' };
    }

    // ─── Main Processing Pipeline ───

    async processPDF(filePath, originalName, options = {}) {
        const result = {
            originalName,
            status: 'processing',
            textFile: null,
            textContent: null,
            pageCount: 0,
            error: null,
            errorDetails: null,
            processingTime: 0,
            quality: null,
            extractionMethod: 'unknown',
            usage: { promptTokens: 0, completionTokens: 0 }
        };

        const startTime = Date.now();
        const errors = {};

        try {
            await this.validatePDFFile(filePath);

            let extractionResult = null;
            const forceMethod = options.forceMethod || null;

            // Build method chain based on forceMethod hint
            // 'text': standard → ocr → vision (default chain)
            // 'ocr': ocr → vision (skip standard)
            // 'vision': vision only
            // null: standard → ocr → vision (default chain)
            const tryStandard = !forceMethod || forceMethod === 'text';
            const tryOCR = this.useOCR && (!forceMethod || forceMethod === 'text' || forceMethod === 'ocr');
            const tryVision = this.useVision && this.visionApiKey;

            // Method 1: Standard PDF text extraction
            if (tryStandard) {
                try {
                    extractionResult = await this.extractTextFromPDF(filePath);
                    if (this.isExtractionSuccessful(extractionResult)) {
                        result.extractionMethod = 'standard';
                        this.logger.info(`[Standard] Success for ${originalName}`);
                    } else {
                        throw new Error('Standard extraction produced insufficient content');
                    }
                } catch (error) {
                    errors.standard = error.message;
                    this.logger.info(`[Standard] Failed for ${originalName}: ${error.message}`);
                    extractionResult = null;
                }
            }

            // Method 2: OCR with Tesseract
            if (!extractionResult && tryOCR) {
                try {
                    extractionResult = await this.extractTextWithOCR(filePath);
                    result.extractionMethod = 'ocr';
                    this.logger.info(`[OCR] Success for ${originalName}`);
                } catch (ocrError) {
                    errors.ocr = ocrError.message;
                    this.logger.info(`[OCR] Failed for ${originalName}: ${ocrError.message}`);
                    extractionResult = null;
                }
            }

            // Method 3: Vision API
            if (!extractionResult && tryVision) {
                try {
                    extractionResult = await this.extractTextWithVision(filePath, options.model);
                    result.extractionMethod = 'vision';
                    if (extractionResult.usage) {
                        result.usage = extractionResult.usage;
                    }
                    this.logger.info(`[Vision] Success for ${originalName}`);
                } catch (visionError) {
                    errors.vision = visionError.message;
                    this.logger.error(`[Vision] Failed for ${originalName}: ${visionError.message}`);
                    extractionResult = null;
                }
            }

            if (!extractionResult) {
                const detail = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ');
                throw new Error(`All extraction methods failed — ${detail}`);
            }

            result.quality = this.assessExtractionQuality(extractionResult.text, result.extractionMethod);
            const cleanedText = this.cleanExtractedText(extractionResult.text);

            const textFilename = this.generateTextFilename(originalName);
            const textFilePath = path.join(this.outputDir, textFilename);
            await fs.writeFile(textFilePath, cleanedText, 'utf8');

            result.status = 'success';
            result.textFile = textFilename;
            result.cleanTextFile = null;
            result.cleanupApplied = false;
            result.textContent = cleanedText;
            result.pageCount = extractionResult.numpages || 1;
            result.processingTime = Date.now() - startTime;

            this.logger.info(`Processed: ${originalName} (${result.pageCount} pages, ${result.processingTime}ms, method: ${result.extractionMethod})`);
            return result;

        } catch (error) {
            result.status = 'error';
            result.error = error.message;
            result.errorDetails = Object.keys(errors).length > 0 ? errors : null;
            result.processingTime = Date.now() - startTime;
            this.logger.error(`Error processing ${originalName}:`, error.message);
            return result;
        }
    }

    // ─── Extraction Methods ───

    async validatePDFFile(filePath) {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) throw new Error('Not a regular file');
        if (stats.size === 0) throw new Error('File is empty');
        if (stats.size > (parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024)) {
            throw new Error('File too large');
        }
    }

    async extractTextFromPDF(filePath) {
        try {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdfParse(dataBuffer, {
                normalizeWhitespace: false,
                disableCombineTextItems: false
            });
            return {
                text: data.text,
                numpages: data.numpages,
                info: data.info,
                metadata: data.metadata,
                version: data.version
            };
        } catch (error) {
            if (error.message.includes('password')) throw new Error('PDF is password protected');
            if (error.message.includes('corrupted') || error.message.includes('damaged')) throw new Error('PDF file appears to be corrupted');
            if (error.message.includes('encrypted')) throw new Error('PDF is encrypted and cannot be processed');
            throw new Error(`PDF parsing failed: ${error.message}`);
        }
    }

    async extractTextWithOCR(filePath) {
        this.logger.info(`[OCR] Starting OCR extraction`);

        const images = await this.convertPdfToImages(filePath, { density: 200 });

        let fullText = '';
        let pageCount = 0;

        for (const { buffer, page } of images) {
            try {
                const { data: { text } } = await Tesseract.recognize(buffer, 'eng');

                if (text && text.trim().length > 0) {
                    fullText += `--- PAGE ${page} ---\n${text}\n\n`;
                    pageCount++;
                }
            } catch (pageError) {
                this.logger.warn(`[OCR] Page ${page} failed: ${pageError.message}`);
            }
        }

        if (fullText.trim().length === 0) {
            throw new Error('OCR could not extract any text from the PDF');
        }

        return { text: fullText, numpages: pageCount, method: 'ocr' };
    }

    async extractTextWithVision(filePath, modelOverride) {
        if (!this.visionApiKey) {
            throw new Error('Vision API not configured');
        }

        const effectiveModel = modelOverride || this.visionModel;
        this.logger.info(`[Vision] Starting Vision extraction (all pages, model: ${effectiveModel})`);

        const images = await this.convertPdfToImages(filePath, {
            density: 150,
            maxPages: null
        });

        let fullText = '';
        let pageCount = 0;
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;

        for (const { buffer, page } of images) {
            try {
                if (buffer.length < 100) {
                    this.logger.warn(`[Vision] Page ${page} image too small (${buffer.length} bytes), skipping`);
                    continue;
                }

                const base64Image = buffer.toString('base64');
                this.logger.info(`[Vision] Sending page ${page}/${images.length} (${Math.round(base64Image.length / 1024)}KB)`);

                const result = await this.callVisionAPI(base64Image, page, modelOverride);

                totalPromptTokens += result.promptTokens;
                totalCompletionTokens += result.completionTokens;

                if (result.text.trim().length > 0) {
                    fullText += `--- PAGE ${page} ---\n${result.text}\n\n`;
                    pageCount++;
                }

                this.logger.info(`[Vision] Page ${page} done (${result.text.length} chars, ${result.promptTokens}+${result.completionTokens} tokens)`);

            } catch (pageError) {
                this.logger.error(`[Vision] Page ${page} failed: ${pageError.message}`);
            }
        }

        if (fullText.trim().length === 0) {
            throw new Error('Vision API could not extract any text from the PDF');
        }

        this.logger.info(`[Vision] Complete: ${pageCount} pages, ${totalPromptTokens}+${totalCompletionTokens} tokens`);

        return {
            text: fullText,
            numpages: pageCount,
            method: 'vision',
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
        };
    }

    // ─── Quality Assessment (unchanged) ───

    isExtractionSuccessful(extractionResult) {
        if (!extractionResult || !extractionResult.text) return false;
        const text = extractionResult.text.trim();
        if (text.length < 10) return false;
        const readableChars = text.match(/[a-zA-Z0-9\s.,!?;:()\[\]{}'"-]/g) || [];
        return (readableChars.length / text.length) > 0.3;
    }

    assessExtractionQuality(text, method) {
        const metrics = {
            textLength: text.length,
            readableRatio: this.calculateReadabilityRatio(text),
            hasTables: this.detectTables(text),
            hasImages: this.detectImageReferences(text),
            language: this.detectLanguage(text),
            avgWordsPerPage: this.countWords(text),
            extractionMethod: method
        };

        let qualityScore = 0;
        if (metrics.textLength > 1000) qualityScore += 30;
        else if (metrics.textLength > 500) qualityScore += 20;
        else if (metrics.textLength > 100) qualityScore += 10;

        qualityScore += metrics.readableRatio * 25;

        if (metrics.avgWordsPerPage > 100) qualityScore += 25;
        else if (metrics.avgWordsPerPage > 50) qualityScore += 20;
        else if (metrics.avgWordsPerPage > 10) qualityScore += 15;
        else if (metrics.avgWordsPerPage > 0) qualityScore += 10;

        if (metrics.hasTables) qualityScore += 10;
        if (metrics.hasImages) qualityScore += 5;
        if (metrics.language !== 'unknown') qualityScore += 5;

        if (method === 'vision') qualityScore += 10;
        else if (method === 'ocr') qualityScore += 5;

        return {
            score: Math.min(100, Math.round(qualityScore)),
            metrics,
            recommendations: this.generateRecommendations(metrics)
        };
    }

    calculateReadabilityRatio(text) {
        if (!text || text.length === 0) return 0;
        const readableChars = text.match(/[a-zA-Z0-9\s.,!?;:()\[\]{}"'-]/g) || [];
        return readableChars.length / text.length;
    }

    countWords(text) {
        if (!text) return 0;
        return (text.match(/\b\w+\b/g) || []).length;
    }

    detectTables(text) {
        return [/\t{2,}/, / {5,}/, /\|.*\|/, /\d+\s+\d+\s+\d+/].some(p => p.test(text));
    }

    detectImageReferences(text) {
        return [/figure/i, /image/i, /picture/i, /diagram/i, /chart/i, /graph/i, /illustration/i].some(p => p.test(text));
    }

    detectLanguage(text) {
        if (!text || text.length < 50) return 'unknown';
        const sample = text.toLowerCase().substring(0, 1000);
        const hits = ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'that', 'it', 'with'].filter(w => sample.includes(w)).length;
        return hits >= 3 ? 'english' : 'unknown';
    }

    generateRecommendations(metrics) {
        const recs = [];
        if (metrics.readableRatio < 0.3) recs.push('Text extraction quality is low - may contain images or complex formatting');
        if (metrics.avgWordsPerPage < 10) recs.push('Low text density detected - may be image-heavy document');
        if (metrics.hasTables) recs.push('Tables detected - formatting may be lost');
        if (metrics.hasImages) recs.push('Images detected - visual content not captured');
        if (metrics.language === 'unknown') recs.push('Language not detected - may need specialized processing');
        if (metrics.extractionMethod === 'ocr') recs.push('OCR was used - accuracy may vary based on image quality');
        if (metrics.extractionMethod === 'vision') recs.push('AI Vision was used - high accuracy but may miss some formatting');
        return recs;
    }

    cleanExtractedText(rawText) {
        if (!rawText) return '';
        let cleaned = rawText;
        cleaned = cleaned.replace(/\s+/g, ' ');
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.replace(/\f/g, '\n--- PAGE BREAK ---\n');
        cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        cleaned = cleaned.replace(/([.!?])\s+([A-Z])/g, '$1\n\n$2');
        cleaned = cleaned.replace(/(\w)\s+(\w)/g, '$1 $2');
        return cleaned.trim();
    }

    generateTextFilename(originalName) {
        const baseName = path.basename(originalName, '.pdf');
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        return `${baseName}-${timestamp}-${random}.txt`;
    }

    getStats() {
        return {
            concurrency: this.concurrency,
            tempDir: this.tempDir,
            outputDir: this.outputDir,
            useOCR: this.useOCR,
            useVision: this.useVision,
            hasVisionAPI: !!this.visionApiKey,
            visionModel: this.visionModel || null
        };
    }
}

module.exports = EnhancedPDFProcessor;
