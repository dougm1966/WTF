// Enhanced PDF Processing Specialist - PDF Text Extraction with OCR and Vision
const fs = require('fs-extra');
const path = require('path');
const pdfParse = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const Tesseract = require('tesseract.js');
const pdf2pic = require('pdf2pic');
const sharp = require('sharp');

class EnhancedPDFProcessor {
    constructor(options = {}) {
        this.concurrency = options.concurrency || 3;
        this.tempDir = options.tempDir || 'uploads/temp';
        this.outputDir = options.outputDir || 'uploads/texts';
        this.useOCR = options.useOCR || false;
        this.useVision = options.useVision || false;

        // Initialize OpenAI-compatible client (OpenRouter preferred, OpenAI fallback)
        if (options.openRouterApiKey) {
            this.model = options.openRouterModel || 'google/gemini-flash-2.0';
            this.openai = new OpenAI({
                apiKey: options.openRouterApiKey,
                baseURL: 'https://openrouter.ai/api/v1',
                defaultHeaders: { 'X-Title': 'Pdf2Txt PDF Converter' }
            });
        } else if (options.openaiApiKey) {
            this.model = 'gpt-4o';
            this.openai = new OpenAI({
                apiKey: options.openaiApiKey
            });
        }
        
        // Ensure directories exist
        fs.ensureDirSync(this.tempDir);
        fs.ensureDirSync(this.outputDir);
    }

