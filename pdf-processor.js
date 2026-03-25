// PDF Processing Specialist - PDF Text Extraction Module
const fs = require('fs-extra');
const path = require('path');
const pdfParse = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');

class PDFProcessor {
    constructor(options = {}) {
        this.concurrency = options.concurrency || 3;
        this.tempDir = options.tempDir || 'uploads/temp';
        this.outputDir = options.outputDir || 'uploads/texts';
        this.ocrEnabled = options.ocrEnabled || false;
        
        // Ensure directories exist
        fs.ensureDirSync(this.tempDir);
        fs.ensureDirSync(this.outputDir);
    }

    /**
     * Process a single PDF file and extract text
     * @param {string} filePath - Path to the PDF file
     * @param {string} originalName - Original filename
     * @returns {Promise<Object>} Processing result
     */
    async processPDF(filePath, originalName) {
        const result = {
            originalName,
            status: 'processing',
            textFile: null,
            textContent: null,
            pageCount: 0,
            error: null,
            processingTime: 0,
            quality: null
        };

        const startTime = Date.now();

        try {
            // Validate file exists and is readable
            await this.validatePDFFile(filePath);

            // Extract text using pdf-parse
            const extractionResult = await this.extractTextFromPDF(filePath);
            
            // Assess quality of extraction
            result.quality = this.assessExtractionQuality(extractionResult);
            
            // Clean and enhance the extracted text
            const cleanedText = this.cleanExtractedText(extractionResult.text);
            
            // Generate output filename
            const textFilename = this.generateTextFilename(originalName);
            const textFilePath = path.join(this.outputDir, textFilename);
            
            // Write text to file
            await fs.writeFile(textFilePath, cleanedText, 'utf8');
            
            // Update result
            result.status = 'success';
            result.textFile = textFilename;
            result.textContent = cleanedText;
            result.pageCount = extractionResult.numpages;
            result.processingTime = Date.now() - startTime;
            
            // Log successful processing
            console.log(`Successfully processed: ${originalName} (${result.pageCount} pages, ${result.processingTime}ms)`);
            
            return result;

        } catch (error) {
            result.status = 'error';
            result.error = error.message;
            result.processingTime = Date.now() - startTime;
            
            console.error(`Error processing ${originalName}:`, error);
            
            return result;
        }
    }

    /**
     * Validate PDF file
     * @param {string} filePath - Path to PDF file
     */
    async validatePDFFile(filePath) {
        try {
            const stats = await fs.stat(filePath);
            
            if (!stats.isFile()) {
                throw new Error('Invalid file: not a regular file');
            }
            
            if (stats.size === 0) {
                throw new Error('File is empty');
            }
            
            if (stats.size > 50 * 1024 * 1024) { // 50MB
                throw new Error('File too large (max 50MB)');
            }
            
            // Check file header to verify it's a PDF
            const buffer = await fs.readFile(filePath, { start: 0, end: 4 });
            if (buffer.toString() !== '%PDF') {
                throw new Error('Invalid PDF file format');
            }
            
        } catch (error) {
            throw new Error(`File validation failed: ${error.message}`);
        }
    }

    /**
     * Extract text from PDF using pdf-parse
     * @param {string} filePath - Path to PDF file
     * @returns {Promise<Object>} Extraction result
     */
    async extractTextFromPDF(filePath) {
        try {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdfParse(dataBuffer);
            
            return {
                text: data.text,
                numpages: data.numpages,
                info: data.info,
                metadata: data.metadata,
                version: data.version
            };
            
        } catch (error) {
            // Handle common PDF parsing errors
            if (error.message.includes('password')) {
                throw new Error('PDF is password protected');
            }
            if (error.message.includes('corrupted') || error.message.includes('damaged')) {
                throw new Error('PDF file is corrupted or damaged');
            }
            if (error.message.includes('encrypted')) {
                throw new Error('PDF is encrypted and cannot be processed');
            }
            
            throw new Error(`PDF parsing failed: ${error.message}`);
        }
    }

    /**
     * Assess the quality of text extraction
     * @param {Object} extractionResult - Result from PDF parsing
     * @returns {Object} Quality assessment
     */
    assessExtractionQuality(extractionResult) {
        const text = extractionResult.text;
        const pageCount = extractionResult.numpages;
        
        const metrics = {
            textLength: text.length,
            textPerPage: pageCount > 0 ? text.length / pageCount : 0,
            readableRatio: this.calculateReadabilityRatio(text),
            hasTables: this.detectTables(text),
            hasImages: this.detectImageReferences(text),
            language: this.detectLanguage(text),
            avgWordsPerPage: pageCount > 0 ? this.countWords(text) / pageCount : 0
        };
        
        // Calculate quality score (0-100)
        let qualityScore = 0;
        
        // Text length contribution (30%)
        if (metrics.textLength > 1000) qualityScore += 30;
        else if (metrics.textLength > 500) qualityScore += 20;
        else if (metrics.textLength > 100) qualityScore += 10;
        
        // Readability ratio contribution (25%)
        qualityScore += metrics.readableRatio * 25;
        
        // Words per page contribution (25%)
        if (metrics.avgWordsPerPage > 100) qualityScore += 25;
        else if (metrics.avgWordsPerPage > 50) qualityScore += 20;
        else if (metrics.avgWordsPerPage > 10) qualityScore += 15;
        else if (metrics.avgWordsPerPage > 0) qualityScore += 10;
        
        // Structure detection contribution (20%)
        if (metrics.hasTables) qualityScore += 10;
        if (metrics.hasImages) qualityScore += 5;
        if (metrics.language !== 'unknown') qualityScore += 5;
        
        return {
            score: Math.min(100, Math.round(qualityScore)),
            metrics,
            needsOCR: metrics.readableRatio < 0.3,
            recommendations: this.generateRecommendations(metrics)
        };
    }

