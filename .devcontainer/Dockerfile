FROM node:24.21.0-bookworm

RUN apt-get update && apt-get install --yes --no-install-recommends \
    build-essential \
    bubblewrap \
    ca-certificates \
    cmake \
    curl \
    git \
    gnupg \
    libasound2-dev \
    libcap-dev \
    libdbus-1-dev \
    libgtk-3-dev \
    libssl-dev \
    libwayland-dev \
    libx11-dev \
    libxkbcommon-dev \
    libxkbfile-dev \
    nasm \
    pkg-config \
    python3 \
    python3-venv \
    sudo \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location https://apt.llvm.org/llvm-snapshot.gpg.key --output /tmp/ash-llvm-key.asc \
    && test "$(gpg --show-keys --with-colons /tmp/ash-llvm-key.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = 6084F3CF814B57C1CF12EFD515CF4D18AF4F7421 \
    && install -m 0644 /tmp/ash-llvm-key.asc /etc/apt/keyrings/llvm.asc \
    && printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/llvm.asc] https://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-21 main' > /etc/apt/sources.list.d/llvm-21.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends clang-21 libclang-21-dev \
    && rm -f /tmp/ash-llvm-key.asc \
    && rm -rf /var/lib/apt/lists/*

COPY .nvmrc /tmp/ash-node-version
COPY package.json /tmp/ash-package.json
COPY app-ts/package.json /tmp/ash-app-ts-package.json
COPY rust-toolchain.toml /tmp/ash-rust-toolchain.toml

ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm/bin:${PATH}

RUN test "$(node --version)" = "v$(cat /tmp/ash-node-version)" \
    && curl --fail --silent --show-error --location https://raw.githubusercontent.com/pnpm/get.pnpm.io/916ce9e8412d2ce06bb7106a53ce24690b9001dd/install.sh --output /tmp/ash-pnpm-install.sh \
    && echo '2a13208d522446c35b61f1220b8a133a7c8db3f7e1ab3d00b1bfeda218ae4262  /tmp/ash-pnpm-install.sh' | sha256sum --check \
    && PNPM_VERSION="$(node -p 'require("/tmp/ash-package.json").packageManager.split("@")[1]')" SHELL=/bin/sh ENV=/tmp/ash-pnpm-profile sh /tmp/ash-pnpm-install.sh \
    && rm /tmp/ash-pnpm-install.sh /tmp/ash-pnpm-profile \
    && ln -s "$PNPM_HOME/bin/pnpm" /usr/local/bin/pnpm \
    && test "$(pnpm --version)" = "$(node -p 'require("/tmp/ash-package.json").packageManager.split("@")[1]')" \
    && pnpm dlx "playwright@$(node -p 'require("/tmp/ash-app-ts-package.json").devDependencies["@playwright/test"]')" install-deps chromium \
    && chown -R node:node "$PNPM_HOME"

RUN printf '%s\n' 'node ALL=(root) NOPASSWD: /usr/bin/chown' > /etc/sudoers.d/ash-node \
    && printf '%s\n' 'node ALL=(root) NOPASSWD: /usr/local/bin/ash-configure-electron-sandbox' >> /etc/sudoers.d/ash-node \
    && chmod 0440 /etc/sudoers.d/ash-node \
    && mkdir -p /workspaces/ash \
    && chown node:node /workspaces/ash

COPY --chmod=0755 .devcontainer/configure-electron-sandbox.sh /usr/local/bin/ash-configure-electron-sandbox

ENV CARGO_HOME=/home/node/.cargo \
    RUSTUP_HOME=/home/node/.rustup \
    PATH=/home/node/.cargo/bin:${PATH}

USER node

RUN curl --fail --silent --show-error --location https://sh.rustup.rs --output /tmp/ash-rustup-init.sh \
    && sh /tmp/ash-rustup-init.sh -y --profile minimal --default-toolchain none \
    && rm /tmp/ash-rustup-init.sh \
    && rustup toolchain install "$(python3 -c 'import tomllib; print(tomllib.load(open("/tmp/ash-rust-toolchain.toml", "rb"))["toolchain"]["channel"])')" --profile minimal --component clippy --component rustfmt

RUN cargo install --locked --jobs 2 --version 1.46.0 just

ENV CXX=clang++-21 \
    LIBCLANG_PATH=/usr/lib/llvm-21/lib \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=${PATH}:/workspaces/ash/scripts/.venv/bin

WORKDIR /workspaces/ash

# The desktop entrypoint prepares the system socket as root; VS Code terminals use remoteUser node.
USER root
RUN apt-get update && apt-get install --yes --no-install-recommends \
    dbus-x11 \
    fluxbox \
    novnc \
    ripgrep \
    tigervnc-standalone-server \
    tigervnc-tools \
    websockify \
    x11-utils \
    xauth \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 .devcontainer/desktop-init.sh /usr/local/bin/ash-desktop-init
ENV DISPLAY=:1
ENTRYPOINT ["/usr/local/bin/ash-desktop-init"]
CMD ["sleep", "infinity"]
