#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROXY_SOURCE:?Point PROXY_SOURCE at a separate checkout of Total.js Proxy}"
PROXY_SOURCE=$(cd "$PROXY_SOURCE" && pwd -P)
export PROXY_SOURCE
proxy_revision=$(git -C "$PROXY_SOURCE" rev-parse --verify HEAD)
[[ -f "$PROXY_SOURCE/lib/server.js" && -f "$PROXY_SOURCE/Dockerfile" ]] || { echo "PROXY_SOURCE must contain the Proxy product" >&2; exit 1; }

seconds=${BENCH_SECONDS:-8}
rounds=${BENCH_ROUNDS:-3}
concurrency=${BENCH_CONCURRENCY:-64}
mode=${BENCH_MODE:-compare}
[[ $mode == compare || $mode == capacity || $mode == ab || $mode == diagnose || $mode == pool || $mode == nginx || $mode == workers || $mode == memory ]] || { echo "Unknown BENCH_MODE" >&2; exit 1; }
for value in "$seconds" "$rounds" "$concurrency"; do
  [[ $value =~ ^[1-9][0-9]*$ ]] || { echo "Benchmark settings must be positive integers" >&2; exit 1; }
done

output=bench/results
mkdir -p "$output"
export BENCH_TLS_DIR BENCH_EDGE_CONFIG BENCH_EDGE_IMAGE
BENCH_TLS_DIR=$(mktemp -d)
BENCH_EDGE_CONFIG="$PWD/bench/proxy.conf"
current_image="edge-bench-$$:current"
baseline_image="edge-bench-$$:baseline"
BENCH_EDGE_IMAGE="$current_image"
compose=(docker compose -p "edge-bench-$$" -f bench/compose.yaml)
sampler=''

stop_sampler() {
  if [[ -n $sampler ]]; then
    kill "$sampler" 2>/dev/null || true
    wait "$sampler" 2>/dev/null || true
    sampler=''
  fi
}

