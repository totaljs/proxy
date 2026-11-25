FROM node:24-alpine
WORKDIR /app
RUN npm install --no-audit --no-fund --save-exact total5@0.0.20-6 && chown node:node /app
COPY --chown=node:node index.js ./
USER node
CMD ["node", "index.js"]
