FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY runner.js errors.js ./
USER pwuser
ENTRYPOINT ["node", "/app/runner.js"]
