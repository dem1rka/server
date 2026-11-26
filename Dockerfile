FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
CMD ["sh", "-c", "npm run db:migrate && exec npm start"]
