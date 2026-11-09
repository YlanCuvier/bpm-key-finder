FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy
WORKDIR /app
COPY server.py index.html analysis.js analysis-worker.js ./
ENV HOST=0.0.0.0 PORT=7860
EXPOSE 7860
CMD ["python", "server.py"]
