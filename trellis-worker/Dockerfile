FROM nvidia/cuda:12.4.1-devel-ubuntu22.04@sha256:da6791294b0b04d7e65d87b7451d6f2390b4d36225ab0701ee7dfec5769829f5

ARG TRELLIS2_COMMIT=75fbf0183001ed9876c8dbb35de6b68552ee08bd
ARG TORCH_CUDA_ARCH_LIST="8.0;8.6;9.0"
ARG MINICONDA_SHA256=84bd8f60fea2e09f1fa72f258132337aff7a20ec1e12dea9d1eff96830cf3d8c
ARG DEBIAN_FRONTEND=noninteractive

ENV CUDA_HOME=/usr/local/cuda-12.4 \
    TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST}" \
    OPENCV_IO_ENABLE_OPENEXR=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/huggingface

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git git-lfs jq libgl1 libglib2.0-0 \
      libjpeg-dev ninja-build sudo wget && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-py310_25.5.1-1-Linux-x86_64.sh -o /tmp/miniconda.sh && \
    echo "${MINICONDA_SHA256}  /tmp/miniconda.sh" | sha256sum -c - && \
    bash /tmp/miniconda.sh -b -p /opt/conda && \
    rm /tmp/miniconda.sh

ENV PATH=/opt/conda/bin:${PATH}

RUN git clone --recursive https://github.com/microsoft/TRELLIS.2.git /opt/trellis2 && \
    cd /opt/trellis2 && \
    git checkout "${TRELLIS2_COMMIT}" && \
    git submodule update --init --recursive

RUN /opt/conda/bin/pip install \
      torch==2.6.0 \
      torchvision==0.21.0 \
      --index-url https://download.pytorch.org/whl/cu124

# TRELLIS.2's setup script only needs nvidia-smi to select the CUDA build path.
# Docker image builds do not expose the host GPU, so a build-only probe is used;
# the real driver and GPU are verified by /readyz at runtime.
RUN printf '#!/bin/sh\nexit 0\n' >/usr/local/bin/nvidia-smi && \
    chmod +x /usr/local/bin/nvidia-smi && \
    bash -lc 'source /opt/conda/etc/profile.d/conda.sh && conda activate base && cd /opt/trellis2 && source ./setup.sh --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm' && \
    rm /usr/local/bin/nvidia-smi

RUN /opt/conda/bin/pip install \
      fastapi==0.116.1 \
      huggingface-hub==1.26.0 \
      python-multipart==0.0.20 \
      transformers==5.14.1 \
      uvicorn==0.35.0 && \
    /opt/conda/bin/pip check

WORKDIR /app
COPY app /app

RUN mkdir -p /jobs /models && useradd --create-home --uid 10001 trellis && \
    chown -R trellis:trellis /app /jobs /models

USER trellis
EXPOSE 8000

CMD ["/opt/conda/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
