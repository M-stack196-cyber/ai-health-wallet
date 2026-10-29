"""Explicit local launch. No default credentials, public bind or access logging."""
import os
import uvicorn
from .app import Config, create_app

def main():
    token = os.environ.get("OCR_SERVICE_TOKEN", "")
    port = int(os.environ.get("OCR_SERVICE_PORT", "8011"))
    if not 1024 <= port <= 65535:
        raise ValueError("INVALID_OCR_CONFIGURATION")
    app = create_app(Config(token=token))
    uvicorn.run(app, host="127.0.0.1", port=port, access_log=False, log_level="critical")

if __name__ == "__main__":
    main()
