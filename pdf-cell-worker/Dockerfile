FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /opt/pdf-cell
COPY pdf-cell-worker/requirements.txt .
RUN python -m pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY pdf-cell-worker/cell.py pdf-cell-worker/worker.py pdf-cell-worker/test_cell.py ./
COPY test/pdfCell/source.pdf ./source.pdf
USER 10001:10001
RUN python test_cell.py source.pdf
WORKDIR /work
ENTRYPOINT ["python", "/opt/pdf-cell/worker.py"]
