FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg MPLCONFIGDIR=/work/mpl OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 HOME=/work TMPDIR=/work
RUN pip install --no-cache-dir --only-binary=:all: numpy==2.2.6 pandas==2.2.3 openpyxl==3.1.5 matplotlib==3.10.3 Pillow==11.3.0
WORKDIR /app
COPY runner.py /app/runner.py
USER 10001:10001
ENTRYPOINT ["python", "-I", "/app/runner.py"]