cleanup() {
  local status=$?
  stop_sampler
  if (( status != 0 )); then
    "${compose[@]}" logs --no-color > "$output/containers.log" 2>&1 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$BENCH_TLS_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=bench.test \
  -addext subjectAltName=DNS:bench.test \
  -keyout "$BENCH_TLS_DIR/key.pem" -out "$BENCH_TLS_DIR/cert.pem" 2>/dev/null
chmod 755 "$BENCH_TLS_DIR"
chmod 644 "$BENCH_TLS_DIR/key.pem" "$BENCH_TLS_DIR/cert.pem"

"${compose[@]}" build app edge
if [[ $mode == compare ]]; then
  "${compose[@]}" pull nginx caddy
elif [[ $mode == nginx || $mode == workers || $mode == memory ]]; then
  "${compose[@]}" pull nginx
fi
"${compose[@]}" up -d --no-deps app
{
  printf 'Benchmark: %s\nProxy source: %s\n' "$(git rev-parse HEAD)" "$proxy_revision"
  node --version
  uname -a
  docker version --format '{{.Server.Version}}'
  docker info --format 'CPUs={{.NCPU}} Memory={{.MemTotal}}'
  "${compose[@]}" images
} > "$output/environment.txt"
: > "$output/index.tsv"

ready() {
  local protocol=$1 port=$2
  local curl_args=(--silent --fail --max-time 2 --resolve "bench.test:$port:127.0.0.1")
  if [[ $protocol == https ]]; then
    curl_args+=(--cacert "$BENCH_TLS_DIR/cert.pem")
  fi
  for ((i=0; i<30; i++)); do
    if [[ $(curl "${curl_args[@]}" "$protocol://bench.test:$port/" 2>/dev/null) == 'Hello from Total.js behind Total.js Proxy.' ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Backend or proxy did not serve the expected body at $protocol port $port" >&2
  return 1
}

measure() {
  local proxy=$1 protocol=$2 round=$3 port=$4 service=$5
  local duration=${6:-$seconds} clients=${7:-$concurrency} warmup=${8:-$concurrency}
  local base="$output/$round-$proxy-$protocol" id
  id=$("${compose[@]}" ps -q "$service") || return
  [[ -n $id ]] || return 1
  BENCH_CERT="$BENCH_TLS_DIR/cert.pem" node bench/load.js "$protocol" "$port" 2 "$warmup" >/dev/null || return
  : > "$base.stats.jsonl"
  (
    while docker stats --no-stream --format '{{json .}}' "$id"; do
      sleep 1
    done
  ) >> "$base.stats.jsonl" &
  sampler=$!
  echo "Measuring $round: $proxy over $protocol with $clients clients for ${duration}s"
  local status=0
  BENCH_CERT="$BENCH_TLS_DIR/cert.pem" node bench/load.js "$protocol" "$port" "$duration" "$clients" > "$base.json" || status=$?
  stop_sampler
  printf '%s\t%s\t%s\t%s\n' "$round" "$proxy" "$protocol" "$base" >> "$output/index.tsv"
  return "$status"
}

use_wide_limit() {
  BENCH_EDGE_CONFIG="$BENCH_TLS_DIR/edge-wide.conf"
  cp bench/proxy.conf "$BENCH_EDGE_CONFIG"
  printf '\nhttp_active : 2048\nhttp_active_per_route : 1024\n' >> "$BENCH_EDGE_CONFIG"
}

ready http 18081
memory_phase() {
  local service=$1 label=$2 duration=$3 from to id
  local base="$output/$service-$label"
  id=$("${compose[@]}" ps -q "$service")
  from=$(node -p 'Date.now()')
  (
    while docker stats --no-stream --format '{{json .}}' "$id"; do
      sleep 1
    done
  ) > "$base.stats.jsonl" &
  sampler=$!
  echo "Memory: $service $label (${duration}s)"
  if [[ $label == load-* ]]; then
    BENCH_CERT="$BENCH_TLS_DIR/cert.pem" node bench/load.js https 18443 "$duration" 256 > "$base.json" || true
    test -s "$base.json"
  else
    sleep "$duration"
  fi
  to=$(node -p 'Date.now()')
  stop_sampler
  printf '%s\t%s\t%s\t%s\n' "$service" "$label" "$from" "$to" >> "$output/memory-phases.tsv"
}

if [[ $mode == memory ]]; then
  use_wide_limit
  compose+=(-f bench/memory.yaml)
  : > "$output/memory-phases.tsv"
  for service in edge nginx; do
    "${compose[@]}" up -d --force-recreate --no-deps "$service"
    ready https 18443
    memory_phase "$service" idle 12
    memory_phase "$service" load-1 40
    memory_phase "$service" recovery-1 25
    memory_phase "$service" load-2 40
    memory_phase "$service" recovery-2 45
    if [[ $service == edge ]]; then
      "${compose[@]}" kill -s SIGUSR2 edge
      sleep 2
    fi
    "${compose[@]}" stop "$service"
    if [[ $service == edge ]]; then
      "${compose[@]}" logs --no-color --no-log-prefix edge |
        sed -n 's/^EDGE_MEMORY //p' > "$output/edge-node.jsonl"
    fi
  done
  node bench/memory-summary.js "$output" | tee "$output/summary.md"
  exit 0
fi

diagnostic_interval() {
  local variant=$1 protocol=$2 clients=$3 duration=$4
  local port=18080
  [[ $protocol != https ]] || port=18443
  "${compose[@]}" up -d --force-recreate --no-deps edge
  ready "$protocol" "$port"
  if [[ $mode == pool ]]; then
    printf '%s port range: ' "$variant/$protocol/$clients" >> "$output/environment.txt"
    "${compose[@]}" exec -T edge cat /proc/sys/net/ipv4/ip_local_port_range >> "$output/environment.txt"
  fi
  measure "$variant" "$protocol" "$clients" "$port" edge "$duration" "$clients" 16 || true
  "${compose[@]}" stop edge
  "${compose[@]}" logs --no-color --no-log-prefix edge |
    sed -n 's/^EDGE_UPSTREAM //p' > "$output/$clients-$variant-$protocol.upstream.jsonl"
  test -s "$output/$clients-$variant-$protocol.upstream.jsonl"
}

if [[ $mode == diagnose || $mode == pool ]]; then
  use_wide_limit
  compose+=(-f bench/diagnose.yaml)
  if [[ $mode == diagnose ]]; then
    measure direct http 1000 18081 app 12 1000 16 || true
    diagnostic_interval edge https 256 60
    diagnostic_interval edge https 1000 15
    diagnostic_interval edge http 1000 15
  else
    pool_config="$BENCH_EDGE_CONFIG"
    stock_config="$BENCH_TLS_DIR/edge-stock.conf"
    cp "$pool_config" "$stock_config"
    printf '\nupstream_connections : 1024\nupstream_idle_connections : 64\n' >> "$stock_config"
    BENCH_EDGE_CONFIG="$stock_config"
    diagnostic_interval stock https 256 60
    BENCH_EDGE_CONFIG="$pool_config"
    diagnostic_interval pool-128 https 256 60
    diagnostic_interval pool-128 https 1000 15
    BENCH_EDGE_CONFIG="$stock_config"
    diagnostic_interval stock https 1000 15
  fi
  [[ $(wc -l < "$output/index.tsv") -eq 4 ]] || { echo "Incomplete diagnostic measurements" >&2; exit 1; }
  node bench/summary.js "$output/index.tsv" diagnose | tee "$output/summary.md"
  exit 0
fi

if [[ $mode == nginx || $mode == workers ]]; then
  # Apply Edge's request limit above the test load so the comparison exercises the proxy.
  use_wide_limit
  variants=(edge nginx)
  if [[ $mode == workers ]]; then
    compose+=(-f bench/workers.yaml)
    variants=(edge-1 edge-2 nginx)
  fi
  export BENCH_EDGE_WORKERS
  for ((round=1; round<=rounds; round++)); do
    for ((offset=0; offset<${#variants[@]}; offset++)); do
      variant=${variants[((round - 1 + offset) % ${#variants[@]})]}
      service=edge
      BENCH_EDGE_WORKERS=1
      case "$variant" in
        edge-2) BENCH_EDGE_WORKERS=2 ;;
        nginx) service=nginx ;;
      esac
      "${compose[@]}" up -d --force-recreate --no-deps "$service"
      ready http 18080
      ready https 18443
      measure "$variant-64" http "$round" 18080 "$service" "$seconds" 64 16 || true
      measure "$variant-64" https "$round" 18443 "$service" "$seconds" 64 16 || true
      if (( round == rounds )); then
        measure "$variant-sustained" https "$round" 18443 "$service" 60 256 16 || true
      fi
      "${compose[@]}" stop "$service"
      if [[ $mode == workers && $service == edge ]]; then
        "${compose[@]}" logs --no-color --no-log-prefix edge |
          sed -n 's/^EDGE_WORKER //p' > "$output/$round-$variant-workers.jsonl"
        node - "$output/$round-$variant-workers.jsonl" "$BENCH_EDGE_WORKERS" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const workers = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
assert.equal(workers.length, Number(process.argv[3]));
assert.equal(new Set(workers.map(worker => worker.id)).size, workers.length);
assert.ok(workers.every(worker => worker.requests > 0));
assert.equal(workers.reduce((sum, worker) => sum + worker.upstreamConnections, 0), 128);
JS
      fi
    done
  done
  [[ $(wc -l < "$output/index.tsv") -eq $(( ${#variants[@]} * (rounds * 2 + 1) )) ]] || { echo "Incomplete proxy comparison" >&2; exit 1; }
  node bench/summary.js "$output/index.tsv" "$mode" | tee "$output/summary.md"
  exit 0
fi

if [[ $mode == ab ]]; then
  baseline=${BENCH_BASELINE:?Set BENCH_BASELINE to a Proxy commit available in PROXY_SOURCE}
  git -C "$PROXY_SOURCE" archive "$baseline" | docker build -t "$baseline_image" -
  use_wide_limit
  printf 'Baseline: %s\nCandidate: %s\n' "$baseline" "$proxy_revision" >> "$output/environment.txt"
  for ((round=1; round<=rounds; round++)); do
    variants=(baseline candidate)
    if (( round % 2 == 0 )); then
      variants=(candidate baseline)
    fi
    for variant in "${variants[@]}"; do
      BENCH_EDGE_IMAGE="$current_image"
      [[ $variant != baseline ]] || BENCH_EDGE_IMAGE="$baseline_image"
      "${compose[@]}" up -d --no-build --force-recreate --no-deps edge
      ready http 18080
      ready https 18443
      for protocol in http https; do
        port=18080
        [[ $protocol != https ]] || port=18443
        for clients in 64 256 512 1000; do
          measure "$variant-$clients" "$protocol" "$round" "$port" edge "$seconds" "$clients" 16 || true
        done
      done
      if (( round == rounds )); then
        measure "$variant-sustained" https "$round" 18443 edge 60 256 16 || true
      fi
      "${compose[@]}" stop edge
    done
  done
  [[ $(wc -l < "$output/index.tsv") -eq $((rounds * 16 + 2)) ]] || { echo "Incomplete A/B measurements" >&2; exit 1; }
  node bench/summary.js "$output/index.tsv" ab | tee "$output/summary.md"
  exit 0
fi

if [[ $mode == capacity ]]; then
  "${compose[@]}" up -d --no-deps edge
  ready http 18080
  ready https 18443
  for protocol in http https; do
    port=18080
    [[ $protocol != https ]] || port=18443
    for clients in 16 64 128 256 512; do
      measure default "$protocol" "$clients" "$port" edge "$seconds" "$clients" 16 || true
    done
  done

  use_wide_limit
  "${compose[@]}" up -d --force-recreate --no-deps edge
  ready http 18080
  ready https 18443
  for protocol in http https; do
    port=18080
    [[ $protocol != https ]] || port=18443
    for clients in 256 512 1024; do
      measure expanded "$protocol" "$clients" "$port" edge "$seconds" "$clients" 16 || true
    done
  done
  measure sustained https 256 18443 edge 60 256 16 || true

  for protocol in http https; do
    port=18080
    [[ $protocol != https ]] || port=18443
    export BENCH_PROFILE_NAME="$protocol.cpuprofile"
    profile=( "${compose[@]}" -f bench/profile.yaml )
    "${profile[@]}" up -d --force-recreate --no-deps edge
    ready "$protocol" "$port"
    BENCH_CERT="$BENCH_TLS_DIR/cert.pem" node bench/load.js "$protocol" "$port" 8 128 >/dev/null
    "${profile[@]}" stop edge
    "${profile[@]}" cp "edge:/proxy/data/$BENCH_PROFILE_NAME" "$output/$BENCH_PROFILE_NAME"
  done
  [[ $(wc -l < "$output/index.tsv") -eq 17 ]] || { echo "Incomplete capacity measurements" >&2; exit 1; }
  node bench/summary.js "$output/index.tsv" capacity | tee "$output/summary.md"
  exit 0
fi
proxies=(edge nginx caddy)
failed=0
for ((round=1; round<=rounds; round++)); do
  measure direct http "$round" 18081 app || failed=1
  for ((offset=0; offset<3; offset++)); do
    proxy=${proxies[((round - 1 + offset) % 3)]}
    "${compose[@]}" up -d --no-deps "$proxy"
    "${compose[@]}" images "$proxy" >> "$output/environment.txt"
    ready http 18080
    ready https 18443
    if (( (round + offset) % 2 )); then
      measure "$proxy" http "$round" 18080 "$proxy" || failed=1
      measure "$proxy" https "$round" 18443 "$proxy" || failed=1
    else
      measure "$proxy" https "$round" 18443 "$proxy" || failed=1
      measure "$proxy" http "$round" 18080 "$proxy" || failed=1
    fi
    "${compose[@]}" stop "$proxy"
  done
done
node bench/summary.js "$output/index.tsv" | tee "$output/summary.md"
exit "$failed"
