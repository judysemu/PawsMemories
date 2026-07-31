# Use a Debian-based slim node image
FROM node:20-slim

# Update package list and install dependencies for headless Blender
RUN apt-get update && \
    apt-get install -y wget xz-utils python3 python3-pip libx11-6 libxi6 libxxf86vm1 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6 libxext6 libwayland-client0 libwayland-cursor0 libwayland-egl1 libxfixes3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Download and install Blender 5.1.2
RUN wget https://download.blender.org/release/Blender5.1/blender-5.1.2-linux-x64.tar.xz && \
    tar -xvf blender-5.1.2-linux-x64.tar.xz -C /usr/local/ && \
    ln -s /usr/local/blender-5.1.2-linux-x64/blender /usr/bin/blender && \
    rm blender-5.1.2-linux-x64.tar.xz

# Create checkpoint and viewport directories
RUN mkdir -p /tmp/blender_checkpoints /tmp/blender_viewports

# Set the working directory in the container
WORKDIR /app

COPY ifc_worker/requirements.txt ./ifc_worker/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r ifc_worker/requirements.txt

# Copy package info and install node dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code (includes bridge/)
COPY . .

# Publish only the authenticated Express relay. The raw Blender bridge executes
# arbitrary Python and is intentionally loopback-only inside the container.
EXPOSE 10000

# Start Express relay. server.js owns the Blender TCP bridge lifecycle and
# autostarts Blender if the bridge is not already reachable.
CMD ["npm", "start"]
