# The container an agent runs each job in: Ubuntu 24.04 with the GitHub runner, as user "runner" with passwordless
# sudo (like GitHub's own runners, so `sudo apt-get install` steps work). One container per job, removed afterwards.
#
#   docker build -t jitrunner-runner runner/
#
# Add your own tools in a Dockerfile that starts FROM this image, and point JITRUNNER_IMAGE at it.
FROM ubuntu:24.04

# An Ubuntu mirror to use instead of archive.ubuntu.com, e.g. http://mirrors.edge.kernel.org/ubuntu. The main archive
# can crawl at a few KB/s over IPv4. The setting stays in the image, so jobs' own apt-get installs use it too.
ARG UBUNTU_MIRROR=
RUN if [ -n "$UBUNTU_MIRROR" ]; then \
		sed -i "s#http://archive.ubuntu.com/ubuntu#$UBUNTU_MIRROR#g" /etc/apt/sources.list.d/ubuntu.sources; \
	fi

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends sudo curl git jq unzip zstd build-essential ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Ubuntu's image ships a user "ubuntu" with uid 1000; the runner gets its own.
RUN useradd --create-home --shell /bin/bash runner \
	&& echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
	&& chmod 0440 /etc/sudoers.d/runner

WORKDIR /opt/actions-runner
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
	&& version=$(curl -fsSL --retry 5 --retry-all-errors -o /dev/null -w '%{url_effective}' https://github.com/actions/runner/releases/latest | sed 's#.*/v##') \
	&& curl -fsSL --retry 5 --retry-all-errors "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-$arch-$version.tar.gz" \
		| tar -xz \
	&& apt-get update \
	&& ./bin/installdependencies.sh \
	&& rm -rf /var/lib/apt/lists/* \
	&& chown -R runner:runner /opt/actions-runner

# What jobs download and can reuse: tool versions (actions/setup-node and friends), and the home caches (Playwright's
# browsers, pnpm's store). The agent mounts a volume on each, shared by its jobs; created here so the runner owns them.
RUN install -d -o runner -g runner /opt/actions-runner/_work/_tool /home/runner/.cache /home/runner/.local/share/pnpm

# Plain COPY and chmod: the legacy builder (Debian and Ubuntu docker.io without buildx) has no COPY --chmod.
COPY entrypoint.sh /usr/local/bin/jitrunner-entrypoint
RUN chmod 0755 /usr/local/bin/jitrunner-entrypoint
USER runner
# JIT_CONFIG comes from the agent: a one-time registration for one runner that runs one job and exits.
ENTRYPOINT ["/usr/local/bin/jitrunner-entrypoint"]
