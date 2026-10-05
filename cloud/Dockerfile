# DSLink Cloud container: RetroArch(+melonDS DS) x2, Xvfb x2, PulseAudio, ffmpeg capture, WebRTC gateway.
# Build context = repository root (needs the pinned submodules): docker build -f cloud/Dockerfile -t dslink-cloud .
# The user's DS firmware (bios7.bin / bios9.bin / firmware.bin) is NEVER baked in: mount it and set DSLINK_FIRMWARE_DIR.

FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build git ca-certificates pkg-config python3 curl golang-go \
    libx11-dev libxext-dev libxrandr-dev libxinerama-dev libxxf86vm-dev libxkbcommon-dev libxkbcommon-x11-dev \
    libpulse-dev libgl1-mesa-dev libx11-xcb-dev libxcb1-dev libxcb-xkb-dev libxi-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . /src

# 1. DSLink C++ layer tools (identity/MAC, RetroArch config, ROM check)
RUN cmake -S dslink -B /build/dslink -G Ninja -DCMAKE_BUILD_TYPE=Release -DDSLINK_BUILD_TESTS=OFF && cmake --build /build/dslink

# 2. melonDS DS libretro core, pinned (software renderer)
RUN . upstream/versions.env && cmake -S upstream/melonds-ds -B /build/core -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DENABLE_OPENGL=OFF -DENABLE_OGLRENDERER=OFF -DMELONDS_REPOSITORY_TAG="$MELONDS_COMMIT" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
 && cmake --build /build/core --parallel

# 3. RetroArch (pinned) + DSLink patches, X11 + software GL + PulseAudio, headless-friendly
RUN rsync --version >/dev/null 2>&1 || true; mkdir -p /build/ra && cp -r upstream/retroarch/. /build/ra/ && rm -rf /build/ra/.git \
 && for p in patches/retroarch/*.patch; do patch -p1 -d /build/ra < "$p"; done \
 && cd /build/ra && ./configure --enable-x11 --enable-opengl --disable-opengl_core --disable-opengl1 --disable-xvideo --enable-pulse \
      --disable-wayland --disable-egl --disable-alsa --disable-oss --disable-qt --disable-sdl2 --disable-udev --disable-vulkan \
      --disable-vulkan_display --disable-ffmpeg --disable-cg --enable-glsl --disable-glslang --disable-jack --disable-kms \
      --disable-materialui --disable-xmb --disable-ozone --enable-networking --disable-cheevos --disable-discord --disable-v4l2 \
      --disable-libusb && make -j"$(nproc)"

# 4. gateway
RUN cd cloud/gateway && CGO_ENABLED=0 go build -o /build/dslink-gateway .

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11-xkb-utils xkb-data ffmpeg pulseaudio libgl1 libgl1-mesa-dri libglx-mesa0 libx11-6 libxext6 libxrandr2 libxinerama1 \
    libxxf86vm1 libxkbcommon0 libxkbcommon-x11-0 libpulse0 libx11-xcb1 libxi6 zlib1g procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/dslink/bin /opt/dslink/lib /opt/dslink/web /var/lib/dslink
COPY --from=build /build/ra/retroarch /opt/dslink/bin/retroarch
COPY --from=build /build/core/src/libretro/melondsds_libretro.so /opt/dslink/lib/melondsds_libretro.so
COPY --from=build /build/dslink/dslink_cfgtool /build/dslink/dslink_romcheck /opt/dslink/bin/
COPY --from=build /build/dslink-gateway /opt/dslink/bin/dslink-gateway
COPY cloud/web /opt/dslink/web
COPY LICENSE /opt/dslink/LICENSE
ENV DSLINK_WORKDIR=/var/lib/dslink XDG_RUNTIME_DIR=/tmp/dslink-xdg LIBGL_ALWAYS_SOFTWARE=1
# WebRTC media: UDP range is configurable; publish it and set DSLINK_PUBLIC_IP (or use a TURN service via DSLINK_ICE)
ENV DSLINK_UDP_MIN=50000 DSLINK_UDP_MAX=50100
EXPOSE 8080/tcp 50000-50100/udp
ENTRYPOINT ["/opt/dslink/bin/dslink-gateway", "-addr", ":8080", "-web", "/opt/dslink/web"]
