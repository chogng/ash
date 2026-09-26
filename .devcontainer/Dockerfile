FROM node:24.21.0-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install --yes --no-install-recommends \
    build-essential \
    bubblewrap \
    ca-certificates \
    clang \
    cmake \
    curl \
    git \
    libasound2-dev \
    libcap-dev \
    libclang-dev \
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
    sudo \
    && rm -rf /var/lib/apt/lists/*

COPY .nvmrc /tmp/ash-node-version
COPY package.json /tmp/ash-package.json
COPY app-ts/package.json /tmp/ash-app-ts-package.json
COPY rust-toolchain.toml /tmp/ash-rust-toolchain.toml

RUN test "$(node --version)" = "v$(cat /tmp/ash-node-version)" \
    && npm install --global "$(node -p 'require("/tmp/ash-package.json").packageManager')" \
    && npm exec --yes --package="playwright@$(node -p 'require("/tmp/ash-app-ts-package.json").devDependencies["@playwright/test"]')" -- playwright install-deps chromium

RUN printf '%s\n' 'node ALL=(root) NOPASSWD: /usr/bin/chown' > /etc/sudoers.d/ash-node \
    && chmod 0440 /etc/sudoers.d/ash-node \
    && mkdir -p /workspaces/ash \
    && chown node:node /workspaces/ash

ENV CARGO_HOME=/home/node/.cargo \
    RUSTUP_HOME=/home/node/.rustup \
    PATH=/home/node/.cargo/bin:${PATH}

USER node

RUN curl --fail --silent --show-error --location https://sh.rustup.rs --output /tmp/ash-rustup-init.sh \
    && sh /tmp/ash-rustup-init.sh -y --profile minimal --default-toolchain none \
    && rm /tmp/ash-rustup-init.sh \
    && rustup toolchain install "$(python3 -c 'import tomllib; print(tomllib.load(open("/tmp/ash-rust-toolchain.toml", "rb"))["toolchain"]["channel"])')" --profile minimal --component clippy --component rustfmt

WORKDIR /workspaces/ash