    /**
     * Calculate readability ratio
     * @param {string} text - Extracted text
     * @returns {number} Readability ratio (0-1)
     */
    calculateReadabilityRatio(text) {
        if (!text || text.length === 0) return 0;
        
        // Count readable characters (letters, numbers, basic punctuation)
        const readableChars = text.match(/[a-zA-Z0-9\s.,!?;:()\[\]{}"'-]/g) || [];
        const totalChars = text.length;
        
        return readableChars.length / totalChars;
    }

    /**
     * Count words in text
     * @param {string} text - Text to analyze
     * @returns {number} Word count
     */
    countWords(text) {
        if (!text) return 0;
        const words = text.match(/\b\w+\b/g) || [];
        return words.length;
    }

    /**
     * Detect table patterns in text
     * @param {string} text - Text to analyze
     * @returns {boolean} True if tables are likely present
     */
    detectTables(text) {
        // Simple table detection based on patterns
        const tablePatterns = [
            /\t{2,}/, // Multiple tabs
            / {5,}/, // Multiple spaces
            /\|.*\|/, // Pipe characters
            /\d+\s+\d+\s+\d+/ // Multiple numbers in sequence
        ];
        
        return tablePatterns.some(pattern => pattern.test(text));
    }

    /**
     * Detect image references in text
     * @param {string} text - Text to analyze
     * @returns {boolean} True if images are referenced
     */
    detectImageReferences(text) {
        const imagePatterns = [
            /figure/i,
            /image/i,
            /picture/i,
            /diagram/i,
            /chart/i,
            /graph/i,
            /illustration/i
        ];
        
        return imagePatterns.some(pattern => pattern.test(text));
    }

    /**
     * Detect primary language of text
     * @param {string} text - Text to analyze
     * @returns {string} Detected language
     */
    detectLanguage(text) {
        if (!text || text.length < 50) return 'unknown';
        
        // Simple language detection based on common words
        const englishWords = ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'that', 'it', 'with'];
        const words = this.countWords(text);
        const sample = text.toLowerCase().substring(0, 1000);
        
        const englishMatches = englishWords.filter(word => sample.includes(word)).length;
        
        if (englishMatches >= 3) return 'english';
        return 'unknown';
    }

    /**
     * Generate recommendations based on quality metrics
     * @param {Object} metrics - Quality metrics
     * @returns {Array} List of recommendations
     */
    generateRecommendations(metrics) {
        const recommendations = [];
        
        if (metrics.readableRatio < 0.3) {
            recommendations.push('Consider OCR processing for better text extraction');
        }
        
        if (metrics.avgWordsPerPage < 10) {
            recommendations.push('Low text density detected - may be image-heavy');
        }
        
        if (metrics.hasTables) {
            recommendations.push('Tables detected - formatting may be lost');
        }
        
        if (metrics.hasImages) {
            recommendations.push('Images detected - visual content not captured');
        }
        
        if (metrics.language === 'unknown') {
            recommendations.push('Language not detected - may need specialized processing');
        }
        
        return recommendations;
    }

    /**
     * Clean and enhance extracted text
     * @param {string} rawText - Raw extracted text
     * @returns {string} Cleaned text
     */
    cleanExtractedText(rawText) {
        if (!rawText) return '';
        
        let cleaned = rawText;
        
        // Normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ');
        
        // Remove excessive line breaks
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        
        // Clean up common PDF extraction artifacts
        cleaned = cleaned.replace(/\f/g, '\n--- PAGE BREAK ---\n'); // Form feeds
        cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Control characters
        
        // Fix common spacing issues
        cleaned = cleaned.replace(/([.!?])\s+([A-Z])/g, '$1\n\n$2'); // Sentence separation
        cleaned = cleaned.replace(/(\w)\s+(\w)/g, '$1 $2'); // Single spaces between words
        
        // Remove leading/trailing whitespace
        cleaned = cleaned.trim();
        
        return cleaned;
    }

    /**
     * Generate unique filename for text output
     * @param {string} originalName - Original PDF filename
     * @returns {string} Generated text filename
     */
    generateTextFilename(originalName) {
        const baseName = path.basename(originalName, '.pdf');
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        
        return `${baseName}-${timestamp}-${random}.txt`;
    }

    /**
     * Process multiple PDF files in batches
     * @param {Array} files - Array of file objects
     * @returns {Promise<Array>} Array of processing results
     */
    async processBatch(files) {
        const results = [];
        const batches = this.createBatches(files, this.concurrency);
        
        for (const batch of batches) {
            const batchPromises = batch.map(file => 
                this.processPDF(file.path, file.originalName)
            );
            
            const batchResults = await Promise.allSettled(batchPromises);
            
            batchResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                } else {
                    results.push({
                        originalName: batch[index].originalName,
                        status: 'error',
                        error: result.reason.message
                    });
                }
            });
        }
        
        return results;
    }

    /**
     * Create batches of files for processing
     * @param {Array} files - Array of files
     * @param {number} batchSize - Size of each batch
     * @returns {Array} Array of batches
     */
    createBatches(files, batchSize) {
        const batches = [];
        for (let i = 0; i < files.length; i += batchSize) {
            batches.push(files.slice(i, i + batchSize));
        }
        return batches;
    }

    /**
     * Get processing statistics
     * @returns {Object} Processing statistics
     */
    getStats() {
        return {
            concurrency: this.concurrency,
            tempDir: this.tempDir,
            outputDir: this.outputDir,
            ocrEnabled: this.ocrEnabled
        };
    }
}

module.exports = PDFProcessor;
