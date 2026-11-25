# Reverse proxy benchmark

The [GitHub Actions workflow](.github/workflows/benchmark.yml) runs a short smoke benchmark on pushes to the `bench` branch. It checks out `main` into a separate directory and records the exact source commit. It compares the checked-out Proxy source, NGINX 1.28.0 and Caddy 2.10.2. Each proxy forwards to the same Total.js app and runs by itself on the same runner.

Run locally with Docker Compose, Node.js 24, curl and OpenSSL:

```sh
git clone --branch main https://github.com/totaljs/proxy.git ../proxy-source
export PROXY_SOURCE="$(cd ../proxy-source && pwd)"
bash bench/run.sh
```

## What it measures

- Three rounds with rotating proxy order and a two-second warm-up per case. Each measurement uses a fixed 64 concurrent clients for eight seconds. Change these with `BENCH_ROUNDS`, `BENCH_CONCURRENCY` and `BENCH_SECONDS`.
- HTTP/1.1 with keep-alive over both HTTP and HTTPS, using the same local certificate for all proxies. Compression, access logs and caching are disabled. Every response must match the app's expected status and body.
- Requests per second, p50/p95/p99 latency, errors, mean sampled proxy CPU and peak sampled proxy memory. The direct HTTP case measures the backend and load generator together without a proxy.
- Results in the workflow summary and in a downloadable artifact. The artifact contains each round's metrics, the Docker samples and information about the runner and images.

These measurements represent one small response and one workload on a GitHub-hosted VM. Read the range across rounds alongside the median. CPU sampling is approximate, and 100% means about one core in Docker's reporting. The HTTPS case measures reused HTTP/1.1 connections, so TLS handshake throughput would need its own workload.

## Measure Proxy capacity

To run the capacity suite locally:

```sh
BENCH_MODE=capacity bash bench/run.sh
```

The suite steps from 16 to 512 concurrent clients with Proxy's default limits, then repeats 256, 512 and 1,024 with the per-route active HTTP request limit set to 1,024. Both runs use the same Total.js backend and test HTTP and HTTPS locally. It records HTTP statuses and transport failures separately, so overload responses do not inflate successful throughput. The suite also runs a 60-second HTTPS interval with 256 concurrent clients and captures CPU profiles of the Proxy container in separate, instrumented intervals. Results are specific to the backend, client and runner used.

## Compare a Proxy change

The `ab` mode runs the A/B suite. It builds the baseline and the candidate with the same runtime image and runs them against the same app, keeping the proxy configuration identical. It alternates the variant order across three rounds and measures HTTP and HTTPS at 64, 256, 512 and 1,000 concurrent clients. Both versions use a per-route limit of 1,024 active HTTP requests. The final round also includes one 60-second HTTPS interval at 256 concurrent clients for each version.

```sh
BENCH_MODE=ab BENCH_BASELINE=YOUR_PROXY_COMMIT BENCH_SECONDS=5 bash bench/run.sh
```

## Diagnose overload

Run `BENCH_MODE=diagnose bash bench/run.sh` to diagnose overload. This mode records downstream failures by HTTP status, `Retry-After` and transport error, and records the status and error codes seen on Proxy's upstream connection. Upstream totals include startup and warm-up traffic. The instrumented runs are intended to explain failures. Use the uninstrumented runs to compare throughput.

## Compare upstream connection pools

Run `BENCH_MODE=pool bash bench/run.sh` to compare the two pools. This compares the stock pool (1,024 active and up to 64 idle upstream sockets per origin) with a pool of 128 active and up to 128 idle sockets. Both cases run one minute over HTTPS at 256 clients and a shorter interval at 1,000 clients. The benchmark changes the pool only in the Proxy containers used for the benchmark.

The `nginx` mode compares Proxy with NGINX. Run it locally with `BENCH_MODE=nginx bash bench/run.sh`. It also measures a one-minute HTTPS interval at 256 clients for both proxies.

## Compare one and two Proxy workers

Run `BENCH_MODE=workers bash bench/run.sh` to compare worker counts. This experiment uses Node cluster to share HTTP and HTTPS listeners while limiting the two workers to 64 upstream connections each. The single worker has 128. Both configurations are measured against NGINX on the same runner, with container-wide CPU and memory samples and a check that both workers served requests. The launcher uses static certificate files with separate worker state for the benchmark.

## Measure memory during load and recovery

Run `BENCH_MODE=memory bash bench/run.sh` to observe memory recovery. The benchmark alternates idle intervals and two bursts of 256 HTTPS clients. It samples CPU and memory in each proxy container. In Proxy, it also records RSS, anonymous RSS on Linux, used JavaScript heap, external memory, ArrayBuffers and upstream sockets. The final forced garbage collection is a separate diagnostic sample after both recovery intervals.
