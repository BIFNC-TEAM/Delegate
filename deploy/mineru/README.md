# Delegate MinerU GPU service

This deployment runs MinerU as an isolated, single-GPU service on
`7567-server`. It does not install or update the host NVIDIA driver, CUDA
driver layer, kernel modules, Docker Engine, or NVIDIA Container Toolkit.

Pinned runtime:

- MinerU `3.4.5`
- immutable CUDA 13 / PyTorch base digest already cached on `7567-server`
- physical host GPU `1` only
- one concurrent MinerU API request
- `20%` maximum vLLM GPU memory utilization

The service initially binds only to `127.0.0.1:8000`. Delegate must reach it
through an authenticated encrypted tunnel or a separately reviewed HTTPS
reverse proxy. Do not publish the native MinerU API directly to the internet.

Build and start:

```bash
docker build \
  --file Dockerfile.gpu \
  --tag delegate-mineru:3.4.5-cu130 \
  .

bash run-gpu1.sh
```

Verify without sending a document:

```bash
docker inspect --format '{{json .State.Health}}' delegate-mineru-api
curl --fail http://127.0.0.1:8000/health
nvidia-smi --query-gpu=index,memory.used,memory.free,utilization.gpu \
  --format=csv,noheader,nounits -i 1
```

The first production integration should set Delegate's `MINERU_BACKEND` to
`pipeline`. That path uses the downloaded pipeline models and avoids reserving
vLLM KV-cache capacity for ordinary knowledge ingestion.
