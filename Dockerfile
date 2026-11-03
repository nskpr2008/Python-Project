# VoltBay for Hugging Face Spaces (Docker SDK) or any container host. No npm install step: the app has no dependencies.
FROM node:22-slim
WORKDIR /home/node/app
COPY --chown=node:node . .
# Hugging Face runs containers as user 1000 ("node" here); the SQLite file is created in this folder.
USER node
ENV HOST=0.0.0.0 PORT=7860 DB_FILE=/home/node/app/voltai.db TRUST_PROXY=1 \
    FRAME_ANCESTORS="https://huggingface.co https://*.huggingface.co https://*.hf.space"
EXPOSE 7860
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
