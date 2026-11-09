# The container an agent runs each job in: Ubuntu 24.04 with the GitHub runner, as user "runner" with passwordless
# sudo (like GitHub's own runners, so `sudo apt-get install` steps work). One container per job, removed afterwards.
#
#   docker build -t jitrunner-runner runner/
#
# Add your own tools in a Dockerfile that starts FROM this image, and point JITRUNNER_IMAGE at it.
FROM ubuntu:24.04

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
	&& version=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//') \
	&& curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-$arch-$version.tar.gz" \
		| tar -xz \
	&& ./bin/installdependencies.sh \
	&& rm -rf /var/lib/apt/lists/* \
	&& chown -R runner:runner /opt/actions-runner

USER runner
# JIT_CONFIG comes from the agent: a one-time registration for one runner that runs one job and exits.
ENTRYPOINT ["/bin/bash", "-c", "exec ./run.sh --jitconfig \"$JIT_CONFIG\""]
