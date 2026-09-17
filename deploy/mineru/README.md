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

The staging topology uses WireGuard between the application host and the GPU
host:

- `8170-server`: `10.77.0.1/30`
- `7567-server`: `10.77.0.2/30`, UDP listener on `51820`
- MinerU remains bound to `127.0.0.1:8000` on `7567-server`
- `run-wg-proxy.sh` exposes a capability-free TCP sidecar only on
  `10.77.0.2:8000`

Set `MINERU_STAGING_API_BASE_URL=http://10.77.0.2:8000` in the private staging
source environment. `prepare-env.mjs` writes the corresponding Dashboard
runtime settings with `MINERU_BACKEND=pipeline` by default. WireGuard private
keys and host configuration must remain outside this repository.

Build and start:

```bash
docker build \
  --file Dockerfile.gpu \
  --tag delegate-mineru:3.4.5-cu130 \
  .

bash run-gpu1.sh
bash run-wg-proxy.sh
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
