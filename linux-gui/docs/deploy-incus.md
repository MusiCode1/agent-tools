# Running linux-gui as an Incus OCI container

The default deployment is Docker Compose on the same host as the agents.
This document covers the other shape: the image runs as an **Incus
application (OCI) container** on a server, and agents reach it over SSH from
a different container. No Docker runs inside Incus and no nesting is needed.

Verified on Debian 13 with Incus 7.0 (2026-11).

## Why not Docker inside an Incus container

It works, but Chrome's own sandbox fails under Docker's default AppArmor
profile inside an Incus container (`credentials.cc … Permission denied`),
even with `seccomp=unconfined`. The only fix there is
`--security-opt apparmor=unconfined`. Running the image directly as an Incus
OCI container avoids the extra layer: the sandbox starts with no exception,
and the browser's user and PID namespaces are its own.

## Build and publish

Build the image anywhere with podman or Docker and push it to a registry that
Incus can reach, then add that registry as an OCI remote:

```bash
podman build --format docker \
  --build-arg LINUX_GUI_LOOPBACK_ONLY=0 \
  -t <registry>/linux-gui-webtop:latest .
podman push <registry>/linux-gui-webtop:latest
incus remote add <name> https://<registry> --protocol=oci --public
```

`LINUX_GUI_LOOPBACK_ONLY=0` skips the build-time patch that binds nginx and
Selkies to loopback. That patch exists for Compose's host networking, where
the container shares the host's interfaces. An Incus container has its own
network namespace and is filtered at its NIC (below). Skipping the patch also
removes the dependency on the exact upstream templates it edits.

🛑 **Incus caches OCI images.** After pushing a new `latest`,
`incus rebuild` may still use the cached copy. Delete it first
(`incus image list`, then `incus image delete <fingerprint>`) and check the
result inside the container, for example that a newly added file exists.

## Instance layout

| Device | Type | Purpose |
|---|---|---|
| `/data/browser-profiles` | storage volume | Browser identities. Survives `incus rebuild` |
| `/data/downloads` | storage volume | Downloads |
| `/data/browser-projects` | `tmpfs` | Runtime metadata and per-agent working dirs |
| `/dev/shm` | `tmpfs`, 2GiB | Chrome shared memory |
| `/data/ssh` | host directory, `shift=true` | Enables SSH for agents; see below |
| desktop proxy | `proxy`, `bind=host` | Host loopback port → container `127.0.0.1:6080` |

Set the webtop ports through `environment.*` keys
(`CUSTOM_HTTPS_PORT`, `CUSTOM_WS_PORT`, …), as Compose does.

`incus rebuild <image> <instance>` replaces the root filesystem and keeps the
volumes and devices: `/config` is reset, profiles and downloads remain.

## Network boundary

Attach a network ACL to the NIC with `security.acls.default.ingress.action=drop`
and a single rule that allows TCP 22 from the agents' container address.

🛑 **Also set `security.acls.default.egress.action=allow`.** Once an ACL is
attached, unmatched egress defaults to `reject`. DNS still resolves, but
every TCP connection out fails, so pages never load and `playwright-cli attach`
times out after the WebSocket connects.

The web desktop is not exposed on the network at all: a `proxy` device with
`bind=host` listens on host loopback, and the host's reverse proxy or tunnel
points there. An Incus proxy listens on the **host**, so the instance ACL does
not apply to it. If you expose CDP the same way, filter it in the host
firewall and place that rule **before** any rule that trusts a whole
interface, such as a VPN interface.

## SSH for agents

The image contains an SSH service that stays idle unless `/data/ssh` is
mounted:

```
/data/ssh/authorized_keys   managed on the host, mounted read-only in effect
/data/ssh/host/             host keys, generated on first start
```

Only `abc` (the browser user) may log in, by key only, with forwarding
disabled. Because the host keys live on the mount, `known_hosts` on the
agents' side survives `incus rebuild`.

On the agents' side:

```bash
export LINUX_GUI_TRANSPORT=ssh
export LINUX_GUI_SSH_HOST=gui        # an ~/.ssh/config Host entry for abc@<container>
export BROWSER=~/.local/bin/linux-gui-open-url
ln -s <repo>/linux-gui/scripts/linux-gui ~/.local/bin/linux-gui
ln -s <repo>/linux-gui/scripts/open-url ~/.local/bin/linux-gui-open-url
```

`linux-gui health`, `profile`, `browser open|close|attach` and `open-url`
then run over SSH. `up`, `down` and `logs` refuse: the lifecycle belongs to
the Incus host.

Revoking access is a matter of the key: remove it from the agents' SSH agent
for a temporary stop, or from `authorized_keys` permanently.
