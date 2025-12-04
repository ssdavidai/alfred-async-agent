# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Generate Prisma client
RUN npx prisma generate

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install curl for healthcheck and openssl for Prisma
RUN apk add --no-cache curl openssl

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prompts ./prompts

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Run migrations and start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
