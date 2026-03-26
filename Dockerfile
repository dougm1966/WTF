# PDF to Text Converter - Production Docker Configuration
FROM node:18-alpine

# Install system dependencies for OCR and image processing
RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    graphicsmagick \
    ghostscript \
    libpng-dev \
    libjpeg-turbo-dev \
    libwebp-dev \
    python3 \
    make \
    g++

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories and set permissions
RUN mkdir -p uploads/pdfs uploads/texts uploads/temp logs && \
    chown -R nodejs:nodejs /app && \
    chmod -R 755 /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]
