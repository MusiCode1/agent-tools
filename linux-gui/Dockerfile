FROM lscr.io/linuxserver/webtop:ubuntu-xfce

ARG NODE_VERSION=22.17.1
ARG PLAYWRIGHT_CLI_VERSION=0.1.17

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        openssh-client \
        ripgrep \
        tint2 \
        xfe \
        xz-utils \
    && curl -fsSLo /tmp/google-chrome.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) node_arch=x64 ;; \
         arm64) node_arch=arm64 ;; \
         *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSLo /tmp/node.tar.xz \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && curl -fsSLo /tmp/SHASUMS256.txt \
        "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && expected="$(awk -v file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" '$2 == file {print $1}' /tmp/SHASUMS256.txt)" \
    && test -n "$expected" \
    && echo "$expected  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && npm install --global "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
    && google-chrome --version \
    && playwright-cli --version \
    && rm -rf /var/lib/apt/lists/* /tmp/google-chrome.deb /tmp/node.tar.xz /tmp/SHASUMS256.txt

COPY config/chromium/policies.json /etc/opt/chrome/policies/managed/linux-gui.json
COPY config/chromium/browser-launch /usr/local/bin/linux-gui-browser-launch
COPY config/chromium/browser-close /usr/local/bin/linux-gui-browser-close
COPY config/init/10-linux-gui-permissions /custom-cont-init.d/10-linux-gui-permissions
COPY config/desktop/startwm.sh /defaults/startwm.sh
COPY config/desktop/menu.xml /defaults/linux-gui-menu.xml
COPY config/desktop/tint2rc /defaults/linux-gui-tint2rc
COPY config/desktop/apps-menu /usr/local/bin/linux-gui-apps-menu
RUN chmod 0755 \
      /usr/local/bin/linux-gui-browser-launch \
      /usr/local/bin/linux-gui-browser-close \
      /usr/local/bin/linux-gui-apps-menu \
      /custom-cont-init.d/10-linux-gui-permissions \
      /defaults/startwm.sh
