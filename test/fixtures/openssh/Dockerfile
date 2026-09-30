FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash easyssh-test \
    && mkdir -p /run/sshd /var/run/sshd \
    && ssh-keygen -A

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/easyssh-fixture
RUN chmod 0755 /usr/local/bin/easyssh-fixture

EXPOSE 2222
CMD ["/usr/local/bin/easyssh-fixture"]
