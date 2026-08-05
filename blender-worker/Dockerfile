# Keep rebuilds on the reviewed multi-architecture base instead of following a
# mutable Docker Hub tag.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

ARG BLENDER_VERSION=5.1.2
ARG BLENDER_ARCHIVE_SHA256=aaccb355f50183979b698bcce7467103a76261b5fa59f4972295842662a285fb
ARG PAWS_RUNTIME_REPOSITORY_REVISION

# Update package list and install dependencies for headless Blender
RUN apt-get update && \
    apt-get install -y wget xz-utils python3 python3-pip libx11-6 libxi6 libxxf86vm1 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6 libxext6 libwayland-client0 libwayland-cursor0 libwayland-egl1 libxfixes3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify the release against Blender Foundation's published checksum before it
# becomes executable in the worker image.
RUN wget -O /tmp/blender.tar.xz \
      "https://download.blender.org/release/Blender5.1/blender-${BLENDER_VERSION}-linux-x64.tar.xz" && \
    echo "${BLENDER_ARCHIVE_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - && \
    tar -xf /tmp/blender.tar.xz -C /usr/local/ && \
    ln -s "/usr/local/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/bin/blender && \
    rm /tmp/blender.tar.xz

# Create checkpoint and viewport directories
RUN mkdir -p /tmp/blender_checkpoints /tmp/blender_viewports

# Set the working directory in the container
WORKDIR /app

COPY ifc_worker/requirements.txt ./ifc_worker/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r ifc_worker/requirements.txt

# Copy package info and install node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code (includes bridge/)
COPY . .

RUN printf '%s' "${PAWS_RUNTIME_REPOSITORY_REVISION}" | grep -Eq '^[0-9a-f]{40}$' && \
    printf '%s\n' "${PAWS_RUNTIME_REPOSITORY_REVISION}" > /app/PAWS_RUNTIME_REVISION

# Publish only the authenticated Express relay. The raw Blender bridge executes
# arbitrary Python and is intentionally loopback-only inside the container.
EXPOSE 10000

# Start Express relay. server.js owns the Blender TCP bridge lifecycle and
# autostarts Blender if the bridge is not already reachable.
CMD ["npm", "start"]
