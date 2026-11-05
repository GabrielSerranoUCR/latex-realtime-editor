# syntax=docker/dockerfile:1.7
# The Gilded Quill backend: the Rust server plus the Tectonic engine it compiles LaTeX with.

# ---- the Tectonic engine (pinned, checked against its published SHA-256) ----
FROM alpine:3 AS tectonic
ARG TARGETARCH
ARG TECTONIC_VERSION=0.17.0
ARG TECTONIC_SHA256_AMD64=8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7
ARG TECTONIC_SHA256_ARM64=b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8
RUN apk add --no-cache ca-certificates curl
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64; sha="$TECTONIC_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sha="$TECTONIC_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/tectonic.tgz "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${arch}-unknown-linux-musl.tar.gz"; \
    echo "${sha}  /tmp/tectonic.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tectonic.tgz -C /usr/local/bin tectonic; \
    chmod 0755 /usr/local/bin/tectonic

# ---- the server ----
FROM rust:1-slim-bookworm AS build
WORKDIR /src
# dependencies first, so a change to the code does not rebuild them
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && : > src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY migrations migrations
COPY src src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

# ---- what runs ----
FROM debian:bookworm-slim
# no package manager is needed here: the CA certificates come from the Rust image, the engine from its own stage
RUN useradd --system --uid 10001 --home-dir /home/quill --create-home quill \
    && mkdir -p /data /cache && chown quill:quill /data /cache
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=tectonic /usr/local/bin/tectonic /usr/local/bin/tectonic
COPY --from=build /src/target/release/quill-server /usr/local/bin/quill-server
ENV QUILL_PORT=8080 \
    QUILL_DATA_DIR=/data \
    QUILL_TECTONIC_BIN=/usr/local/bin/tectonic \
    XDG_CACHE_HOME=/cache \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    RUST_LOG=quill_server=info,tower_http=info
USER quill
WORKDIR /data
VOLUME ["/data", "/cache"]
EXPOSE 8080
# bash is in the image; curl is not
HEALTHCHECK --interval=15s --timeout=4s --start-period=40s --retries=5 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["quill-server"]
