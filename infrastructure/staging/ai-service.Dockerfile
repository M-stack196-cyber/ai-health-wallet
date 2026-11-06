# syntax=docker/dockerfile:1
# Python FastAPI services (RAG, summary, OCR). One image, one command per service. Build context: repository root.
# All three bind 127.0.0.1 only; compose runs them in the API's network namespace so the Node client can reach them.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 aiservice \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin aiservice
WORKDIR /app/ai-service
COPY ai-service/requirements.txt ai-service/requirements-ocr.txt ai-service/requirements-rag.txt ./
RUN pip install -r requirements-rag.txt
COPY ai-service/ocr_service ./ocr_service
COPY ai-service/rag_service ./rag_service
COPY ai-service/summary_service ./summary_service
COPY ai-service/summary_contracts ./summary_contracts
# summary_contracts loads these two files from /app/shared at import time.
COPY shared/medical-summary/v1.schema.json shared/medical-summary/glossary-v1.json /app/shared/medical-summary/
COPY infrastructure/staging/load-secrets.sh /usr/local/bin/load-secrets.sh
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/load-secrets.sh"]
CMD ["python", "-m", "rag_service.entry"]
