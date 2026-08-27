ARG OPENVIKING_BASE_IMAGE=ghcr.io/volcengine/openviking:v0.4.12@sha256:0d99361a0029ce5221fd11588d9f0f374c6e5f8f1eacbcf1d76de6a0f6cd82cb
FROM ${OPENVIKING_BASE_IMAGE}

# OpenViking v0.4.12 still uses Python 3.13 and locks cryptography 49.0.0.
# That release's prebuilt ARM64 extension exits with SIGILL under Docker
# Desktop's virtual CPU on Apple Silicon. Keep OpenViking pinned by OCI digest
# and replace only that native dependency with the known-compatible wheel until
# the upstream image no longer requires this workaround.
RUN pip install \
    --no-cache-dir \
    --upgrade \
    --force-reinstall \
    --root-user-action=ignore \
    --target /app/.venv/lib/python3.13/site-packages \
    "cryptography==46.0.5"

COPY deploy/openviking /opt/delegate-openviking

RUN chmod 0555 /opt/delegate-openviking/entrypoint.sh \
  /opt/delegate-openviking/render-config.py
