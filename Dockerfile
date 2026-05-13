# Multi-stage Dockerfile for Trajectos Worker (production)
# Build stage: Compile TypeScript, run tests
# Runtime stage: Minimal production image

# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build/compile TypeScript
RUN npm run build

# Run type checks
RUN npm run typecheck

# Run tests
RUN npm run snapshots

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

# Install only production dependencies
ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /build/.next ./.next
COPY --from=builder /build/public ./public
COPY --from=builder /build/next.config.ts ./
COPY --from=builder /build/tsconfig.json ./

# Copy runtime scripts
COPY --from=builder /build/scripts ./scripts

# Switch to non-root user
USER nextjs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "run", "start:worker"]
