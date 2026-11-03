# VoltBay for Hugging Face Spaces (Docker SDK), Render or any container host. No npm install step: the app has no dependencies.
FROM node:22-slim
# The server runs as the unprivileged "node" user (uid 1000, which Hugging Face also requires), so the folders it writes to must belong to it.
RUN mkdir -p /home/node/app /home/node/data && chown -R node:node /home/node
WORKDIR /home/node/app
COPY --chown=node:node . .
USER node
ENV HOST=0.0.0.0 PORT=7860 DB_FILE=/home/node/data/voltai.db TRUST_PROXY=1 \
    FRAME_ANCESTORS="https://huggingface.co https://*.huggingface.co https://*.hf.space"
EXPOSE 7860
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