    /**
     * Process a single PDF file and extract text with multiple methods
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
            quality: null,
            extractionMethod: 'unknown',
            usage: { promptTokens: 0, completionTokens: 0 }
        };

        const startTime = Date.now();

        try {
            // Validate file exists and is readable
            await this.validatePDFFile(filePath);

            // Try multiple extraction methods in order of preference
            let extractionResult = null;
            let extractionMethod = 'standard';

            // Method 1: Standard PDF text extraction
            try {
                extractionResult = await this.extractTextFromPDF(filePath);
                extractionMethod = 'standard';
                
                // Check if extraction was successful and has meaningful content
                if (this.isExtractionSuccessful(extractionResult)) {
                    result.extractionMethod = 'standard';
                } else {
                    throw new Error('Standard extraction produced insufficient content');
                }
            } catch (error) {
                console.log(`Standard extraction failed for ${originalName}: ${error.message}`);
                
                // Method 2: OCR with Tesseract
                if (this.useOCR) {
                    try {
                        extractionResult = await this.extractTextWithOCR(filePath);
                        extractionMethod = 'ocr';
                        result.extractionMethod = 'ocr';
                    } catch (ocrError) {
                        console.log(`OCR extraction failed for ${originalName}: ${ocrError.message}`);
                        
                        // Method 3: OpenAI Vision (if available)
                        if (this.useVision && this.openai) {
                            try {
                                extractionResult = await this.extractTextWithVision(filePath);
                                extractionMethod = 'vision';
                                result.extractionMethod = 'vision';
                                if (extractionResult.usage) {
                                    result.usage = extractionResult.usage;
                                }
                            } catch (visionError) {
                                console.log(`Vision extraction failed for ${originalName}: ${visionError.message}`);
                                throw new Error('All extraction methods failed');
                            }
                        } else {
                            throw new Error('Standard extraction failed and OCR/Vision not available');
                        }
                    }
                } else {
                    throw error;
                }
            }

            // Assess quality of extraction
            result.quality = this.assessExtractionQuality(extractionResult.text, extractionMethod);
            
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
            result.pageCount = extractionResult.numpages || 1;
            result.processingTime = Date.now() - startTime;
            
            // Log successful processing
            console.log(`Successfully processed: ${originalName} (${result.pageCount} pages, ${result.processingTime}ms, method: ${result.extractionMethod})`);
            
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
     * Validate PDF file with more permissive checks
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
            
            if (stats.size > (parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024)) {
                throw new Error('File too large');
            }
            
            // More permissive file header check - accept various PDF formats
            try {
                const buffer = await fs.readFile(filePath, { start: 0, end: 10 });
                const header = buffer.toString();
                
                // Accept various PDF headers including fillable forms
                if (!header.startsWith('%PDF') && !header.includes('PDF-')) {
                    console.log('Unusual PDF header detected, proceeding anyway:', header.substring(0, 20));
                }
            } catch (headerError) {
                console.log('Could not read file header, proceeding anyway');
            }
            
        } catch (error) {
            throw new Error(`File validation failed: ${error.message}`);
        }
    }

    /**
     * Extract text from PDF using standard method with better error handling
     * @param {string} filePath - Path to PDF file
     * @returns {Promise<Object>} Extraction result
     */
    async extractTextFromPDF(filePath) {
        try {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdfParse(dataBuffer, {
                // More permissive parsing options
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
            // Handle common PDF parsing errors with more specific messages
            if (error.message.includes('password')) {
                throw new Error('PDF is password protected');
            }
            if (error.message.includes('corrupted') || error.message.includes('damaged')) {
                throw new Error('PDF file appears to be corrupted');
            }
            if (error.message.includes('encrypted')) {
                throw new Error('PDF is encrypted and cannot be processed');
            }
            if (error.message.includes('Invalid')) {
                throw new Error('PDF format is not supported');
            }
            
            throw new Error(`PDF parsing failed: ${error.message}`);
        }
    }

    /**
     * Extract text using OCR with Tesseract
     * @param {string} filePath - Path to PDF file
     * @returns {Promise<Object>} Extraction result
     */
    async extractTextWithOCR(filePath) {
        try {
            // Convert PDF to images
            const convert = pdf2pic.fromPath(filePath, {
                density: 200,
                saveFilename: "page",
                savePath: this.tempDir,
                format: "png",
                width: 2000,
                height: 2000
            });

            // Convert all pages to images
            const pageImages = await convert.bulk(-1, { responseType: "buffer" });
            
            if (!pageImages || pageImages.length === 0) {
                throw new Error('Failed to convert PDF to images');
            }

            let fullText = '';
            let pageCount = 0;

            // Process each page with OCR
            for (let i = 0; i < pageImages.length; i++) {
                try {
                    const imageBuffer = pageImages[i].buffer;
                    
                    // Use Tesseract to extract text from image
                    const { data: { text } } = await Tesseract.recognize(
                        imageBuffer,
                        'eng',
                        {
                            logger: m => console.log(`OCR Page ${i + 1}: ${Math.round(m.progress * 100)}%`)
                        }
                    );

                    if (text && text.trim().length > 0) {
                        fullText += `--- PAGE ${i + 1} ---\n${text}\n\n`;
                        pageCount++;
                    }

                    // Clean up temporary image file
                    if (pageImages[i].path) {
                        await fs.remove(pageImages[i].path);
                    }

                } catch (pageError) {
                    console.error(`Error processing page ${i + 1}:`, pageError);
                    // Continue with other pages
                }
            }

            if (fullText.trim().length === 0) {
                throw new Error('OCR could not extract any text from the PDF');
            }

            return {
                text: fullText,
                numpages: pageCount,
                method: 'ocr'
            };

        } catch (error) {
            throw new Error(`OCR extraction failed: ${error.message}`);
        }
    }

    /**
     * Extract text using OpenAI Vision API
     * @param {string} filePath - Path to PDF file
     * @returns {Promise<Object>} Extraction result
     */
    async extractTextWithVision(filePath) {
        try {
            if (!this.openai) {
                throw new Error('OpenAI client not initialized');
            }

            // Convert PDF to images
            const convert = pdf2pic.fromPath(filePath, {
                density: 150, // Lower density for faster processing
                saveFilename: "vision_page",
                savePath: this.tempDir,
                format: "png",
                width: 1024,
                height: 1024
            });

            // Convert first few pages to images (limit for cost)
            const pageImages = await convert.bulk(Math.min(5, 10), { responseType: "buffer" });
            
            if (!pageImages || pageImages.length === 0) {
                throw new Error('Failed to convert PDF to images for Vision API');
            }

            let fullText = '';
            let pageCount = 0;
            let totalPromptTokens = 0;
            let totalCompletionTokens = 0;

            // Process each page with OpenAI Vision
            for (let i = 0; i < pageImages.length; i++) {
                try {
                    const imageBuffer = pageImages[i].buffer;
                    
                    // Convert buffer to base64
                    const base64Image = imageBuffer.toString('base64');

                    const response = await this.openai.chat.completions.create({
                        model: this.model,
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "Extract all text from this PDF page. Preserve the structure, formatting, and layout as much as possible. Include headers, paragraphs, lists, and any other text content. If there are tables, try to maintain the table structure. Return only the extracted text without any additional commentary."
                                    },
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: `data:image/png;base64,${base64Image}`
                                        }
                                    }
                                ]
                            }
                        ],
                        max_tokens: 2000
                    });

