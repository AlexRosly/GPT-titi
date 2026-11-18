FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer poppler-utils python3-lxml python3-pil fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/work TMPDIR=/work XDG_CACHE_HOME=/work/.cache LANG=C.UTF-8
COPY verify.py test_verify.py /opt/quality/
WORKDIR /work
USER 10001:10001
RUN TMPDIR=/tmp PYTHONDONTWRITEBYTECODE=1 python3 /opt/quality/test_verify.py
ENTRYPOINT ["/usr/bin/timeout", "-s", "KILL", "65s", "/usr/bin/python3", "/opt/quality/verify.py"]
