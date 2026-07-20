FROM ghcr.io/volcengine/openviking:v0.4.9

# cryptography 49.0.0's prebuilt ARM64 extension exits with SIGILL under
# Docker Desktop's virtual CPU on Apple Silicon. Keep OpenViking pinned to the
# stable release and replace only that native dependency with a compatible
# wheel until the upstream image no longer requires this workaround.
RUN pip install \
    --no-cache-dir \
    --upgrade \
    --force-reinstall \
    --root-user-action=ignore \
    --target /app/.venv/lib/python3.13/site-packages \
    "cryptography==46.0.5"