                    const extractedText = response.choices[0]?.message?.content || '';

                    // Capture actual token usage from API response
                    if (response.usage) {
                        totalPromptTokens += response.usage.prompt_tokens || 0;
                        totalCompletionTokens += response.usage.completion_tokens || 0;
                    }

                    if (extractedText.trim().length > 0) {
                        fullText += `--- PAGE ${i + 1} ---\n${extractedText}\n\n`;
                        pageCount++;
                    }

                    // Clean up temporary image file
                    if (pageImages[i].path) {
                        await fs.remove(pageImages[i].path);
                    }

                } catch (pageError) {
                    console.error(`Error processing page ${i + 1} with Vision:`, pageError);
                    // Continue with other pages
                }
            }

            if (fullText.trim().length === 0) {
                throw new Error('Vision API could not extract any text from the PDF');
            }

            return {
                text: fullText,
                numpages: pageCount,
                method: 'vision',
                usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
            };

        } catch (error) {
            throw new Error(`Vision extraction failed: ${error.message}`);
        }
    }

    /**
     * Check if extraction was successful
     * @param {Object} extractionResult - Result from extraction
     * @returns {boolean} True if successful
     */
    isExtractionSuccessful(extractionResult) {
        if (!extractionResult || !extractionResult.text) {
            return false;
        }

        const text = extractionResult.text.trim();
        
        // Check if we have meaningful content
        if (text.length < 10) {
            return false;
        }

        // Check if we have readable characters (not just random symbols)
        const readableChars = text.match(/[a-zA-Z0-9\s.,!?;:()\[\]{}'"-]/g) || [];
        const readableRatio = readableChars.length / text.length;
        
        return readableRatio > 0.3; // At least 30% readable characters
    }

    /**
     * Assess the quality of text extraction
     * @param {string} text - Extracted text
     * @param {string} method - Extraction method used
     * @returns {Object} Quality assessment
     */
    assessExtractionQuality(text, method) {
        const metrics = {
            textLength: text.length,
            readableRatio: this.calculateReadabilityRatio(text),
            hasTables: this.detectTables(text),
            hasImages: this.detectImageReferences(text),
            language: this.detectLanguage(text),
            avgWordsPerPage: this.countWords(text) / 1, // Simplified since we don't always have page count
            extractionMethod: method
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
        
        // Bonus for advanced extraction methods
        if (method === 'vision') qualityScore += 10;
        else if (method === 'ocr') qualityScore += 5;
        
        return {
            score: Math.min(100, Math.round(qualityScore)),
            metrics,
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
        
        const englishWords = ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'that', 'it', 'with'];
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
            recommendations.push('Text extraction quality is low - may contain images or complex formatting');
        }
        
        if (metrics.avgWordsPerPage < 10) {
            recommendations.push('Low text density detected - may be image-heavy document');
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
        
        if (metrics.extractionMethod === 'ocr') {
            recommendations.push('OCR was used - accuracy may vary based on image quality');
        }
        
        if (metrics.extractionMethod === 'vision') {
            recommendations.push('AI Vision was used - high accuracy but may miss some formatting');
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
        
        // Clean up common extraction artifacts
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
     * Get processing statistics
     * @returns {Object} Processing statistics
     */
    getStats() {
        return {
            concurrency: this.concurrency,
            tempDir: this.tempDir,
            outputDir: this.outputDir,
            useOCR: this.useOCR,
            useVision: this.useVision,
            hasOpenAI: !!this.openai
        };
    }
}

module.exports = EnhancedPDFProcessor;
